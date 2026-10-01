/** The colour existing page text is drawn in (Edit text shows and keeps it). */
import { usePDFStore } from '@/store/usePDFStore';
import { displayToPdfMatrix, totalRotation, transformRectBounds, type Rect } from '@/lib/geometry';
import type { PageRef } from '@/types';

/** Most common fill colour of the letters inside `rects` (display space), or null. */
export async function pageTextColor(page: PageRef, rects: Rect[]): Promise<string | null> {
  const src = page.sourceId ? usePDFStore.getState().sources[page.sourceId] : undefined;
  if (!src || page.kind !== 'source') return null;
  try {
    const [{ PDFDocument }, { analyzePageText }] = await Promise.all([import('pdf-lib'), import('@/lib/pdf/textRemoval')]);
    const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    const p = doc.getPage(page.sourceIndex);
    const box = p.getCropBox();
    const m = displayToPdfMatrix(totalRotation(page), { x: box.x, y: box.y, width: box.width, height: box.height });
    const boxes = rects.map((r) => transformRectBounds(m, r));
    const counts = new Map<string, number>();
    for (const g of analyzePageText(doc, p).glyphs) {
      if (!g.text.trim() || !boxes.some((b) => g.cx >= b.x && g.cx <= b.x + b.width && g.cy >= b.y && g.cy <= b.y + b.height)) continue;
      counts.set(g.color, (counts.get(g.color) ?? 0) + 1);
    }
    let best: string | null = null;
    let n = 0;
    for (const [c, k] of counts) if (k > n) [best, n] = [c, k];
    return best;
  } catch {
    return null;
  }
}
