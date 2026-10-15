/**
 * Benchmark for very large documents (not part of `npm test`):
 *   LARGE_DIR=<folder for the generated files> npx vitest run --config tests/manual/vitest.config.ts tests/manual/largeDocs.run.ts
 * LARGE_MODE=eager measures the old way (getPage for every page before the
 * document shows), the default `lazy` the page size loader used since 1.14.
 */
import { it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { containsToken, firstPagesToRead, loadPageSizes } from '../../src/lib/pdf/pageSizes';
import { verifyPdfSignatures } from '../../src/lib/crypto/digitalSignature';
import { readPortfolio } from '../../src/lib/pdf/portfolio';
import { buildPdf } from '../../src/lib/pdf/exportPdf';
import type { EditorObject, PageRef } from '../../src/types';

const DIR = process.env.LARGE_DIR ?? join(tmpdir(), 'adika-large-docs');
const MODE = process.env.LARGE_MODE ?? 'lazy';

async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    // Mixed sizes: every 50th page is landscape A4, every 7th has /Rotate 90.
    const p = doc.addPage(i % 50 === 0 ? [842, 595] : [595, 842]);
    if (i % 7 === 0) p.setRotation({ type: 'degrees', angle: 90 } as never);
    p.drawText(`Page ${i} of the large document`, { x: 60, y: 520, size: 18, font });
    for (let l = 0; l < 20; l++) p.drawText(`Line ${l + 1}: lorem ipsum dolor sit amet ${i * 100 + l}`, { x: 60, y: 500 - l * 16, size: 10, font });
  }
  return doc.save({ objectsPerTick: 2000 });
}

/** One distinct uncompressed RGB image per page (~`kb` KB each): a file of hundreds of MB. */
async function imagePdf(pages: number, kb: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const side = Math.round(Math.sqrt((kb * 1024) / 3));
  for (let i = 0; i < pages; i++) {
    const data = new Uint8Array(side * side * 3);
    let x = i * 2654435761;
    for (let j = 0; j < data.length; j += 64) data[j] = (x = (x * 1103515245 + 12345) >>> 0) & 255;
    const img = doc.context.register(doc.context.stream(data, { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const p = doc.addPage([595, 842]);
    p.node.setXObject(PDFName.of('Im0'), img);
    p.pushOperators();
    const content = doc.context.register(doc.context.stream(`q 500 0 0 500 47 171 cm /Im0 Do Q`));
    p.node.set(PDFName.of('Contents'), content);
  }
  return doc.save({ objectsPerTick: 2000, useObjectStreams: false });
}

async function file(name: string, make: () => Promise<Uint8Array>): Promise<Uint8Array> {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, name);
  if (!existsSync(path)) writeFileSync(path, await make());
  return new Uint8Array(readFileSync(path));
}

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

async function measure(label: string, bytes: Uint8Array) {
  global.gc?.();
  const m0 = process.memoryUsage();
  const t0 = performance.now();
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, disableFontFace: true }).promise;
  const tOpen = performance.now() - t0;
  let tFirst = 0;
  let tAll = 0;
  if (MODE === 'eager') {
    for (let i = 0; i < doc.numPages; i++) {
      const p = await doc.getPage(i + 1);
      void p.view;
      void p.rotate;
    }
    tFirst = tAll = performance.now() - t0;
  } else {
    const first = firstPagesToRead(doc.numPages);
    let done = 0;
    await loadPageSizes(doc, first, () => undefined);
    tFirst = performance.now() - t0;
    const rest = Array.from({ length: doc.numPages - first.length }, (_, i) => i + first.length);
    await loadPageSizes(doc, rest, (b) => (done += b.length));
    tAll = performance.now() - t0;
  }
  const m1 = process.memoryUsage();
  const p = await doc.getPage(Math.min(doc.numPages, 4000));
  const t2 = performance.now();
  await p.getOperatorList();
  const tFar = performance.now() - t2;
  const line =
    `${label.padEnd(26)} ${MODE.padEnd(5)} | file ${mb(bytes.length).padStart(7)} | pages ${String(doc.numPages).padStart(6)} | open ${tOpen.toFixed(0).padStart(5)} ms | first screen ${tFirst.toFixed(0).padStart(6)} ms | all sizes ${tAll.toFixed(0).padStart(6)} ms | heap +${mb(m1.heapUsed - m0.heapUsed)} rss +${mb(m1.rss - m0.rss)} | page ~4000 ops ${tFar.toFixed(0)} ms`;
  console.log(line);
  appendFileSync(join(DIR, 'results.txt'), `${line}\n`);
  // Work the app does right after opening (signature status, portfolio / e-invoice check).
  const t3 = performance.now();
  if (MODE === 'eager' || containsToken(bytes, '/ByteRange')) await verifyPdfSignatures(bytes).catch(() => []);
  const tSig = performance.now() - t3;
  const t4 = performance.now();
  const atts = await doc.getAttachments();
  const tAtt = performance.now() - t4;
  const t5 = performance.now();
  if (MODE === 'eager' || atts) await readPortfolio(bytes);
  const tPortfolio = performance.now() - t5;
  const after = `${''.padEnd(26)} ${MODE.padEnd(5)} | after open: signatures ${tSig.toFixed(0)} ms, attachments ${tAtt.toFixed(0)} ms (${atts ? 'some' : 'none'}), pdf-lib portfolio check ${tPortfolio.toFixed(0)} ms`;
  console.log(after);
  appendFileSync(join(DIR, 'results.txt'), `${after}\n`);
  await doc.loadingTask.destroy();
  if (process.env.LARGE_SAVE) await save(label, bytes);
}

/** Saving with one rectangle on page ~4,000: time, progress calls, memory. */
async function save(label: string, bytes: Uint8Array) {
  const count = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  const pages: PageRef[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, kind: 'source', sourceId: 's', sourceIndex: i, baseRotation: 0, userRotation: 0, width: 595, height: 842 }));
  const target = pages[Math.min(3999, count - 1)].id;
  const objects = [{ id: 'r', type: 'rect', pageId: target, x: 50, y: 50, width: 100, height: 60, rotation: 0, opacity: 1, stroke: '#ff0000', strokeWidth: 2, fill: null }] as unknown as EditorObject[];
  let calls = 0;
  let peak = 0;
  const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  const r0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const out = await buildPdf(
    { sources: { s: { id: 's', name: 'big.pdf', bytes, pageCount: count } }, pages, objects, fieldValues: {} },
    { measure: () => (t: string) => t.length * 5, loadFont: async () => new Uint8Array(), onProgress: () => void calls++ },
  );
  clearInterval(watch);
  const line = `${label.padEnd(26)} ${MODE.padEnd(5)} | save ${(performance.now() - t0).toFixed(0)} ms, ${mb(out.length)} out, ${calls} progress calls, rss peak +${mb(Math.max(0, peak - r0))}`;
  console.log(line);
  appendFileSync(join(DIR, 'results.txt'), `${line}\n`);
}

it('large documents', async () => {
  for (const n of [1000, 5000, 10000]) await measure(`${n} text pages`, await file(`text-${n}.pdf`, () => textPdf(n)));
  await measure('600 image pages', await file('images-600.pdf', () => imagePdf(600, 400)));
}, 1_800_000);
