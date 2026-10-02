import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { PAPER_SIZES, resizePages } from '@/lib/pdf/pageSize';
import { vectorPaths } from '@/lib/pdf/vectorEdit';

async function sample() {
  const d = await PDFDocument.create();
  const p = d.addPage([400, 300]);
  p.drawRectangle({ x: 0, y: 0, width: 400, height: 300, borderWidth: 1 });
  const annot = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 150] }));
  p.node.set(PDFName.of('Annots'), d.context.obj([annot]));
  const q = d.addPage([300, 400]);
  q.setRotation(degrees(90));
  return d.save();
}
const rectOf = (doc: PDFDocument) => ((doc.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray).lookup(0) as unknown as { lookup(n: PDFName): PDFArray }).lookup(PDFName.of('Rect')).asArray().map((n) => (n as PDFNumber).asNumber());

describe('page size', () => {
  it('scales content and comments to fit the paper, turned to the page orientation', async () => {
    const r = await resizePages(await sample(), { size: PAPER_SIZES.A4, matchOrientation: true, mode: 'fit' });
    expect(r.resized).toBe(2);
    const doc = await PDFDocument.load(r.bytes);
    const a = doc.getPage(0).getMediaBox();
    expect([a.width, a.height].map(Math.round)).toEqual([842, 595]);
    const s = 595.28 / 300;
    const box = vectorPaths(doc, doc.getPage(0))[0].box;
    expect(box.x1 - box.x0).toBeCloseTo(400 * s, 0);
    expect(box.y1 - box.y0).toBeCloseTo(300 * s, 0);
    const rect = rectOf(doc);
    expect(rect[2] - rect[0]).toBeCloseTo(100 * s, 1);
    // A page shown sideways (rotated 90°) is landscape too: its own box becomes 595 × 842.
    const b = doc.getPage(1).getMediaBox();
    expect([b.width, b.height].map(Math.round)).toEqual([595, 842]);
  });

  it('keeps the content size and grows the page around it', async () => {
    const r = await resizePages(await sample(), { size: [600, 500], matchOrientation: false, mode: 'canvas', pages: [1] });
    expect(r.resized).toBe(1);
    const doc = await PDFDocument.load(r.bytes);
    const box = vectorPaths(doc, doc.getPage(0))[0].box;
    expect(box.x0).toBeCloseTo(100);
    expect(box.y0).toBeCloseTo(100);
    expect(box.x1 - box.x0).toBeCloseTo(400);
    expect(rectOf(doc)).toEqual([200, 200, 300, 250]);
  });
});
