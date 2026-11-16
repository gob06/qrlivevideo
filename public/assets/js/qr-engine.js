/**
 * Self-contained ISO/IEC 18004 QR Code Encoder & Reed-Solomon Image Decoder (Versions 1..16).
 * Zero external CDN dependencies.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error('GF division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

function rsGeneratorPoly(ecCount) {
  let g = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(g.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], factor);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const RS_TABLE = {
  L: [
    null,
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0],
    [24, 2, 92, 2, 93],
    [26, 4, 107, 0, 0],
    [30, 3, 115, 1, 116],
    [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99],
  ],
  M: [
    null,
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51],
    [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38],
    [24, 4, 40, 5, 41],
    [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46],
  ],
  Q: [
    null,
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
    [28, 4, 22, 4, 23],
    [26, 4, 20, 6, 21],
    [24, 8, 20, 4, 21],
    [20, 11, 16, 5, 17],
    [30, 5, 24, 7, 25],
    [24, 15, 19, 2, 20],
  ],
  H: [
    null,
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
    [24, 3, 12, 8, 13],
    [28, 7, 14, 4, 15],
    [22, 12, 11, 4, 12],
    [24, 11, 12, 5, 13],
    [24, 11, 12, 7, 13],
    [30, 3, 15, 13, 16],
  ],
};

const ALIGN_POS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
];

const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const BITS_TO_ECL = ['M', 'L', 'H', 'Q'];

function bchDigit(data) {
  let d = 0;
  while (data !== 0) {
    d++;
    data >>>= 1;
  }
  return d;
}

function encodeFormatInfo(ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let d = data << 10;
  const g = 0x537;
  while (bchDigit(d) - bchDigit(g) >= 0) {
    d ^= g << (bchDigit(d) - bchDigit(g));
  }
  return ((data << 10) | d) ^ 0x5412;
}

function encodeVersionInfo(version) {
  let d = version << 12;
  const g = 0x1f25;
  while (bchDigit(d) - bchDigit(g) >= 0) {
    d ^= g << (bchDigit(d) - bchDigit(g));
  }
  return (version << 12) | d;
}

function maskFn(pattern, r, c) {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function buildFunctionGrid(version) {
  const n = version * 4 + 17;
  const modules = Array.from({ length: n }, () => new Int8Array(n).fill(-1)); // -1 unset, 0 light, 1 dark
  const isFunc = Array.from({ length: n }, () => new Uint8Array(n));

  function setFunc(r, c, dark) {
    if (r >= 0 && r < n && c >= 0 && c < n) {
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    }
  }

  function placeFinder(row, col) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inBox && (onOuter || inInner));
      }
    }
  }

  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const pos = ALIGN_POS[version] || [];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const r0 = pos[i];
      const c0 = pos[j];
      if (isFunc[r0][c0]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setFunc(r0 + dr, c0 + dc, dark);
        }
      }
    }
  }

  // Reserve format info
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    isFunc[8][n - 1 - i] = 1;
    if (i < 7) isFunc[n - 1 - i][8] = 1;
  }
  setFunc(n - 8, 8, true); // Dark module

  // Reserve & write version info if v >= 7
  if (version >= 7) {
    const vBits = encodeVersionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + n - 11;
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  return { n, modules, isFunc };
}

function writeFormatToGrid(modules, n, ecl, mask) {
  const f = encodeFormatInfo(ecl, mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((f >>> i) & 1) === 1 ? 1 : 0;
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[n - 15 + i][8] = bit;

    if (i < 8) modules[8][n - 1 - i] = bit;
    else if (i < 9) modules[8][7] = bit;
    else modules[8][14 - i] = bit;
  }
}

function penaltyScore(modules, n) {
  let score = 0;
  // Rule 1: adjacent same-color modules in row/col
  for (let r = 0; r < n; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < n; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < n; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n - 11; c++) {
      let m1 = true, m2 = true, m3 = true, m4 = true;
      for (let k = 0; k < 11; k++) {
        if (modules[r][c + k] !== p1[k]) m1 = false;
        if (modules[r][c + k] !== p2[k]) m2 = false;
        if (modules[c + k][r] !== p1[k]) m3 = false;
        if (modules[c + k][r] !== p2[k]) m4 = false;
      }
      if (m1 || m2) score += 40;
      if (m3 || m4) score += 40;
    }
  }
  // Rule 4: dark ratio
  let dark = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (modules[r][c] === 1) dark++;
  }
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function encodeQR(text, ecl = 'H') {
  const bytes = new TextEncoder().encode(text);
  const table = RS_TABLE[ecl] || RS_TABLE.H;
  let version = 0;
  for (let v = 1; v <= 16; v++) {
    const [, g1b, g1d, g2b, g2d] = table[v];
    const totalDataBytes = g1b * g1d + g2b * g2d;
    const headerBits = 4 + (v >= 10 ? 16 : 8);
    const availDataBytes = Math.floor((totalDataBytes * 8 - headerBits) / 8);
    if (bytes.length <= availDataBytes) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error('URL exceeds Version 16 QR capacity.');
  }

  const [ecPerBlock, g1b, g1d, g2b, g2d] = table[version];
  const totalDataBytes = g1b * g1d + g2b * g2d;

  // Build bit buffer
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataBytes * 8;
  const term = Math.min(4, maxBits - bits.length);
  pushBits(0, term);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(totalDataBytes);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    dataBytes[i] = v;
  }
  const padBytes = [0xec, 0x11];
  let pi = 0;
  for (let i = bits.length / 8; i < totalDataBytes; i++) {
    dataBytes[i] = padBytes[pi % 2];
    pi++;
  }

  // Split into RS blocks
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1b; i++) {
    const blk = dataBytes.slice(offset, offset + g1d);
    offset += g1d;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecPerBlock));
  }
  for (let i = 0; i < g2b; i++) {
    const blk = dataBytes.slice(offset, offset + g2d);
    offset += g2d;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecPerBlock));
  }

  // Interleave codewords
  const codewords = [];
  const maxD = Math.max(g1d, g2d);
  for (let i = 0; i < maxD; i++) {
    for (const blk of dataBlocks) if (i < blk.length) codewords.push(blk[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of ecBlocks) codewords.push(blk[i]);
  }

  // Place modules and pick best mask
  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = null;

  for (let m = 0; m < 8; m++) {
    const { n, modules, isFunc } = buildFunctionGrid(version);
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let dirUp = true;
    for (let col = n - 1; col >= 1; col -= 2) {
      if (col === 6) col = 5;
      for (let i = 0; i < n; i++) {
        const row = dirUp ? n - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (isFunc[row][c]) continue;
          let dark = false;
          if (bitIdx < totalBits) {
            const cw = codewords[bitIdx >> 3];
            dark = ((cw >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          if (maskFn(m, row, c)) dark = !dark;
          modules[row][c] = dark ? 1 : 0;
        }
      }
      dirUp = !dirUp;
    }
    writeFormatToGrid(modules, n, ecl, m);
    const s = penaltyScore(modules, n);
    if (s < bestScore) {
      bestScore = s;
      bestMask = m;
      bestModules = modules;
    }
  }

  return {
    version,
    ecl,
    mask: bestMask,
    size: version * 4 + 17,
    modules: bestModules,
  };
}

// ---------------- IN-BROWSER QR DECODER ("TEST SCAN" HELPER) ----------------

function decodeFormatBits(raw15) {
  let bestDist = 16;
  let bestFmt = -1;
  for (let eclCode = 0; eclCode < 4; eclCode++) {
    for (let mask = 0; mask < 8; mask++) {
      const data = (eclCode << 3) | mask;
      let d = data << 10;
      const g = 0x537;
      while (bchDigit(d) - bchDigit(g) >= 0) {
        d ^= g << (bchDigit(d) - bchDigit(g));
      }
      const encoded = ((data << 10) | d) ^ 0x5412;
      let diff = raw15 ^ encoded;
      let dist = 0;
      while (diff) {
        dist += diff & 1;
        diff >>>= 1;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestFmt = data;
      }
    }
  }
  if (bestDist > 3 || bestFmt < 0) return null;
  return {
    ecl: BITS_TO_ECL[bestFmt >>> 3],
    mask: bestFmt & 7,
  };
}

function rsDecodeBlock(received, ecCount) {
  const n = received.length;
  // Compute syndromes S_0 .. S_{ecCount-1} at alpha^i
  const syn = new Uint8Array(ecCount);
  let hasError = false;
  for (let i = 0; i < ecCount; i++) {
    let val = 0;
    const x = GF_EXP[i];
    for (let j = 0; j < n; j++) {
      val = gfMul(val, x) ^ received[j];
    }
    syn[i] = val;
    if (val !== 0) hasError = true;
  }
  if (!hasError) return received.slice(0, n - ecCount);

  // Berlekamp-Massey
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < ecCount; k++) {
    let d = syn[k];
    for (let i = 1; i <= L; i++) {
      d ^= gfMul(C[i], syn[k - i]);
    }
    if (d === 0) {
      m++;
    } else if (2 * L <= k) {
      const T = C.slice();
      const coef = gfDiv(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) {
        C[i + m] ^= gfMul(coef, B[i]);
      }
      L = k + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      const coef = gfDiv(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) {
        C[i + m] ^= gfMul(coef, B[i]);
      }
      m++;
    }
  }
  if (L * 2 > ecCount) return null;

  // Chien Search: find roots of C(x) where x = alpha^(-pos)
  const errPos = [];
  for (let pos = 0; pos < n; pos++) {
    const xInv = GF_EXP[(255 - pos) % 255];
    let evalVal = 0;
    let xPow = 1;
    for (let i = 0; i < C.length; i++) {
      evalVal ^= gfMul(C[i], xPow);
      xPow = gfMul(xPow, xInv);
    }
    if (evalVal === 0) errPos.push(pos);
  }
  if (errPos.length !== L) return null;

  // Error evaluator Omega(x) = S(x) * C(x) mod x^ecCount
  const omega = new Uint8Array(ecCount);
  for (let i = 0; i < ecCount; i++) {
    let sum = 0;
    for (let j = 0; j < C.length && j <= i; j++) {
      sum ^= gfMul(C[j], syn[i - j]);
    }
    omega[i] = sum;
  }

  // Formal derivative of C(x): odd-indexed coefficients
  const corrected = new Uint8Array(received);
  for (const pos of errPos) {
    const xInv = GF_EXP[(255 - pos) % 255];
    let num = 0;
    let pow = 1;
    for (let i = 0; i < ecCount; i++) {
      num ^= gfMul(omega[i], pow);
      pow = gfMul(pow, xInv);
    }
    let den = 0;
    let sq = 1;
    const xInvSq = gfMul(xInv, xInv);
    for (let i = 1; i < C.length; i += 2) {
      den ^= gfMul(C[i], sq);
      sq = gfMul(sq, xInvSq);
    }
    if (den === 0) return null;
    // Standard RS magnitude for b=0 (roots alpha^0..alpha^{ecCount-1}): X_k * Omega(X_k^-1) / C'(X_k^-1)
    const mag = gfMul(GF_EXP[pos % 255], gfDiv(num, den));
    corrected[n - 1 - pos] ^= mag;
  }

  // Re-verify syndromes are all zero
  for (let i = 0; i < ecCount; i++) {
    let val = 0;
    const x = GF_EXP[i];
    for (let j = 0; j < n; j++) val = gfMul(val, x) ^ corrected[j];
    if (val !== 0) return null;
  }

  return corrected.slice(0, n - ecCount);
}

function findFinderCenters(bin, width, height) {
  const candidates = [];

  function checkRatio(counts) {
    const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    if (total < 7) return false;
    const mod = total / 7;
    const maxVar = mod * 0.55;
    return (
      Math.abs(counts[0] - mod) < maxVar &&
      Math.abs(counts[1] - mod) < maxVar &&
      Math.abs(counts[2] - 3 * mod) < maxVar * 2.2 &&
      Math.abs(counts[3] - mod) < maxVar &&
      Math.abs(counts[4] - mod) < maxVar
    );
  }

  function crossCheckVert(cx, cy, maxCount, expectedTotal) {
    let r = cy;
    const c = [0, 0, 0, 0, 0];
    while (r >= 0 && bin[r * width + cx] === 1) { c[2]++; r--; }
    if (r < 0) return null;
    while (r >= 0 && bin[r * width + cx] === 0 && c[1] <= maxCount) { c[1]++; r--; }
    if (r < 0 || c[1] > maxCount) return null;
    while (r >= 0 && bin[r * width + cx] === 1 && c[0] <= maxCount) { c[0]++; r--; }
    if (c[0] > maxCount) return null;

    r = cy + 1;
    while (r < height && bin[r * width + cx] === 1) { c[2]++; r++; }
    if (r >= height) return null;
    while (r < height && bin[r * width + cx] === 0 && c[3] <= maxCount) { c[3]++; r++; }
    if (r >= height || c[3] > maxCount) return null;
    while (r < height && bin[r * width + cx] === 1 && c[4] <= maxCount) { c[4]++; r++; }
    if (c[4] > maxCount) return null;

    const tot = c[0] + c[1] + c[2] + c[3] + c[4];
    if (5 * Math.abs(tot - expectedTotal) >= 2 * expectedTotal) return null;
    if (!checkRatio(c)) return null;
    return r - c[4] - c[3] - c[2] / 2;
  }

  for (let y = 2; y < height; y += 2) {
    const counts = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x < width; x++) {
      const dark = bin[y * width + x] === 1;
      if (dark) {
        if ((state & 1) === 1) state++;
        counts[state]++;
      } else {
        if ((state & 1) === 0) {
          if (state === 4) {
            if (checkRatio(counts)) {
              const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
              const cx = x - counts[4] - counts[3] - counts[2] / 2;
              const cy = crossCheckVert(Math.round(cx), y, counts[2], total);
              if (cy !== null) {
                const modSize = total / 7;
                let merged = false;
                for (const p of candidates) {
                  if (Math.hypot(p.x - cx, p.y - cy) < modSize * 2.5) {
                    p.x = (p.x * p.count + cx) / (p.count + 1);
                    p.y = (p.y * p.count + cy) / (p.count + 1);
                    p.mod = (p.mod * p.count + modSize) / (p.count + 1);
                    p.count++;
                    merged = true;
                    break;
                  }
                }
                if (!merged) candidates.push({ x: cx, y: cy, mod: modSize, count: 1 });
              }
            }
            counts[0] = counts[2];
            counts[1] = counts[3];
            counts[2] = counts[4];
            counts[3] = 1;
            counts[4] = 0;
            state = 3;
          } else {
            state++;
            counts[state]++;
          }
        } else {
          counts[state]++;
        }
      }
    }
  }

  if (candidates.length < 3) return null;
  candidates.sort((a, b) => b.count - a.count);
  const top3 = candidates.slice(0, 3);

  // Order as [topLeft, topRight, bottomLeft]
  const d01 = Math.hypot(top3[0].x - top3[1].x, top3[0].y - top3[1].y);
  const d02 = Math.hypot(top3[0].x - top3[2].x, top3[0].y - top3[2].y);
  const d12 = Math.hypot(top3[1].x - top3[2].x, top3[1].y - top3[2].y);

  let tl, a, b;
  if (d12 >= d01 && d12 >= d02) { tl = top3[0]; a = top3[1]; b = top3[2]; }
  else if (d02 >= d01 && d02 >= d12) { tl = top3[1]; a = top3[0]; b = top3[2]; }
  else { tl = top3[2]; a = top3[0]; b = top3[1]; }

  // Cross product (a - tl) x (b - tl) > 0 => a is topRight, b is bottomLeft
  const cross = (a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x);
  return cross > 0 ? { tl, tr: a, bl: b } : { tl, tr: b, bl: a };
}

export function decodeQRFromImageData(imageData) {
  const { data, width, height } = imageData;
  const lum = new Uint8Array(width * height);
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    // Composite against white if alpha < 1
    const cr = r * a + 255 * (1 - a);
    const cg = g * a + 255 * (1 - a);
    const cb = b * a + 255 * (1 - a);
    const y = Math.round(0.299 * cr + 0.587 * cg + 0.114 * cb);
    lum[i] = y;
    sum += y;
  }

  // Global midpoint threshold between min and max luminance
  let minL = 255, maxL = 0;
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] < minL) minL = lum[i];
    if (lum[i] > maxL) maxL = lum[i];
  }
  if (maxL - minL < 30) return null;
  const thresh = (minL + maxL) >> 1;
  const bin = new Uint8Array(width * height);
  for (let i = 0; i < lum.length; i++) {
    bin[i] = lum[i] < thresh ? 1 : 0;
  }

  const finders = findFinderCenters(bin, width, height);
  if (!finders) return null;

  const { tl, tr, bl } = finders;
  const mod = (tl.mod + tr.mod + bl.mod) / 3;
  const distX = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const distY = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const dimX = Math.round(distX / mod) + 7;
  const dimY = Math.round(distY / mod) + 7;
  let dim = Math.round((dimX + dimY) / 2);
  dim = Math.round((dim - 17) / 4) * 4 + 17;
  const version = (dim - 17) / 4;
  if (version < 1 || version > 16) return null;

  // Affine mapping from module (col, row) to image (x, y)
  const ux = (tr.x - tl.x) / (dim - 7);
  const uy = (tr.y - tl.y) / (dim - 7);
  const vx = (bl.x - tl.x) / (dim - 7);
  const vy = (bl.y - tl.y) / (dim - 7);
  const originX = tl.x - 3 * ux - 3 * vx;
  const originY = tl.y - 3 * uy - 3 * vy;

  const matrix = Array.from({ length: dim }, () => new Uint8Array(dim));
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const px = Math.round(originX + c * ux + r * vx);
      const py = Math.round(originY + c * uy + r * vy);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        matrix[r][c] = bin[py * width + px];
      }
    }
  }

  // Read format bits (two redundant copies)
  let fmt1 = 0;
  for (let i = 0; i < 6; i++) fmt1 = (fmt1 << 1) | matrix[8][i];
  fmt1 = (fmt1 << 1) | matrix[8][7];
  fmt1 = (fmt1 << 1) | matrix[8][8];
  fmt1 = (fmt1 << 1) | matrix[7][8];
  for (let i = 5; i >= 0; i--) fmt1 = (fmt1 << 1) | matrix[i][8];
  // Note: standard bit order puts bit 14 at (8,0) -> read reversed
  let fmtA = 0;
  for (let i = 0; i < 15; i++) {
    let bit = 0;
    if (i < 6) bit = matrix[i][8];
    else if (i < 8) bit = matrix[i + 1][8];
    else bit = matrix[dim - 15 + i][8];
    fmtA |= bit << i;
  }
  let fmtB = 0;
  for (let i = 0; i < 15; i++) {
    let bit = 0;
    if (i < 8) bit = matrix[8][dim - 1 - i];
    else if (i < 9) bit = matrix[8][7];
    else bit = matrix[8][14 - i];
    fmtB |= bit << i;
  }

  const fmt = decodeFormatBits(fmtA) || decodeFormatBits(fmtB);
  if (!fmt) return null;

  const { isFunc } = buildFunctionGrid(version);
  const table = RS_TABLE[fmt.ecl][version];
  if (!table) return null;
  const [ecPerBlock, g1b, g1d, g2b, g2d] = table;
  const totalCodewords = g1b * (g1d + ecPerBlock) + g2b * (g2d + ecPerBlock);

  // Extract masked data bits in zigzag order
  const rawBytes = new Uint8Array(totalCodewords);
  let bitIdx = 0;
  let dirUp = true;
  for (let col = dim - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < dim; i++) {
      const row = dirUp ? dim - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (isFunc[row][c]) continue;
        if (bitIdx >= totalCodewords * 8) break;
        let bit = matrix[row][c];
        if (maskFn(fmt.mask, row, c)) bit ^= 1;
        rawBytes[bitIdx >> 3] |= bit << (7 - (bitIdx & 7));
        bitIdx++;
      }
    }
    dirUp = !dirUp;
  }

  // De-interleave RS blocks
  const blocks = [];
  for (let i = 0; i < g1b; i++) blocks.push(new Uint8Array(g1d + ecPerBlock));
  for (let i = 0; i < g2b; i++) blocks.push(new Uint8Array(g2d + ecPerBlock));

  let ri = 0;
  const maxD = Math.max(g1d, g2d);
  for (let i = 0; i < maxD; i++) {
    for (let b = 0; b < blocks.length; b++) {
      const dLen = b < g1b ? g1d : g2d;
      if (i < dLen) blocks[b][i] = rawBytes[ri++];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks.length; b++) {
      const dLen = b < g1b ? g1d : g2d;
      blocks[b][dLen + i] = rawBytes[ri++];
    }
  }

  // Error-correct every block
  const decodedBytes = [];
  for (const blk of blocks) {
    const corr = rsDecodeBlock(blk, ecPerBlock);
    if (!corr) return null;
    for (const byteVal of corr) decodedBytes.push(byteVal);
  }

  // Parse Byte mode payload
  let pos = 0;
  const readBits = (len) => {
    let v = 0;
    for (let i = 0; i < len; i++) {
      const bytePos = pos >> 3;
      if (bytePos >= decodedBytes.length) return 0;
      const bit = (decodedBytes[bytePos] >>> (7 - (pos & 7))) & 1;
      v = (v << 1) | bit;
      pos++;
    }
    return v;
  };

  const mode = readBits(4);
  if (mode !== 0b0100) return null;
  const countLen = version >= 10 ? 16 : 8;
  const charCount = readBits(countLen);
  const out = new Uint8Array(charCount);
  for (let i = 0; i < charCount; i++) {
    out[i] = readBits(8);
  }
  return new TextDecoder().decode(out);
}
