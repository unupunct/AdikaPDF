/**
 * Document tools that rewrite the whole PDF (like Acrobat's Edit and
 * Comment tools): watermark / header & footer / Bates / background, crop,
 * comment import/export (XFDF, FDF), comment summary and file comparison.
 *
 * In-place tools apply the current edits first, transform the bytes and
 * swap them in as one undoable step, marked as unsaved.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, openPdfBytes, refreshSignatureStatus, withBusy, PDF_FILTER } from './document';
import { replaceWholeDocument } from './sourceRewrite';
import { askConfirm } from '@/store/useDialogs';
import { pickFiles, saveBytes } from '@/lib/platform';
import { openPdf } from '@/lib/pdf/pdfService';
import { loadFontBytes } from '@/lib/fonts';
import { log } from '@/lib/log';
import type { PageMarksOptions } from '@/lib/pdf/pageMarks';
import type { CropMargins } from '@/lib/pdf/crop';

/** Shows the busy state at once, before the engine module loads, so nothing (e.g. Save) runs in between. */
function busyNow(message: string): void {
  usePDFStore.getState().setBusy({ message: `${message}…`, progress: null });
}

/**
 * Applies `transform` to the current document (with its edits) and swaps the
 * result in as one undoable step, unsaved. Redaction boxes not yet applied
 * stay pending; a tool that moves page content (`geometry`: crop, page size)
 * asks to apply them first.
 */
async function applyInPlace(
  label: string,
  transform: (bytes: Uint8Array, progress: (m: string, f: number | null) => void) => Promise<{ bytes: Uint8Array; summary: string } | null>,
  geometry = false,
): Promise<boolean> {
  const s = usePDFStore.getState();
  if (!s.pages.length) {
    s.setBusy(null);
    return false;
  }
  let pending = s.objects.filter((o) => o.type === 'redact');
  if (pending.length && geometry) {
    s.setBusy(null);
    const ok = await askConfirm({
      title: 'Apply redactions first?',
      message: 'This tool moves page content, so the redaction boxes must be applied first: the content under them is removed for good once you save. (Undo still brings them back before saving.)',
      confirmLabel: 'Apply redactions',
      danger: true,
    });
    if (!ok) return false;
    pending = [];
  }
  const out = await withBusy(`${label}…`, async (progress) => {
    const r = await transform(await exportCurrentPdf({}, progress, pending.map((o) => o.id)), progress);
    if (r) await replaceWholeDocument(r.bytes, pending);
    return r;
  });
  if (!out) return false;
  void refreshSignatureStatus();
  usePDFStore.getState().toast(`${out.summary} Save to keep the changes.`, 'success');
  log('info', `${label}: ${out.summary}`);
  return true;
}

// ------------------------------------------------------------------ page marks

export async function applyPageMarks(opts: PageMarksOptions): Promise<boolean> {
  busyNow('Adding page marks');
  const { addPageMarks } = await import('@/lib/pdf/pageMarks');
  const parts = [opts.watermark ? 'watermark' : '', opts.headerFooter ? 'header/footer' : '', opts.background ? 'background' : ''].filter(Boolean);
  return applyInPlace('Adding page marks', async (bytes) => {
    const out = await addPageMarks(bytes, { fileName: usePDFStore.getState().fileName ?? '', ...opts }, (v) => loadFontBytes(v));
    const n = opts.pages?.length ?? usePDFStore.getState().pages.length;
    return { bytes: out, summary: `Added ${parts.join(', ')} to ${n} page${n === 1 ? '' : 's'}.` };
  });
}

export async function removeAllPageMarks(): Promise<boolean> {
  busyNow('Removing page marks');
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
  busyNow('Cropping pages');
  const { cropPages } = await import('@/lib/pdf/crop');
  return applyInPlace('Cropping pages', async (bytes) => {
    const out = await cropPages(bytes, margins, pageNumbers);
    if (!out.cropped) {
      usePDFStore.getState().toast('Nothing was cropped: the margins are larger than the pages.', 'error');
      return null;
    }
    return { bytes: out.bytes, summary: `Cropped ${out.cropped} page${out.cropped === 1 ? '' : 's'}.` };
  }, true);
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
  busyNow('Importing comments');
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

// ------------------------------------------------------------------ review

/** Comments of several reviewers' copies of this document, merged in (duplicates skipped). */
export async function mergeReviewCopies(): Promise<boolean> {
  const files = await pickFiles(PDF_FILTER, true);
  if (!files.length) return false;
  busyNow('Merging comments');
  const { mergeCommentCopies } = await import('@/lib/pdf/review');
  return applyInPlace('Merging comments', async (bytes) => {
    const r = await mergeCommentCopies(bytes, files.map((f) => ({ name: f.name, bytes: f.bytes })), loadFontBytes);
    const failed = r.report.files.filter((f) => f.error);
    if (!r.report.added) {
      usePDFStore.getState().toast(failed.length ? `No comments merged: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}.` : 'The copies have no comments that are not already here.', 'info');
      return null;
    }
    const per = r.report.files.filter((f) => !f.error).map((f) => `${f.name}: ${f.added}`).join(', ');
    return { bytes: r.bytes, summary: `Merged ${r.report.added} comment${r.report.added === 1 ? '' : 's'} (${per})${failed.length ? `; not merged: ${failed.map((f) => f.name).join(', ')}` : ''}.` };
  });
}

/** Review status of a comment stored in the file. */
export async function setFileCommentStatus(pageIndex: number, match: { subtype: string; rect: number[]; contents: string }, state: import('@/lib/pdf/review').ReviewState): Promise<boolean> {
  const [{ setReviewStateAt }, { getAuthor }] = await Promise.all([import('@/lib/pdf/review'), import('@/lib/author')]);
  return applyInPlace('Setting the review status', async (bytes) => ({ bytes: await setReviewStateAt(bytes, pageIndex, match, state, getAuthor()), summary: `Status: ${state}.` }));
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

/**
 * Compares the current document (new version) with a PDF the user picks
 * (old version) by pixels: a report with both versions overlaid.
 */
export async function compareVisually(): Promise<void> {
  const s = usePDFStore.getState();
  if (!s.pages.length) return;
  const [f] = await pickFiles(PDF_FILTER);
  if (!f) return;
  const newName = s.fileName ?? 'Current document';
  const out = await withBusy('Comparing documents…', async (progress) => {
    const newBytes = await exportCurrentPdf({}, progress);
    const [oldDoc, newDoc] = await Promise.all([openPdf(f.bytes), openPdf(newBytes)]);
    try {
      const [{ visualCompareReport }, { renderPageToCanvas }] = await Promise.all([import('@/lib/pdf/visualCompare'), import('@/lib/pdf/convert')]);
      const raster = (pdf: typeof oldDoc, n: number) => async () => {
        const { canvas, viewport, scale } = await renderPageToCanvas(pdf, n, 100);
        const img = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height);
        canvas.width = canvas.height = 0;
        return { data: img.data, width: img.width, height: img.height, widthPt: viewport.width / scale, heightPt: viewport.height / scale };
      };
      const pages = (pdf: typeof oldDoc) => Array.from({ length: pdf.numPages }, (_, i) => raster(pdf, i + 1));
      return await visualCompareReport(pages(oldDoc), pages(newDoc), { oldName: f.name, newName }, (d, t) => progress(`Comparing page ${Math.min(d + 1, t)} of ${t}`, t ? d / t : null));
    } finally {
      await Promise.all([oldDoc.loadingTask.destroy().catch(() => undefined), newDoc.loadingTask.destroy().catch(() => undefined)]);
    }
  });
  if (!out) return;
  const base = newName.replace(/\.pdf$/i, '');
  await openPdfBytes(out.bytes, `${base} - visual comparison.pdf`, null, false);
  usePDFStore.setState({ dirty: true });
  const st = usePDFStore.getState();
  if (!out.changedPages.length) st.toast('No visible differences were found.', 'info');
  else st.toast(`${out.areas} changed area${out.areas === 1 ? '' : 's'} on page${out.changedPages.length === 1 ? '' : 's'} ${out.changedPages.slice(0, 8).join(', ')}${out.changedPages.length > 8 ? '…' : ''}. The first page is a summary.`, 'success');
}

/** Compares the current document (new version) with a PDF the user picks (old version). */
export async function compareWithFile(redline = false): Promise<void> {
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
      const { translate } = await import('@/lib/i18n');
      return await comparePdfs(oldDoc, f.bytes, newDoc, newBytes, (v) => loadFontBytes(v), { oldName: f.name, newName, redline: redline ? { title: translate('List of changes'), page: translate('Page {0}') } : undefined });
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


// ------------------------------------------------------------------ page size

export async function applyPageSize(o: import('@/lib/pdf/pageSize').PageSizeOptions): Promise<boolean> {
  busyNow('Resizing pages');
  const { resizePages } = await import('@/lib/pdf/pageSize');
  return applyInPlace('Resizing pages', async (bytes) => {
    const out = await resizePages(bytes, o);
    if (!out.resized) {
      usePDFStore.getState().toast('The pages already have this size.', 'info');
      return null;
    }
    return { bytes: out.bytes, summary: `Resized ${out.resized} page${out.resized === 1 ? '' : 's'}.` };
  }, true);
}
