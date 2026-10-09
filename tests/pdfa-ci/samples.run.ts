/**
 * PDF/A samples made with the app's converter, for validation by veraPDF:
 * standard fonts that are not embedded, DeviceCMYK drawings and images, a
 * spot colour with a CMYK alternate, a form field, annotations, a bookmark,
 * transparency (flattened for PDF/A-1), attachments (PDF/A-3), and the
 * "Keep CMYK" variant. Written to $PDFA_OUT/<level>/*.pdf.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { convertToPdfADetailed, pdfaWarnings, type PdfALevel } from '@/lib/pdf/pdfa';
import type { PdfAFontSources } from '@/lib/pdf/pdfaFonts';

const OUT = process.env.PDFA_OUT ?? resolve('.tools/pdfa-samples');
const FONT_DIR = resolve('node_modules/pdfjs-dist/standard_fonts');
const fonts: PdfAFontSources = { standardFont: async (f) => (existsSync(`${FONT_DIR}/${f}`) ? new Uint8Array(readFileSync(`${FONT_DIR}/${f}`)) : null) };
const fieldFont = new Uint8Array(readFileSync(resolve('node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf')));

async function source(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Sample');
  const page = doc.addPage([595, 842]);
  let y = 780;
  const fontsUsed = [StandardFonts.Helvetica, StandardFonts.HelveticaBoldOblique, StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.Courier, StandardFonts.CourierOblique];
  for (const f of fontsUsed) {
    page.drawText(`${f}: Archival text, ÄÖÜ äöü 0123456789 (€ – “quotes”)`, { x: 40, y, size: 12, font: await doc.embedFont(f) });
    y -= 22;
  }
  page.drawText('αβγδ', { x: 40, y, size: 12, font: await doc.embedFont(StandardFonts.Symbol) });
  y -= 22;
  page.drawText('✓✔✗', { x: 40, y, size: 12, font: await doc.embedFont(StandardFonts.ZapfDingbats) });
  page.drawRectangle({ x: 40, y: 500, width: 120, height: 60, color: rgb(0.1, 0.4, 0.8) });
  page.drawRectangle({ x: 200, y: 500, width: 120, height: 60, color: rgb(0.9, 0.2, 0.1), opacity: 0.5 });
  const ctx = doc.context;
  // DeviceCMYK drawing, image and a spot colour with a CMYK alternate.
  const img = ctx.register(ctx.flateStream(new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }));
  const spot = ctx.obj([PDFName.of('Separation'), PDFName.of('Gold'), PDFName.of('DeviceCMYK'), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 0.2, 1, 0.1], N: 1 })]);
  const res = page.node.Resources()!;
  res.set(PDFName.of('ColorSpace'), ctx.obj({ Gold: spot }));
  const xo = res.lookup(PDFName.of('XObject'));
  if (xo) (xo as unknown as { set(k: PDFName, v: unknown): void }).set(PDFName.of('Cmyk'), img);
  else res.set(PDFName.of('XObject'), ctx.obj({ Cmyk: img }));
  const extra = ctx.register(ctx.stream('q 0 1 1 0 k 1 0 0 0 K 40 400 120 60 re B /Gold cs 1 scn 200 400 120 60 re f 60 0 0 60 360 400 cm /Cmyk Do Q'));
  const contents = page.node.get(PDFName.of('Contents'));
  page.node.set(PDFName.of('Contents'), ctx.obj([contents, extra]));
  // A form field and a comment.
  const field = doc.getForm().createTextField('Name');
  field.addToPage(page, { x: 40, y: 300, width: 200, height: 24 });
  field.setText('Ana Pop');
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [300, 300, 360, 340], C: [1, 0, 0], F: 4 }));
  page.node.set(PDFName.of('Annots'), ctx.obj([...(page.node.lookup(PDFName.of('Annots')) as unknown as { asArray(): unknown[] }).asArray(), note] as never));
  return doc.save();
}

const raster = async () => ({ data: new Uint8Array(100 * 100 * 3).fill(230), width: 100, height: 100 });

describe('PDF/A samples for veraPDF', () => {
  for (const level of ['1b', '2b', '3b'] as PdfALevel[]) {
    it(`PDF/A-${level}`, async () => {
      mkdirSync(`${OUT}/${level}`, { recursive: true });
      const src = await source();
      const variants: Array<[string, Parameters<typeof convertToPdfADetailed>[1]]> = [
        ['sample', { title: `Sample ${level}`, author: 'Adika CI', level, fonts, fieldFont, rasterRgb: raster }],
        ['keep-cmyk', { title: `Sample ${level} CMYK`, author: 'Adika CI', level, fonts, fieldFont, rasterRgb: raster, keepCmyk: true }],
      ];
      if (level === '3b') variants[0][1].attachments = [{ name: 'data.csv', mime: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), relationship: 'Data' }];
      for (const [name, meta] of variants) {
        const r = await convertToPdfADetailed(src, meta);
        writeFileSync(`${OUT}/${level}/${name}.pdf`, r.bytes);
        // Adika's own check finds nothing left (the last line asks for veraPDF).
        expect((await pdfaWarnings(r.bytes, level)).slice(0, -1)).toEqual([]);
      }
    });
  }
});
