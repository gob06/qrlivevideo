import { computeVideoFrameMetrics } from './webrtc-common.js';

export function normalizeFitMode(raw, fallback = 'fit') {
  const v = String(raw || '').toLowerCase();
  if (v === 'fit' || v === 'fill' || v === 'stretch') return v;
  return fallback;
}

export function normalizeTileBg(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'blur' || v === 'solid' || v === 'transparent') return v;
  return 'blur';
}

export function createWallTile({ onMetricsChange } = {}) {
  const root = document.createElement('div');
  root.className = 'wall-tile bg-blur fit-fit';

  const bgVideo = document.createElement('video');
  bgVideo.className = 'wall-tile-bg-video';
  bgVideo.autoplay = true;
  bgVideo.playsInline = true;
  bgVideo.setAttribute('playsinline', '');
  bgVideo.setAttribute('webkit-playsinline', '');
  bgVideo.muted = true;
  bgVideo.setAttribute('aria-hidden', 'true');

  const video = document.createElement('video');
  video.className = 'wall-tile-video';
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true; // Starts muted for zero-gesture autoplay; caller adjusts per audio policy

  const connEl = document.createElement('div');
  connEl.className = 'wall-tile-connecting';
  connEl.textContent = 'Connecting camera...';

  const lowerEl = document.createElement('div');
  lowerEl.className = 'wall-lower-third';
  const nameEl = document.createElement('div');
  nameEl.className = 'wall-lower-name';
  const msgEl = document.createElement('div');
  msgEl.className = 'wall-lower-msg';
  lowerEl.appendChild(nameEl);
  lowerEl.appendChild(msgEl);

  const frameOverlay = document.createElement('div');
  frameOverlay.className = 'wall-frame-overlay';
  frameOverlay.hidden = true;
  const frameBox = document.createElement('div');
  frameBox.className = 'wall-frame-box';
  frameBox.innerHTML = '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>';
  const frameReadout = document.createElement('div');
  frameReadout.className = 'wall-frame-readout';
  frameOverlay.appendChild(frameBox);
  frameOverlay.appendChild(frameReadout);

  root.appendChild(bgVideo);
  root.appendChild(video);
  root.appendChild(connEl);
  root.appendChild(lowerEl);
  root.appendChild(frameOverlay);

  const state = {
    root,
    bgVideo,
    video,
    nameEl,
    msgEl,
    lowerEl,
    connEl,
    frameOverlay,
    frameBox,
    frameReadout,
    fitMode: 'fit',
    tileBg: 'blur',
    tileBgColor: '#090d16',
    mirrored: false,
    frameCheck: false,
    captureInfo: null,
  };

  function syncOverlayMetrics() {
    if (state.destroyed) return null;
    const metrics = computeVideoFrameMetrics(video, root, state.fitMode);
    if (state.frameCheck) {
      frameOverlay.hidden = false;
      frameBox.style.left = `${metrics.boxLeft}px`;
      frameBox.style.top = `${metrics.boxTop}px`;
      frameBox.style.width = `${metrics.boxWidth}px`;
      frameBox.style.height = `${metrics.boxHeight}px`;
      frameBox.classList.toggle('is-cropped', metrics.croppedPct > 0.5);

      const cap = state.captureInfo || {};
      const zoomStr = typeof cap.zoom === 'number' ? `${cap.zoom.toFixed(2).replace(/\.?0+$/, '')}x` : '—';
      const fitLabel = state.fitMode === 'fit' ? 'Fit (no crop)' : state.fitMode === 'fill' ? 'Fill (crops)' : 'Stretch';
      const visStr = metrics.croppedPct > 0.5
        ? `Visible ${metrics.visiblePct}% · Cropped ${metrics.croppedPct}%`
        : `Visible ${metrics.visiblePct}%`;
      const capRes = cap.width && cap.height ? `${cap.width}×${cap.height}` : (metrics.videoWidth ? `${metrics.videoWidth}×${metrics.videoHeight}` : '—');
      const streamRes = metrics.videoWidth ? `${metrics.videoWidth}×${metrics.videoHeight}` : '—';
      frameReadout.textContent =
        `Cap ${capRes} · Stream ${streamRes} · AR ${metrics.aspectLabel} · Zoom ${zoomStr} · ${fitLabel} · Tile ${metrics.tileWidth}×${metrics.tileHeight} · ${visStr}`;
    } else {
      frameOverlay.hidden = true;
    }
    if (onMetricsChange && root.isConnected) onMetricsChange(metrics, state);
    return metrics;
  }

  video.addEventListener('loadedmetadata', syncOverlayMetrics);
  video.addEventListener('resize', syncOverlayMetrics);
  video.addEventListener('loadeddata', () => {
    connEl.hidden = true;
    syncOverlayMetrics();
  });
  video.addEventListener('playing', () => {
    connEl.hidden = true;
    syncOverlayMetrics();
  });

  state.destroyed = false;
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (state.destroyed || !root.isConnected) return;
      syncOverlayMetrics();
    });
    ro.observe(root);
  }

  state.syncOverlayMetrics = syncOverlayMetrics;
  state.destroy = () => {
    state.destroyed = true;
    if (ro) {
      ro.disconnect();
      ro = null;
    }
  };
  return state;
}

export function updateWallTileAppearance(tile, opts = {}) {
  const fitMode = normalizeFitMode(opts.fitMode, 'fit');
  const tileBg = normalizeTileBg(opts.tileBg);
  const tileBgColor = String(opts.tileBgColor || '#090d16');
  const mirrored = Boolean(opts.mirrored);

  tile.fitMode = fitMode;
  tile.tileBg = tileBg;
  tile.tileBgColor = tileBgColor;
  tile.mirrored = mirrored;
  if (opts.frameCheck !== undefined) {
    tile.frameCheck = Boolean(opts.frameCheck);
  }
  if (opts.captureInfo !== undefined) {
    tile.captureInfo = opts.captureInfo;
  }

  tile.root.classList.remove('fit-fit', 'fit-fill', 'fit-stretch', 'bg-blur', 'bg-solid', 'bg-transparent');
  tile.root.classList.add(`fit-${fitMode}`, `bg-${tileBg}`);
  tile.root.style.backgroundColor = tileBg === 'solid' ? tileBgColor : (tileBg === 'transparent' ? 'transparent' : '#090d16');

  tile.video.classList.toggle('is-mirrored', mirrored);
  tile.bgVideo.classList.toggle('is-mirrored', mirrored);

  const showBlurBg = tileBg === 'blur' && fitMode === 'fit';
  tile.bgVideo.hidden = !showBlurBg;
  if (!showBlurBg && tile.bgVideo.srcObject) {
    tile.bgVideo.srcObject = null;
  } else if (showBlurBg && tile.video.srcObject && tile.bgVideo.srcObject !== tile.video.srcObject) {
    tile.bgVideo.srcObject = tile.video.srcObject;
    tile.bgVideo.play().catch(() => {});
  }

  tile.syncOverlayMetrics();
}

export function attachStreamToWallTile(tile, stream) {
  if (tile.video.srcObject !== stream) {
    tile.video.srcObject = stream;
  }
  const showBlurBg = tile.tileBg === 'blur' && tile.fitMode === 'fit';
  if (showBlurBg) {
    if (tile.bgVideo.srcObject !== stream) {
      tile.bgVideo.srcObject = stream;
    }
    tile.bgVideo.play().catch(() => {});
  } else if (tile.bgVideo.srcObject) {
    tile.bgVideo.srcObject = null;
  }
  if (stream && tile.video.readyState >= 2) {
    tile.connEl.hidden = true;
  }
  tile.syncOverlayMetrics();
}
