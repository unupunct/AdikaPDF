/** Largest backing canvas for on-screen pages: Chromium draws nothing beyond its canvas limits. */
export const MAX_CANVAS_PIXELS = 16_777_216;
export const MAX_CANVAS_SIDE = 8192;

/** Device pixels per CSS pixel for a `cssWidth` × `cssHeight` page, kept within the canvas limits. */
export function cappedPixelRatio(cssWidth: number, cssHeight: number, pixelRatio: number): number {
  const area = Math.max(1, cssWidth * cssHeight);
  return Math.min(pixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / area), MAX_CANVAS_SIDE / Math.max(1, cssWidth), MAX_CANVAS_SIDE / Math.max(1, cssHeight));
}
