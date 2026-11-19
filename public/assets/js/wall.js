import { renderBrandedQR } from './qr-brand.js';
import { collectPeerStats, sanitizeIceServers, startAdaptiveTransport } from './webrtc-common.js';
import { createWallTile, updateWallTileAppearance, attachStreamToWallTile } from './wall-renderer.js';

const cfg = JSON.parse(document.getElementById('app-config').textContent);
const urlParams = new URLSearchParams(window.location.search);
const frameCheckEnabled = urlParams.get('framecheck') === '1';

const el = {
  qrIdle: document.getElementById('wall-qr-idle'),
  qrCanvas: document.getElementById('wall-qr-canvas'),
  qrCorner: document.getElementById('wall-qr-corner'),
  qrCornerCanvas: document.getElementById('wall-qr-corner-canvas'),
  eventTitle: document.getElementById('wall-event-title'),
  grid: document.getElementById('wall-grid'),
  blackout: document.getElementById('wall-blackout'),
};

const peers = new Map(); // participantId -> { pc, pendingCandidates, stream }
const earlyCandidates = new Map(); // participantId -> RTCIceCandidateInit[]
const slotSeenAt = new Map(); // participantId -> timestamp ms
const lastRenegAt = new Map(); // participantId -> timestamp ms
const tiles = new Map(); // participantId -> wall-renderer tile
const prevBytesMap = new Map();
let lastQrSig = '';
let activeSlots = [];
let wallAudioEnabled = false;

function resolveAudioEnabled(serverAudioEnabled) {
  if (cfg.isMonitor) return false; // Never play wall iframe audio directly inside admin monitor
  if (cfg.audioOverride === 'on') return true;
  if (cfg.audioOverride === 'off') return false;
  return !!serverAudioEnabled;
}

function resolvePublicUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, window.location.origin);
    const cur = new URL(window.location.origin);
    const rawLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname);
    const curLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(cur.hostname);
    if (rawLocal && !curLocal) {
      return cur.origin + u.pathname + u.search + u.hash;
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

async function syncQrRendering(qrConfig) {
  const joinUrl = resolvePublicUrl(qrConfig.joinUrl || cfg.joinUrl);
  const sig = JSON.stringify({ ...qrConfig, joinUrl });
  if (sig === lastQrSig) return;
  lastQrSig = sig;
  const baseOpts = {
    text: joinUrl,
    logoUrl: qrConfig.logoUrl,
    shape: qrConfig.shape,
    fit: qrConfig.fit,
    scalePct: qrConfig.scale,
    paddingPx: qrConfig.padding,
    logoBg: qrConfig.logoBg,
    fg: qrConfig.fg,
    bg: qrConfig.bg,
  };
  await renderBrandedQR(el.qrCanvas, { ...baseOpts, size: 1360 });
  if (cfg.qrMode === 'corner' || cfg.qrMode === 'on') {
    await renderBrandedQR(el.qrCornerCanvas, { ...baseOpts, size: 440 });
  }
}

function closePeer(pid) {
  const entry = peers.get(pid);
  if (entry) {
    try { entry.pc.close(); } catch {}
    peers.delete(pid);
  }
}

function createOrUpdateTile(slot, idx, showLabels, state) {
  let tile = tiles.get(slot.participant_id);
  if (!tile) {
    tile = createWallTile();
    tiles.set(slot.participant_id, tile);
  }

  tile.root.dataset.pos = String(idx);
  tile.nameEl.textContent = slot.display_name;
  tile.msgEl.textContent = slot.message || '';
  tile.msgEl.hidden = !slot.message;
  tile.lowerEl.hidden = !showLabels;

  const fitMode = slot.fit_mode || state.wall_fit_mode || 'fit';
  const tileBg = state.wall_tile_bg || 'blur';
  const tileBgColor = state.wall_tile_bg_color || '#090d16';
  const mirrored = Boolean(state.mirror_front_wall) && slot.facing_mode === 'user';

  updateWallTileAppearance(tile, {
    fitMode,
    tileBg,
    tileBgColor,
    mirrored,
    frameCheck: frameCheckEnabled,
    captureInfo: slot.capture_settings || null,
  });

  const shouldMute = !wallAudioEnabled || !!slot.muted;
  tile.video.muted = shouldMute;

  const pEntry = peers.get(slot.participant_id);
  if (pEntry && pEntry.stream) {
    attachStreamToWallTile(tile, pEntry.stream);
    tile.video.play().catch(() => {
      // Fallback: if browser blocks unmuted autoplay outside OBS, keep video playing muted
      tile.video.muted = true;
      tile.video.play().catch(() => {});
    });
  }

  return tile;
}

async function sendSignal(participantId, type, payload) {
  await fetch('/api/wall/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: cfg.eventSlug,
      key: cfg.wallKey,
      viewer_id: cfg.viewerId,
      participant_id: participantId,
      type,
      payload,
    }),
  });
}

function requestRenegotiation(pid) {
  const now = Date.now();
  const last = lastRenegAt.get(pid) || 0;
  if (now - last < 4500) return;
  lastRenegAt.set(pid, now);
  sendSignal(pid, 'renegotiate', {}).catch(() => {});
}

async function handleOffer(pid, sdp) {
  closePeer(pid);
  const queued = earlyCandidates.get(pid) || [];
  earlyCandidates.delete(pid);
  const pc = new RTCPeerConnection({ iceServers: sanitizeIceServers(cfg.iceServers) });
  const entry = { pc, pendingCandidates: queued, stream: null };
  peers.set(pid, entry);

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || entry.stream || new MediaStream();
    if (!ev.streams[0] && !stream.getTracks().includes(ev.track)) {
      stream.addTrack(ev.track);
    }
    entry.stream = stream;
    const tile = tiles.get(pid);
    if (tile) {
      attachStreamToWallTile(tile, stream);
      tile.video.play().catch(() => {
        tile.video.muted = true;
        tile.video.play().catch(() => {});
      });
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal(pid, 'candidate', ev.candidate.toJSON()).catch(() => {});
    }
  };

  pc.oniceconnectionstatechange = () => {
    const tile = tiles.get(pid);
    if (!tile) return;
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      tile.connEl.hidden = true;
    } else if (pc.iceConnectionState === 'failed') {
      tile.connEl.hidden = false;
      tile.connEl.textContent = 'WebRTC blocked (use same Wi-Fi or configure TURN server)';
      requestRenegotiation(pid);
    } else if (pc.iceConnectionState === 'disconnected') {
      tile.connEl.hidden = false;
      tile.connEl.textContent = 'Reconnecting feed...';
      requestRenegotiation(pid);
    }
  };

  pc.onconnectionstatechange = () => {
    const tile = tiles.get(pid);
    if (!tile) return;
    if (pc.connectionState === 'connected') {
      tile.connEl.hidden = true;
    } else if (pc.connectionState === 'failed') {
      tile.connEl.hidden = false;
      tile.connEl.textContent = 'WebRTC blocked (use same Wi-Fi or configure TURN server)';
      requestRenegotiation(pid);
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  for (const c of entry.pendingCandidates) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }
  entry.pendingCandidates = [];
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await sendSignal(pid, 'answer', { type: answer.type, sdp: answer.sdp });
}

async function handleSignal(sig) {
  const pid = sig.participant_id;
  if (sig.type === 'offer' && sig.payload) {
    await handleOffer(pid, sig.payload);
  } else if (sig.type === 'candidate' && sig.payload) {
    const entry = peers.get(pid);
    if (!entry) {
      const list = earlyCandidates.get(pid) || [];
      list.push(sig.payload);
      earlyCandidates.set(pid, list);
      return;
    }
    if (entry.pc.remoteDescription) {
      try { await entry.pc.addIceCandidate(new RTCIceCandidate(sig.payload)); } catch {}
    } else {
      entry.pendingCandidates.push(sig.payload);
    }
  }
}

async function handleWallState(state) {
  el.eventTitle.textContent = state.title || cfg.eventTitle;
  el.blackout.hidden = !state.blackout;
  wallAudioEnabled = resolveAudioEnabled(state.audio_enabled);

  const maxFeeds = Math.max(1, Math.min(4, state.max_wall_feeds || 4));
  activeSlots = (state.slots || []).slice(0, maxFeeds);
  const activeIds = new Set(activeSlots.map((s) => s.participant_id));

  // Remove dropped participants
  for (const pid of Array.from(peers.keys())) {
    if (!activeIds.has(pid)) closePeer(pid);
  }
  for (const pid of Array.from(earlyCandidates.keys())) {
    if (!activeIds.has(pid)) earlyCandidates.delete(pid);
  }
  for (const pid of Array.from(slotSeenAt.keys())) {
    if (!activeIds.has(pid)) {
      slotSeenAt.delete(pid);
      lastRenegAt.delete(pid);
    }
  }
  for (const [pid, tile] of Array.from(tiles.entries())) {
    if (!activeIds.has(pid)) {
      tile.root.remove();
      tiles.delete(pid);
    }
  }

  // Toggle idle QR vs live grid FIRST so QR/logo rendering never blocks live feed visibility
  const hasLive = activeSlots.length > 0;
  if (!hasLive) {
    el.grid.hidden = true;
    el.qrIdle.hidden = cfg.qrMode === 'off';
    el.qrCorner.hidden = true;
  } else {
    el.qrIdle.hidden = true;
    el.grid.hidden = false;
    el.grid.className = `wall-grid layout-${state.layout || 'single'}`;

    const now = Date.now();
    activeSlots.forEach((slot, idx) => {
      if (!slotSeenAt.has(slot.participant_id)) {
        slotSeenAt.set(slot.participant_id, now);
      }
      const tile = createOrUpdateTile(slot, idx, !!state.show_labels, state);
      if (tile.root.parentNode !== el.grid) {
        el.grid.appendChild(tile.root);
      }
    });

    el.qrCorner.hidden = !(cfg.qrMode === 'corner' || cfg.qrMode === 'on');
  }

  if (state.qr && (!hasLive || cfg.qrMode === 'corner' || cfg.qrMode === 'on')) {
    try {
      await syncQrRendering(state.qr);
    } catch {
      // Keep live stage responsive even if branded QR rendering fails
    }
  }

  for (const sig of state.signals || []) {
    try {
      await handleSignal(sig);
    } catch {
      // Ignore stale or malformed signaling message so subsequent messages still process
    }
  }

  // If wall opened or reloaded after participant was already on-air, request fresh offer
  const now = Date.now();
  for (const slot of activeSlots) {
    const pid = slot.participant_id;
    const seenForMs = now - (slotSeenAt.get(pid) || now);
    if (!peers.has(pid) && seenForMs > 1200) {
      requestRenegotiation(pid);
    }
  }
}

async function reportWallStats() {
  if (cfg.isMonitor || peers.size === 0) return;
  const stats = [];
  for (const [pid, entry] of peers.entries()) {
    const s = await collectPeerStats(entry.pc, prevBytesMap, `w_${pid}`);
    stats.push({ participant_id: pid, ...s });
  }
  if (stats.length > 0) {
    fetch('/api/wall/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: cfg.eventSlug, key: cfg.wallKey, stats }),
    }).catch(() => {});
  }
}

setInterval(reportWallStats, 3500);

function buildParams() {
  const res = `${window.innerWidth}x${window.innerHeight}`;
  return `slug=${encodeURIComponent(cfg.eventSlug)}&key=${encodeURIComponent(cfg.wallKey)}&viewer_id=${encodeURIComponent(cfg.viewerId)}&is_primary=${cfg.isMonitor ? '0' : '1'}&resolution=${encodeURIComponent(res)}&version=${encodeURIComponent(cfg.version || '1.0.0')}`;
}

const stopTransport = startAdaptiveTransport({
  mode: cfg.signalingMode,
  sseUrlFn: () => `/api/wall/stream?${buildParams()}`,
  pollUrlFn: () => `/api/wall/poll?${buildParams()}&_=${Date.now()}`,
  onState: handleWallState,
  onError: () => {},
  getIntervalMs: () => (activeSlots.length > 0 || peers.size > 0 ? (cfg.pollFastMs || 700) : (cfg.pollIdleMs || 2000)),
});

window.addEventListener('message', (ev) => {
  if (ev.origin === window.location.origin && ev.data && ev.data.type === 'qrlw_poll_now') {
    stopTransport.trigger();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    stopTransport.trigger();
  }
});
