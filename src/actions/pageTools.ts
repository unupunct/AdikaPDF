/**
 * Document tools that rewrite the whole PDF (like Acrobat's Edit and
 * Comment tools): watermark / header & footer / Bates / background, crop,
 * comment import/export (XFDF, FDF), comment summary and file comparison.
 *
 * In-place tools apply the current edits first, transform the bytes and
 * reopen them in the same tab, marked as unsaved.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, openPdfBytes, withBusy, PDF_FILTER } from './document';
import { pickFiles, saveBytes } from '@/lib/platform';
import { openPdf } from '@/lib/pdf/pdfService';
import { loadFontBytes } from '@/lib/fonts';
import { log } from '@/lib/log';
import type { PageMarksOptions } from '@/lib/pdf/pageMarks';
import type { CropMargins } from '@/lib/pdf/crop';

/** Applies `transform` to the current document (with edits) and reopens the result in place, unsaved. */
async function applyInPlace(label: string, transform: (bytes: Uint8Array, progress: (m: string, f: number | null) => void) => Promise<{ bytes: Uint8Array; summary: string } | null>): Promise<boolean> {
  const s = usePDFStore.getState();
  if (!s.pages.length) return false;
  const name = s.fileName ?? 'Untitled.pdf';
  const path = s.filePath;
  const out = await withBusy(`${label}…`, async (progress) => transform(await exportCurrentPdf({}, progress), progress));
  if (!out) return false;
  if (!(await openPdfBytes(out.bytes, name, path, true))) return false;
  usePDFStore.setState({ dirty: true });
  usePDFStore.getState().toast(`${out.summary} Save to keep the changes.`, 'success');
  log('info', `${label}: ${out.summary}`);
  return true;
}

// ------------------------------------------------------------------ page marks

export async function applyPageMarks(opts: PageMarksOptions): Promise<boolean> {
  const { addPageMarks } = await import('@/lib/pdf/pageMarks');
  const parts = [opts.watermark ? 'watermark' : '', opts.headerFooter ? 'header/footer' : '', opts.background ? 'background' : ''].filter(Boolean);
  return applyInPlace('Adding page marks', async (bytes) => {
    const out = await addPageMarks(bytes, { fileName: usePDFStore.getState().fileName ?? '', ...opts }, (v) => loadFontBytes(v));
    const n = opts.pages?.length ?? usePDFStore.getState().pages.length;
    return { bytes: out, summary: `Added ${parts.join(', ')} to ${n} page${n === 1 ? '' : 's'}.` };
  });
}

export async function removeAllPageMarks(): Promise<boolean> {
  const { removePageMarks } = await import('@/lib/pdf/pageMarks');
  return applyInPlace('Removing page marks', async (bytes) => {
    const out = await removePageMarks(bytes);
    if (!out.removed) {
      usePDFStore.getState().toast('This document has no watermark, header/footer or background added by Adika.', 'info');
      return null;
    }
    return { bytes: out.bytes, summary: `Removed ${out.removed} page mark${out.removed === 1 ? '' : 's'}.` };
  });
}

// ------------------------------------------------------------------ crop

export async function applyCrop(margins: CropMargins, pageNumbers?: number[]): Promise<boolean> {
  const { cropPages } = await import('@/lib/pdf/crop');
  return applyInPlace('Cropping pages', async (bytes) => {
    const out = await cropPages(bytes, margins, pageNumbers);
    if (!out.cropped) {
      usePDFStore.getState().toast('Nothing was cropped: the margins are larger than the pages.', 'error');
      return null;
    }
    return { bytes: out.bytes, summary: `Cropped ${out.cropped} page${out.cropped === 1 ? '' : 's'}.` };
  });
}

// ------------------------------------------------------------------ comments: import / export

export async function exportComments(format: 'xfdf' | 'fdf'): Promise<void> {
  const s = usePDFStore.getState();
  if (!s.pages.length) return;
  const { exportXfdf, exportFdf, countComments } = await import('@/lib/pdf/xfdf');
  const pdfName = s.fileName ?? 'document.pdf';
  const out = await withBusy('Exporting comments…', async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    const count = await countComments(bytes);
    const data = format === 'xfdf' ? new TextEncoder().encode(await exportXfdf(bytes, { fileName: pdfName })) : await exportFdf(bytes, { fileName: pdfName });
    return { data, count };
  });
  if (!out) return;
  if (!out.count) {
    usePDFStore.getState().toast('This document has no comments to export.', 'info');
    return;
  }
  const name = pdfName.replace(/\.pdf$/i, '') + `.${format}`;
  const path = await saveBytes(out.data, name, [{ name: format.toUpperCase(), extensions: [format] }]);
  if (path) usePDFStore.getState().toast(`Exported ${out.count} comment${out.count === 1 ? '' : 's'}${path === 'downloaded' ? '.' : ` to ${path}`}`, 'success');
}

export async function importComments(): Promise<boolean> {
  const [f] = await pickFiles([{ name: 'Comments (XFDF, FDF)', extensions: ['xfdf', 'fdf', 'xml'] }]);
  if (!f) return false;
  const { importXfdf, importFdf } = await import('@/lib/pdf/xfdf');
  const isFdf = /\.fdf$/i.test(f.name) || new TextDecoder().decode(f.bytes.subarray(0, 8)).startsWith('%FDF');
  return applyInPlace('Importing comments', async (bytes) => {
    const r = isFdf ? await importFdf(bytes, f.bytes, loadFontBytes) : await importXfdf(bytes, new TextDecoder().decode(f.bytes), loadFontBytes);
    if (!r.added) {
      usePDFStore.getState().toast(r.skipped ? `No comments imported (${r.skipped} skipped: already present or on missing pages).` : 'The file contains no comments.', 'info');
      return null;
    }
    return { bytes: r.bytes, summary: `Imported ${r.added} comment${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped)` : ''}.` };
  });
}

// ------------------------------------------------------------------ comment summary

export async function summarizeCommentsAction(): Promise<void> {
  const s = usePDFStore.getState();
  if (!s.pages.length) return;
  const base = (s.fileName ?? 'Document').replace(/\.pdf$/i, '');
  const out = await withBusy('Summarising comments…', async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    const doc = await openPdf(bytes);
    try {
      const { summarizeComments } = await import('@/lib/pdf/commentSummary');
      const { renderPageToCanvas, canvasToBlob, releaseCanvas } = await import('@/lib/pdf/convert');
      return await summarizeComments(doc, (v) => loadFontBytes(v), {
        title: 'Comment summary',
        documentName: s.fileName ?? undefined,
        renderPage: async (pageNumber, maxWidth) => {
          const page = await doc.getPage(pageNumber);
          const w = page.getViewport({ scale: 1 }).width;
          const r = await renderPageToCanvas(doc, pageNumber, (72 * maxWidth) / w);
          try {
            const blob = await canvasToBlob(r.canvas, 'image/jpeg', 0.85);
            return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'jpg', width: r.canvas.width, height: r.canvas.height };
          } finally {
            releaseCanvas(r.canvas);
          }
        },
      });
    } finally {
      await doc.loadingTask.destroy().catch(() => undefined);
    }
  });
  if (!out) return;
  if (!out.count) usePDFStore.getState().toast('This document has no comments; the summary says so.', 'info');
  // Opened as a new document (tab) so it can be read, printed or saved.
  await openPdfBytes(out.bytes, `${base} - comments.pdf`, null, false);
  usePDFStore.setState({ dirty: true });
}

// ------------------------------------------------------------------ compare

/** Compares the current document (new version) with a PDF the user picks (old version). */
export async function compareWithFile(): Promise<void> {
  const s = usePDFStore.getState();
  if (!s.pages.length) return;
  const [f] = await pickFiles(PDF_FILTER);
  if (!f) return;
  const newName = s.fileName ?? 'Current document';
  const out = await withBusy('Comparing documents…', async (progress) => {
    const newBytes = await exportCurrentPdf({}, progress);
    progress('Reading both documents', null);
    const [oldDoc, newDoc] = await Promise.all([openPdf(f.bytes), openPdf(newBytes)]);
    try {
      const { comparePdfs } = await import('@/lib/pdf/compare');
      return await comparePdfs(oldDoc, f.bytes, newDoc, newBytes, (v) => loadFontBytes(v), { oldName: f.name, newName });
    } finally {
      await Promise.all([oldDoc.loadingTask.destroy().catch(() => undefined), newDoc.loadingTask.destroy().catch(() => undefined)]);
    }
  });
  if (!out) return;
  const base = newName.replace(/\.pdf$/i, '');
  await openPdfBytes(out.bytes, `${base} - compared.pdf`, null, false);
  usePDFStore.setState({ dirty: true });
  const st = usePDFStore.getState();
  if (!out.inserted && !out.deleted) st.toast('No differences in the text were found.', 'info');
  else st.toast(`${out.inserted} word${out.inserted === 1 ? '' : 's'} inserted, ${out.deleted} deleted, on page${out.changedPages.length === 1 ? '' : 's'} ${out.changedPages.slice(0, 8).join(', ')}${out.changedPages.length > 8 ? '…' : ''}. The first page is a summary.`, 'success');
}

