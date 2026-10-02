/**
 * Minimal QR encoder — no npm dependencies.
 *
 * Scope: byte mode, error-correction level L, versions 1-4 (21-33 modules).
 * Versions 1-4 at level L are all a SINGLE Reed-Solomon block, so no block
 * interleaving is needed. The pairing deep link (~45 bytes) fits in v3/v4.
 * Payloads beyond v4 capacity fall back to a large monospace-text SVG.
 *
 * The encoder follows ISO/IEC 18004: mode + length + data, 0xEC/0x11 padding,
 * Reed-Solomon ECC over GF(256) (poly 0x11d), fixed masks evaluated with the
 * standard penalty rules, BCH(15,5) format info with the 0x5412 mask.
 */

const DATA_L = [0, 19, 34, 55, 80]; // data codewords per version at EC level L
const ECC_L = [0, 7, 10, 15, 20]; // ecc codewords per version at EC level L
const ALIGN_CENTER = [0, 0, 18, 22, 26]; // single alignment pattern center, v2+
const EC_LEVEL_L_BITS = 0b01;

// ------------------------------------------------------------------ GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial (highest-degree coefficient first, gen[0] === 1). */
function rsGenerator(eccLen: number): number[] {
  let poly: number[] = [1];
  for (let k = 0; k < eccLen; k++) {
    const a = EXP[k]; // alpha^k
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i]; // multiply by x
      next[i + 1] ^= gmul(poly[i], a); // multiply by (x + alpha^k)
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon ECC codewords for a data codeword block. */
function rsEcc(data: number[], eccLen: number): number[] {
  const gen = rsGenerator(eccLen);
  const work = data.slice();
  for (let i = 0; i < eccLen; i++) work.push(0);
  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j++) work[i + j] ^= gmul(gen[j], factor);
  }
  return work.slice(data.length);
}

// ------------------------------------------------------------ codeword build

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const dataLen = DATA_L[version];
  const bits: number[] = [];
  const push = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // char count (8 bits for versions 1-9)
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);
  const cap = dataLen * 8;
  const term = Math.min(4, cap - bits.length);
  if (term > 0) push(0, term);
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  const pad = [0xec, 0x11];
  for (let i = 0; data.length < dataLen; i++) data.push(pad[i % 2]);
  const ecc = rsEcc(data, ECC_L[version]);
  return Uint8Array.from([...data, ...ecc]);
}

// ------------------------------------------------------------ matrix layout

export interface QrMatrix {
  size: number;
  dark: boolean[][];
}

function emptyGrid(size: number): { dark: boolean[][]; fn: boolean[][] } {
  const dark: boolean[][] = [];
  const fn: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    dark.push(new Array<boolean>(size).fill(false));
    fn.push(new Array<boolean>(size).fill(false));
  }
  return { dark, fn };
}

function drawFunctionPatterns(
  dark: boolean[][],
  fn: boolean[][],
  version: number,
  size: number
): void {
  const set = (r: number, c: number, isDark: boolean): void => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    dark[r][c] = isDark;
    fn[r][c] = true;
  };

  // Finder patterns + separators (the -1..7 range clips separators at edges).
  const finder = (r0: number, c0: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          set(r, c, dist !== 2); // outer ring + 3x3 center dark, ring light
        } else {
          set(r, c, false); // separator: reserved light
        }
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let c = 8; c < size - 8; c++) set(6, c, c % 2 === 0);
  for (let r = 8; r < size - 8; r++) set(r, 6, r % 2 === 0);

  // Single alignment pattern for v2-4.
  if (version >= 2) {
    const o = ALIGN_CENTER[version] - 2;
    for (let dr = 0; dr < 5; dr++) {
      for (let dc = 0; dc < 5; dc++) {
        const dist = Math.max(Math.abs(dr - 2), Math.abs(dc - 2));
        set(o + dr, o + dc, dist !== 1);
      }
    }
  }

  // Dark module (column 8, row size-8).
  set(size - 8, 8, true);

  // Reserve format-info cells (values written after masking).
  for (let r = 0; r <= 8; r++) {
    if (r !== 6) fn[r][8] = true;
  }
  for (let c = 0; c <= 8; c++) {
    if (c !== 6) fn[8][c] = true;
  }
  for (let r = size - 8; r < size; r++) fn[r][8] = true;
  for (let c = size - 8; c < size; c++) fn[8][c] = true;
}

/** Zigzag placement of codeword bits; leftover (remainder) modules stay light. */
function placeData(dark: boolean[][], fn: boolean[][], codewords: Uint8Array, size: number): void {
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 0x2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!fn[r][c] && bitIndex < totalBits) {
          const bit = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          dark[r][c] = bit === 1;
          bitIndex++;
        }
      }
    }
  }
  if (bitIndex !== totalBits) throw new Error("QR internal error: data placement mismatch");
}

// ------------------------------------------------------------------- masks

function maskBit(maskId: number, r: number, c: number): boolean {
  switch (maskId) {
    case 0:
      return ((r + c) & 1) === 0;
    case 1:
      return (r & 1) === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: {
      const t = r * c;
      return (t % 2) + (t % 3) === 0;
    }
    case 6: {
      const t = r * c;
      return ((t % 2) + (t % 3)) % 2 === 0;
    }
    default: {
      const t = r * c;
      return (((r + c) & 1) + (t % 3)) % 2 === 0;
    }
  }
}

/** BCH(15,5) format bits, pre-masked with 0x5412 (both copies + dark module). */
function drawFormatBits(dark: boolean[][], size: number, maskId: number): void {
  const data = (EC_LEVEL_L_BITS << 3) | maskId;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  // Copy 1: around the top-left finder.
  for (let i = 0; i <= 5; i++) dark[i][8] = bit(i);
  dark[7][8] = bit(6);
  dark[8][8] = bit(7);
  dark[8][7] = bit(8);
  for (let i = 9; i < 15; i++) dark[8][14 - i] = bit(i);
  // Copy 2: split across top-right and bottom-left.
  for (let i = 0; i < 8; i++) dark[size - 1 - i][8] = bit(i);
  for (let i = 8; i < 15; i++) dark[8][size - 15 + i] = bit(i);
  dark[size - 8][8] = true; // always-dark module
}

function lineRunsPenalty(get: (i: number) => boolean, n: number): number {
  let p = 0;
  let color = get(0);
  let run = 1;
  for (let i = 1; i < n; i++) {
    if (get(i) === color) {
      run++;
      if (run === 5) p += 3;
      else if (run > 5) p += 1;
    } else {
      color = get(i);
      run = 1;
    }
  }
  return p;
}

/** Rule N3: 1:1:3:1:1 dark pattern with 4 light modules on one side. */
function finderPatternPenalty(get: (i: number) => boolean, n: number): number {
  let p = 0;
  for (let i = 0; i + 6 < n; i++) {
    if (
      get(i) &&
      !get(i + 1) &&
      get(i + 2) &&
      get(i + 3) &&
      get(i + 4) &&
      !get(i + 5) &&
      get(i + 6)
    ) {
      let lightBefore = true;
      for (let k = 1; k <= 4; k++) {
        if (i - k < 0 || get(i - k)) {
          lightBefore = false;
          break;
        }
      }
      let lightAfter = true;
      for (let k = 0; k < 4; k++) {
        if (i + 7 + k >= n || get(i + 7 + k)) {
          lightAfter = false;
          break;
        }
      }
      if (lightBefore) p += 40;
      if (lightAfter) p += 40;
    }
  }
  return p;
}

function maskPenalty(m: boolean[][]): number {
  const n = m.length;
  let penalty = 0;
  // N1: runs of 5+ same-colored modules in rows and columns.
  for (let r = 0; r < n; r++) penalty += lineRunsPenalty((i) => m[r][i], n);
  for (let c = 0; c < n; c++) penalty += lineRunsPenalty((i) => m[i][c], n);
  // N2: 2x2 blocks of the same color.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) penalty += 3;
    }
  }
  // N3: fake finder-like patterns.
  penalty += finderPatternPenaltyRows(m) + finderPatternPenaltyCols(m);
  // N4: deviation of dark-module ratio from 50%.
  let darkCount = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (m[r][c]) darkCount++;
  }
  const ratio = (darkCount * 100) / (n * n);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return penalty;
}

function finderPatternPenaltyRows(m: boolean[][]): number {
  let p = 0;
  for (let r = 0; r < m.length; r++) p += finderPatternPenalty((i) => m[r][i], m.length);
  return p;
}

function finderPatternPenaltyCols(m: boolean[][]): number {
  let p = 0;
  for (let c = 0; c < m.length; c++) p += finderPatternPenalty((i) => m[i][c], m.length);
  return p;
}

// --------------------------------------------------------------- assembly

/** Encode payload into a QR module matrix. Throws if it exceeds v4-L capacity. */
export function qrMatrix(payload: string): QrMatrix {
  const bytes = new TextEncoder().encode(payload);
  let version = 0;
  for (let v = 1; v <= 4; v++) {
    if (12 + bytes.length * 8 <= DATA_L[v] * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error("payload too long for minimal QR encoder");
  const codewords = buildCodewords(bytes, version);
  const size = 17 + 4 * version;
  const { dark, fn } = emptyGrid(size);
  drawFunctionPatterns(dark, fn, version, size);
  placeData(dark, fn, codewords, size);

  // Try all 8 masks; keep the lowest-penalty symbol (format bits differ per mask).
  let best: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let maskId = 0; maskId < 8; maskId++) {
    const m = dark.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fn[r][c] && maskBit(maskId, r, c)) m[r][c] = !m[r][c];
      }
    }
    drawFormatBits(m, size, maskId);
    const p = maskPenalty(m);
    if (p < bestPenalty) {
      bestPenalty = p;
      best = m;
    }
  }
  if (!best) throw new Error("QR internal error: mask selection failed");
  return { size, dark: best };
}

// ------------------------------------------------------------------ SVG out

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the QR as an SVG string (white background, 4-module quiet zone).
 * Insert with `el.innerHTML = renderQrSvg(payload)`.
 */
export function renderQrSvg(payload: string): string {
  let matrix: QrMatrix;
  try {
    matrix = qrMatrix(payload);
  } catch {
    return textFallbackSvg(payload);
  }
  const n = matrix.size;
  const quiet = 4;
  const dim = n + quiet * 2;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix.dark[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" class="flock-qr" ` +
    `style="width:200px;max-width:100%;height:auto;background:#ffffff">` +
    `<rect x="0" y="0" width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}

/** Workable fallback: the pairing code as huge monospace text. */
function textFallbackSvg(payload: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 120">` +
    `<rect x="0" y="0" width="440" height="120" fill="#ffffff"/>` +
    `<text x="220" y="66" text-anchor="middle" font-family="monospace" font-size="14" ` +
    `fill="#000000">${xmlEscape(payload)}</text></svg>`
  );
}