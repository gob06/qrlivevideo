/**
 * Shared WebRTC signaling, bitrate cap, getStats() health collector, and SSE/poll transport helpers.
 */

export function sanitizeIceServers(rawList) {
  const validRe = /^(stuns?|turns?):[a-z0-9.\[\]-]+(:\d+)?(\?[^\s]*)?$/i;
  const out = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const rawUrls = Array.isArray(item.urls) ? item.urls : [item.urls];
      const urls = rawUrls
        .map((u) => String(u ?? '').trim())
        .filter((u) => validRe.test(u));
      if (urls.length === 0) continue;
      const entry = { urls: Array.isArray(item.urls) ? urls : urls[0] };
      if (item.username) entry.username = String(item.username);
      if (item.credential) entry.credential = String(item.credential);
      out.push(entry);
    }
  }
  return out.length > 0 ? out : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
}

export function applyBitrateCap(pc, maxBps = 1500000) {
  for (const sender of pc.getSenders()) {
    if (sender.track && sender.track.kind === 'video') {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = maxBps;
        sender.setParameters(params).catch(() => {});
      } catch {
        // Some mobile browsers reject partial setParameters
      }
    }
  }
}

export async function collectPeerStats(pc, prevBytesMap, key) {
  const result = {
    state: pc.iceConnectionState || pc.connectionState || 'new',
    width: 0,
    height: 0,
    fps: 0,
    bitrate: 0,
    packet_loss: 0,
    rtt: 0,
    relay_type: 'unknown',
  };

  try {
    const report = await pc.getStats();
    let activePairId = null;
    const localCandidates = new Map();
    const remoteCandidates = new Map();

    report.forEach((stat) => {
      if (stat.type === 'local-candidate') localCandidates.set(stat.id, stat);
      if (stat.type === 'remote-candidate') remoteCandidates.set(stat.id, stat);
      if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        activePairId = stat.selectedCandidatePairId;
      }
    });

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && (stat.id === activePairId || stat.nominated || stat.state === 'succeeded')) {
        if (typeof stat.currentRoundTripTime === 'number') {
          result.rtt = Math.round(stat.currentRoundTripTime * 1000 * 10) / 10;
        }
        const lc = localCandidates.get(stat.localCandidateId);
        const rc = remoteCandidates.get(stat.remoteCandidateId);
        if (lc || rc) {
          const isTurn = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay');
          result.relay_type = isTurn ? 'turn' : 'direct';
        }
      }

      if ((stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp') && stat.kind === 'video') {
        if (stat.frameWidth) result.width = stat.frameWidth;
        if (stat.frameHeight) result.height = stat.frameHeight;
        if (stat.framesPerSecond) result.fps = Math.round(stat.framesPerSecond * 10) / 10;

        const bytes = stat.type === 'inbound-rtp' ? (stat.bytesReceived || 0) : (stat.bytesSent || 0);
        const ts = stat.timestamp || Date.now();
        const prev = prevBytesMap.get(key);
        if (prev && ts > prev.ts && bytes >= prev.bytes) {
          const dtSec = (ts - prev.ts) / 1000;
          if (dtSec > 0) {
            result.bitrate = Math.round(((bytes - prev.bytes) * 8) / dtSec);
          }
        }
        prevBytesMap.set(key, { bytes, ts });

        if (stat.type === 'inbound-rtp') {
          const lost = stat.packetsLost || 0;
          const recv = stat.packetsReceived || 0;
          if (lost + recv > 0) {
            result.packet_loss = Math.round((lost / (lost + recv)) * 10000) / 100;
          }
        }
      }

      if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
        if (typeof stat.roundTripTime === 'number' && result.rtt === 0) {
          result.rtt = Math.round(stat.roundTripTime * 1000 * 10) / 10;
        }
        if (typeof stat.fractionLost === 'number' && result.packet_loss === 0) {
          result.packet_loss = Math.round(stat.fractionLost * 10000) / 100;
        }
      }
    });
  } catch {
    // Ignore transient getStats errors during teardown
  }
  return result;
}

/**
 * Starts real-time state updates using SSE (if mode === 'auto') with seamless fallback to adaptive HTTP polling.
 */
export function startAdaptiveTransport({ mode, sseUrlFn, pollUrlFn, onState, onError, getIntervalMs }) {
  let stopped = false;
  let es = null;
  let timer = null;
  let usePoll = mode !== 'auto' || typeof EventSource === 'undefined';

  async function doPoll() {
    if (stopped) return;
    try {
      const resp = await fetch(pollUrlFn(), { cache: 'no-store' });
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      await onState(data);
    } catch (err) {
      if (onError) onError(err);
    } finally {
      if (!stopped) {
        timer = setTimeout(doPoll, getIntervalMs());
      }
    }
  }

  function startSse() {
    if (stopped) return;
    try {
      es = new EventSource(sseUrlFn());
      let gotData = false;
      const fallbackWatch = setTimeout(() => {
        if (!gotData && !stopped) {
          if (es) es.close();
          usePoll = true;
          doPoll();
        }
      }, 4000);

      es.addEventListener('state', (ev) => {
        gotData = true;
        clearTimeout(fallbackWatch);
        try {
          onState(JSON.parse(ev.data));
        } catch {
          // ignore parse error
        }
      });

      es.onerror = () => {
        clearTimeout(fallbackWatch);
        if (es) {
          es.close();
          es = null;
        }
        if (!stopped) {
          usePoll = true;
          timer = setTimeout(doPoll, getIntervalMs());
        }
      };
    } catch {
      usePoll = true;
      doPoll();
    }
  }

  if (usePoll) {
    doPoll();
  } else {
    startSse();
  }

  return () => {
    stopped = true;
    if (es) es.close();
    if (timer) clearTimeout(timer);
  };
}
