import { renderBrandedQR, renderBrandedQRSvg, downloadBlob } from './qr-brand.js';

const cfg = JSON.parse(document.getElementById('app-config').textContent);
const canvas = document.getElementById('print-qr-canvas');

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

const joinUrl = resolvePublicUrl(cfg.joinUrl);
const urlEl = document.getElementById('print-join-url');
if (urlEl) urlEl.textContent = joinUrl;

const opts = {
  text: joinUrl,
  logoUrl: cfg.logoUrl,
  shape: cfg.qrLogoShape,
  fit: cfg.qrLogoFit,
  scalePct: cfg.qrLogoScale,
  paddingPx: cfg.qrLogoPadding,
  logoBg: cfg.qrLogoBg,
  fg: cfg.qrFg,
  bg: cfg.qrBg,
  size: 1024,
};

await renderBrandedQR(canvas, opts);

document.getElementById('print-btn').addEventListener('click', () => window.print());
document.getElementById('dl-png-btn').addEventListener('click', () => {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, 'qr-poster.png');
  }, 'image/png');
});
document.getElementById('dl-svg-btn').addEventListener('click', async () => {
  const svg = await renderBrandedQRSvg(opts);
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'qr-poster.svg');
});
