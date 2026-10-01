/**
 * Scan cleanup on page pictures (pure, no DOM): straighten (deskew), remove
 * specks, whiten the dark scanner edges, find the upright orientation
 * (0 / 90 / 180 / 270°) and recognise blank pages. Works on RGBA pixels as
 * canvas ImageData has them.
 */

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface CleanupOptions {
  deskew?: boolean;
  despeckle?: boolean;
  /** Whiten dark borders (scanner lid, page shadow). */
  edges?: boolean;
  /** Turn sideways and upside-down pages upright. */
  orient?: boolean;
}

export interface CleanupResult {
  img: Img;
  /** Degrees the page was turned (clockwise) to be upright. */
  rotated: 0 | 90 | 180 | 270;
  /** Skew corrected, degrees. */
  skew: number;
  blank: boolean;
  /** Share of dark pixels (0..1), after cleanup. */
  ink: number;
}

// ---------------------------------------------------------------- basics

export function toGray(img: Img): Uint8Array {
  const g = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
  return g;
}

/** Otsu's threshold: the grey level that best separates ink from paper. */
export function otsu(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  // A nearly empty page: Otsu splits paper noise; keep a sane limit.
  return Math.min(threshold, 200);
}

/** 1 = ink. */
export function binarize(gray: Uint8Array, threshold = otsu(gray)): Uint8Array {
  const b = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) b[i] = gray[i] <= threshold ? 1 : 0;
  return b;
}

/** Nearest-neighbour downscale of a bitmap by an integer factor (any ink in the cell counts). */
function shrink(bin: Uint8Array, w: number, h: number, f: number): { b: Uint8Array; w: number; h: number } {
  const W = Math.max(1, Math.floor(w / f));
  const H = Math.max(1, Math.floor(h / f));
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H * f; y++) for (let x = 0; x < W * f; x++) if (bin[y * w + x]) out[Math.floor(y / f) * W + Math.floor(x / f)] = 1;
  return { b: out, w: W, h: H };
}

/** Paper colour: the median of the lightest half, per channel. */
export function paperColor(img: Img): [number, number, number] {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 20000));
  const px: Array<[number, number, number, number]> = [];
  for (let i = 0; i < n; i += step) {
    const j = i * 4;
    px.push([img.data[j], img.data[j + 1], img.data[j + 2], img.data[j] + img.data[j + 1] + img.data[j + 2]]);
  }
  px.sort((a, b) => b[3] - a[3]);
  const top = px.slice(0, Math.max(1, Math.floor(px.length / 2)));
  const med = (k: number) => {
    const v = top.map((p) => p[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return [med(0), med(1), med(2)];
}

// ---------------------------------------------------------------- deskew

/** Variance of the row sums of the bitmap sheared by `angle` degrees (text lines line up when straight). */
function profileScore(pts: Int32Array, count: number, h: number, angle: number): number {
  const t = Math.tan((angle * Math.PI) / 180);
  const rows = new Float64Array(h * 2 + 2);
  for (let k = 0; k < count; k++) {
    const x = pts[k * 2];
    const y = pts[k * 2 + 1];
    const r = Math.round(y - x * t) + h;
    if (r >= 0 && r < rows.length) rows[r]++;
  }
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < rows.length; i++) {
    s += rows[i];
    s2 += rows[i] * rows[i];
  }
  return s2 / rows.length - (s / rows.length) ** 2;
}

/** Skew of the text lines in degrees (positive: lines rise to the right), within ±maxAngle. */
export function estimateSkew(bin: Uint8Array, w: number, h: number, maxAngle = 8): number {
  // Work on a small bitmap: ~800 px wide is plenty.
  const f = Math.max(1, Math.floor(w / 800));
  const s = shrink(bin, w, h, f);
  let count = 0;
  for (let i = 0; i < s.b.length; i++) count += s.b[i];
  if (count < 50) return 0;
  const pts = new Int32Array(count * 2);
  let k = 0;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.b[y * s.w + x]) ((pts[k++] = x), (pts[k++] = y));
  let best = 0;
  let bestScore = -1;
  const search = (from: number, to: number, step: number) => {
    for (let a = from; a <= to + 1e-9; a += step) {
      const sc = profileScore(pts, count, s.h, a);
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
  };
  search(-maxAngle, maxAngle, 0.5);
  const coarse = best;
  search(coarse - 0.5, coarse + 0.5, 0.05);
  // In image coordinates (y down) a positive shear angle means lines fall to the right.
  return -Math.round(best * 100) / 100;
}

/** Rotates by `deg` degrees counter-clockwise about the centre, same size, corners filled with `bg`. Bilinear. */
export function rotate(img: Img, deg: number, bg: [number, number, number]): Img {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse mapping (y axis down: counter-clockwise on screen).
      const dx = x - cx;
      const dy = y - cy;
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      const o = (y * w + x) * 4;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
        out[o] = bg[0];
        out[o + 1] = bg[1];
        out[o + 2] = bg[2];
        out[o + 3] = 255;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Quarter turns, clockwise. */
export function rotateQuarter(img: Img, turns: number): Img {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return img;
  const { width: w, height: h, data } = img;
  const W = t === 2 ? w : h;
  const H = t === 2 ? h : w;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X: number;
      let Y: number;
      if (t === 1) [X, Y] = [h - 1 - y, x];
      else if (t === 2) [X, Y] = [w - 1 - x, h - 1 - y];
      else [X, Y] = [y, w - 1 - x];
      const s = (y * w + x) * 4;
      const d = (Y * W + X) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: W, height: H };
}

// ---------------------------------------------------------------- specks and edges

/** Connected ink blobs no larger than `maxArea` pixels (8-connected). Returns their pixel indices. */
export function specks(bin: Uint8Array, w: number, h: number, maxArea: number): number[] {
  const seen = new Uint8Array(bin.length);
  const out: number[] = [];
  const stack: number[] = [];
  const blob: number[] = [];
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || seen[i]) continue;
    blob.length = 0;
    stack.push(i);
    seen[i] = 1;
    let big = false;
    while (stack.length) {
      const p = stack.pop()!;
      if (!big) blob.push(p);
      if (blob.length > maxArea) big = true;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (bin[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    if (!big) out.push(...blob);
  }
  return out;
}

/**
 * Dark bands along the edges (scanner lid, page shadow): how many rows /
 * columns from each side are mostly ink. Only bands touching the edge count.
 */
export function darkEdges(bin: Uint8Array, w: number, h: number): { top: number; bottom: number; left: number; right: number } {
  const rowDark = (y: number) => {
    let n = 0;
    for (let x = 0; x < w; x++) n += bin[y * w + x];
    return n / w;
  };
  const colDark = (x: number) => {
    let n = 0;
    for (let y = 0; y < h; y++) n += bin[y * w + x];
    return n / h;
  };
  const limit = 0.5;
  const scan = (len: number, dark: (i: number) => number, from: number, dir: 1 | -1) => {
    let k = 0;
    // A band may fade out: allow it to continue while at least 30% dark after it started strongly.
    while (k < len * 0.15) {
      const v = dark(from + dir * k);
      if (v >= limit || (k > 0 && v >= 0.3)) k++;
      else break;
    }
    return k;
  };
  return { top: scan(h, rowDark, 0, 1), bottom: scan(h, rowDark, h - 1, -1), left: scan(w, colDark, 0, 1), right: scan(w, colDark, w - 1, -1) };
}

// ---------------------------------------------------------------- orientation

/**
 * 0 when text lines run horizontally, 90 when they run vertically (the page
 * is sideways): text lines give row sums with strong peaks and gaps.
 */
function linesAreHorizontal(bin: Uint8Array, w: number, h: number): boolean {
  const s = shrink(bin, w, h, Math.max(1, Math.floor(Math.max(w, h) / 600)));
  const variance = (sums: Float64Array) => {
    let a = 0;
    let b = 0;
    for (const v of sums) {
      a += v;
      b += v * v;
    }
    const m = a / sums.length;
    return b / sums.length - m * m;
  };
  const rows = new Float64Array(s.h);
  const cols = new Float64Array(s.w);
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++)
      if (s.b[y * s.w + x]) {
        rows[y]++;
        cols[x]++;
      }
  // Normalise by the line length so the page's aspect does not decide.
  const nr = variance(rows) / (s.w * s.w);
  const nc = variance(cols) / (s.h * s.h);
  return nr >= nc;
}

/**
 * Upright or upside down: in Latin text ascenders (b d f h k l t, capitals)
 * are far more common than descenders (g j p q y), so each text line has
 * more ink above its x-height band than below it.
 */
function isUpsideDown(bin: Uint8Array, w: number, h: number): boolean | null {
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += bin[y * w + x];
    rows[y] = n;
  }
  let above = 0;
  let below = 0;
  let lines = 0;
  for (let y = 0; y < h; ) {
    if (rows[y] === 0) {
      y++;
      continue;
    }
    const start = y;
    while (y < h && rows[y] > 0) y++;
    const end = y;
    const lh = end - start;
    if (lh < 6) continue;
    // The x-height band: rows with at least half the line's peak density.
    let peak = 0;
    for (let k = start; k < end; k++) peak = Math.max(peak, rows[k]);
    let top = end;
    let bottom = start;
    for (let k = start; k < end; k++)
      if (rows[k] >= peak * 0.5) {
        top = Math.min(top, k);
        bottom = Math.max(bottom, k);
      }
    for (let k = start; k < top; k++) above += rows[k];
    for (let k = bottom + 1; k < end; k++) below += rows[k];
    lines++;
  }
  if (lines < 2 || above + below < 50) return null;
  return below > above * 1.25;
}

/** Clockwise quarter turns that make the page upright (0 when unsure). */
export function uprightTurns(bin: Uint8Array, w: number, h: number): 0 | 1 | 2 | 3 {
  let turns = 0;
  let b = bin;
  let W = w;
  let H = h;
  if (!linesAreHorizontal(bin, w, h)) {
    // Sideways: turn a quarter clockwise, then check upside down.
    const r = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r[x * h + (h - 1 - y)] = bin[y * w + x];
    b = r;
    W = h;
    H = w;
    turns = 1;
  }
  const down = isUpsideDown(b, W, H);
  if (down) turns += 2;
  return (turns % 4) as 0 | 1 | 2 | 3;
}

// ---------------------------------------------------------------- the whole cleanup

export function cleanupPage(img: Img, opts: CleanupOptions): CleanupResult {
  const bg = paperColor(img);
  let cur = img;
  let gray = toGray(cur);
  let threshold = otsu(gray);
  let bin = binarize(gray, threshold);
  const fillBg = (target: Img, idx: Iterable<number>) => {
    for (const p of idx) {
      const o = p * 4;
      target.data[o] = bg[0];
      target.data[o + 1] = bg[1];
      target.data[o + 2] = bg[2];
    }
  };
  if (opts.edges) {
    const e = darkEdges(bin, cur.width, cur.height);
    if (e.top || e.bottom || e.left || e.right) {
      cur = { ...cur, data: new Uint8ClampedArray(cur.data) };
      const { width: w, height: h } = cur;
      const idx: number[] = [];
      // A little beyond the band: its soft edge.
      const pad = Math.max(2, Math.round(Math.min(w, h) * 0.004));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if ((e.top && y < e.top + pad) || (e.bottom && y >= h - e.bottom - pad) || (e.left && x < e.left + pad) || (e.right && x >= w - e.right - pad)) idx.push(y * w + x);
      fillBg(cur, idx);
      gray = toGray(cur);
      bin = binarize(gray, threshold);
    }
  }
  let rotated: CleanupResult['rotated'] = 0;
  if (opts.orient) {
    const t = uprightTurns(bin, cur.width, cur.height);
    if (t) {
      cur = rotateQuarter(cur, t);
      rotated = (t * 90) as CleanupResult['rotated'];
      gray = toGray(cur);
      bin = binarize(gray, threshold);
    }
  }
  let skew = 0;
  if (opts.deskew) {
    skew = estimateSkew(bin, cur.width, cur.height);
    if (Math.abs(skew) >= 0.1) {
      cur = rotate(cur, -skew, bg);
      gray = toGray(cur);
      threshold = otsu(gray);
      bin = binarize(gray, threshold);
    } else skew = 0;
  }
  if (opts.despeckle) {
    // Specks: up to ~0.25 mm² at 300 DPI.
    const maxArea = Math.max(2, Math.round((cur.width / 2480) * 6));
    const idx = specks(bin, cur.width, cur.height, maxArea);
    if (idx.length) {
      if (cur === img) cur = { ...cur, data: new Uint8ClampedArray(cur.data) };
      fillBg(cur, idx);
      for (const p of idx) bin[p] = 0;
    }
  }
  const ink = inkShare(bin, cur.width, cur.height);
  return { img: cur, rotated, skew, blank: ink < 0.0015, ink };
}

/** Share of ink pixels, margins (4%) left out, after removing specks. */
export function inkShare(bin: Uint8Array, w: number, h: number): number {
  const mx = Math.round(w * 0.04);
  const my = Math.round(h * 0.04);
  const tiny = new Set(specks(bin, w, h, Math.max(2, Math.round((w / 2480) * 6))));
  let n = 0;
  let total = 0;
  for (let y = my; y < h - my; y++)
    for (let x = mx; x < w - mx; x++) {
      total++;
      const i = y * w + x;
      if (bin[i] && !tiny.has(i)) n++;
    }
  return total ? n / total : 0;
}

/** Whether a page picture is blank (no ink beyond specks and edges). */
export function isBlankPage(img: Img): boolean {
  return cleanupPage(img, { edges: true }).blank;
}
