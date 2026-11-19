import { encodeQR, decodeQRFromImageData } from './qr-engine.js?v=20261119';

export function hexLuminance(hex) {
  const clean = (hex || '#000000').replace('#', '');
  if (clean.length !== 6) return 0;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fgHex, bgHex) {
  const l1 = hexLuminance(fgHex);
  const l2 = hexLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function checkQrSafety({ hasLogo, scalePct, paddingPx, fg, bg }) {
  const warnings = [];
  let blocked = false;

  const fgLum = hexLuminance(fg);
  const bgLum = hexLuminance(bg);
  const ratio = contrastRatio(fg, bg);

  if (fgLum >= bgLum) {
    warnings.push('QR modules must be darker than the background.');
    blocked = true;
  } else if (ratio < 4.5) {
    warnings.push(`Low contrast (${ratio.toFixed(1)}:1). Minimum 4.5:1 required for venue scanning.`);
    blocked = true;
  }

  if (hasLogo) {
    // Logo area % of module grid including padding
    const effectiveScale = Math.min(22, Math.max(10, Number(scalePct || 18)));
    const padFactor = 1 + (Number(paddingPx || 8) / 140);
    const areaPct = Math.pow((effectiveScale / 100) * padFactor, 2) * 100;
    if (effectiveScale > 20 || areaPct > 5.5) {
      // Note: 20% width = 4% area, 22% width with heavy padding can exceed safe bounds on small versions
      if (effectiveScale >= 21) {
        warnings.push('Logo width above 20% reduces error-correction margin. Test scan before going live.');
      }
    }
  }

  return { warnings, blocked, ratio };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function renderBrandedQR(canvas, opts) {
  const size = opts.size || 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const ecl = opts.logoUrl ? 'H' : 'M';
  const qr = encodeQR(opts.text, ecl);
  const quietModules = 4; // Mandatory >= 4 module quiet zone
  const totalModules = qr.size + quietModules * 2;
  const modSize = size / totalModules;

  const bg = opts.bg || '#ffffff';
  const fg = opts.fg || '#000000';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = fg;
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c] === 1) {
        const x = Math.floor((c + quietModules) * modSize);
        const y = Math.floor((r + quietModules) * modSize);
        const w = Math.ceil((c + 1 + quietModules) * modSize) - x;
        const h = Math.ceil((r + 1 + quietModules) * modSize) - y;
        ctx.fillRect(x, y, w, h);
      }
    }
  }

  if (opts.logoUrl) {
    try {
      const img = await loadImage(opts.logoUrl);
      const qrInnerPx = qr.size * modSize;
      // Clamp logo width to 10%..22% of QR module width (~<= 20% area coverage safely)
      const scaleFrac = Math.min(0.22, Math.max(0.10, Number(opts.scalePct || 18) / 100));
      const boxSize = Math.round(qrInnerPx * scaleFrac);
      const pad = Math.round((Number(opts.paddingPx ?? 8) / 512) * size);
      const outerSize = boxSize + pad * 2;
      const cx = size / 2;
      const cy = size / 2;
      const x0 = Math.round(cx - outerSize / 2);
      const y0 = Math.round(cy - outerSize / 2);
      const isCircle = opts.shape === 'circle';
      const logoBg = opts.logoBg || '#ffffff';

      ctx.save();
      if (isCircle) {
        ctx.beginPath();
        ctx.arc(cx, cy, outerSize / 2, 0, Math.PI * 2);
        ctx.clip();
      } else {
        const rad = Math.max(4, Math.round(outerSize * 0.1));
        ctx.beginPath();
        ctx.roundRect(x0, y0, outerSize, outerSize, rad);
        ctx.clip();
      }

      if (logoBg !== 'transparent') {
        ctx.fillStyle = logoBg;
        ctx.fillRect(x0, y0, outerSize, outerSize);
      } else {
        ctx.fillStyle = bg;
        ctx.fillRect(x0, y0, outerSize, outerSize);
      }

      const ix = Math.round(cx - boxSize / 2);
      const iy = Math.round(cy - boxSize / 2);
      const natW = img.naturalWidth || boxSize;
      const natH = img.naturalHeight || boxSize;
      const fit = opts.fit === 'cover' ? 'cover' : 'contain';

      if (fit === 'cover') {
        const sc = Math.max(boxSize / natW, boxSize / natH);
        const dw = natW * sc;
        const dh = natH * sc;
        ctx.save();
        ctx.beginPath();
        if (isCircle) ctx.arc(cx, cy, boxSize / 2, 0, Math.PI * 2);
        else ctx.rect(ix, iy, boxSize, boxSize);
        ctx.clip();
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        ctx.restore();
      } else {
        const sc = Math.min(boxSize / natW, boxSize / natH);
        const dw = natW * sc;
        const dh = natH * sc;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      }
      ctx.restore();
    } catch {
      // Keep clean QR if logo fails to load
    }
  }
}

export function testScanCanvas(canvas, expectedText) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = decodeQRFromImageData(imgData);
  if (!decoded) {
    return { scannable: false, decoded: null, reason: 'Decoder could not read the QR pattern. Reduce logo size or increase contrast.' };
  }
  if (expectedText && decoded !== expectedText) {
    return { scannable: false, decoded, reason: 'Decoded payload mismatch.' };
  }
  return { scannable: true, decoded, reason: 'Verified scannable with Error Correction H.' };
}

export async function renderBrandedQRSvg(opts) {
  const size = opts.size || 1024;
  const ecl = opts.logoUrl ? 'H' : 'M';
  const qr = encodeQR(opts.text, ecl);
  const quiet = 4;
  const total = qr.size + quiet * 2;
  const mod = size / total;
  const bg = opts.bg || '#ffffff';
  const fg = opts.fg || '#000000';

  let rects = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c] === 1) {
        const x = ((c + quiet) * mod).toFixed(2);
        const y = ((r + quiet) * mod).toFixed(2);
        const w = (mod + 0.05).toFixed(2);
        rects += `<rect x="${x}" y="${y}" width="${w}" height="${w}"/>`;
      }
    }
  }

  let logoLayer = '';
  if (opts.logoUrl) {
    const scaleFrac = Math.min(0.22, Math.max(0.10, Number(opts.scalePct || 18) / 100));
    const qrInnerPx = qr.size * mod;
    const boxSize = Math.round(qrInnerPx * scaleFrac);
    const pad = Math.round((Number(opts.paddingPx ?? 8) / 512) * size);
    const outerSize = boxSize + pad * 2;
    const cx = size / 2;
    const cy = size / 2;
    const x0 = Math.round(cx - outerSize / 2);
    const y0 = Math.round(cy - outerSize / 2);
    const ix = Math.round(cx - boxSize / 2);
    const iy = Math.round(cy - boxSize / 2);
    const isCircle = opts.shape === 'circle';
    const fillBg = opts.logoBg === 'transparent' ? bg : (opts.logoBg || '#ffffff');

    // Embed logo raster/svg as base64 data URI so downloaded SVG is 100% standalone
    let dataUri = '';
    try {
      const resp = await fetch(opts.logoUrl);
      const blob = await resp.blob();
      dataUri = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
    } catch {
      dataUri = '';
    }

    const clipShape = isCircle
      ? `<circle cx="${cx}" cy="${cy}" r="${(boxSize / 2).toFixed(1)}"/>`
      : `<rect x="${ix}" y="${iy}" width="${boxSize}" height="${boxSize}" rx="${Math.max(4, Math.round(boxSize * 0.08))}"/>`;
    const bgShape = isCircle
      ? `<circle cx="${cx}" cy="${cy}" r="${(outerSize / 2).toFixed(1)}" fill="${fillBg}"/>`
      : `<rect x="${x0}" y="${y0}" width="${outerSize}" height="${outerSize}" rx="${Math.max(4, Math.round(outerSize * 0.1))}" fill="${fillBg}"/>`;
    const preserve = opts.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';

    logoLayer = `<defs><clipPath id="qrLogoClip">${clipShape}</clipPath></defs>${bgShape}` +
      (dataUri ? `<image href="${dataUri}" x="${ix}" y="${iy}" width="${boxSize}" height="${boxSize}" preserveAspectRatio="${preserve}" clip-path="url(#qrLogoClip)"/>` : '');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g fill="${fg}">${rects}</g>
  ${logoLayer}
</svg>`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
