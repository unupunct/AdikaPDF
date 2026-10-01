import { afterAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { join } from 'node:path';
import { encodeG4 } from '@/lib/scan/ccitt';

const WASM = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'wasm').split('\\').join('/') + '/';
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

/** A bitmap page (1 = black) with text, lines, a box and a long black run. */
function bitmap(w: number, h: number): Uint8Array {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#000';
  g.font = '28px sans-serif';
  for (let i = 0; i < 8; i++) g.fillText(`Linia ${i + 1}: contract, factură și anexe — 0123456789`, 20, 50 + i * 40);
  g.fillRect(0, h - 30, w, 12); // a full-width black line (long runs)
  g.fillRect(w - 60, 20, 40, 300);
  g.strokeRect(10.5, 10.5, w - 21, h - 60);
  const d = g.getImageData(0, 0, w, h).data;
  const bits = new Uint8Array(w * h);
  for (let i = 0; i < bits.length; i++) bits[i] = d[i * 4] < 128 ? 1 : 0;
  return bits;
}

async function roundTrip(bits: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  const img = doc.context.register(
    doc.context.stream(encodeG4(bits, w, h), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 1,
      Filter: 'CCITTFaxDecode',
      DecodeParms: { K: -1, Columns: w, Rows: h, BlackIs1: false },
    }),
  );
  const name = page.node.newXObject('Im', img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject(name), popGraphicsState());
  const task = pdfjs.getDocument({ data: (await doc.save()).slice(), verbosity: 0, wasmUrl: WASM });
  tasks.push(task);
  const p = await (await task.promise).getPage(1);
  const vp = p.getViewport({ scale: 1 });
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  await p.render({ canvasContext: ctx as never, viewport: vp, canvas: null as never }).promise;
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] < 128 ? 1 : 0;
  return out;
}

describe('CCITT Group 4', () => {
  it('encodes a page that pdf.js decodes back pixel for pixel, much smaller than raw bits', async () => {
    const w = 1000;
    const h = 420;
    const bits = bitmap(w, h);
    const g4 = encodeG4(bits, w, h);
    expect(g4.length).toBeLessThan((w * h) / 8 / 6);
    const back = await roundTrip(bits, w, h);
    let diff = 0;
    for (let i = 0; i < bits.length; i++) if (bits[i] !== back[i]) diff++;
    expect(diff).toBe(0);
  });

  it('handles all-white, all-black and very long runs', async () => {
    for (const [w, h, fill] of [
      [300, 10, 0],
      [300, 10, 1],
      [3000, 4, 1],
    ] as const) {
      const bits = new Uint8Array(w * h).fill(fill);
      const back = await roundTrip(bits, w, h);
      expect(back.every((v) => v === fill)).toBe(true);
    }
  });
});
