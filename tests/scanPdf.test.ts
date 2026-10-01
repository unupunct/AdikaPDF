import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildScanPdf, pageRole, separatorSheet, splitPages } from '@/lib/scan/scanPdf';
import { readCode128 } from '@/lib/barcode/code128';
import { binarize, toGray } from '@/lib/scan/cleanup';

const WASM = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'wasm').split('\\').join('/') + '/';
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
async function open(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, wasmUrl: WASM });
  tasks.push(task);
  return task.promise;
}
/** Renders a page like a 150 DPI scan. */
async function scan(pdf: Awaited<ReturnType<typeof open>>, n: number) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 150 / 72 });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g as never, viewport: vp, canvas: null as never }).promise;
  const d = g.getImageData(0, 0, c.width, c.height);
  return { data: new Uint8ClampedArray(d.data), width: c.width, height: c.height };
}

describe('scan to PDF', () => {
  it('prints separator sheets whose barcode is read back from a scan (names folded to ASCII)', async () => {
    const pdf = await open(await separatorSheet(['Factură 114 Sibiu', null]));
    expect(pdf.numPages).toBe(2);
    const s1 = await scan(pdf, 1);
    expect(readCode128(binarize(toGray(s1)), s1.width, s1.height)).toEqual(['ADIKA:SPLIT:Factura 114 Sibiu']);
    const s2 = await scan(pdf, 2);
    expect(readCode128(binarize(toGray(s2)), s2.width, s2.height)).toEqual(['ADIKA:SPLIT']);
  });

  it('splits at separator sheets (named) and blank pages', () => {
    const C = pageRole([], false);
    const B = pageRole([], true);
    const S = (n?: string) => pageRole([n ? `ADIKA:SPLIT:${n}` : 'ADIKA:SPLIT', 'OTHER'], false);
    expect(S('Contract').kind).toBe('separator');
    const roles = [C, C, S('Anexa 1'), C, B, C, S(), S('Gol'), C];
    expect(splitPages(roles, { atBlank: false, dropBlank: true })).toEqual([
      { name: null, pages: [0, 1] },
      { name: 'Anexa 1', pages: [3, 5] },
      { name: 'Gol', pages: [8] }, // an empty group between two separators is skipped
    ]);
    expect(splitPages(roles, { atBlank: true, dropBlank: true })).toEqual([
      { name: null, pages: [0, 1] },
      { name: 'Anexa 1', pages: [3] },
      { name: null, pages: [5] },
      { name: 'Gol', pages: [8] }, // an empty group between two separators is skipped
    ]);
    expect(splitPages([C, B, C], { atBlank: false, dropBlank: false })).toEqual([{ name: null, pages: [0, 1, 2] }]);
  });

  it('builds a PDF sized from the resolution: JPEG colour pages, Group 4 black-and-white pages', async () => {
    const w = 1240;
    const h = 1754; // A4 at 150 DPI
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.font = '30px serif';
    for (let i = 0; i < 30; i++) g.fillText('Un rând de text scanat, alb-negru, pentru compresia Group 4.', 100, 150 + i * 45);
    const d = g.getImageData(0, 0, w, h);
    const bits = binarize(toGray({ data: new Uint8ClampedArray(d.data), width: w, height: h }));
    const jpeg = new Uint8Array(c.toBuffer('image/jpeg', 80));
    const bytes = await buildScanPdf(
      [
        { kind: 'bits', bits, width: w, height: h, dpi: 150 },
        { kind: 'jpeg', bytes: jpeg, width: w, height: h, dpi: 150 },
      ],
      { title: 'Scan' },
    );
    const pdf = await open(bytes);
    expect(pdf.numPages).toBe(2);
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
    expect(vp.width).toBeCloseTo(595.2, 0);
    expect(vp.height).toBeCloseTo(841.9, 0);
    // The bitonal page is far smaller than the JPEG of the same page.
    expect(bytes.length - jpeg.length).toBeLessThan(jpeg.length / 3);
    const back = await scan(pdf, 1);
    const bb = binarize(toGray(back));
    let ink = 0;
    for (const v of bb) ink += v;
    expect(ink).toBeGreaterThan(20000);
  });
});
