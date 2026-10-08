import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractStructuredText } from '../src/lib/pdf/convert';
import { exportToCsv } from '../src/lib/pdf/exportFormats';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

describe('text of pages turned with /Rotate', () => {
  it('is read along the unturned page, so exports keep it (no OCR fallback)', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const rot of [0, 90, 180, 270]) {
      const page = doc.addPage([595, 842]);
      page.drawText(`Invoice Total ${rot}`, { x: 60, y: 760, size: 14, font });
      page.drawText('Second line of text', { x: 60, y: 730, size: 12, font });
      page.setRotation(degrees(rot));
    }
    const task = pdfjs.getDocument({ data: await doc.save(), verbosity: 0 });
    tasks.push(task);
    const text = await extractStructuredText((await task.promise) as never, undefined, { detectBold: false });
    expect(text.map((p) => p.lines.length)).toEqual([2, 2, 2, 2]);
    const csv = exportToCsv(text, { delimiter: ',' });
    for (const rot of [0, 90, 180, 270]) expect(csv).toContain(`Invoice Total ${rot}`);
  });
});
