import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cnpValid, findPattern, ibanValid, luhnValid, parseTerms } from '@/lib/patterns';
import { engineMatches, findTextMatches, queryFinder } from '@/lib/pdf/textSearch';
import { buildPdf } from '@/lib/pdf/exportPdf';
import type { FontVariant } from '@/lib/fonts';
import type { PageRef, SourceDoc, TextObject } from '@/types';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
async function textOf(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const c = await (await (await task.promise).getPage(1)).getTextContent();
  return c.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

async function source(rotate = 0): Promise<{ src: SourceDoc; ref: PageRef }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Client: Ion Popescu, e-mail ion.popescu@firma.ro', { x: 60, y: 700, size: 12, font });
  p.drawText('IBAN RO49 AAAA 1B31 0075 9384 0000, tel. +40 722 123 456', { x: 60, y: 680, size: 12, font });
  p.drawText('CNP 1800101221144 · total 1111.50 EUR · factura 2024001234', { x: 60, y: 660, size: 12, font, color: rgb(0.8, 0, 0) });
  if (rotate) p.setRotation(degrees(rotate));
  const bytes = await doc.save();
  const src: SourceDoc = { id: 's', name: 'c.pdf', bytes, pageCount: 1 };
  const ref: PageRef = { id: 'p0', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: rotate as 0, userRotation: 0, width: 595, height: 842 };
  return { src, ref };
}

describe('sensitive-data patterns', () => {
  const text = 'IBAN RO49 AAAA 1B31 0075 9384 0000, tel. +40 722 123 456 sau 0722-123-456; CNP 1800101221144; card 4111 1111 1111 1111; total 1111.50 EUR; factura 2024001234; data 12.03.1985; ana.pop@firma.ro';
  const found = (id: Parameters<typeof findPattern>[0]) => findPattern(id, text).map(([s, e]) => text.slice(s, e));

  it('checks IBAN, CNP and card check digits', () => {
    expect(ibanValid('RO49 AAAA 1B31 0075 9384 0000')).toBe(true);
    expect(ibanValid('RO49 AAAA 1B31 0075 9384 0001')).toBe(false);
    expect(cnpValid('1800101221144')).toBe(true);
    expect(cnpValid('1800101221145')).toBe(false);
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('4111 1111 1111 1112')).toBe(false);
  });

  it('finds each kind and leaves amounts and invoice numbers alone', () => {
    expect(found('iban')).toEqual(['RO49 AAAA 1B31 0075 9384 0000']);
    expect(found('cnp')).toEqual(['1800101221144']);
    expect(found('card')).toEqual(['4111 1111 1111 1111']);
    expect(found('email')).toEqual(['ana.pop@firma.ro']);
    expect(found('date')).toEqual(['12.03.1985']);
    const phones = found('phone');
    expect(phones).toContain('+40 722 123 456');
    expect(phones).toContain('0722-123-456');
    expect(phones.some((p) => p.includes('1111.50') || p.includes('2024001234') || p.includes('1800101221144'))).toBe(false);
  });

  it('parses the words list', () => {
    expect(parseTerms('Ion Popescu\n\n Strada Lalelelor 5 ;Cluj')).toEqual(['Ion Popescu', 'Strada Lalelelor 5', 'Cluj']);
  });
});

describe('matches with exact positions', () => {
  it('finds a phrase ignoring case and diacritics, with display rects on the right line', async () => {
    const { src, ref } = await source();
    const doc = await PDFDocument.load(src.bytes);
    const [m] = engineMatches(doc, ref, queryFinder('ion popescu'))!;
    expect(m.text).toBe('Ion Popescu');
    expect(m.exact).toBe(true);
    // Baseline 700 pt from the bottom = 142 pt from the top; x after "Client: " (Helvetica 12 pt).
    expect(m.origin[1]).toBeCloseTo(142, 1);
    expect(m.origin[0]).toBeCloseTo(60 + (722 + 222 + 222 + 556 + 556 + 278 + 278 + 278) * 0.012, 1);
    expect(m.rects).toHaveLength(1);
    expect(m.rects[0].y).toBeLessThan(142);
    expect(m.rects[0].y + m.rects[0].height).toBeGreaterThan(142);
    expect(m.size).toBeCloseTo(12, 3);
    expect(m.family).toBe('sans');
  });

  it('maps positions on a rotated page and keeps the text colour', async () => {
    const { src, ref } = await source(90);
    const doc = await PDFDocument.load(src.bytes);
    const [m] = engineMatches(doc, ref, queryFinder('1800101221144'))!;
    // Rotated 90° clockwise: display is 842 wide, text runs downwards.
    expect(m.dir[0]).toBeCloseTo(0, 5);
    expect(m.dir[1]).toBeCloseTo(1, 5);
    expect(m.origin[0]).toBeCloseTo(660, 1);
    expect(m.color).toBe('#cc0000');
  });

  it('replacing through the exporter swaps the words for real', async () => {
    const { src, ref } = await source();
    const [m] = await findTextMatches([ref], { s: src }, queryFinder('Ion Popescu'));
    const t: TextObject = { id: 't', type: 'text', pageId: ref.id, x: m.origin[0] - 2, y: m.origin[1] - 11, width: 120, height: 16, rotation: 0, opacity: 1, text: 'Maria Ionescu', fontFamily: m.family, bold: m.bold, italic: m.italic, fontSize: 12, color: m.color, align: 'left', lineHeight: 1.25, background: null, replaces: m.rects };
    const out = await buildPdf({ sources: { s: src }, pages: [ref], objects: [t], fieldValues: {} }, { loadFont, measure });
    const text = await textOf(out);
    expect(text).toContain('Maria Ionescu');
    expect(text).not.toContain('Popescu,');
    expect(text).toContain('ion.popescu@firma.ro'); // only the name was replaced
    expect(text).toContain('Client:');
  });
});
