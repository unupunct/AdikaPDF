/**
 * Accessibility → PDF/UA check and Reading order: runs the checker on the
 * current document, applies the chosen fixes (one undoable step), jumps to an
 * issue, saves the report, and the reading-order edits (each an undoable
 * rewrite of the page's source document; the Tags panel follows).
 */
import { usePDFStore } from '@/store/usePDFStore';
import { useA11y } from '@/store/a11y';
import { translate, useLang } from '@/lib/i18n';
import { loadFontBytes } from '@/lib/fonts';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import { getPdfPage } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import type { UaFix, UaIssue } from '@/lib/pdf/pdfua';
import type { OrderType, PageOrder } from '@/lib/pdf/readingOrder';
import type { Box } from '@/lib/pdf/textRemoval';
import type { PageRef } from '@/types';
import { exportCurrentPdf, suggestedName, withBusy } from './document';
import { replaceWholeDocument, rewriteSource } from './sourceRewrite';
import { saveFile } from './saveGuard';

export async function runPdfUaCheck(): Promise<void> {
  useA11y.setState({ checking: true });
  try {
    const report = await withBusy('Checking PDF/UA…', async () => {
      const { checkPdfUa } = await import('@/lib/pdf/pdfua');
      return checkPdfUa(await exportCurrentPdf());
    });
    if (report) useA11y.setState({ report });
  } finally {
    useA11y.setState({ checking: false });
  }
}

export async function applyPdfUaFixes(fixes: UaFix[], lang: string): Promise<void> {
  if (!fixes.length) return;
  const store = usePDFStore.getState();
  const res = await withBusy('Fixing accessibility issues…', async () => {
    const bytes = await exportCurrentPdf();
    if (isPdfEncrypted(bytes)) throw new Error('Remove the password protection first.');
    const { fixPdfUa } = await import('@/lib/pdf/pdfuaFix');
    return fixPdfUa(bytes, { fixes, lang, title: (store.fileName ?? '').replace(/\.pdf$/i, '') });
  });
  if (!res) return;
  await replaceWholeDocument(res.bytes);
  useA11y.setState((s) => ({ epoch: s.epoch + 1, highlight: null }));
  usePDFStore.getState().toast(`${res.applied.length} kind(s) of issue fixed. Undo reverts them.`, 'success');
  await runPdfUaCheck();
}

/** PDF user-space box -> CSS pixels on the page at zoom 1. */
export async function boxToView(page: PageRef, box: Box): Promise<{ left: number; top: number; width: number; height: number } | null> {
  if (!page.sourceId) return null;
  const p = await getPdfPage(page.sourceId, page.sourceIndex);
  const vp = p.getViewport({ scale: 1, rotation: totalRotation(page) });
  const [x1, y1] = vp.convertToViewportPoint(box.x0, box.y0);
  const [x2, y2] = vp.convertToViewportPoint(box.x1, box.y1);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** View pixels (zoom 1) -> PDF user space. */
export async function viewToBox(page: PageRef, r: { left: number; top: number; width: number; height: number }): Promise<Box | null> {
  if (!page.sourceId) return null;
  const p = await getPdfPage(page.sourceId, page.sourceIndex);
  const vp = p.getViewport({ scale: 1, rotation: totalRotation(page) });
  const [ax, ay] = vp.convertToPdfPoint(r.left, r.top);
  const [bx, by] = vp.convertToPdfPoint(r.left + r.width, r.top + r.height);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export async function goToIssue(issue: UaIssue): Promise<void> {
  const store = usePDFStore.getState();
  if (issue.page === null) return;
  const page = store.pages[issue.page];
  if (!page) return;
  let y: number | undefined;
  if (issue.box) {
    const v = await boxToView(page, issue.box).catch(() => null);
    if (v) y = v.top;
    useA11y.setState({ highlight: { pageId: page.id, box: issue.box } });
  } else useA11y.setState({ highlight: null });
  store.navigateTo(page.id, y);
}

export async function savePdfUaReport(format: 'pdf' | 'html' | 'txt'): Promise<void> {
  const report = useA11y.getState().report;
  if (!report) return;
  const fileName = usePDFStore.getState().fileName ?? 'document.pdf';
  const base = suggestedName('-pdfua').replace(/\.pdf$/i, '');
  const lang = useLang.getState().lang;
  const r = await import('@/lib/pdf/pdfuaReport');
  if (format === 'pdf') {
    const bytes = await withBusy('Writing the report…', () => r.reportPdf(report, { fileName, loadFont: loadFontBytes, t: translate }));
    if (bytes) await saveFile(bytes, `${base}.pdf`, [{ name: 'PDF documents', extensions: ['pdf'] }]);
  } else if (format === 'html') {
    await saveFile(new TextEncoder().encode(r.reportHtml(report, { fileName }, translate, lang)), `${base}.html`, [{ name: 'Web page', extensions: ['html'] }]);
  } else {
    await saveFile(new TextEncoder().encode(r.reportText(report, { fileName }, translate)), `${base}.txt`, [{ name: 'Text', extensions: ['txt'] }]);
  }
}

// ---------------------------------------------------------------- reading order

export function setReadingOrderMode(on: boolean): void {
  useA11y.setState({ orderMode: on, selected: [], selectedPage: null });
  if (on) {
    const s = usePDFStore.getState();
    if (s.tool !== 'select' && s.tool !== 'pan') s.setTool('select');
  }
}

export async function loadPageOrder(page: PageRef): Promise<PageOrder | null> {
  if (page.kind !== 'source' || !page.sourceId) return null;
  const src = usePDFStore.getState().sources[page.sourceId];
  if (!src) return null;
  const [{ PDFDocument }, { readPageOrder }] = await Promise.all([import('pdf-lib'), import('@/lib/pdf/readingOrder')]);
  const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
  return readPageOrder(doc, page.sourceIndex);
}

async function editOrder(page: PageRef, label: string, fn: (m: typeof import('@/lib/pdf/readingOrder'), doc: import('pdf-lib').PDFDocument) => void | number): Promise<void> {
  if (!page.sourceId) return;
  const m = await import('@/lib/pdf/readingOrder');
  const out = { pieces: -1 };
  const ok = await withBusy(label, async () => {
    await rewriteSource(page.sourceId!, (doc) => {
      const r = fn(m, doc);
      if (typeof r === 'number') out.pieces = r;
    });
    return true;
  });
  if (ok) useA11y.setState((s) => ({ epoch: s.epoch + 1 }));
  if (ok && out.pieces === 0) usePDFStore.getState().toast('There is no untagged content in that area.', 'info');
}

export const reorderItems = (page: PageRef, ids: string[]) => editOrder(page, 'Changing the reading order…', (m, doc) => void m.reorderPage(doc, page.sourceIndex, ids));

export async function retagSelection(type: OrderType): Promise<void> {
  const { selected: ids, selectedPage } = useA11y.getState();
  const page = usePDFStore.getState().pages.find((p) => p.id === selectedPage);
  if (!ids.length || !page) return;
  await editOrder(page, 'Updating the tags…', (m, doc) => m.retagItems(doc, page.sourceIndex, ids, type));
  useA11y.setState({ selected: [], selectedPage: null });
}

export const tagRegionOn = (page: PageRef, box: Box, type: OrderType) => editOrder(page, 'Tagging the area…', (m, doc) => m.tagRegion(doc, page.sourceIndex, box, type));
