/** Convert → Batch: one operation on many PDF files, results saved next to the originals. */
import { BATCH_OPS, BatchSkip, outputPath, runBatchOp, type BatchOp } from '@/lib/batch';
import { loadFontBytes } from '@/lib/fonts';
import { fileStamp, pickPaths, readFile, writeFile } from '@/lib/platform';

export interface BatchResult {
  input: string;
  status: 'done' | 'skipped' | 'failed';
  output?: string;
  message?: string;
}

export async function pickBatchFiles(): Promise<string[]> {
  return pickPaths([{ name: 'PDF documents', extensions: ['pdf'] }], true);
}

async function ocrBytes(bytes: Uint8Array, lang: string): Promise<Uint8Array> {
  const [{ openPdf }, { ocrPages, makeSearchable }] = await Promise.all([import('@/lib/pdf/pdfService'), import('@/lib/pdf/ocr')]);
  const pdf = await openPdf(bytes.slice());
  try {
    const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const results = await ocrPages(pdf, { pageNumbers, dpi: 300, lang });
    return await makeSearchable(bytes, results);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export async function runBatch(paths: string[], op: BatchOp, onProgress: (done: number, total: number, current: string) => void, cancelled: () => boolean = () => false): Promise<BatchResult[]> {
  const suffix = BATCH_OPS.find((o) => o.kind === op.kind)!.suffix;
  const results: BatchResult[] = [];
  for (let i = 0; i < paths.length; i++) {
    const input = paths[i];
    if (cancelled()) {
      results.push({ input, status: 'skipped', message: 'cancelled' });
      continue;
    }
    onProgress(i, paths.length, baseName(input));
    try {
      const bytes = await readFile(input);
      const r = await runBatchOp(bytes, op, { fileName: baseName(input), loadFont: loadFontBytes, ocr: ocrBytes });
      const output = await outputPath(input, suffix, async (p) => (await fileStamp(p)) !== null);
      await writeFile(output, r.bytes);
      results.push({ input, status: 'done', output, message: r.note });
    } catch (e) {
      results.push({ input, status: e instanceof BatchSkip ? 'skipped' : 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }
  onProgress(paths.length, paths.length, '');
  return results;
}
