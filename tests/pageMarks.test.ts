import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFBool,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import {
  addPageMarks,
  expandMarkTokens,
  hasPageMarks,
  openSaveDepth,
  removePageMarks,
  type MarkFont,
  type PageMarksOptions,
} from '../src/lib/pdf/pageMarks';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function loadFont(v: MarkFont): Promise<Uint8Array> {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
}

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

// 1x1 red PNG
const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/**
 * Four pages: plain; /Rotate 90; CropBox with a non-zero origin; and one whose
 * content leaks an unbalanced `q … cm` (no closing Q).
 */
async function makeDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([600, 800]);
  p1.drawText('Original one', { x: 50, y: 700, size: 14, font });
  const p2 = doc.addPage([600, 800]);
  p2.drawText('Original two', { x: 50, y: 700, size: 14, font });
  p2.setRotation(degrees(90));
  const p3 = doc.addPage([700, 900]);
  p3.setCropBox(100, 150, 500, 600);
  p3.drawText('Original three', { x: 150, y: 600, size: 14, font });
  const p4 = doc.addPage([595, 842]);
  p4.drawText('Original four', { x: 50, y: 780, size: 14, font });
  p4.node.normalize();
  const leak = doc.context.flateStream('q 1 0 0 1 5 5 cm q 3 0 0 3 40 40 cm 1 0 0 rg % Q\n');
  p4.node.addContentStream(doc.context.register(leak));
  return doc.save();
}

interface PlacedText {
  str: string;
  /** Baseline start in viewport (screen) coordinates. */
  x: number;
  y: number;
  width: number;
  /** Direction angle on screen, degrees counter-clockwise. */
  angle: number;
  vw: number;
  vh: number;
}

async function placedText(bytes: Uint8Array, n: number): Promise<PlacedText[]> {
  const pdf = await openPdf(bytes);
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return (tc.items as TextItem[])
    .filter((i) => 'str' in i && i.str.trim())
    .map((i) => {
      const t = pdfjs.Util.transform(vp.transform, i.transform);
      const len = Math.hypot(t[0], t[1]);
      // pdf.js reports width in user space; measured along the text direction.
      return {
        str: i.str,
        x: t[4],
        y: t[5],
        width: i.width * (len / Math.hypot(i.transform[0], i.transform[1])),
        angle: (Math.atan2(-t[1], t[0]) * 180) / Math.PI,
        vw: vp.width,
        vh: vp.height,
      };
    });
}

async function texts(bytes: Uint8Array, n: number): Promise<string[]> {
  return (await placedText(bytes, n)).map((t) => t.str);
}

const find = (items: PlacedText[], s: string) => {
  const t = items.find((i) => i.str.includes(s));
  if (!t) throw new Error(`"${s}" not found in ${JSON.stringify(items.map((i) => i.str))}`);
  return t;
};

const HF: NonNullable<PageMarksOptions['headerFooter']> = {
  headerLeft: '{file}',
  headerRight: 'Pagina {page} din {pages}',
  footerCenter: 'Subsol ăâîșț {page}',
  footerRight: '{bates}',
  fontSize: 10,
  color: '#333333',
  margins: { top: 30, bottom: 25, left: 40, right: 40 },
  bates: { prefix: 'ADK-', suffix: '-R', digits: 6, start: 7 },
  date: new Date(2026, 8, 28),
};

describe('expandMarkTokens', () => {
  const ctx = { page: 3, pages: 12, date: new Date(2026, 0, 5), file: 'contract.pdf', bates: 'X-000042' };
  it('replaces every token', () => {
    expect(expandMarkTokens('{page}/{pages} {date} {file} {bates}', ctx)).toBe('3/12 05.01.2026 contract.pdf X-000042');
  });
  it('repeats, ignores case and keeps unknown tokens and plain text', () => {
    expect(expandMarkTokens('{PAGE}-{page} {foo} ț', ctx)).toBe('3-3 {foo} ț');
    expect(expandMarkTokens('', ctx)).toBe('');
  });
});

describe('openSaveDepth', () => {
  const d = (s: string) => openSaveDepth(new TextEncoder().encode(s));
  it('counts q left open, ignoring strings, comments and inline images', () => {
    expect(d('q 1 0 0 1 0 0 cm Q')).toBe(0);
    expect(d('q q Q')).toBe(1);
    expect(d('q BT (Q) Tj <51> Tj ET % Q\n')).toBe(1);
    expect(d('q (a \\) Q (b) Q) Tj')).toBe(1);
    expect(d('q BI /W 1 /H 1 ID Q Q EI Q')).toBe(0);
    expect(d('Q Q q')).toBe(1);
    expect(d('/q q qq')).toBe(1);
  });
});

describe('addPageMarks', () => {
  it('writes header/footer on the requested pages, upright and in the seen corners', async () => {
    const src = await makeDoc();
    const out = await addPageMarks(src, { pages: [2, 3, 4], headerFooter: HF, fileName: 'dosar.pdf' }, loadFont);

    // Page 1 is outside the range: untouched.
    expect(await texts(out, 1)).toEqual(['Original one']);

    const bates: string[] = [];
    for (const [n, idx] of [[2, 0], [3, 1], [4, 2]] as const) {
      const items = await placedText(out, n);
      find(items, 'Original');
      const footer = find(items, 'Subsol');
      expect(footer.str).toBe(`Subsol ăâîșț ${idx + 1}`);
      const { vw, vh } = footer;
      // Upright, centred at the bottom of what the user sees, baseline at the margin.
      expect(Math.abs(footer.angle)).toBeLessThan(0.5);
      expect(footer.x + footer.width / 2).toBeCloseTo(vw / 2, 0);
      expect(footer.y).toBeCloseTo(vh - 25, 0);

      const right = find(items, 'Pagina');
      expect(right.str).toBe(`Pagina ${idx + 1} din 4`);
      expect(Math.abs(right.angle)).toBeLessThan(0.5);
      expect(right.x + right.width).toBeCloseTo(vw - 40, 0);
      // Text top at the top margin: baseline one ascent (~1.07 em for Noto) below it.
      expect(right.y).toBeGreaterThan(30 + 7);
      expect(right.y).toBeLessThan(30 + 12);

      const left = find(items, 'dosar.pdf');
      expect(left.x).toBeCloseTo(40, 0);
      expect(left.y).toBeCloseTo(right.y, 1);

      bates.push(find(items, 'ADK-').str);
    }
    expect(bates).toEqual(['ADK-000007-R', 'ADK-000008-R', 'ADK-000009-R']);
  });

  it('keeps the rotated page landscape-sized and the cropped page offset right', async () => {
    const out = await addPageMarks(await makeDoc(), { headerFooter: HF }, loadFont);
    const p2 = find(await placedText(out, 2), 'Subsol');
    expect([p2.vw, p2.vh]).toEqual([800, 600]);
    const p3 = find(await placedText(out, 3), 'Subsol');
    expect([p3.vw, p3.vh]).toEqual([500, 600]);
    expect(p3.x + p3.width / 2).toBeCloseTo(250, 0);
    expect(p3.y).toBeCloseTo(575, 0);
  });

  it('centres a rotated text watermark with diacritics on every page', async () => {
    const out = await addPageMarks(
      await makeDoc(),
      {
        watermark: {
          kind: 'text',
          text: 'CONFIDENȚIAL ăâîșț',
          fontSize: 48,
          color: '#ff0000',
          opacity: 0.3,
          rotation: 45,
          position: 'center',
          behind: false,
          font: { family: 'serif', bold: true, italic: false },
        },
      },
      loadFont,
    );
    for (const n of [1, 2, 3, 4]) {
      const items = await placedText(out, n);
      const wm = find(items, 'CONFIDEN');
      expect(wm.str).toBe('CONFIDENȚIAL ăâîșț');
      expect(wm.angle).toBeCloseTo(45, 0);
      // Midpoint of the baseline sits a little below/left of the centre (cap height / 2).
      const t = (45 * Math.PI) / 180;
      const midX = wm.x + (Math.cos(t) * wm.width) / 2;
      const midY = wm.y - (Math.sin(t) * wm.width) / 2;
      expect(Math.hypot(midX - wm.vw / 2, midY - wm.vh / 2)).toBeLessThan(48 * 0.4);
      find(items, 'Original');
    }
  });

  it('places top/bottom watermarks inside the visible page', async () => {
    const wm = { kind: 'text' as const, text: 'SUS', fontSize: 40, opacity: 1, rotation: 0, behind: true };
    const top = await addPageMarks(await makeDoc(), { watermark: { ...wm, position: 'top' } }, loadFont);
    const bottom = await addPageMarks(await makeDoc(), { watermark: { ...wm, position: 'bottom' } }, loadFont);
    for (const n of [2, 3]) {
      const t = find(await placedText(top, n), 'SUS');
      expect(t.y).toBeGreaterThan(36);
      expect(t.y).toBeLessThan(36 + 40);
      const b = find(await placedText(bottom, n), 'SUS');
      expect(b.y).toBeCloseTo(b.vh - 36, 0);
    }
  });

  it('writes each mark as its own tagged stream, behind marks first', async () => {
    const out = await addPageMarks(
      await makeDoc(),
      {
        pages: [1],
        background: { color: '#fff4cc', opacity: 1 },
        watermark: { kind: 'image', imageBytes: PNG, opacity: 0.5, rotation: 0, position: 'center', behind: true },
        headerFooter: { ...HF, headerLeft: undefined, headerRight: undefined },
      },
      loadFont,
    );
    const doc = await PDFDocument.load(out);
    const contents = doc.getPage(0).node.Contents() as PDFArray;
    const heads = contents.asArray().map((r) => {
      const s = doc.context.lookup(r as PDFRef) as PDFRawStream;
      const tagged = s.dict.get(PDFName.of('AdikaMark')) === PDFBool.True;
      return { tagged, text: new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) };
    });
    const subtype = (t: string) => /\/Subtype\s*\/(\w+)/.exec(t)?.[1];
    expect(heads[0].tagged && subtype(heads[0].text)).toBe('Background');
    expect(heads[1].tagged && subtype(heads[1].text)).toBe('Watermark');
    expect(heads[heads.length - 1].tagged && subtype(heads[heads.length - 1].text)).toBe('Footer');
    for (const h of heads.filter((x) => x.tagged)) {
      expect(h.text).toMatch(/^\/Artifact\s*<<[^]*\/Type \/Pagination[^]*\/AdikaMark true[^]*>>\s*BDC\s+q\b/);
      expect(h.text.trimEnd()).toMatch(/Q\s+EMC$/);
    }
    // Image watermark: half the page width, square (1x1 image), centred.
    expect(heads[1].text).toMatch(/300 0 0 300 -150 -150 cm/);
    expect(heads[1].text).toMatch(/\/ca 0\.5|gs/);
    const pdf = await openPdf(out);
    const ops = await (await pdf.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject);
  });

  it('keeps unbalanced existing content from moving the marks', async () => {
    const out = await addPageMarks(await makeDoc(), { pages: [4], headerFooter: HF }, loadFont);
    const f = find(await placedText(out, 1 + 3), 'Subsol');
    expect(f.x + f.width / 2).toBeCloseTo(595 / 2, 0);
    expect(f.y).toBeCloseTo(842 - 25, 0);
  });
});

describe('removePageMarks / hasPageMarks', () => {
  it('removes exactly the marks and restores the original text', async () => {
    const src = await makeDoc();
    expect(await hasPageMarks(src)).toBe(false);
    const marked = await addPageMarks(
      src,
      {
        pages: [1, 2, 4],
        background: { color: '#eeeeee', opacity: 0.5 },
        watermark: { kind: 'text', text: 'CIORNĂ', opacity: 0.2, rotation: 30, position: 'center', behind: false },
        headerFooter: HF,
      },
      loadFont,
    );
    expect(await hasPageMarks(marked)).toBe(true);
    // 3 pages x (background + watermark + header + footer)
    const { bytes, removed } = await removePageMarks(marked);
    expect(removed).toBe(12);
    expect(await hasPageMarks(bytes)).toBe(false);
    for (const n of [1, 2, 3, 4]) expect(await texts(bytes, n)).toEqual(await texts(src, n));
    const again = await removePageMarks(bytes);
    expect(again.removed).toBe(0);
  });

  it('marks can be added twice and all are removed', async () => {
    const opts: PageMarksOptions = { watermark: { kind: 'text', text: 'A', opacity: 1, rotation: 0, position: 'center', behind: false } };
    const twice = await addPageMarks(await addPageMarks(await makeDoc(), opts, loadFont), opts, loadFont);
    const { bytes, removed } = await removePageMarks(twice);
    expect(removed).toBe(8);
    expect(await texts(bytes, 4)).toEqual(['Original four']);
  });
});
