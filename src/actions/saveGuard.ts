/**
 * Guarded saving: every operation that writes a result file goes through
 * `saveFile`, so a failed write (file locked, access denied, disk full) shows
 * an error toast with the reason and a "Save as…" retry to another location.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { saveBytes, type FileFilter } from '@/lib/platform';
import { errorText, log } from '@/lib/log';

/** A readable reason for a failed write (Windows error codes in the Rust message). */
export function saveErrorReason(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unexpected error';
  const code = /os error (\d+)/.exec(text)?.[1];
  switch (code) {
    case '5':
      return 'Access was denied. The file may be read-only or the folder protected.';
    case '32':
    case '33':
      return 'The file is open in another program.';
    case '39':
    case '112':
      return 'The disk is full.';
    case '3':
      return 'The folder does not exist.';
    default:
      return text;
  }
}

export interface SaveFileOptions {
  /** Overwrite this path instead of asking where to save. */
  existingPath?: string | null;
  /** Run by the toast's "Save as…" button instead of saving the same bytes again. */
  retry?: () => unknown;
  /** Toast shown after a successful write; `false` for none (the caller shows its own). */
  successMessage?: string | false;
}

/**
 * Writes `bytes` like `saveBytes`, but never throws: a failure is logged and
 * shown. Returns the path ('downloaded' in a browser), or null when cancelled or failed.
 */
export async function saveFile(bytes: Uint8Array | Blob, suggestedName: string, filters: FileFilter[], opts: SaveFileOptions = {}): Promise<string | null> {
  let path: string | null;
  try {
    path = await saveBytes(bytes, suggestedName, filters, opts.existingPath);
  } catch (e) {
    log('error', `Saving ${suggestedName} failed: ${errorText(e)}`);
    const retry = opts.retry ?? (() => saveFile(bytes, suggestedName, filters, { successMessage: opts.successMessage }));
    usePDFStore.getState().toast(`Could not save ${suggestedName}: ${saveErrorReason(e)}`, 'error', { label: 'Save as…', run: () => void retry() });
    return null;
  }
  if (path && opts.successMessage !== false) usePDFStore.getState().toast(opts.successMessage ?? (path === 'downloaded' ? 'Downloaded.' : `Saved to ${path}`), 'success');
  return path;
}
