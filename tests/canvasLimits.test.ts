import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, cappedPixelRatio } from '@/lib/pdf/canvasLimits';

describe('canvas size cap', () => {
  it('keeps the device pixel ratio for ordinary pages', () => {
    expect(cappedPixelRatio(612 * 1.5, 792 * 1.5, 2)).toBe(2);
  });

  it('stays within the area and side limits at maximum zoom', () => {
    // A3 at 800 % on a 150 % display
    const w = 842 * 8;
    const h = 1191 * 8;
    const r = cappedPixelRatio(w, h, 1.5);
    expect(w * r * h * r).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
    expect(Math.max(w, h) * r).toBeLessThanOrEqual(MAX_CANVAS_SIDE + 1e-6);
    // A long strip is limited by its side
    const s = cappedPixelRatio(600, 20000, 2);
    expect(20000 * s).toBeLessThanOrEqual(MAX_CANVAS_SIDE + 1e-6);
  });
});
