/** Convert → Batch: one operation or a saved action sequence on many PDF files, results saved next to the originals. */
import { BATCH_OPS, BatchSkip, outputPath, runBatchOp, runSequence, sequenceSuffix, type ActionSequence, type BatchOp } from '@/lib/batch';
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

export async function ocrBytes(bytes: Uint8Array, lang: string): Promise<Uint8Array> {
  const [{ openPdf }, { ocrPages, makeSearchable }] = await Promise.all([import('@/lib/pdf/pdfService'), import('@/lib/pdf/ocr')]);
  const pdf = await openPdf(bytes.slice());
  try {
    const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const results = await ocrPages(pdf, { pageNumbers, dpi: 300, lang, straighten: true });
    return await makeSearchable(bytes, results);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export async function runBatch(
  paths: string[],
  job: BatchOp | ActionSequence,
  onProgress: (done: number, total: number, current: string) => void,
  cancelled: () => boolean = () => false,
): Promise<BatchResult[]> {
  const sequence = 'steps' in job ? job : null;
  const suffix = sequence ? sequenceSuffix(sequence.name) : BATCH_OPS.find((o) => o.kind === (job as BatchOp).kind)!.suffix;
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
      const { colorHooks } = await import('./printProduction');
      const ctx = { fileName: baseName(input), loadFont: loadFontBytes, ocr: ocrBytes, colorHooks };
      const r = sequence ? await runSequence(bytes, sequence.steps, ctx) : await runBatchOp(bytes, job as BatchOp, ctx);
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

// ---------------------------------------------------------------- saved sequences

const SEQ_KEY = 'adika.actionSequences';

export function loadSequences(): ActionSequence[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEQ_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as ActionSequence[]).filter((s) => s && typeof s.name === 'string' && Array.isArray(s.steps)) : [];
  } catch {
    return [];
  }
}

/** Saves (or replaces, by name) a sequence. Passwords are never stored. */
export function saveSequence(seq: Omit<ActionSequence, 'id'> & { id?: string }): ActionSequence[] {
  const clean: ActionSequence = {
    id: seq.id ?? `seq-${Date.now().toString(36)}`,
    name: seq.name.trim(),
    steps: seq.steps.map((s) => (s.kind === 'protect' ? { kind: 'protect', userPassword: '' } : s)),
  };
  const list = loadSequences().filter((s) => s.id !== clean.id && s.name.toLowerCase() !== clean.name.toLowerCase());
  list.push(clean);
  list.sort((a, b) => a.name.localeCompare(b.name));
  try {
    localStorage.setItem(SEQ_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: kept for this session only */
  }
  return list;
}

export function deleteSequence(id: string): ActionSequence[] {
  const list = loadSequences().filter((s) => s.id !== id);
  try {
    localStorage.setItem(SEQ_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
