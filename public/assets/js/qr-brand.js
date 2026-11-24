import { encodeQR, decodeQRFromImageData } from './qr-engine.js?v=20261124';

// Maximum odd-module center cutout per QR Version (1..16) at ECC H that leaves
// >= 2 codewords of extra per-block RS margin even with a +1 module camera-blur ring.
const SAFE_CUTOUT_MODULES = [
  0, 3, 5, 7, 9, 9, 11, 11, 13, 13, 15, 15, 17, 17, 19, 19, 21,
];

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
    const effectiveScale = Math.min(22, Math.max(10, Number(scalePct || 18)));
    const padFactor = 1 + (Number(paddingPx || 8) / 140);
    const areaPct = Math.pow((effectiveScale / 100) * padFactor, 2) * 100;
    if (effectiveScale >= 21 || areaPct > 5.5) {
      warnings.push('Large logo or heavy padding is auto-clamped to safe ECC-H module bounds for reliable phone scanning.');
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

function computeLogoGeometry(qr, modSize, qrInnerOrigin, qrDrawSize, opts) {
  const qrInnerSize = qr.size * modSize;
  const maxSafeMod = SAFE_CUTOUT_MODULES[qr.version] || Math.max(3, Math.floor(qr.size * 0.24) | 1);
  const scaleFrac = Math.min(0.22, Math.max(0.10, Number(opts.scalePct || 18) / 100));
  const reqLogoPx = qrInnerSize * scaleFrac;
  const reqPadPx = Math.max(0, (Number(opts.paddingPx ?? 8) / 512) * qrDrawSize);
  const reqOuterPx = reqLogoPx + reqPadPx * 2;

  let cutoutModules = Math.round(reqOuterPx / modSize);
  if (cutoutModules % 2 === 0) cutoutModules += 1;
  cutoutModules = Math.max(3, Math.min(maxSafeMod, cutoutModules));

  // Odd cutout centered in odd qr.size lands on exact integer module indices
  const startMod = (qr.size - cutoutModules) / 2;
  const clearX = qrInnerOrigin + startMod * modSize;
  const clearY = qrInnerOrigin + startMod * modSize;
  const clearSize = cutoutModules * modSize;

  const bg = opts.bg || '#ffffff';
  const logoBg = opts.logoBg || '#ffffff';
  const isDarkBadge = logoBg !== 'transparent' && hexLuminance(logoBg) < hexLuminance(bg) * 0.7;
  const badgeInset = isDarkBadge ? Math.max(2, Math.round(modSize * 0.28)) : 0;

  const outerSize = Math.max(4, clearSize - badgeInset * 2);
  const maxPad = Math.floor(outerSize * 0.28);
  const pad = Math.min(Math.round(reqPadPx), maxPad);
  const boxSize = Math.max(4, outerSize - pad * 2);

  const cx = clearX + clearSize / 2;
  const cy = clearY + clearSize / 2;
  const x0 = cx - outerSize / 2;
  const y0 = cy - outerSize / 2;
  const ix = cx - boxSize / 2;
  const iy = cy - boxSize / 2;

  return { clearX, clearY, clearSize, outerSize, boxSize, cx, cy, x0, y0, ix, iy };
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
  // Exact integer module pitch prevents subpixel module overlap/fattening on TVs & OBS
  const modPx = Math.max(2, Math.floor(size / totalModules));
  const qrDrawSize = modPx * totalModules;
  const originOffset = Math.floor((size - qrDrawSize) / 2);
  const qrInnerOrigin = originOffset + quietModules * modPx;

  const bg = opts.bg || '#ffffff';
  const fg = opts.fg || '#000000';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = fg;
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c] === 1) {
        const x = qrInnerOrigin + c * modPx;
        const y = qrInnerOrigin + r * modPx;
        ctx.fillRect(x, y, modPx, modPx);
      }
    }
  }

  if (opts.logoUrl) {
    try {
      const img = await loadImage(opts.logoUrl);
      const g = computeLogoGeometry(qr, modPx, qrInnerOrigin, qrDrawSize, opts);
      const isCircle = opts.shape === 'circle';
      const logoBg = opts.logoBg || '#ffffff';

      // Clear exact module-aligned area with QR background so no half-modules sit on the border
      ctx.fillStyle = bg;
      ctx.fillRect(g.clearX, g.clearY, g.clearSize, g.clearSize);

      ctx.save();
      if (isCircle) {
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.outerSize / 2, 0, Math.PI * 2);
        ctx.clip();
      } else {
        const rad = Math.max(4, Math.round(g.outerSize * 0.1));
        ctx.beginPath();
        ctx.roundRect(g.x0, g.y0, g.outerSize, g.outerSize, rad);
        ctx.clip();
      }

      if (logoBg !== 'transparent') {
        ctx.fillStyle = logoBg;
        ctx.fillRect(g.x0, g.y0, g.outerSize, g.outerSize);
      } else {
        ctx.fillStyle = bg;
        ctx.fillRect(g.x0, g.y0, g.outerSize, g.outerSize);
      }

      const natW = img.naturalWidth || g.boxSize;
      const natH = img.naturalHeight || g.boxSize;
      const fit = opts.fit === 'cover' ? 'cover' : 'contain';

      if (fit === 'cover') {
        const sc = Math.max(g.boxSize / natW, g.boxSize / natH);
        const dw = natW * sc;
        const dh = natH * sc;
        ctx.save();
        ctx.beginPath();
        if (isCircle) ctx.arc(g.cx, g.cy, g.boxSize / 2, 0, Math.PI * 2);
        else ctx.rect(g.ix, g.iy, g.boxSize, g.boxSize);
        ctx.clip();
        ctx.drawImage(img, g.cx - dw / 2, g.cy - dh / 2, dw, dh);
        ctx.restore();
      } else {
        const sc = Math.min(g.boxSize / natW, g.boxSize / natH);
        const dw = natW * sc;
        const dh = natH * sc;
        ctx.drawImage(img, g.cx - dw / 2, g.cy - dh / 2, dw, dh);
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
    const g = computeLogoGeometry(qr, mod, quiet * mod, size, opts);
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

    const clearRect = `<rect x="${g.clearX.toFixed(2)}" y="${g.clearY.toFixed(2)}" width="${g.clearSize.toFixed(2)}" height="${g.clearSize.toFixed(2)}" fill="${bg}"/>`;
    const clipShape = isCircle
      ? `<circle cx="${g.cx.toFixed(2)}" cy="${g.cy.toFixed(2)}" r="${(g.boxSize / 2).toFixed(2)}"/>`
      : `<rect x="${g.ix.toFixed(2)}" y="${g.iy.toFixed(2)}" width="${g.boxSize.toFixed(2)}" height="${g.boxSize.toFixed(2)}" rx="${Math.max(4, Math.round(g.boxSize * 0.08))}"/>`;
    const bgShape = isCircle
      ? `<circle cx="${g.cx.toFixed(2)}" cy="${g.cy.toFixed(2)}" r="${(g.outerSize / 2).toFixed(2)}" fill="${fillBg}"/>`
      : `<rect x="${g.x0.toFixed(2)}" y="${g.y0.toFixed(2)}" width="${g.outerSize.toFixed(2)}" height="${g.outerSize.toFixed(2)}" rx="${Math.max(4, Math.round(g.outerSize * 0.1))}" fill="${fillBg}"/>`;
    const preserve = opts.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';

    logoLayer = `${clearRect}<defs><clipPath id="qrLogoClip">${clipShape}</clipPath></defs>${bgShape}` +
      (dataUri ? `<image href="${dataUri}" x="${g.ix.toFixed(2)}" y="${g.iy.toFixed(2)}" width="${g.boxSize.toFixed(2)}" height="${g.boxSize.toFixed(2)}" preserveAspectRatio="${preserve}" clip-path="url(#qrLogoClip)"/>` : '');
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
