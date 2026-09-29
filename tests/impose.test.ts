import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layOut, sheetCount } from '@/lib/pdf/impose';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function doc(n: number, rotateFirst = 0): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = d.addPage([595.28, 841.89]);
    p.drawText(`P${i}`, { x: 60, y: 760, size: 40, font });
    if (i === 1 && rotateFirst) p.setRotation(degrees(rotateFirst));
  }
  return d.save();
}

/** Per output sheet: labels with their position (x, y from the top) and text direction. */
async function sheets(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const pdf = await task.promise;
  const out: Array<{ w: number; h: number; items: Array<{ s: string; x: number; y: number; down: boolean }> }> = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const c = await page.getTextContent();
    const items = c.items
      .filter((it): it is Extract<typeof it, { str: string }> => 'str' in it && /^P\d+$/.test(it.str))
      .map((it) => {
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        return { s: it.str, x, y, down: it.transform[1] < 0 };
      });
    out.push({ w: vp.width, h: vp.height, items });
  }
  return out;
}

const labels = (s: { items: Array<{ s: string; x: number; y: number }> }) =>
  [...s.items].sort((a, b) => Math.round(a.y / 50) - Math.round(b.y / 50) || a.x - b.x).map((i) => i.s);

describe('print layouts', () => {
  it('4 pages per sheet, reading order across', async () => {
    const out = await sheets(await layOut(await doc(6), { kind: 'nup', perSheet: 4, sheet: 'A4', order: 'across', borders: true }));
    expect(out).toHaveLength(2);
    expect(labels(out[0])).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(labels(out[1])).toEqual(['P5', 'P6']);
    expect(out[0].h).toBeGreaterThan(out[0].w); // portrait sheet
  });

  it('2 pages per sheet turns the sheet to landscape', async () => {
    const out = await sheets(await layOut(await doc(2), { kind: 'nup', perSheet: 2, sheet: 'A4', order: 'across', borders: false }));
    expect(out).toHaveLength(1);
    expect(out[0].w).toBeGreaterThan(out[0].h);
    expect(labels(out[0])).toEqual(['P1', 'P2']);
  });

  it('booklet: pages imposed for folding, padded to a multiple of 4', async () => {
    const eight = await sheets(await layOut(await doc(8), { kind: 'booklet', sheet: 'A4' }));
    expect(eight.map(labels)).toEqual([
      ['P8', 'P1'],
      ['P2', 'P7'],
      ['P6', 'P3'],
      ['P4', 'P5'],
    ]);
    const six = await sheets(await layOut(await doc(6), { kind: 'booklet', sheet: 'A4' }));
    expect(six.map(labels)).toEqual([['P1'], ['P2'], ['P6', 'P3'], ['P4', 'P5']]);
    expect(sheetCount(6, { kind: 'booklet', sheet: 'A4' })).toBe(4);
  });

  it('poster: one page at 200% over 3 x 3 A4 sheets, the top-left tile shows the top-left corner', async () => {
    const out = await sheets(await layOut(await doc(1), { kind: 'poster', scale: 2, sheet: 'A4', overlapMm: 10, marks: true }));
    expect(out).toHaveLength(9);
    expect(out[0].items.map((i) => i.s)).toEqual(['P1']);
    expect(out.slice(1).every((s) => s.items.length === 0)).toBe(true);
  });

  it('rotated pages keep their orientation', async () => {
    const out = await sheets(await layOut(await doc(2, 90), { kind: 'nup', perSheet: 2, sheet: 'A4', order: 'across', borders: false }));
    const p1 = out[0].items.find((i) => i.s === 'P1')!;
    const p2 = out[0].items.find((i) => i.s === 'P2')!;
    expect(p1.down).toBe(true); // shown turned a quarter clockwise, as in the viewer
    expect(p2.down).toBe(false);
  });

  it('page ranges without a layout just pick the pages', async () => {
    const out = await sheets(await layOut(await doc(5), { kind: 'normal' }, [1, 3]));
    expect(out.map(labels)).toEqual([['P2'], ['P4']]);
  });
});
