import { renderBrandedQR } from './qr-brand.js?v=20261124';
import { collectPeerStats, sanitizeIceServers, startAdaptiveTransport } from './webrtc-common.js?v=20261119';
import { createWallTile, updateWallTileAppearance, attachStreamToWallTile } from './wall-renderer.js?v=20261124';

const cfg = JSON.parse(document.getElementById('app-config').textContent);
const urlParams = new URLSearchParams(window.location.search);
const frameCheckEnabled = urlParams.get('framecheck') === '1';

const el = {
  stage: document.getElementById('wall-stage'),
  liveLayout: document.getElementById('wall-live-layout'),
  videoArea: document.getElementById('wall-video-area'),
  idlePrompt: document.getElementById('wall-idle-prompt'),
  qrPanel: document.getElementById('wall-qr-panel'),
  qrPanelInner: document.getElementById('wall-qr-panel-inner'),
  panelLogoWrap: document.getElementById('wall-panel-logo-wrap'),
  panelLogo: document.getElementById('wall-panel-logo'),
  panelBox: document.getElementById('wall-panel-box'),
  qrSideCanvas: document.getElementById('wall-qr-side-canvas'),
  panelStatus: document.getElementById('wall-panel-status'),
  qrCorner: document.getElementById('wall-qr-corner'),
  cornerLogoWrap: document.getElementById('wall-corner-logo-wrap'),
  cornerLogo: document.getElementById('wall-corner-logo'),
  qrCornerCanvas: document.getElementById('wall-qr-corner-canvas'),
  cornerStatus: document.getElementById('wall-corner-status'),
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
let lastJoinLogoUrl = '';
let activeSlots = [];
let wallAudioEnabled = false;

function syncStageScale() {
  if (!el.stage) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (Math.abs(vw - 1920) <= 1 && Math.abs(vh - 1080) <= 1) {
    el.stage.style.transform = 'none';
    return;
  }
  const scale = Math.min(vw / 1920, vh / 1080);
  el.stage.style.transform = scale > 0 ? `scale(${scale})` : 'none';
}

window.addEventListener('resize', syncStageScale);
syncStageScale();

function bindLogoFallback(imgEl, wrapEl) {
  if (!imgEl || !wrapEl) return;
  imgEl.addEventListener('error', () => {
    wrapEl.hidden = true;
  });
}

bindLogoFallback(el.panelLogo, el.panelLogoWrap);
bindLogoFallback(el.cornerLogo, el.cornerLogoWrap);

function syncJoinLogoDisplay(logoUrl) {
  const normalized = logoUrl ? String(logoUrl) : '';
  if (normalized === lastJoinLogoUrl) return;
  lastJoinLogoUrl = normalized;

  if (el.panelLogoWrap && el.panelLogo) {
    if (normalized) {
      el.panelLogo.src = normalized;
      el.panelLogoWrap.hidden = false;
    } else {
      el.panelLogo.removeAttribute('src');
      el.panelLogoWrap.hidden = true;
    }
  }
  if (el.cornerLogoWrap && el.cornerLogo) {
    if (normalized) {
      el.cornerLogo.src = normalized;
      el.cornerLogoWrap.hidden = false;
    } else {
      el.cornerLogo.removeAttribute('src');
      el.cornerLogoWrap.hidden = true;
    }
  }
}

// Render initial join logo immediately before first poll returns
syncJoinLogoDisplay(cfg.joinLogoUrl || '');

function hexToRgba(hex, opacityPct) {
  const clean = String(hex || '#021048').replace('#', '').trim();
  const alpha = Math.max(0, Math.min(1, Number(opacityPct ?? 100) / 100));
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `rgba(2, 16, 72, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolveQrStatusMessage(state) {
  if (state.event_status === 'closed') return 'Event has ended';
  if (state.join_locked) return 'Joining is closed';
  if (state.is_full) return 'Event is full';
  return null;
}

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

async function syncQrRendering(qrConfig, sideSize = 500) {
  const joinUrl = resolvePublicUrl(qrConfig.joinUrl || cfg.joinUrl);
  const resolvedSideSize = Math.max(320, Math.min(560, Number(sideSize || 500)));
  const sig = JSON.stringify({ ...qrConfig, joinUrl, resolvedSideSize, qrMode: cfg.qrMode });
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
  if (el.qrSideCanvas && cfg.qrMode !== 'off') {
    await renderBrandedQR(el.qrSideCanvas, { ...baseOpts, size: resolvedSideSize });
  }
  if (cfg.qrMode === 'corner' && el.qrCornerCanvas) {
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

function createOrUpdateTile(slot, idx, state) {
  let tile = tiles.get(slot.participant_id);
  if (!tile) {
    tile = createWallTile();
    tiles.set(slot.participant_id, tile);
  }

  tile.root.dataset.pos = String(idx);
  // Zero text or lower-thirds over wall video
  tile.nameEl.textContent = '';
  tile.msgEl.textContent = '';
  tile.msgEl.hidden = true;
  tile.lowerEl.hidden = true;

  const fitMode = slot.fit_mode || state.wall_fit_mode || 'fit';
  const tileBg = state.wall_tile_bg || 'blur';
  const tileBgColor = state.wall_tile_bg_color || '#020c3b';

  updateWallTileAppearance(tile, {
    fitMode,
    tileBg,
    tileBgColor,
    mirrored: false,
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

function applyQrStatusDisplay(statusMsg) {
  const blocked = Boolean(statusMsg);
  if (el.qrSideCanvas && el.panelStatus) {
    el.qrSideCanvas.hidden = blocked;
    el.panelStatus.hidden = !blocked;
    el.panelStatus.textContent = statusMsg || '';
  }
  if (el.qrCornerCanvas && el.cornerStatus) {
    el.qrCornerCanvas.hidden = blocked;
    el.cornerStatus.hidden = !blocked;
    el.cornerStatus.textContent = statusMsg || '';
  }
}

function applySideQrLayout(state, hasLive) {
  const sideQr = state.side_qr || {};
  const size = Math.max(320, Math.min(560, Number(sideQr.size || 500)));
  const side = sideQr.side === 'left' ? 'left' : 'right';
  const valign = sideQr.valign === 'top' ? 'top' : 'center';
  const bgRgba = hexToRgba(sideQr.bg_color || '#021048', sideQr.bg_opacity ?? 92);
  const forceHidden = !!sideQr.hidden;
  const sideEnabled = sideQr.enabled !== false;

  // Same 2-panel jumbotron theme on BOTH QR-only (idle) and QR-with-live-video pages.
  // Only collapse right panel when ?qr=off, emergency hidden, corner mode while live, or live + side disabled.
  const panelOpen = !forceHidden && (
    cfg.qrMode === 'side'
      ? (!hasLive || sideEnabled)
      : (cfg.qrMode === 'corner' && !hasLive)
  );
  const showCorner = hasLive && cfg.qrMode === 'corner' && !forceHidden;

  el.liveLayout.dataset.qrSide = side;
  el.liveLayout.style.setProperty('--qr-size', `${size}px`);
  el.liveLayout.style.setProperty('--qr-panel-bg', bgRgba);
  el.liveLayout.classList.toggle('is-live', hasLive);
  el.liveLayout.classList.toggle('is-panel-collapsed', !panelOpen);

  if (el.idlePrompt) el.idlePrompt.hidden = hasLive;
  if (el.grid) el.grid.hidden = !hasLive;

  el.qrPanel.classList.toggle('is-panel-open', panelOpen);
  el.qrPanelInner.classList.toggle('valign-top', valign === 'top');
  el.qrPanelInner.classList.toggle('valign-center', valign !== 'top');

  el.qrCorner.hidden = !showCorner;

  syncJoinLogoDisplay((state.qr && state.qr.joinLogoUrl) || cfg.joinLogoUrl || '');

  const statusMsg = resolveQrStatusMessage(state);
  applyQrStatusDisplay(statusMsg);
  return { panelOpen, showCorner, size, hasStatusBlock: Boolean(statusMsg) };
}

async function handleWallState(state) {
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
      tile.destroy?.();
      tile.root.remove();
      tiles.delete(pid);
    }
  }

  const hasLive = activeSlots.length > 0;
  if (hasLive) {
    el.grid.className = `wall-grid layout-${state.layout || 'single'}`;
    const now = Date.now();
    activeSlots.forEach((slot, idx) => {
      if (!slotSeenAt.has(slot.participant_id)) {
        slotSeenAt.set(slot.participant_id, now);
      }
      const tile = createOrUpdateTile(slot, idx, state);
      if (tile.root.parentNode !== el.grid) {
        el.grid.appendChild(tile.root);
      }
    });
  }

  const qrVis = applySideQrLayout(state, hasLive);

  if (state.qr && !qrVis.hasStatusBlock && (qrVis.panelOpen || qrVis.showCorner)) {
    try {
      await syncQrRendering(state.qr, qrVis.size);
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
