import { describe, expect, it } from 'vitest';
import { rasterRules } from '@/lib/scan/rasterRules';
import { detectRuledGrids } from '@/lib/pdf/wordLayout';

/** A white page (pt size × scale px) with a 3 × 2 ruled table drawn 2 px thick, a heavy bar and some "letters". */
function scannedTable(scale: number) {
  const W = Math.round(400 * scale);
  const H = Math.round(300 * scale);
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = 20;
  };
  const hline = (y: number, x0: number, x1: number, t = 2) => {
    for (let k = 0; k < t; k++) for (let x = x0; x < x1; x++) ink(x, y + k);
  };
  const vline = (x: number, y0: number, y1: number, t = 2) => {
    for (let k = 0; k < t; k++) for (let y = y0; y < y1; y++) ink(x + k, y);
  };
  const s = (pt: number) => Math.round(pt * scale);
  // Grid: x 50..350 (columns at 50, 150, 250, 350), y 50..190 (rows at 50, 120, 190).
  for (const y of [50, 120, 190]) hline(s(y), s(50), s(350) + 2);
  for (const x of [50, 150, 250, 350]) vline(s(x), s(50), s(190) + 2);
  // A scan break in one line.
  for (let x = s(200); x < s(200) + 2; x++) for (let k = 0; k < 2; k++) px[((s(120) + k) * W + x) * 4] = 255;
  // A heavy bar (not a rule) and short marks (letters).
  for (let y = s(230); y < s(250); y++) hline(y, s(50), s(350), 1);
  for (let i = 0; i < 20; i++) hline(s(270), s(60 + i * 12), s(60 + i * 12) + s(6));
  return { px, W, H };
}

describe('table lines in scanned pages', () => {
  it('finds the rules of a scanned table and the table grid from them', () => {
    const scale = 2;
    const { px, W, H } = scannedTable(scale);
    const rules = rasterRules(px, W, H, scale);
    const horiz = rules.filter((r) => r.x1 - r.x0 > r.y1 - r.y0);
    const vert = rules.filter((r) => r.y1 - r.y0 > r.x1 - r.x0);
    expect(horiz).toHaveLength(3);
    expect(vert).toHaveLength(4);
    for (const r of horiz) {
      expect(r.x0).toBeCloseTo(50, 0);
      expect(r.x1).toBeCloseTo(351, 0);
      expect(r.y1 - r.y0).toBeLessThan(2);
    }
    const grids = detectRuledGrids(rules, 400, 300);
    expect(grids).toHaveLength(1);
    expect(grids[0].xs.length).toBe(4);
    expect(grids[0].ys.length).toBe(3);
  });
});
