import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { comparePdfs, diffWords, type DiffOp, type LoadFont } from '@/lib/pdf/compare';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont: LoadFont = (v) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  tasks.push(task);
  return task.promise as unknown as Promise<PDFDocumentProxy>;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

/** Pages of text lines (top to bottom, 20 pt apart). */
async function makePdf(pages: Array<{ lines: string[]; rotate?: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([595, 842]);
    if (p.rotate) page.setRotation(degrees(p.rotate));
    p.lines.forEach((l, i) => page.drawText(l, { x: 72, y: 760 - i * 20, size: 12, font }));
  }
  return doc.save();
}

/** Rebuilds b from a and the ops, checking the ranges are contiguous. */
function apply(a: string[], b: string[], ops: DiffOp[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const o of ops) {
    expect(o.a[0]).toBe(i);
    expect(o.b[0]).toBe(j);
    if (o.op === 'equal') {
      expect(a.slice(o.a[0], o.a[1])).toEqual(b.slice(o.b[0], o.b[1]));
      out.push(...a.slice(o.a[0], o.a[1]));
    } else if (o.op === 'insert') {
      expect(o.a[1]).toBe(o.a[0]);
      out.push(...b.slice(o.b[0], o.b[1]));
    } else {
      expect(o.b[1]).toBe(o.b[0]);
    }
    i = o.a[1];
    j = o.b[1];
  }
  expect(i).toBe(a.length);
  expect(j).toBe(b.length);
  return out;
}

function lcsLength(a: string[], b: string[]): number {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[b.length];
}

const equalCount = (ops: DiffOp[]) => ops.filter((o) => o.op === 'equal').reduce((s, o) => s + o.a[1] - o.a[0], 0);

describe('diffWords', () => {
  it('handles empty and identical inputs', () => {
    expect(diffWords([], [])).toEqual([]);
    expect(diffWords(['a'], [])).toEqual([{ op: 'delete', a: [0, 1], b: [0, 0] }]);
    expect(diffWords([], ['a', 'b'])).toEqual([{ op: 'insert', a: [0, 0], b: [0, 2] }]);
    expect(diffWords(['a', 'b'], ['a', 'b'])).toEqual([{ op: 'equal', a: [0, 2], b: [0, 2] }]);
  });

  it('reports a replacement as delete then insert', () => {
    const ops = diffWords('the quick brown fox'.split(' '), 'the quick red fox'.split(' '));
    expect(ops).toEqual([
      { op: 'equal', a: [0, 2], b: [0, 2] },
      { op: 'delete', a: [2, 3], b: [2, 2] },
      { op: 'insert', a: [3, 3], b: [2, 3] },
      { op: 'equal', a: [3, 4], b: [3, 4] },
    ]);
  });

  it('finds insertions and deletions in the middle', () => {
    const a = 'a b c d e f g'.split(' ');
    const b = 'a b x y c d f g z'.split(' ');
    const ops = diffWords(a, b);
    expect(apply(a, b, ops)).toEqual(b);
    expect(ops.filter((o) => o.op === 'insert').map((o) => b.slice(...o.b))).toEqual([['x', 'y'], ['z']]);
    expect(ops.filter((o) => o.op === 'delete').map((o) => a.slice(...o.a))).toEqual([['e']]);
  });

  it('is minimal on random inputs', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 30; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 60) }, () => 'abcdef'[Math.floor(rnd() * 6)]);
      const b = Array.from({ length: Math.floor(rnd() * 60) }, () => 'abcdef'[Math.floor(rnd() * 6)]);
      const ops = diffWords(a, b);
      expect(apply(a, b, ops)).toEqual(b);
      expect(equalCount(ops)).toBe(lcsLength(a, b));
    }
  });

  it('stays fast and correct on long, heavily edited documents (anchored fallback)', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const a = Array.from({ length: 120_000 }, (_, i) => `w${i}`);
    // Replace ~10% of the words and insert some new ones: edit distance far above the Myers cap.
    const b: string[] = [];
    for (const w of a) {
      const r = rnd();
      if (r < 0.1) b.push(`n${b.length}`);
      else b.push(w);
      if (r > 0.97) b.push(`x${b.length}`);
    }
    const t0 = Date.now();
    const ops = diffWords(a, b);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(apply(a, b, ops)).toEqual(b);
    const kept = b.filter((w) => w.startsWith('w')).length;
    expect(equalCount(ops)).toBe(kept);
  });
});

describe('comparePdfs', () => {
  const oldPages = [
    { lines: ['The quick brown fox jumps over the lazy dog.', 'Second line stays here.', 'This line will be deleted.'] },
    { lines: ['Page two text is unchanged.'] },
  ];
  const newPages = [
    { lines: ['A brand new sentence appears.', 'The quick red fox jumps over the lazy dog.', 'Second line stays here.'] },
    { lines: ['Page two text is unchanged.'] },
    { lines: ['Extra page content here.'] },
  ];

  it('finds replaced, inserted and deleted words and an added page', async () => {
    const oldBytes = await makePdf(oldPages);
    const newBytes = await makePdf(newPages);
    const r = await comparePdfs(await openPdf(oldBytes), oldBytes, await openPdf(newBytes), newBytes, loadFont, { oldName: 'v1.pdf', newName: 'v2.pdf' });
    // Inserted: 5 (sentence) + 1 (red) + 4 (extra page); deleted: 1 (brown) + 5 (line).
    expect(r.inserted).toBe(10);
    expect(r.deleted).toBe(6);
    expect(r.changedPages).toEqual([1, 3]);
    expect(r.pageCountOld).toBe(2);
    expect(r.pageCountNew).toBe(3);

    const pdf = await openPdf(r.bytes);
    expect(pdf.numPages).toBe(4);
    const summary = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(summary).toContain('Comparison');
    expect(summary).toContain('v1.pdf');
    expect(summary).toContain('v2.pdf');
    expect(summary).toContain('Inserted words: 10');
    expect(summary).toContain('Deleted words: 6');
    expect(summary).toMatch(/Changed pages \(new file\): 1, 3/);

    const p2 = await pdf.getPage(2);
    const annots = await p2.getAnnotations();
    const highlights = annots.filter((a) => a.subtype === 'Highlight');
    const notes = annots.filter((a) => a.subtype === 'Text');
    expect(highlights.map((h) => h.contentsObj.str).sort()).toEqual(['Inserted: A brand new sentence appears.', 'Inserted: red\nDeleted: brown']);
    expect(notes.map((n) => n.contentsObj.str)).toEqual(['Deleted: This line will be deleted.']);
    for (const a of [...highlights, ...notes]) expect(a.hasAppearance).toBe(true);

    // The "red" highlight sits on the fox line (y = 740), after "The quick ".
    const items = (await p2.getTextContent()).items as TextItem[];
    const fox = items.find((i) => i.str.startsWith('The quick red'))!;
    const red = highlights.find((h) => h.contentsObj.str.includes('red'))!;
    const [x1, y1, x2, y2] = red.rect;
    const charW = fox.width / fox.str.length;
    expect(y1).toBeLessThan(740);
    expect(y2).toBeGreaterThan(745);
    expect(x1).toBeGreaterThan(72 + charW * 8);
    expect(x2).toBeLessThan(72 + charW * 15);
    // The whole new sentence is one highlight over line 1 (y = 760).
    const sentence = highlights.find((h) => h.contentsObj.str.includes('brand'))!;
    expect(sentence.rect[1]).toBeLessThan(760);
    expect(sentence.rect[3]).toBeGreaterThan(765);
    expect(sentence.quadPoints.length).toBe(8);
    // The deletion note sits at the end of the last remaining line of page 1 (y = 720).
    expect(notes[0].rect[1]).toBeGreaterThan(715);
    expect(notes[0].rect[1]).toBeLessThan(745);

    expect(await (await pdf.getPage(3)).getAnnotations()).toHaveLength(0);
    const p4 = await (await pdf.getPage(4)).getAnnotations();
    expect(p4.map((a) => a.contentsObj.str)).toEqual(['Inserted: Extra page content here.']);
  });

  it('reports no changes for identical documents', async () => {
    const bytes = await makePdf(oldPages);
    const copy = await makePdf(oldPages);
    for (const [a, b] of [
      [bytes, bytes],
      [bytes, copy],
    ]) {
      const r = await comparePdfs(await openPdf(a), a, await openPdf(b), b, loadFont);
      expect(r).toMatchObject({ inserted: 0, deleted: 0, changedPages: [], pageCountOld: 2, pageCountNew: 2 });
      const pdf = await openPdf(r.bytes);
      expect(pdf.numPages).toBe(3);
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
      expect(text).toContain('No differences in the text were found.');
      for (let n = 2; n <= 3; n++) expect(await (await pdf.getPage(n)).getAnnotations()).toHaveLength(0);
    }
  });

  it('treats text moved to the next page as unchanged', async () => {
    const a = await makePdf([{ lines: ['one two three', 'four five six'] }, { lines: ['seven eight'] }]);
    const b = await makePdf([{ lines: ['one two three'] }, { lines: ['four five six', 'seven eight'] }]);
    const r = await comparePdfs(await openPdf(a), a, await openPdf(b), b, loadFont);
    expect(r.inserted + r.deleted).toBe(0);
  });

  it('places highlights on rotated pages in PDF user space', async () => {
    const a = await makePdf([{ lines: ['alpha beta gamma'], rotate: 90 }]);
    const b = await makePdf([{ lines: ['alpha delta gamma'], rotate: 90 }]);
    const r = await comparePdfs(await openPdf(a), a, await openPdf(b), b, loadFont);
    expect(r).toMatchObject({ inserted: 1, deleted: 1, changedPages: [1] });
    const pdf = await openPdf(r.bytes);
    const page = await pdf.getPage(2);
    const [h] = await page.getAnnotations();
    expect(h.subtype).toBe('Highlight');
    const item = (await page.getTextContent()).items[0] as TextItem;
    const charW = item.width / item.str.length;
    // "delta" is characters 6..11 of the line drawn at (72, 760), unrotated in user space.
    const [x1, y1, x2, y2] = h.rect;
    expect(x1).toBeGreaterThan(72 + charW * 5);
    expect(x2).toBeLessThan(72 + charW * 12);
    expect(y1).toBeLessThan(760);
    expect(y2).toBeGreaterThan(766);
    expect(y2 - y1).toBeLessThan(20);
  });
});

describe('redline list of changes', () => {
  it('lists every change with its context after the summary page', async () => {
    const a = await makePdf([{ lines: ['The quick brown fox jumps over the lazy dog.', 'Payment is due in 30 days.'] }]);
    const b = await makePdf([{ lines: ['The quick red fox jumps over the lazy dog.', 'Payment is due in 60 days.'] }]);
    const r = await comparePdfs(await openPdf(a), a, await openPdf(b), b, loadFont, { redline: { title: 'List of changes', page: 'Page {0}' } });
    const doc = await openPdf(r.bytes);
    expect(doc.numPages).toBe(3); // summary, list of changes, the page
    const text = (await (await doc.getPage(2)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(text).toContain('List of changes');
    expect(text).toMatch(/quick\s+brown\s+red\s+fox/);
    expect(text).toMatch(/in\s+30\s+60\s+days/);
    expect(text.match(/Page 1/g)).toHaveLength(2);
  });
});
