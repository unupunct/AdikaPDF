import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { Font, FontNames } from '@pdf-lib/standard-fonts';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertToPdfADetailed, pdfaWarnings } from '@/lib/pdf/pdfa';
import { readCff, type PdfAFontSources } from '@/lib/pdf/pdfaFonts';
import { readFontProgram } from '@/lib/pdf/fontProgram';
import { cmykToRgb } from '@/lib/print/color';
import { scanContentOps } from '@/lib/pdf/compress';

const FONT_DIR = resolve('node_modules/pdfjs-dist/standard_fonts');
const fonts: PdfAFontSources = {
  standardFont: async (f) => (existsSync(`${FONT_DIR}/${f}`) ? new Uint8Array(readFileSync(`${FONT_DIR}/${f}`)) : null),
};
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
const openPdf = (bytes: Uint8Array) => {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, standardFontDataUrl: FONT_DIR.replace(/\\/g, '/') + '/', verbosity: 0 });
  tasks.push(task);
  return task.promise;
};
/** Every content stream (pages and forms), decoded. */
function contents(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    const sub = o.dict.lookup(PDFName.of('Subtype'));
    if (sub && sub !== PDFName.of('Form')) continue;
    if (o.dict.has(PDFName.of('Type')) || o.dict.has(PDFName.of('Length1')) || o.dict.has(PDFName.of('N'))) continue;
    out.push(new TextDecoder('latin1').decode(decodePDFRawStream(o).decode()));
  }
  return out;
}
/** Problems besides the closing "validate with veraPDF" line. */
const problems = async (bytes: Uint8Array) => (await pdfaWarnings(bytes)).slice(0, -1);

describe('PDF/A: DeviceCMYK is converted', () => {
  async function cmykSource(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const img = ctx.register(ctx.flateStream(new Uint8Array([0, 255, 0, 0, 255, 255, 255, 255]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }));
    const spot = ctx.obj([PDFName.of('Separation'), PDFName.of('Gold'), PDFName.of('DeviceCMYK'), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 0.2, 1, 0.1], N: 1 })]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im: img }, ColorSpace: { Gold: spot } }));
    const ops = '1 0 0 0 k 0 0 1 0 K 10 10 50 50 re B /DeviceCMYK cs 0 1 1 0 sc 70 70 20 20 re f /Gold cs 1 scn 100 100 20 20 re f 0.5 g 0 0 1 rg q 20 0 0 10 120 20 cm /Im Do Q';
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops)));
    return doc.save();
  }

  it('leaves no DeviceCMYK operators, images or alternates; colours stay close', async () => {
    const src = await cmykSource();
    expect((await problems(src)).join('\n')).toMatch(/DeviceCMYK/);
    const r = await convertToPdfADetailed(src, { title: 'CMYK', author: '' });
    expect(r.notes.join('\n')).toMatch(/DeviceCMYK colours were converted to RGB/);
    const doc = await PDFDocument.load(r.bytes);
    const all = contents(doc).join('\n');
    const ops = contents(doc).flatMap((c) => [...scanContentOps(new TextEncoder().encode(c))].map((o) => o.op));
    expect(ops).not.toContain('k');
    expect(ops).not.toContain('K');
    expect(all).not.toMatch(/DeviceCMYK/);
    // Cyan fill -> (0, 1, 1) RGB; yellow stroke -> (1, 1, 0); grey and RGB untouched.
    expect(all).toMatch(/0 1 1 rg/);
    expect(all).toMatch(/1 1 0 RG/);
    expect(all).toMatch(/0\.5 g/);
    expect(all).toMatch(/0 0 1 rg/);
    // The sc after /DeviceRGB cs has three operands: red.
    expect(all).toMatch(/\/DeviceRGB cs 1 0 0 sc/);
    // Image pixels: cyan and white.
    const im = [...doc.context.enumerateIndirectObjects()].map(([, o]) => o).find((o) => o instanceof PDFRawStream && o.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) as PDFRawStream;
    expect(im.dict.lookup(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceRGB'));
    expect([...decodePDFRawStream(im).decode()]).toEqual([...cmykToRgb([0, 1, 0, 0]), 0, 0, 0].map((v, i) => (i < 3 ? Math.round(v * 255) : v)));
    // The spot colour now falls back to RGB.
    const spot = doc.getPage(0).node.Resources()!.lookup(PDFName.of('ColorSpace'), PDFDict).lookup(PDFName.of('Gold'), PDFArray);
    expect(spot.get(2)).toBe(PDFName.of('DeviceRGB'));
    expect(await problems(r.bytes)).toEqual([]);
  });

  it('"Keep CMYK": a CMYK output intent, RGB converted to CMYK', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: { type: 'RGB', red: 1, green: 0, blue: 0 } as never });
    const r = await convertToPdfADetailed(await doc.save(), { title: 'Print', author: '', keepCmyk: true });
    const out = await PDFDocument.load(r.bytes);
    const intent = out.catalog.lookup(PDFName.of('OutputIntents'), PDFArray).lookup(0, PDFDict);
    expect((intent.lookup(PDFName.of('DestOutputProfile')) as PDFRawStream).dict.lookup(PDFName.of('N'))).toEqual(PDFNumber.of(4));
    const all = contents(out).join('\n');
    expect(all).toMatch(/0 1 1 0 k/);
    expect(all).not.toMatch(/ rg/);
    expect(await problems(r.bytes)).toEqual([]);
  });

  it('"Keep CMYK" in PDF/A-1: annotations lose /C and /IC (allowed only with an RGB intent), PDF/A-2 keeps them', async () => {
    const make = async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([200, 200]);
      const ap = doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 40, 40], Resources: doc.context.obj({}) }));
      const square = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50], F: 4, C: [1, 0, 0], IC: [0, 0, 1], AP: { N: ap } }));
      page.node.set(PDFName.of('Annots'), doc.context.obj([square]));
      return doc.save();
    };
    const annot = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPage(0).node.Annots()!.lookup(0, PDFDict);
    const a1 = await annot((await convertToPdfADetailed(await make(), { title: 'Print', author: '', keepCmyk: true, level: '1b' })).bytes);
    expect(a1.has(PDFName.of('C'))).toBe(false);
    expect(a1.has(PDFName.of('IC'))).toBe(false);
    expect(a1.has(PDFName.of('AP'))).toBe(true);
    const a2 = await annot((await convertToPdfADetailed(await make(), { title: 'Print', author: '', keepCmyk: true, level: '2b' })).bytes);
    expect(a2.has(PDFName.of('C'))).toBe(true);
  });
});

describe('PDF/A: fonts the file only names are embedded', () => {
  const text = 'Hello, PDF/A world! 123 ÄÖÜ';
  async function fontSource(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([500, 300]);
    let y = 250;
    for (const f of [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.TimesRoman, StandardFonts.TimesRomanItalic, StandardFonts.Courier]) {
      page.drawText(text, { x: 20, y, size: 14, font: await doc.embedFont(f) });
      y -= 30;
    }
    page.drawText('αβγ', { x: 20, y, size: 14, font: await doc.embedFont(StandardFonts.Symbol) });
    return doc.save();
  }

  it('Helvetica / Times / Courier / Symbol get programs with the standard widths; text and positions unchanged', async () => {
    const src = await fontSource();
    expect((await problems(src)).join('\n')).toMatch(/font\(s\) are not embedded/);
    const r = await convertToPdfADetailed(src, { title: 'Fonts', author: '', fonts });
    expect(r.notes.join('\n')).toMatch(/6 font\(s\) were embedded/);
    expect(await problems(r.bytes)).toEqual([]);

    const doc = await PDFDocument.load(r.bytes);
    let checked = 0;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict) || o.lookup(PDFName.of('Type')) !== PDFName.of('Font')) continue;
      const base = o.lookup(PDFName.of('BaseFont'), PDFName).decodeText();
      const first = o.lookup(PDFName.of('FirstChar'), PDFNumber).asNumber();
      const widths = o.lookup(PDFName.of('Widths'), PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());
      const fd = o.lookup(PDFName.of('FontDescriptor'), PDFDict);
      const afm = Font.load(base as FontNames);
      // Layout: the original (AFM) widths of the letters of the text.
      const enc = o.lookup(PDFName.of('Encoding'));
      if (base !== 'Symbol') expect(enc instanceof PDFName ? enc.decodeText() : 'dict').toBe('WinAnsiEncoding');
      const winAnsi = (ch: string) => ({ Ä: 0xc4, Ö: 0xd6, Ü: 0xdc })[ch] ?? ch.charCodeAt(0);
      const glyph = (ch: string) => ({ ' ': 'space', ',': 'comma', '!': 'exclam', '/': 'slash', '1': 'one', '2': 'two', '3': 'three', Ä: 'Adieresis', Ö: 'Odieresis', Ü: 'Udieresis' })[ch] ?? ch;
      const sample = base === 'Symbol' ? [] : [...new Set(text)];
      for (const ch of sample) expect(Math.abs(widths[winAnsi(ch) - first] - (afm.getWidthOfGlyph(glyph(ch)) as number))).toBeLessThanOrEqual(1);
      // Consistency: the program's own widths match the dictionary (PDF/A 6.2.11.5).
      const ff2 = fd.lookup(PDFName.of('FontFile2'));
      const ff = fd.lookup(PDFName.of('FontFile3'));
      if (ff2 instanceof PDFRawStream) {
        expect(o.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('TrueType'));
        const p = readFontProgram(decodePDFRawStream(ff2).decode())!;
        for (const ch of sample) {
          const g = p.gidForUnicode(ch.codePointAt(0)!);
          expect(Math.abs((p.advance(g) * 1000) / p.unitsPerEm - widths[winAnsi(ch) - first])).toBeLessThanOrEqual(1);
        }
      } else {
        expect(ff).toBeInstanceOf(PDFRawStream);
        const t1 = readCff(decodePDFRawStream(ff as PDFRawStream).decode())!;
        for (const ch of sample) expect(Math.abs(t1.widths.get(glyph(ch))! - widths[winAnsi(ch) - first])).toBeLessThanOrEqual(1);
      }
      checked++;
    }
    expect(checked).toBe(6);

    // pdf.js reads the same text at the same places.
    const items = async (b: Uint8Array) => {
      const page = await (await openPdf(b)).getPage(1);
      return (await page.getTextContent()).items.map((i) => ('str' in i ? [i.str, Math.round(i.transform[4]), Math.round(i.width)] : null));
    };
    expect(await items(r.bytes)).toEqual(await items(src));
  });

  it('a font no program is found for stays reported', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const f = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Wingdings', FontDescriptor: ctx.obj({ Type: 'FontDescriptor', FontName: 'Wingdings', Flags: 4 }) }));
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 12 Tf 10 10 Td (a) Tj ET')));
    const r = await convertToPdfADetailed(await doc.save(), { title: 'W', author: '', fonts });
    expect((await problems(r.bytes)).join('\n')).toMatch(/1 font\(s\) are not embedded \(Wingdings\)/);
  });
});

describe('PDF/A-1: transparency', () => {
  it('pages with transparency are flattened when a rasteriser is given', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]).drawRectangle({ x: 10, y: 10, width: 50, height: 50, opacity: 0.5 });
    doc.addPage([100, 100]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const src = await doc.save();
    const kept = await convertToPdfADetailed(src, { title: 'T', author: '', level: '1b' });
    expect((await problems(kept.bytes)).join('\n')).toMatch(/PDF\/A-1 forbids transparency/);
    const raster: number[] = [];
    const r = await convertToPdfADetailed(src, {
      title: 'T',
      author: '',
      level: '1b',
      rasterRgb: async (i) => {
        raster.push(i);
        return { data: new Uint8Array(4 * 4 * 3).fill(200), width: 4, height: 4 };
      },
    });
    expect(raster).toEqual([0]);
    expect(r.notes.join('\n')).toMatch(/1 page\(s\) with transparency were flattened/);
    expect(await problems(r.bytes)).toEqual([]);
  });
});
