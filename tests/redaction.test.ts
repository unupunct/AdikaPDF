import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { buildPdf, type ExportInput } from '@/lib/pdf/exportPdf';
import { pageContent } from '@/lib/pdf/textRemoval';
import type { EditorObject, TextObject } from '@/types';
import { PNG_1PX, PNG_DATA_URL, contains, everything, loadFont, measure, pageRefs, pdfjsText, rasterize, sourceOf } from './helpers/redaction';

const opts = { loadFont, measure, rasterizeRedactedPage: rasterize };

function textObj(pageId: string, id: string, x: number, y: number, str: string): TextObject {
  return { id, type: 'text', pageId, x, y, rotation: 0, opacity: 1, width: 90, height: 20, text: str, fontFamily: 'sans', bold: false, italic: false, fontSize: 10, color: '#000000', align: 'left', lineHeight: 1.2, background: null };
}

const meta = { author: 'A', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z' };

/** A redaction box at (100,50)-(200,150) and objects under it, around it and drawn after it. */
function objectsUnderBox(pageId: string): EditorObject[] {
  return [
    { id: 'rd', type: 'redact', pageId, x: 100, y: 50, width: 100, height: 100, rotation: 0, opacity: 1, fill: '#000000' },
    textObj(pageId, 't1', 110, 60, 'HIDDENWORD'),
    textObj(pageId, 't2', 20, 200, 'VISIBLEWORD'),
    { id: 'n', type: 'note', pageId, x: 120, y: 90, width: 20, height: 20, rotation: 0, opacity: 1, text: 'NOTESECRET', color: '#ffd400', ...meta },
    { id: 'st', type: 'stamp', pageId, x: 105, y: 120, width: 60, height: 20, rotation: 0, opacity: 1, label: 'STAMPSECRET', subtitle: '', color: '#cc0000', name: 'Approved', text: 'STAMPCOMMENT', ...meta },
    { id: 'im', type: 'image', pageId, x: 110, y: 110, width: 20, height: 20, rotation: 0, opacity: 1, src: PNG_DATA_URL, crop: null, naturalWidth: 1, naturalHeight: 1 },
    { id: 'pen', type: 'pen', pageId, x: 0, y: 0, rotation: 0, opacity: 1, points: [110, 60, 150, 100, 190, 140], stroke: '#ff0000', strokeWidth: 2 },
    { id: 'bar', type: 'rect', pageId, x: 50, y: 70, width: 200, height: 10, rotation: 0, opacity: 1, stroke: null, strokeWidth: 0, fill: '#00ff00' },
    { id: 'fa', type: 'text', pageId, x: 130, y: 70, rotation: 0, opacity: 1, width: 60, height: 20, text: 'TYPEWRITERSECRET', fontFamily: 'sans', bold: false, italic: false, fontSize: 10, color: '#000000', align: 'left', lineHeight: 1.2, background: null, annotation: true },
  ];
}

async function plainSource(withImage: boolean) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([300, 300]);
  p.drawText('public text', { x: 20, y: 20, size: 12, font });
  if (withImage) p.drawImage(await d.embedPng(PNG_1PX), { x: 120, y: 170, width: 40, height: 40 });
  return sourceOf(await d.save());
}

describe('redaction removes what the user put under the box', () => {
  for (const raster of [false, true]) {
    it(`text, comments, stamps, pictures and ink under a box are gone (${raster ? 'raster' : 'vector'} path)`, async () => {
      const src = await plainSource(raster);
      const [p] = pageRefs(src, 1);
      let asked = 0;
      const input: ExportInput = { sources: { [src.id]: src }, pages: [p], objects: objectsUnderBox(p.id), fieldValues: {} };
      const out = await buildPdf(input, { ...opts, rasterizeRedactedPage: async () => (asked++, rasterize()) });
      expect(asked).toBe(raster ? 1 : 0);
      const [text] = await pdfjsText(out);
      expect(text).toContain('VISIBLEWORD');
      expect(text).not.toContain('HIDDENWORD');
      const all = await everything(out);
      for (const w of ['NOTESECRET', 'STAMPSECRET', 'STAMPCOMMENT', 'TYPEWRITERSECRET']) expect(contains(all, w), w).toBe(false);
      const doc = await PDFDocument.load(out);
      const page = doc.getPage(0);
      const annots = page.node.lookup(PDFName.of('Annots'));
      expect(annots instanceof PDFArray ? annots.size() : 0).toBe(0);
      const content = Buffer.from(pageContent(doc, page)).toString('latin1');
      // The bar crossing the box is clipped out of it; the user's picture is not drawn at all.
      expect(content).toContain('W*');
      const imageDraws = (content.match(/ Do\b/g) ?? []).length;
      expect(imageDraws).toBe(raster ? 1 : 0);
      if (!raster) {
        // The box is the last thing drawn: nothing over it.
        const box = content.slice(content.lastIndexOf('0 0 0 rg'));
        expect(box).toMatch(/100 100 l/);
        expect(box).not.toMatch(/\b(c|Do|Tj|TJ|S)\b/);
      }
    });
  }
});
