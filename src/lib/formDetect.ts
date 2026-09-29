/**
 * Form field detection on a rendered page (works the same for vector PDFs
 * and scans): underlines and "____" with free space above become text
 * fields, empty table cells / boxes become text fields, small drawn squares
 * become checkboxes. Labels come from the page text next to each field.
 * Pure: takes RGBA pixels, returns rects in display space (points).
 */
import type { Rect } from './geometry';

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface LabelRun {
  str: string;
  rect: Rect;
}

export interface DetectedField {
  kind: 'text' | 'checkbox';
  rect: Rect;
  label: string;
  /** How it was found. */
  source: 'line' | 'cell' | 'square';
}

interface Seg {
  a0: number; // start along
  a1: number; // end along (exclusive)
  c0: number; // first row/column
  c1: number; // last row/column
}

function darkMask(img: PixelImage): Uint8Array {
  const { width, height, data } = img;
  const m = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    const a = data[p + 3];
    if (a < 128) continue;
    const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    if (lum < 150) m[i] = 1;
  }
  return m;
}

/** Straight runs of dark pixels merged across neighbouring rows (horizontal) or columns (vertical). */
function segments(mask: Uint8Array, w: number, h: number, horizontal: boolean, minLen: number, maxThick: number): Seg[] {
  const outer = horizontal ? h : w;
  const inner = horizontal ? w : h;
  const at = horizontal ? (o: number, i: number) => mask[o * w + i] : (o: number, i: number) => mask[i * w + o];
  const open: Seg[] = [];
  const done: Seg[] = [];
  for (let o = 0; o < outer; o++) {
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < inner; ) {
      if (!at(o, i)) {
        i++;
        continue;
      }
      const s = i;
      // Allow 1-pixel gaps (antialiasing, dashed rendering).
      while (i < inner && (at(o, i) || (i + 1 < inner && at(o, i + 1)))) i++;
      if (i - s >= minLen) runs.push([s, i]);
    }
    const next: Seg[] = [];
    for (const [s, e] of runs) {
      const hit = open.find((g) => g.c1 === o - 1 && Math.min(e, g.a1) - Math.max(s, g.a0) > 0.8 * Math.min(e - s, g.a1 - g.a0));
      if (hit) {
        hit.a0 = Math.min(hit.a0, s);
        hit.a1 = Math.max(hit.a1, e);
        hit.c1 = o;
        next.push(hit);
      } else next.push({ a0: s, a1: e, c0: o, c1: o });
    }
    for (const g of open) if (!next.includes(g)) done.push(g);
    open.length = 0;
    open.push(...next);
  }
  done.push(...open);
  return done.filter((g) => g.c1 - g.c0 + 1 <= maxThick);
}

function darkRatio(mask: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.floor(x1);
  y1 = Math.floor(y1);
  if (x1 <= x0 || y1 <= y0) return 1;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += mask[y * w + x];
  return n / ((x1 - x0) * (y1 - y0));
}

const overlapY = (a: Rect, b: Rect) => Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

function iou(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = overlapY(a, b);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / (a.width * a.height + b.width * b.height - i);
}

/** "Nume și prenume: ______" -> "Nume și prenume". */
export function cleanLabel(s: string): string {
  return s
    .replace(/[_.…]{2,}/g, ' ')
    .replace(/[☐□■▢]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s:;,*_-]+$/g, '')
    .slice(0, 40)
    .trim();
}

function labelLeft(runs: LabelRun[], field: Rect, maxGap: number): string {
  let best: LabelRun | null = null;
  for (const r of runs) {
    const right = r.rect.x + r.rect.width;
    if (overlapY(r.rect, field) < Math.min(r.rect.height, field.height) * 0.4) continue;
    if (right > field.x + 6 || field.x - right > maxGap) continue;
    if (!best || right > best.rect.x + best.rect.width) best = r;
  }
  return best ? cleanLabel(best.str) : '';
}

function labelRight(runs: LabelRun[], field: Rect, maxGap: number): string {
  let best: LabelRun | null = null;
  for (const r of runs) {
    if (overlapY(r.rect, field) < Math.min(r.rect.height, field.height) * 0.4) continue;
    const gap = r.rect.x - (field.x + field.width);
    if (gap < -2 || gap > maxGap) continue;
    if (!best || r.rect.x < best.rect.x) best = r;
  }
  return best ? cleanLabel(best.str) : '';
}

function labelAbove(runs: LabelRun[], field: Rect, maxGap: number): string {
  let best: LabelRun | null = null;
  for (const r of runs) {
    const bottom = r.rect.y + r.rect.height;
    if (bottom > field.y + 2 || field.y - bottom > maxGap) continue;
    if (Math.min(r.rect.x + r.rect.width, field.x + field.width) - Math.max(r.rect.x, field.x) <= 0) continue;
    if (!best || bottom > best.rect.y + best.rect.height) best = r;
  }
  return best ? cleanLabel(best.str) : '';
}

/**
 * @param scale pixels per point of the rendered image
 * @param runs page text in display space (points), for labels
 * @param existing rects of fields already on the page (not detected again)
 */
export function detectFields(img: PixelImage, scale: number, runs: LabelRun[] = [], existing: Rect[] = []): DetectedField[] {
  const { width: w, height: h } = img;
  const mask = darkMask(img);
  const pt = (v: number) => v * scale;
  const toRect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale });
  const out: DetectedField[] = [];

  const H = segments(mask, w, h, true, pt(30), Math.max(2, pt(2.5)));
  const V = segments(mask, w, h, false, pt(9), Math.max(2, pt(2.5)));
  const usedH = new Set<Seg>();

  // 1. Table cells / boxes: between two horizontal rules, bounded by vertical rules.
  const hs = H.slice(0, 400).sort((a, b) => a.c0 - b.c0);
  const vs = V.slice(0, 400);
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      const top = hs[i];
      const bot = hs[j];
      const gap = bot.c0 - top.c1;
      if (gap < pt(10)) continue;
      if (gap > pt(60)) break;
      const x0 = Math.max(top.a0, bot.a0);
      const x1 = Math.min(top.a1, bot.a1);
      if (x1 - x0 < pt(30)) continue;
      // Verticals joining the two rules, left to right.
      const walls = vs
        .filter((v) => v.c0 >= x0 - pt(2) && v.c1 <= x1 + pt(2) && v.a0 <= top.c1 + pt(2) && v.a1 >= bot.c0 - pt(2))
        .map((v) => (v.c0 + v.c1) / 2)
        .sort((a, b) => a - b);
      if (walls.length < 2) continue;
      // Only the nearest rule below counts (not a rule further down the table).
      const between = hs.some((m, k) => k !== i && k !== j && m.c0 > top.c1 && m.c1 < bot.c0 && Math.min(m.a1, x1) - Math.max(m.a0, x0) > pt(20));
      if (between) continue;
      usedH.add(top);
      usedH.add(bot);
      for (let k = 0; k + 1 < walls.length; k++) {
        const cx0 = walls[k];
        const cx1 = walls[k + 1];
        if (cx1 - cx0 < pt(30)) continue;
        const pad = Math.max(2, pt(1.5));
        if (darkRatio(mask, w, cx0 + pad, top.c1 + pad, cx1 - pad, bot.c0 - pad) > 0.004) continue; // has content
        const rect = toRect(cx0 + pad, top.c1 + pad, cx1 - pad, bot.c0 - pad);
        // The label is usually in the cell to the left (same row), else just above.
        out.push({ kind: 'text', rect, label: labelLeft(runs, rect, 250) || labelAbove(runs, rect, 14), source: 'cell' });
      }
    }
  }

  // 2. Underlines with free space above: fill-in lines.
  for (const s of H) {
    if (usedH.has(s)) continue;
    const len = s.a1 - s.a0;
    if (len < pt(36) || len > pt(520)) continue;
    // Free band above the line (the text height of a field).
    let free = 0;
    const step = Math.max(1, Math.round(pt(1)));
    for (let y = s.c0 - 2; y > s.c0 - pt(22) && y > 0; y -= step) {
      if (darkRatio(mask, w, s.a0 + 2, y - step, s.a1 - 2, y) > 0.01) break;
      free = s.c0 - 1 - (y - step);
    }
    if (free < pt(9)) continue;
    const height = Math.min(free, pt(18));
    const rect = toRect(s.a0, s.c0 - height, s.a1, s.c0 - Math.max(1, pt(0.5)));
    out.push({ kind: 'text', rect, label: labelLeft(runs, rect, 250) || labelAbove(runs, rect, 16), source: 'line' });
  }

  // 3. Checkboxes: small squares drawn on all four sides, empty inside.
  const seen = new Uint8Array(w * h);
  const minS = pt(6.5);
  const maxS = pt(22);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let big = false;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x1 - x0 > maxS || y1 - y0 > maxS) big = true;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (big) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw < minS || bh < minS || Math.abs(bw - bh) > 0.2 * Math.max(bw, bh)) continue;
    // Each side must be drawn along its whole length (any pixel of a thin band).
    const t = Math.max(2, Math.round(Math.min(bw, bh) * 0.15));
    const cover = (horizontal: boolean, from: number) => {
      let n = 0;
      const len = horizontal ? bw : bh;
      for (let k = 0; k < len; k++) {
        let hit = 0;
        for (let d = 0; d < t && !hit; d++) hit = horizontal ? mask[(from + d) * w + x0 + k] : mask[(y0 + k) * w + from + d];
        n += hit;
      }
      return n / len;
    };
    const sides = [cover(true, y0), cover(true, y1 + 1 - t), cover(false, x0), cover(false, x1 + 1 - t)];
    if (sides.some((r) => r < 0.85)) continue;
    const edge = (ax0: number, ay0: number, ax1: number, ay1: number) => darkRatio(mask, w, ax0, ay0, ax1, ay1);
    const ix = Math.round(bw * 0.25);
    const iy = Math.round(bh * 0.25);
    if (edge(x0 + ix, y0 + iy, x1 + 1 - ix, y1 + 1 - iy) > 0.1) continue;
    const rect = toRect(x0, y0, x1 + 1, y1 + 1);
    out.push({ kind: 'checkbox', rect, label: labelRight(runs, rect, 150) || labelLeft(runs, rect, 150), source: 'square' });
  }

  // Drop duplicates and anything over an existing field.
  const kept: DetectedField[] = [];
  for (const f of out) {
    if (existing.some((r) => iou(r, f.rect) > 0.2)) continue;
    if (kept.some((k) => iou(k.rect, f.rect) > 0.3)) continue;
    kept.push(f);
  }
  return kept.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/** Unique field names from labels ("Nume", "Nume 2", …), falling back to "Text1" / "Check1". */
export function fieldNames(fields: DetectedField[], taken: string[]): string[] {
  const used = new Set(taken);
  let text = 1;
  let check = 1;
  return fields.map((f) => {
    let base = f.label;
    if (!base) {
      const prefix = f.kind === 'checkbox' ? 'Check' : 'Text';
      do base = `${prefix}${f.kind === 'checkbox' ? check++ : text++}`;
      while (used.has(base));
    }
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base} ${k}`;
    used.add(name);
    return name;
  });
}
