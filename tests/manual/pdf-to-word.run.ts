// Manual harness (not part of `npm test`): W2D_IN=<pdf> W2D_OUT=<dir> npx vitest run --config tests/manual/vitest.config.ts
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';
import { extractStructuredText } from '../../src/lib/pdf/convert';
import { collectDocxGraphics, exportToDocx } from '../../src/lib/pdf/docx';

const g = globalThis as Record<string, unknown>;
g.OffscreenCanvas ??= function OffscreenCanvas(w: number, h: number) {
  const c = createCanvas(w, h) as unknown as Record<string, unknown>;
  c.convertToBlob = async ({ type }: { type?: string } = {}) => {
    const png = type !== 'image/jpeg';
    const buf = await (c as unknown as { encode(f: string, q?: number): Promise<Buffer> }).encode(png ? 'png' : 'jpeg', 90);
    return new Blob([new Uint8Array(buf)], { type: png ? 'image/png' : 'image/jpeg' });
  };
  return c;
};
g.ImageData ??= NapiImageData;

it('converts', async () => {
  const input = process.env.W2D_IN!;
  const outDir = process.env.W2D_OUT!;
  for (const file of input.split(';')) {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
    const base = basename(file, '.pdf');
    for (const layout of ['flow', 'exact'] as const) {
      const pages = await extractStructuredText(pdf, undefined, { detectBold: true });
      const graphics = await collectDocxGraphics(pdf, pages);
      const blob = await exportToDocx(pages, base, { layout, graphics });
      writeFileSync(join(outDir, `${base}-${layout}.docx`), new Uint8Array(await blob.arrayBuffer()));
    }
    await pdf.loadingTask.destroy();
  }
}, 600_000);


