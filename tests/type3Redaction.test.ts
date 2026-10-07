import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { analyzePageText, removeGlyphs } from '@/lib/pdf/textRemoval';

/** A Type3 font whose glyphs sit 0.5 to 1.5 em above the baseline (FontBBox), or per glyph (d1) when the FontBBox is zeros. */
async function type3Doc(fontBBox: number[], d1: number[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const glyph = ctx.register(ctx.stream(`600 0 ${d1.join(' ')} d1 ${d1[0]} ${d1[1]} ${d1[2] - d1[0]} ${d1[3] - d1[1]} re f`));
  const font = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: fontBBox,
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { box: glyph },
      Encoding: { Type: 'Encoding', Differences: [65, 'box'] },
      FirstChar: 65,
      LastChar: 65,
      Widths: [600],
      Resources: {},
    }),
  );
  const page = doc.addPage([300, 300]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { T3: font } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /T3 20 Tf 50 100 Td (AAA) Tj ET')));
  return doc;
}

describe('Type3 glyph boxes follow the font matrix and bounding boxes', () => {
  for (const [label, bbox, d1] of [
    ['FontBBox', [0, 500, 600, 1500], [0, 500, 600, 1500]],
    ['d1 box', [0, 0, 0, 0], [0, 500, 600, 1500]],
  ] as const) {
    it(`a glyph drawn above its baseline is found and redacted where it is (${label})`, async () => {
      const doc = await type3Doc([...bbox], [...d1]);
      const page = doc.getPage(0);
      const [g] = analyzePageText(doc, page).glyphs;
      // 20 pt glyph from 0.5 em to 1.5 em above the baseline at y = 100.
      expect(g.box.y0).toBeCloseTo(110, 3);
      expect(g.box.y1).toBeCloseTo(130, 3);
      expect(g.box.x1 - g.box.x0).toBeCloseTo(12, 3);
      // A box over the drawn glyphs (not over the usual em band) removes them.
      const res = removeGlyphs(doc, page, [{ x0: 45, y0: 116, x1: 90, y1: 132 }], 'redact');
      expect(res.ok).toBe(true);
      expect(res.removedGlyphs).toBe(3);
    });
  }
});
