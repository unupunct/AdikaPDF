import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePageText, parseContent, parseToUnicode, removeGlyphs, type Box, type PageText } from '@/lib/pdf/textRemoval';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function pdfjsText(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const doc = await task.promise;
  const c = await (await doc.getPage(1)).getTextContent();
  return c.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

/** Boxes of the glyphs of `word` (first occurrence) in the analysed text. */
function boxesOf(t: PageText, word: string): Box[] {
  const at = t.text.indexOf(word);
  expect(at, `"${word}" in "${t.text}"`).toBeGreaterThanOrEqual(0);
  const idx = new Set(t.map.slice(at, at + word.length).filter((i) => i >= 0));
  return [...idx].map((i) => t.glyphs[i].box);
}

const glyphX = (t: PageText, word: string) => t.glyphs[t.map[t.text.indexOf(word)]].cx;

async function standardDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Invoice Total 1111.50 EUR', { x: 60, y: 700, size: 12, font });
  p.drawText('CONFIDENTIAL account 4242-4242 END', { x: 60, y: 650, size: 14, font });
  return PDFDocument.load(await doc.save());
}

async function unicodeDoc() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const ttf = readFileSync(join(process.cwd(), 'node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'));
  const font = await doc.embedFont(ttf, { subset: true });
  const p = doc.addPage([595, 842]);
  p.drawText('Contractul nr. 17 semnat de Ștefan Ionescu, București', { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
  return PDFDocument.load(await doc.save());
}

describe('content stream lexer', () => {
  it('splits instructions, strings with escapes, arrays and inline images', () => {
    const src = new TextEncoder().encode('q 1 0 0 1 5 5 cm BT /F1 12 Tf (a\\(b\\) \\101) Tj [(x) -250 <4142>] TJ ET BI /W 1 /H 1 ID \x00\x01 EI Q');
    const ops = parseContent(src).map((i) => i.op);
    expect(ops).toEqual(['q', 'cm', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q']);
    const tj = parseContent(src)[4].args[0];
    expect(tj.k === 's' && new TextDecoder().decode(tj.v)).toBe('a(b) A');
  });

  it('reads ToUnicode bfchar and bfrange', () => {
    const m = parseToUnicode('beginbfchar <0003> <0020> endbfchar beginbfrange <0010> <0012> <0041> <0020> <0021> [<0218> <021A>] endbfrange');
    expect([m.get(3), m.get(0x10), m.get(0x12), m.get(0x20), m.get(0x21)]).toEqual([' ', 'A', 'C', 'Ș', 'Ț']);
  });
});

describe('glyph-level text removal', () => {
  it('analyses a standard-font page (no /Widths) into text with exact positions', async () => {
    const doc = await standardDoc();
    const t = analyzePageText(doc, doc.getPage(0));
    expect(t.partial).toBe(false);
    expect(t.text).toContain('Invoice Total 1111.50 EUR');
    expect(t.text).toContain('CONFIDENTIAL account 4242-4242 END');
    // Helvetica "I" is 278/1000 wide at 12 pt: the next glyph starts 3.336 pt later.
    const i = t.map[t.text.indexOf('Invoice')];
    expect(t.glyphs[i + 1].origin[0] - t.glyphs[i].origin[0]).toBeCloseTo(3.336, 3);
  });

  it('deletes exactly the covered letters and keeps the rest of the line in place', async () => {
    const doc = await standardDoc();
    const page = doc.getPage(0);
    const before = analyzePageText(doc, page);
    const endX = glyphX(before, 'END');
    const r = removeGlyphs(doc, page, boxesOf(before, '4242-4242'), 'redact');
    expect(r).toMatchObject({ ok: true, removedGlyphs: 9 });
    const after = analyzePageText(doc, page);
    expect(after.text).not.toContain('4242');
    expect(after.text).toContain('CONFIDENTIAL account');
    expect(glyphX(after, 'END')).toBeCloseTo(endX, 3);
    const out = await doc.save();
    const text = await pdfjsText(out);
    expect(text).not.toContain('4242');
    expect(text).toContain('END');
    expect(text).toContain('Invoice Total 1111.50 EUR');
  });

  it('works with an embedded Unicode font (Type0 / Identity-H) and diacritics', async () => {
    const doc = await unicodeDoc();
    const page = doc.getPage(0);
    const t = analyzePageText(doc, page);
    expect(t.text).toContain('Ștefan Ionescu, București');
    const commaX = glyphX(t, ', București');
    const r = removeGlyphs(doc, page, boxesOf(t, 'Ștefan Ionescu'), 'replace');
    expect(r).toMatchObject({ ok: true, removedGlyphs: 14, coversImage: false });
    const after = analyzePageText(doc, page);
    expect(after.text).not.toContain('Ionescu');
    expect(glyphX(after, ', București')).toBeCloseTo(commaX, 3);
    expect(await pdfjsText(await doc.save())).not.toContain('Ionescu');
  });

  it('refuses to redact over an image (the caller rasterises instead)', async () => {
    const d0 = await PDFDocument.create();
    const font = await d0.embedFont(StandardFonts.Helvetica);
    const p = d0.addPage([300, 300]);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    p.drawImage(await d0.embedPng(png), { x: 40, y: 140, width: 200, height: 40 });
    p.drawText('SECRET over a scan', { x: 50, y: 150, size: 12, font });
    const doc = await PDFDocument.load(await d0.save());
    const t = analyzePageText(doc, doc.getPage(0));
    expect(removeGlyphs(doc, doc.getPage(0), boxesOf(t, 'SECRET'), 'redact')).toMatchObject({ ok: false });
    // Replacing still removes the letters, but reports the image under them.
    expect(removeGlyphs(doc, doc.getPage(0), boxesOf(t, 'SECRET'), 'replace')).toMatchObject({ ok: true, coversImage: true, removedGlyphs: 6 });
  });
});

describe('restyled text in the document font', () => {
  it('writes the new letters in another colour and size, then restores the original style', async () => {
    const doc = await standardDoc();
    const page = doc.getPage(0);
    const t = analyzePageText(doc, page);
    const boxes = boxesOf(t, 'Total');
    const r = removeGlyphs(doc, page, boxes, 'replace', [{ boxes, newWidth: 40, text: 'Total', color: '#cc0000', sizeRatio: 1.5 }]);
    expect(r).toMatchObject({ ok: true, editNative: [true] });
    const out = await doc.save();
    const again = await PDFDocument.load(out);
    const glyphs = analyzePageText(again, again.getPage(0)).glyphs;
    const T = glyphs.find((g) => g.text === 'T')!;
    const E = glyphs.find((g) => g.text === 'E')!; // "EUR" after it keeps black
    expect(T.color).toBe('#cc0000');
    expect(E.color).toBe('#000000');
    expect(T.size / E.size).toBeCloseTo(1.5, 1);
    expect((await pdfjsText(out)).replace(/\s+/g, ' ')).toContain('Invoice Total 1111.50 EUR');
  });
});
