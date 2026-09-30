import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { binarize, cleanupPage, estimateSkew, isBlankPage, rotate, rotateQuarter, toGray, uprightTurns, type Img } from '@/lib/scan/cleanup';

const TEXT = [
  'The quick brown fox jumps over the lazy dog while the',
  'little black kitten sleeps behind the old wooden table;',
  'both of them will stay there until the light fades and',
  'the whole house finally becomes quiet for the night.',
  'Details like these make a simple story feel much better.',
  'Hold the thought: every line should look like real text.',
];

/** A page of text: 1240 x 1754 px (A4 at 150 DPI). */
function page(opts: { lines?: string[]; angle?: number; speckles?: number; edge?: boolean } = {}): Img {
  const w = 1240;
  const h = 1754;
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf6';
  g.fillRect(0, 0, w, h);
  g.save();
  if (opts.angle) {
    g.translate(w / 2, h / 2);
    g.rotate((opts.angle * Math.PI) / 180);
    g.translate(-w / 2, -h / 2);
  }
  g.fillStyle = '#111';
  g.font = '34px serif';
  (opts.lines ?? TEXT).forEach((l, i) => g.fillText(l, 110, 260 + i * 58));
  (opts.lines ?? TEXT).forEach((l, i) => g.fillText(l, 110, 760 + i * 58));
  g.restore();
  // Dust.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#000';
  for (let i = 0; i < (opts.speckles ?? 0); i++) g.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), 2, 2);
  if (opts.edge) {
    g.fillStyle = '#222';
    g.fillRect(0, 0, 40, h); // scanner lid shadow on the left
    g.fillRect(0, h - 30, w, 30);
  }
  const d = g.getImageData(0, 0, w, h);
  return { data: new Uint8ClampedArray(d.data), width: w, height: h };
}

const bin = (img: Img) => binarize(toGray(img));

describe('scan cleanup', () => {
  it('measures and removes skew', () => {
    for (const a of [-3, 1.5, 4]) {
      const img = page({ angle: a });
      // Canvas rotate(+a) turns clockwise on screen; lines then fall to the right.
      const s = estimateSkew(bin(img), img.width, img.height);
      expect(Math.abs(s + a)).toBeLessThan(0.25);
      const r = cleanupPage(img, { deskew: true });
      expect(Math.abs(r.skew + a)).toBeLessThan(0.25);
      expect(Math.abs(estimateSkew(bin(r.img), r.img.width, r.img.height))).toBeLessThan(0.2);
    }
    expect(Math.abs(estimateSkew(bin(page()), 1240, 1754))).toBeLessThan(0.1);
  });

  it('finds upright, sideways and upside-down pages', () => {
    const up = page();
    expect(uprightTurns(bin(up), up.width, up.height)).toBe(0);
    for (const t of [1, 2, 3]) {
      const turned = rotateQuarter(up, t);
      const fix = uprightTurns(bin(turned), turned.width, turned.height);
      expect((t + fix) % 4).toBe(0);
    }
    const r = cleanupPage(rotateQuarter(up, 2), { orient: true });
    expect(r.rotated).toBe(180);
    expect(r.img.width).toBe(1240);
  });

  it('removes specks and dark scanner edges; recognises blank pages', () => {
    const dusty = page({ speckles: 400, edge: true });
    const r = cleanupPage(dusty, { despeckle: true, edges: true });
    const b = bin(r.img);
    // The left band and the bottom band are paper now.
    let dark = 0;
    for (let y = 0; y < r.img.height; y++) for (let x = 0; x < 40; x++) dark += b[y * r.img.width + x];
    expect(dark).toBe(0);
    // The text is kept.
    expect(r.ink).toBeGreaterThan(0.005);
    expect(r.blank).toBe(false);

    expect(isBlankPage(page({ lines: [], speckles: 300, edge: true }))).toBe(true);
    expect(isBlankPage(page({ lines: ['Only one short line on this page.'] }))).toBe(false);
  });

  it('rotates by an angle keeping the size and filling corners with paper', () => {
    const img = page();
    const r = rotate(img, 10, [255, 255, 255]);
    expect([r.width, r.height]).toEqual([img.width, img.height]);
    expect(Array.from(r.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });
});
