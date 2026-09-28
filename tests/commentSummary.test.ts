import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, type PDFPage } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { formatDate, parsePdfDate, summarizeComments, type LoadFont } from '@/lib/pdf/commentSummary';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont: LoadFont = (v) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const PNG = new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', '400Regular', 'NotoSans_400Regular.ttf.png')));

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  tasks.push(task);
  return task.promise as unknown as Promise<PDFDocumentProxy>;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await openPdf(bytes);
  const out: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    out.push(tc.items.map((i) => ('str' in i ? i.str : '')).join('\n'));
  }
  return out;
}

/** Local-time PDF date (so the formatted time is the same in every time zone). */
function localPdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

function addAnnot(doc: PDFDocument, page: PDFPage, dict: Record<string, unknown>) {
  const ref = doc.context.register(doc.context.obj({ Type: 'Annot', F: 4, P: page.ref, ...dict } as never));
  let annots = page.node.Annots();
  if (!annots) {
    annots = doc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
  return ref;
}

const LONG = Array.from({ length: 900 }, (_, i) => `cuvânt${i + 1}`).join(' ');

async function makeCommented(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Some highlighted words here.', { x: 72, y: 700, size: 12, font });
  const p2 = doc.addPage([595, 842]);
  p2.drawText('Page two.', { x: 72, y: 700, size: 12, font });
  doc.addPage([595, 842]); // no comments

  const date = PDFString.of(localPdfDate(new Date(2026, 8, 28, 14, 5)));
  const t = (s: string) => PDFHexString.fromText(s);
  const note = addAnnot(doc, p1, { Subtype: 'Text', Rect: [300, 600, 320, 620], Contents: t('Verificați secțiunea: ă â î ș ț Ă Â Î Ș Ț'), T: t('Ioana Popescu'), M: date });
  addAnnot(doc, p1, { Subtype: 'Popup', Rect: [320, 500, 520, 620], Parent: note });
  addAnnot(doc, p1, { Subtype: 'Text', Rect: [300, 580, 320, 600], Contents: t('De acord, mulțumesc.'), T: t('Andrei'), M: date, IRT: note });
  // "highlighted" spans x ≈ 72 + 5 chars … 72 + 16 chars at 12 pt Helvetica.
  const x0 = 72 + font.widthOfTextAtSize('Some ', 12);
  const x1 = x0 + font.widthOfTextAtSize('highlighted', 12);
  addAnnot(doc, p1, { Subtype: 'Highlight', Rect: [x0, 696, x1, 712], QuadPoints: [x0, 712, x1, 712, x0, 696, x1, 696], Contents: t('Check this'), T: t('Ioana Popescu'), M: date });
  addAnnot(doc, p1, { Subtype: 'Link', Rect: [72, 650, 200, 670], A: { S: 'URI', URI: PDFString.of('https://example.com') } });
  addAnnot(doc, p1, { Subtype: 'FreeText', Rect: [72, 400, 300, 440], Contents: t('Typed text box'), T: t('Maria'), DA: PDFString.of('0 g /Helv 12 Tf') });
  addAnnot(doc, p2, { Subtype: 'Square', Rect: [100, 100, 300, 300], Contents: t(LONG), T: t('Reviewer'), M: date });
  addAnnot(doc, p2, { Subtype: 'StrikeOut', Rect: [72, 696, 120, 712], QuadPoints: [72, 712, 120, 712, 72, 696, 120, 696], T: t('Reviewer') });
  return doc.save();
}

describe('dates', () => {
  it('parses PDF dates with and without offsets', () => {
    expect(parsePdfDate("D:20260928120500Z")!.toISOString()).toBe('2026-09-28T12:05:00.000Z');
    expect(parsePdfDate("D:20260928150500+03'00'")!.toISOString()).toBe('2026-09-28T12:05:00.000Z');
    expect(parsePdfDate("D:20260928070500-05'00")!.toISOString()).toBe('2026-09-28T12:05:00.000Z');
    expect(formatDate(parsePdfDate('D:2026092814')!)).toBe('28.09.2026 14:00');
    expect(parsePdfDate('garbage')).toBeNull();
    expect(parsePdfDate(null)).toBeNull();
  });
});

describe('summarizeComments', () => {
  it('lists comments per page with type, author, date, contents and marked text', async () => {
    const src = await makeCommented();
    const r = await summarizeComments(await openPdf(src), loadFont, { title: 'Rezumat comentarii', documentName: 'raport.pdf' });
    // Note, reply, highlight, text box on page 1; rectangle and strikethrough on page 2.
    expect(r.count).toBe(6);
    const pages = await pageTexts(r.bytes);
    const all = pages.join('\n');
    expect(pages[0]).toContain('Rezumat comentarii');
    expect(pages[0]).toContain('Document: raport.pdf');
    expect(pages[0]).toContain('6 comments');
    expect(all).toContain('Page 1');
    expect(all).toContain('Page 2');
    expect(all).not.toMatch(/Page 3(?! \/)/);
    expect(all).toContain('Verificați secțiunea: ă â î ș ț Ă Â Î Ș Ț');
    expect(all).toContain('De acord, mulțumesc.');
    expect(all).toContain('Ioana Popescu');
    expect(all).toContain('28.09.2026 14:05');
    expect(all).toContain('“highlighted”');
    expect(all).toContain('Check this');
    expect(all).toContain('Typed text box');
    expect(all).not.toContain('example.com');
    // Reading order on each page (top to bottom), replies right after their comment.
    const order = ['1. Highlight', '2. Note', '3. Reply', '4. Text box', '5. Strikethrough', '6. Rectangle'].map((s) => all.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // The 900-word comment wraps onto many lines and continues on following pages.
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const lines = all.split('\n').filter((l) => l.includes('cuvânt'));
    expect(lines.length).toBeGreaterThan(40);
    expect(pages[pages.length - 1]).toContain('cuvânt900');
    expect(pages[pages.length - 1]).toContain('Page 2 (continued)');
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain(LONG);
    // Footer page numbers.
    expect(pages[0]).toContain(`1 / ${pages.length}`);
  });

  it('places a page image when renderPage is given', async () => {
    const src = await makeCommented();
    const calls: Array<[number, number]> = [];
    const r = await summarizeComments(await openPdf(src), loadFont, {
      renderPage: async (n, w) => {
        calls.push([n, w]);
        return n === 1 ? { bytes: PNG, type: 'png', width: 100, height: 140 } : null;
      },
    });
    expect(calls).toEqual([
      [1, 300],
      [2, 300],
    ]);
    expect(r.count).toBe(6);
    const pdf = await openPdf(r.bytes);
    const ops = await (await pdf.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject);
    const all = (await pageTexts(r.bytes)).join('\n');
    expect(all).toContain('Comment summary');
    expect(all).toContain('Verificați secțiunea');
  });

  it('says so when there are no comments', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    const r = await summarizeComments(await openPdf(bytes), loadFont);
    expect(r.count).toBe(0);
    const pages = await pageTexts(r.bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('This document has no comments.');
    expect(pages[0]).toContain('0 comments');
  });
});
