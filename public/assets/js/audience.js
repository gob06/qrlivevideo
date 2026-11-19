import {
  applyVideoSenderParameters,
  collectPeerStats,
  preferVideoCodecs,
  sanitizeIceServers,
  startAdaptiveTransport,
} from './webrtc-common.js?v=20261119';

const cfg = JSON.parse(document.getElementById('app-config').textContent);
const storageKey = `qrlw_aud_${cfg.eventSlug}`;

const el = {
  inappWarn: document.getElementById('aud-inapp-warning'),
  copyLinkBtn: document.getElementById('aud-copy-link'),
  statusBanner: document.getElementById('aud-status-banner'),
  statusText: document.getElementById('aud-status-text'),
  stepJoin: document.getElementById('aud-step-join'),
  stepStage: document.getElementById('aud-step-stage'),
  stepEnded: document.getElementById('aud-step-ended'),
  endedTitle: document.getElementById('aud-ended-title'),
  endedDesc: document.getElementById('aud-ended-desc'),
  rejoinBtn: document.getElementById('aud-rejoin-btn'),
  joinForm: document.getElementById('aud-join-form'),
  joinError: document.getElementById('aud-join-error'),
  stageError: document.getElementById('aud-stage-error'),
  consentInput: document.getElementById('aud-consent'),
  startBtn: document.getElementById('aud-start-btn'),
  orientHint: document.getElementById('aud-orient-hint'),
  previewVideo: document.getElementById('aud-preview'),
  videoWrap: document.getElementById('aud-video-wrap') || document.querySelector('.aud-video-wrap'),
  onairFrame: document.getElementById('aud-onair-frame'),
  previewNote: document.getElementById('aud-preview-note'),
  micBtn: document.getElementById('aud-mic-btn'),
  micLabel: document.getElementById('aud-mic-label'),
  flipBtn: document.getElementById('aud-flip-btn'),
  leaveBtn: document.getElementById('aud-leave-btn'),
};

let sessionToken = localStorage.getItem(storageKey) || '';
let iceServers = cfg.iceServers || [];
let localStream = null;
let facingMode = 'user';
let currentCaptureSettings = {};
let userMuted = false;
let adminMuted = false;
let currentStatus = 'idle';
let activeTargets = [];
let stopTransport = null;
let thumbTimer = null;
let statsTimer = null;
let wakeLock = null;
let wakeFallbackCanvas = null;
let lastJoinMeta = null;
let rejoining = false;
const peers = new Map(); // targetId -> { pc, pendingCandidates, degraded }
const prevBytesMap = new Map();

// Detect common in-app WebViews where getUserMedia fails on iOS/Android
function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /(FBAN|FBAV|Instagram|Line\/|TikTok|BytedanceWebview|MicroMessenger|Snapchat)/i.test(ua);
}

if (detectInAppBrowser()) {
  el.inappWarn.hidden = false;
}

el.copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    el.copyLinkBtn.textContent = 'Link Copied!';
  } catch {
    el.copyLinkBtn.textContent = 'Copy URL from browser bar';
  }
});

function showJoinError(msg) {
  el.joinError.textContent = msg;
  el.joinError.hidden = false;
}

function setBanner(mode, text) {
  el.statusBanner.hidden = false;
  el.statusBanner.className = `aud-status-bar status-${mode}`;
  el.statusText.textContent = text;
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      return;
    }
  } catch {
    // Fallback below
  }
  if (!wakeFallbackCanvas) {
    wakeFallbackCanvas = document.createElement('canvas');
    wakeFallbackCanvas.width = 2;
    wakeFallbackCanvas.height = 2;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStream) {
    acquireWakeLock();
  }
});

function buildIdealVideoConstraints(extra = {}) {
  const isPortrait = window.innerHeight > window.innerWidth;
  return {
    width: { ideal: isPortrait ? 720 : 1280 },
    height: { ideal: isPortrait ? 1280 : 720 },
    frameRate: { ideal: 30 },
    ...extra,
  };
}

function inferFacingFromLabel(label, fallback = '') {
  const l = String(label || '').toLowerCase();
  if (/(front|user|selfie|facetime|true?depth)/i.test(l)) return 'user';
  if (/(back|rear|environment|world)/i.test(l)) return 'environment';
  return fallback;
}

async function resetZoomToWide(track) {
  if (!track || typeof track.getCapabilities !== 'function') return;
  try {
    const caps = track.getCapabilities();
    if (caps && caps.zoom && typeof caps.zoom.min === 'number') {
      const targetZoom = Math.min(caps.zoom.max ?? caps.zoom.min, Math.max(caps.zoom.min, Math.min(1, caps.zoom.min)));
      const minZoom = caps.zoom.min;
      await track.applyConstraints({ advanced: [{ zoom: minZoom || targetZoom }] }).catch(() => {});
    }
  } catch {
    // Ignore zoom capability errors on browsers without zoom support
  }
}

function syncCaptureInfo() {
  const track = localStream?.getVideoTracks?.()[0];
  if (!track) return;
  const s = typeof track.getSettings === 'function' ? track.getSettings() : {};
  const label = track.label || '';
  const detectedFacing = (s.facingMode === 'user' || s.facingMode === 'environment')
    ? s.facingMode
    : inferFacingFromLabel(label, facingMode);
  facingMode = detectedFacing || facingMode;

  const vw = el.previewVideo.videoWidth || s.width || 0;
  const vh = el.previewVideo.videoHeight || s.height || 0;
  const ar = vw && vh ? Number((vw / vh).toFixed(4)) : (s.aspectRatio ? Number(s.aspectRatio.toFixed(4)) : 0);

  currentCaptureSettings = {
    width: s.width || vw || 0,
    height: s.height || vh || 0,
    videoWidth: vw,
    videoHeight: vh,
    frameRate: s.frameRate ? Math.round(s.frameRate * 10) / 10 : 0,
    aspectRatio: ar,
    facingMode,
    zoom: typeof s.zoom === 'number' ? Math.round(s.zoom * 100) / 100 : null,
    label: label.slice(0, 80),
    deviceId: s.deviceId ? String(s.deviceId).slice(0, 64) : '',
  };

  // Match local preview container aspect ratio to real stream dimensions (uncropped, no stretch)
  if (el.videoWrap && vw > 0 && vh > 0) {
    el.videoWrap.style.aspectRatio = `${vw} / ${vh}`;
  }
  el.previewVideo.classList.toggle('mirrored', facingMode === 'user');

  // Show non-blocking landscape hint only when device/stream is portrait
  if (el.orientHint) {
    const streamPortrait = vw && vh ? vh > vw : window.innerHeight > window.innerWidth;
    el.orientHint.hidden = !streamPortrait;
  }
}

async function openVideoTrack(mode, deviceId = null) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera requires HTTPS and a modern mobile browser (Safari or Chrome).');
  }

  let attempts;
  if (deviceId) {
    attempts = [
      { video: buildIdealVideoConstraints({ deviceId: { exact: deviceId } }), audio: false },
      { video: { deviceId: { exact: deviceId } }, audio: false },
    ];
  } else {
    attempts = [
      { video: buildIdealVideoConstraints({ facingMode: { ideal: mode } }), audio: false },
      { video: { facingMode: { exact: mode } }, audio: false },
      { video: { facingMode: mode }, audio: false },
    ];
  }

  let lastErr = null;
  for (const c of attempts) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(c);
      const track = s.getVideoTracks()[0];
      if (track) {
        await resetZoomToWide(track);
        return track;
      }
      s.getTracks().forEach((t) => t.stop());
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw new Error('Camera permission was denied. Enable camera access in browser settings and retry.');
      }
    }
  }
  throw lastErr || new Error('Could not access the requested camera.');
}

async function pickPreferredDeviceId(targetMode, currentDeviceId) {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId !== currentDeviceId);
    if (cams.length === 0) return null;

    const isBackWanted = targetMode === 'environment';
    const frontRe = /(front|user|selfie|facetime|true?depth)/i;
    const backRe = /(back|rear|environment|world)/i;
    const secondaryLensRe = /(tele|periscope|macro|depth|ultra|0\.5|tof|mono)/i;

    const dirMatches = cams.filter((d) => {
      const lbl = d.label || '';
      return isBackWanted ? backRe.test(lbl) : frontRe.test(lbl);
    });

    if (dirMatches.length > 0) {
      // Avoid silently picking a telephoto/ultra-wide rear camera when a standard main lens exists
      const mainLens = dirMatches.find((d) => !secondaryLensRe.test(d.label || ''));
      return (mainLens || dirMatches[0]).deviceId;
    }

    const nonSecondary = cams.find((d) => !secondaryLensRe.test(d.label || ''));
    return (nonSecondary || cams[0]).deviceId || null;
  } catch {
    return null;
  }
}

async function startCamera(mode) {
  const constraints = {
    video: buildIdealVideoConstraints({ facingMode: { ideal: mode } }),
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera requires HTTPS and a modern mobile browser (Safari or Chrome).');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      throw new Error('Camera/microphone permission was denied. Enable camera access in browser settings and retry.');
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      throw new Error('No camera found on this device.');
    }
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode }, audio: true });
  }
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) {
    await resetZoomToWide(vTrack);
  }
  return stream;
}

function applyAudioMuteState() {
  if (!localStream) return;
  const muted = userMuted || adminMuted;
  for (const track of localStream.getAudioTracks()) {
    track.enabled = !muted;
  }
  el.micBtn.classList.toggle('is-muted', userMuted);
  el.micBtn.setAttribute('aria-pressed', String(userMuted));
  if (adminMuted) {
    el.micLabel.textContent = 'Host Muted';
  } else {
    el.micLabel.textContent = userMuted ? 'Mic Off' : 'Mic On';
  }
}

el.micBtn.addEventListener('click', () => {
  userMuted = !userMuted;
  applyAudioMuteState();
});

async function switchCameraTrack({ targetMode = null, deviceId = null } = {}) {
  if (!localStream || flippingCamera) return;
  flippingCamera = true;
  el.flipBtn.disabled = true;
  el.stageError.hidden = true;

  const prevMode = facingMode;
  const nextMode = targetMode || (prevMode === 'user' ? 'environment' : 'user');
  const oldVideoTracks = localStream.getVideoTracks();
  const oldDeviceId = oldVideoTracks[0]?.getSettings?.().deviceId || null;
  const audioTracks = localStream.getAudioTracks();

  try {
    // Android Chrome locks the camera hardware until the active video track is stopped
    oldVideoTracks.forEach((t) => {
      try { t.stop(); } catch {}
    });

    let newVideoTrack = null;
    if (deviceId) {
      newVideoTrack = await openVideoTrack(nextMode, deviceId);
    } else {
      try {
        // When flipping to rear, pick standard main rear lens if identifiable
        const preferredBackId = nextMode === 'environment' ? await pickPreferredDeviceId('environment', oldDeviceId) : null;
        newVideoTrack = preferredBackId
          ? await openVideoTrack(nextMode, preferredBackId)
          : await openVideoTrack(nextMode);
      } catch {
        const altId = await pickPreferredDeviceId(nextMode, oldDeviceId);
        if (altId) newVideoTrack = await openVideoTrack(nextMode, altId);
      }
    }

    if (!newVideoTrack) {
      throw new Error('Could not switch to the selected camera on this device.');
    }

    const actualDeviceId = newVideoTrack.getSettings?.().deviceId || null;
    if (!deviceId && oldDeviceId && actualDeviceId === oldDeviceId) {
      const altId = await pickPreferredDeviceId(nextMode, oldDeviceId);
      if (altId) {
        try {
          newVideoTrack.stop();
          newVideoTrack = await openVideoTrack(nextMode, altId);
        } catch {
          newVideoTrack = await openVideoTrack(nextMode);
        }
      }
    }

    const updatedStream = new MediaStream([newVideoTrack, ...audioTracks]);
    for (const entry of peers.values()) {
      for (const sender of entry.pc.getSenders()) {
        if (sender.track && sender.track.kind === 'video') {
          await sender.replaceTrack(newVideoTrack);
        }
      }
      applyVideoSenderParameters(entry.pc, {
        maxBitrate: 2000000,
        degradationPreference: entry.degraded ? 'balanced' : 'maintain-resolution',
      });
    }

    localStream = updatedStream;
    const settings = newVideoTrack.getSettings?.() || {};
    const reportedFacing = (settings.facingMode === 'user' || settings.facingMode === 'environment')
      ? settings.facingMode
      : inferFacingFromLabel(newVideoTrack.label, nextMode);
    facingMode = reportedFacing || nextMode;

    el.previewVideo.srcObject = localStream;
    syncCaptureInfo();
    await el.previewVideo.play().catch(() => {});
    syncCaptureInfo();
    applyAudioMuteState();
    reportAudienceStats();
  } catch (err) {
    try {
      const fallbackTrack = await openVideoTrack(prevMode, oldDeviceId);
      const recovered = new MediaStream([fallbackTrack, ...audioTracks]);
      for (const entry of peers.values()) {
        for (const sender of entry.pc.getSenders()) {
          if (sender.track && sender.track.kind === 'video') {
            await sender.replaceTrack(fallbackTrack);
          }
        }
      }
      localStream = recovered;
      el.previewVideo.srcObject = localStream;
      syncCaptureInfo();
      await el.previewVideo.play().catch(() => {});
    } catch {}
    el.stageError.textContent = err.message || 'Could not switch camera.';
    el.stageError.hidden = false;
  } finally {
    flippingCamera = false;
    el.flipBtn.disabled = false;
  }
}

let flippingCamera = false;
el.flipBtn.addEventListener('click', () => {
  switchCameraTrack({ targetMode: facingMode === 'user' ? 'environment' : 'user' });
});

const onViewportOrVideoChange = () => {
  if (!localStream) return;
  setTimeout(syncCaptureInfo, 80);
};
window.addEventListener('orientationchange', onViewportOrVideoChange);
window.addEventListener('resize', onViewportOrVideoChange);
el.previewVideo.addEventListener('loadedmetadata', syncCaptureInfo);
el.previewVideo.addEventListener('resize', syncCaptureInfo);

async function sendThumbnail() {
  if (!localStream || !sessionToken || !['waiting', 'onair'].includes(currentStatus)) return;
  if (el.previewVideo.videoWidth === 0) return;

  const canvas = document.createElement('canvas');
  const w = 160;
  const h = 120;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, w, h);
  // Fit uncropped using Math.min so admin lobby thumbnail matches full-frame view
  const vw = el.previewVideo.videoWidth;
  const vh = el.previewVideo.videoHeight;
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(el.previewVideo, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const dataUri = canvas.toDataURL('image/jpeg', 0.68);

  try {
    const resp = await fetch('/api/audience/thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: cfg.eventSlug, session_token: sessionToken, image: dataUri }),
    });
    if (resp.status === 404) {
      autoRejoinIfNeeded();
    }
  } catch {
    // Ignore transient thumbnail failure
  }
}

async function autoRejoinIfNeeded() {
  if (rejoining || !localStream || !lastJoinMeta) return;
  rejoining = true;
  try {
    syncCaptureInfo();
    const resp = await fetch('/api/audience/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: cfg.eventSlug,
        consent: true,
        session_token: '',
        facing_mode: facingMode,
        capture_settings: currentCaptureSettings,
      }),
    });
    const data = await resp.json();
    if (resp.ok && data.session_token) {
      sessionToken = data.session_token;
      localStorage.setItem(storageKey, sessionToken);
      if (Array.isArray(data.ice_servers)) iceServers = data.ice_servers;
      closeAllPeers();
      currentStatus = data.status || 'waiting';
      setBanner('waiting', 'Waiting in lobby');
      setTimeout(sendThumbnail, 200);
    } else if (resp.status === 403) {
      localStorage.removeItem(storageKey);
      sessionToken = '';
      teardownMediaAndLoops();
      el.stepStage.hidden = true;
      el.stepEnded.hidden = false;
      el.endedTitle.textContent = 'Session Ended';
      el.endedDesc.textContent = data.error || 'Unable to rejoin this event.';
    }
  } catch {
    // Retry on next poll
  } finally {
    rejoining = false;
  }
}

async function postSignal(targetId, type, payload) {
  await fetch('/api/audience/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: cfg.eventSlug,
      session_token: sessionToken,
      target_id: targetId,
      type,
      payload,
    }),
  });
}

function closePeer(targetId) {
  const entry = peers.get(targetId);
  if (entry) {
    try { entry.pc.close(); } catch {}
    peers.delete(targetId);
  }
}

function closeAllPeers() {
  for (const tid of Array.from(peers.keys())) {
    closePeer(tid);
  }
}

async function ensurePeerForTarget(targetId) {
  if (peers.has(targetId) || !localStream) return;

  const pc = new RTCPeerConnection({ iceServers: sanitizeIceServers(iceServers) });
  const entry = { pc, pendingCandidates: [], degraded: false };
  peers.set(targetId, entry);

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }
  preferVideoCodecs(pc);
  applyVideoSenderParameters(pc, { maxBitrate: 2000000, degradationPreference: 'maintain-resolution' });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      postSignal(targetId, 'candidate', ev.candidate.toJSON()).catch(() => {});
    }
  };

  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'failed' || st === 'disconnected') {
      setTimeout(() => {
        if (peers.get(targetId)?.pc === pc && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
          closePeer(targetId);
          if (activeTargets.includes(targetId)) {
            ensurePeerForTarget(targetId);
          }
        }
      }, 4500);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await postSignal(targetId, 'offer', { type: offer.type, sdp: offer.sdp });
  } catch {
    closePeer(targetId);
  }
}

async function handleIncomingSignal(sig) {
  if (sig.type === 'renegotiate') {
    closePeer(sig.target_id);
    if (activeTargets.includes(sig.target_id)) {
      await ensurePeerForTarget(sig.target_id);
    }
    return;
  }
  const entry = peers.get(sig.target_id);
  if (!entry) return;
  const { pc } = entry;
  try {
    if (sig.type === 'answer' && sig.payload) {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.payload));
      for (const c of entry.pendingCandidates) {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }
      entry.pendingCandidates = [];
      applyVideoSenderParameters(pc, {
        maxBitrate: 2000000,
        degradationPreference: entry.degraded ? 'balanced' : 'maintain-resolution',
      });
    } else if (sig.type === 'candidate' && sig.payload) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(sig.payload));
      } else {
        entry.pendingCandidates.push(sig.payload);
      }
    }
  } catch {
    // Ignore stale signal
  }
}

async function handleServerState(state) {
  currentStatus = state.status;
  adminMuted = !!state.muted_by_admin;
  applyAudioMuteState();

  if (state.status === 'onair') {
    setBanner('onair', `ON AIR — Slot ${state.slot_no || 1}`);
    el.videoWrap.classList.add('is-onair');
    el.onairFrame.hidden = false;
    el.previewNote.textContent = state.blackout
      ? 'Wall is in blackout mode'
      : 'You are live on the venue screen';
  } else if (state.status === 'waiting') {
    setBanner('waiting', state.preview_active ? 'Host is previewing your camera...' : 'Waiting in lobby');
    el.videoWrap.classList.remove('is-onair');
    el.onairFrame.hidden = true;
    el.previewNote.textContent = 'Previewing locally · Full uncropped frame';
  } else if (state.status === 'removed' || state.status === 'banned' || state.status === 'event_closed' || state.status === 'left') {
    teardownMediaAndLoops();
    el.stepStage.hidden = true;
    el.stepEnded.hidden = false;
    if (state.status === 'banned') {
      setBanner('err', 'Removed from event');
      el.endedTitle.textContent = 'Removed by Host';
      el.endedDesc.textContent = 'You have been banned from participating in this event.';
      el.rejoinBtn.hidden = true;
    } else if (state.status === 'removed') {
      setBanner('warn', 'Removed by host');
      el.endedTitle.textContent = 'Removed from Lobby';
      el.endedDesc.textContent = 'The host removed your connection.';
      el.rejoinBtn.hidden = false;
    } else if (state.status === 'event_closed') {
      setBanner('warn', 'Event closed');
      el.endedTitle.textContent = 'Event Ended';
      el.endedDesc.textContent = 'Thank you for participating! This event has closed.';
      el.rejoinBtn.hidden = true;
    }
    return;
  }

  activeTargets = Array.isArray(state.active_targets) ? state.active_targets : [];
  for (const tid of Array.from(peers.keys())) {
    if (!activeTargets.includes(tid)) {
      closePeer(tid);
    }
  }
  for (const tid of activeTargets) {
    await ensurePeerForTarget(tid);
  }
  for (const sig of state.signals || []) {
    await handleIncomingSignal(sig);
  }
}

function teardownMediaAndLoops() {
  if (stopTransport) { stopTransport(); stopTransport = null; }
  if (thumbTimer) { clearInterval(thumbTimer); thumbTimer = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  closeAllPeers();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

async function reportAudienceStats() {
  if (!sessionToken || !localStream) return;
  syncCaptureInfo();
  const obsEntry = peers.get('obs') || peers.values().next().value;
  let st = {
    state: obsEntry ? (obsEntry.pc.iceConnectionState || obsEntry.pc.connectionState || 'new') : 'lobby',
    width: currentCaptureSettings.width || 0,
    height: currentCaptureSettings.height || 0,
    fps: currentCaptureSettings.frameRate || 0,
    bitrate: 0,
    packet_loss: 0,
    rtt: 0,
    relay_type: 'unknown',
  };
  if (obsEntry) {
    st = await collectPeerStats(obsEntry.pc, prevBytesMap, 'aud');
    const isDegraded = st.packet_loss > 5 || st.rtt > 350;
    if (isDegraded !== obsEntry.degraded) {
      obsEntry.degraded = isDegraded;
      applyVideoSenderParameters(obsEntry.pc, {
        maxBitrate: isDegraded ? 1200000 : 2000000,
        degradationPreference: isDegraded ? 'balanced' : 'maintain-resolution',
      });
    }
  }
  try {
    await fetch('/api/audience/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: cfg.eventSlug,
        session_token: sessionToken,
        facing_mode: facingMode,
        capture_settings: currentCaptureSettings,
        ...st,
      }),
    });
  } catch {
    // ignore
  }
}

el.joinForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  el.joinError.hidden = true;
  el.startBtn.disabled = true;
  el.startBtn.textContent = 'Starting camera...';

  try {
    localStream = await startCamera(facingMode);
    el.previewVideo.srcObject = localStream;
    syncCaptureInfo();
    await el.previewVideo.play().catch(() => {});
    syncCaptureInfo();
    await acquireWakeLock();

    lastJoinMeta = { consent: Boolean(el.consentInput.checked) };
    const resp = await fetch('/api/audience/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: cfg.eventSlug,
        consent: el.consentInput.checked,
        session_token: sessionToken,
        facing_mode: facingMode,
        capture_settings: currentCaptureSettings,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || 'Could not join event.');
    }

    sessionToken = data.session_token;
    localStorage.setItem(storageKey, sessionToken);
    if (Array.isArray(data.ice_servers)) iceServers = data.ice_servers;

    el.stepJoin.hidden = true;
    el.stepEnded.hidden = true;
    el.stepStage.hidden = false;
    setBanner('waiting', 'Waiting in lobby');
    applyAudioMuteState();
    syncCaptureInfo();

    el.previewVideo.addEventListener('loadeddata', () => { syncCaptureInfo(); sendThumbnail(); }, { once: true });
    setTimeout(() => { syncCaptureInfo(); sendThumbnail(); }, 400);
    thumbTimer = setInterval(sendThumbnail, cfg.thumbIntervalMs || 3000);
    statsTimer = setInterval(reportAudienceStats, 4000);

    stopTransport = startAdaptiveTransport({
      mode: cfg.signalingMode,
      sseUrlFn: () => `/api/audience/stream?slug=${encodeURIComponent(cfg.eventSlug)}&token=${encodeURIComponent(sessionToken)}`,
      pollUrlFn: () => `/api/audience/poll?slug=${encodeURIComponent(cfg.eventSlug)}&token=${encodeURIComponent(sessionToken)}&_=${Date.now()}`,
      onState: handleServerState,
      onError: (err) => {
        if (err && err.status === 404) {
          autoRejoinIfNeeded();
        } else {
          setBanner('warn', 'Connection lost — reconnecting...');
        }
      },
      getIntervalMs: () => (activeTargets.length > 0 ? (cfg.pollFastMs || 700) : (cfg.pollIdleMs || 2000)),
    });
  } catch (err) {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    showJoinError(err.message || 'Failed to start.');
  } finally {
    el.startBtn.disabled = false;
    el.startBtn.textContent = 'Start Camera & Join';
  }
});

async function leaveStream() {
  if (sessionToken) {
    try {
      await fetch('/api/audience/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: cfg.eventSlug, session_token: sessionToken }),
      });
    } catch {}
  }
  teardownMediaAndLoops();
  el.stepStage.hidden = true;
  el.stepEnded.hidden = false;
  el.endedTitle.textContent = 'You Left the Wall';
  el.endedDesc.textContent = 'Your camera and microphone are turned off.';
  el.rejoinBtn.hidden = false;
  setBanner('warn', 'Disconnected');
}

el.leaveBtn.addEventListener('click', leaveStream);
el.rejoinBtn.addEventListener('click', () => {
  el.stepEnded.hidden = true;
  el.stepJoin.hidden = false;
  el.statusBanner.hidden = true;
});

window.addEventListener('pagehide', () => {
  if (sessionToken && ['waiting', 'onair'].includes(currentStatus)) {
    const blob = new Blob([JSON.stringify({ slug: cfg.eventSlug, session_token: sessionToken })], { type: 'application/json' });
    navigator.sendBeacon('/api/audience/leave', blob);
  }
});
