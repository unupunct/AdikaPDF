/** Forms → Mail merge: the open form filled once per row of a CSV / Excel table. */
import JSZip from 'jszip';
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf } from './document';
import { loadFontBytes } from '@/lib/fonts';
import { combineMerged, fileNameFor, formFieldNames, mergeRow, readTable, type DataTable } from '@/lib/mailMerge';
import { fileStamp, isDesktop, pickFiles, pickFolder, saveBytes, writeFile } from '@/lib/platform';

export interface MergeJob {
  table: DataTable;
  mapping: Record<string, string>;
  flatten: boolean;
  /** One PDF per row (in a folder, or a ZIP in the browser) or everything in one PDF. */
  output: 'files' | 'combined';
  /** File name pattern with {Column} and {#}. */
  pattern: string;
}

export interface MergeResult {
  written: number;
  target: string | null;
  problems: string[];
}

/** The fillable fields of the open document (with its unsaved changes). */
export async function currentFormFields(): Promise<string[]> {
  return formFieldNames(await exportCurrentPdf());
}

export async function pickMergeTable(): Promise<{ name: string; table: DataTable } | null> {
  const f = (await pickFiles([{ name: 'Tables (CSV, Excel)', extensions: ['csv', 'txt', 'xlsx'] }]))[0];
  if (!f) return null;
  return { name: f.name, table: await readTable(f.name, f.bytes) };
}

/** Rows whose file names collide get " (2)", " (3)"… */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    return count === 1 ? n : n.replace(/\.pdf$/i, ` (${count}).pdf`);
  });
}

export async function runMailMerge(job: MergeJob, onProgress: (done: number, total: number) => void, cancelled: () => boolean = () => false): Promise<MergeResult | null> {
  const store = usePDFStore.getState();
  const rows = job.table.rows;
  if (!rows.length) throw new Error('The table has no rows.');
  // Pick where to write first, so nothing is computed for nothing.
  let folder: string | null = null;
  if (job.output === 'files' && isDesktop) {
    folder = await pickFolder();
    if (!folder) return null;
  }
  const template = await exportCurrentPdf();
  const base = (store.fileName ?? 'form.pdf').replace(/\.pdf$/i, '');
  const names = uniqueNames(rows.map((r, i) => fileNameFor(job.pattern || `${base} {#}`, r, i)));
  const problems: string[] = [];
  const parts: Uint8Array[] = [];
  const zip = folder || job.output === 'combined' ? null : new JSZip();
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    if (cancelled()) break;
    onProgress(i, rows.length);
    // Several copies of one form in one file would share their fields: combined output is flattened.
    const r = await mergeRow(template, rows[i], { mapping: job.mapping, flatten: job.flatten || job.output === 'combined', loadFont: loadFontBytes });
    problems.push(...r.problems.map((p) => `Row ${i + 1}: ${p}`));
    if (job.output === 'combined') parts.push(r.bytes);
    else if (zip) zip.file(names[i], r.bytes);
    else {
      let path = `${folder}\\${names[i]}`;
      for (let n = 2; (await fileStamp(path)) !== null; n++) path = `${folder}\\${names[i].replace(/\.pdf$/i, ` (${n}).pdf`)}`;
      await writeFile(path, r.bytes);
    }
    written++;
  }
  onProgress(rows.length, rows.length);
  let target: string | null = folder;
  if (job.output === 'combined' && parts.length) {
    target = await saveBytes(await combineMerged(parts), `${base}-merged.pdf`, [{ name: 'PDF document', extensions: ['pdf'] }]);
  } else if (zip && written) {
    target = await saveBytes(await zip.generateAsync({ type: 'uint8array' }), `${base}-merged.zip`, [{ name: 'ZIP archive', extensions: ['zip'] }]);
  }
  return { written, target, problems };
}
