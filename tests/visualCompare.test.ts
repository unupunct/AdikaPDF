import { afterAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { diffRasters, visualCompareReport, type Raster } from '@/lib/pdf/visualCompare';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function makePdf(opts: { word: string; boxX: number; pages?: number }): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 1); i++) {
    const p = d.addPage([300, 200]);
    p.drawText(`Total: ${opts.word}`, { x: 20, y: 160, size: 16, font: f });
    p.drawText('Unchanged footer line', { x: 20, y: 20, size: 10, font: f });
    p.drawRectangle({ x: opts.boxX, y: 80, width: 40, height: 30, color: rgb(0.2, 0.5, 0.2) });
  }
  return d.save();
}

async function rasters(bytes: Uint8Array): Promise<Array<() => Promise<Raster>>> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, disableFontFace: true, useSystemFonts: false });
  tasks.push(task);
  const pdf = await task.promise;
  return Array.from({ length: pdf.numPages }, (_, i) => async () => {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 100 / 72 });
    const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx as never, viewport: vp, canvas: null as never }).promise;
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    return { data: img.data, width: img.width, height: img.height, widthPt: 300, heightPt: 200 };
  });
}

describe('visual compare', () => {
  it('finds nothing between identical renderings', async () => {
    const [a] = await rasters(await makePdf({ word: '100', boxX: 100 }));
    const [b] = await rasters(await makePdf({ word: '100', boxX: 100 }));
    const d = diffRasters(await a(), await b());
    expect(d.changed).toBe(0);
    expect(d.boxes).toEqual([]);
  });

  it('boxes a changed number and a moved shape; ink colours tell old from new', async () => {
    const [a] = await rasters(await makePdf({ word: '100', boxX: 100 }));
    const [b] = await rasters(await makePdf({ word: '180', boxX: 180 }));
    const ra = await a();
    const d = diffRasters(ra, await b());
    const px = 100 / 72;
    // The changed number (top) and the shape (old place + new place, far apart) — not the footer.
    expect(d.boxes.length).toBeGreaterThanOrEqual(2);
    expect(d.boxes.every((bx) => bx.y + bx.height < (200 - 20 - 12) * px)).toBe(true);
    const inBox = (x: number, y: number) => d.boxes.some((bx) => x >= bx.x && x <= bx.x + bx.width && y >= bx.y && y <= bx.y + bx.height);
    expect(inBox(200 * px, (200 - 95) * px)).toBe(true); // the shape's new place
    expect(inBox(120 * px, (200 - 95) * px)).toBe(true); // its old place
    // Only-new ink is blue, only-old ink is red.
    const at = (x: number, y: number) => Array.from(d.overlay.subarray((Math.round(y * px) * d.width + Math.round(x * px)) * 3, (Math.round(y * px) * d.width + Math.round(x * px)) * 3 + 3));
    const newInk = at(200, 200 - 95);
    const oldInk = at(120, 200 - 95);
    expect(newInk[2]).toBeGreaterThan(newInk[0] + 60);
    expect(oldInk[0]).toBeGreaterThan(oldInk[2] + 60);
  });

  it('writes a report: summary, one overlay page per page, extra pages flagged', async () => {
    const old = await rasters(await makePdf({ word: '100', boxX: 100, pages: 1 }));
    const neu = await rasters(await makePdf({ word: '180', boxX: 100, pages: 2 }));
    const r = await visualCompareReport(old, neu, { oldName: 'contract-v1.pdf', newName: 'contract-v2.pdf' });
    expect(r.changedPages).toEqual([1, 2]);
    if (process.env.VC_OUT) (await import('node:fs')).writeFileSync(process.env.VC_OUT, r.bytes);
    const task = pdfjs.getDocument({ data: r.bytes.slice(), verbosity: 0 });
    tasks.push(task);
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(3);
    const text = async (n: number) => (await (await pdf.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(await text(1)).toMatch(/Visual comparison[\s\S]*contract-v1\.pdf[\s\S]*on pages 1, 2/);
    expect(await text(2)).toMatch(/Page 1: \d+ changed area/);
    expect(await text(3)).toContain('Page 2: only in the new version');
  });
});
