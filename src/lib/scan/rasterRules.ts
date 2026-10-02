/**
 * Table lines in a scanned page: long thin dark runs found in the page
 * pixels, horizontal and vertical, returned as rule boxes in points (top-left
 * origin) like the vector rules of a born-digital PDF, so the same table
 * detection turns a scanned table into rows and cells. Pure.
 */
import type { Box } from '@/lib/pdf/wordLayout';

interface Run {
  a: number; // start (x for horizontal runs, y for vertical)
  b: number; // end, exclusive
  at: number; // row (or column)
}

/** Dark runs of at least `minLen` pixels in each row (horizontal) or column (vertical). */
function runs(dark: Uint8Array, W: number, H: number, horizontal: boolean, minLen: number): Run[] {
  const out: Run[] = [];
  const outer = horizontal ? H : W;
  const inner = horizontal ? W : H;
  for (let o = 0; o < outer; o++) {
    let start = -1;
    let gap = 0;
    for (let i = 0; i <= inner; i++) {
      const on = i < inner && dark[horizontal ? o * W + i : i * W + o] === 1;
      if (on) {
        if (start < 0) start = i;
        gap = 0;
      } else if (start >= 0) {
        // One- or two-pixel breaks (scan noise) do not end a line.
        if (i < inner && gap < 2) {
          gap++;
          continue;
        }
        const end = i - gap;
        if (end - start >= minLen) out.push({ a: start, b: end, at: o });
        start = -1;
        gap = 0;
      }
    }
  }
  return out;
}

/** Runs on neighbouring rows that overlap make one line; too thick means a bar or a picture, not a rule. */
function merge(rs: Run[], maxThick: number): Array<{ a: number; b: number; t0: number; t1: number }> {
  const lines: Array<{ a: number; b: number; t0: number; t1: number }> = [];
  const open: Array<{ a: number; b: number; t0: number; t1: number }> = [];
  rs.sort((x, y) => x.at - y.at || x.a - y.a);
  for (const r of rs) {
    let hit = open.find((l) => l.t1 >= r.at - 1 && Math.min(l.b, r.b) - Math.max(l.a, r.a) > 0.8 * Math.min(l.b - l.a, r.b - r.a));
    if (hit) {
      hit.a = Math.min(hit.a, r.a);
      hit.b = Math.max(hit.b, r.b);
      hit.t1 = r.at;
    } else {
      hit = { a: r.a, b: r.b, t0: r.at, t1: r.at };
      open.push(hit);
      lines.push(hit);
    }
    // Lines that ended above this row are closed.
    for (let k = open.length - 1; k >= 0; k--) if (open[k].t1 < r.at - 1) open.splice(k, 1);
  }
  return lines.filter((l) => l.t1 - l.t0 + 1 <= maxThick);
}

/**
 * Rules of a page rendered at `scale` pixels per point (RGBA pixels). Lines
 * shorter than `minLenPt` (default 24 pt) are ignored: letters and dashes.
 */
export function rasterRules(rgba: Uint8ClampedArray, W: number, H: number, scale: number, minLenPt = 24): Box[] {
  const dark = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    if (luma < 150 && rgba[p + 3] > 128) dark[i] = 1;
  }
  const minLen = Math.max(8, Math.round(minLenPt * scale));
  const maxThick = Math.max(2, Math.round(3 * scale));
  const out: Box[] = [];
  for (const l of merge(runs(dark, W, H, true, minLen), maxThick)) out.push({ x0: l.a / scale, x1: l.b / scale, y0: l.t0 / scale, y1: (l.t1 + 1) / scale });
  for (const l of merge(runs(dark, W, H, false, minLen), maxThick)) out.push({ x0: l.t0 / scale, x1: (l.t1 + 1) / scale, y0: l.a / scale, y1: l.b / scale });
  return out;
}
