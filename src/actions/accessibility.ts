/** Protect → Accessibility: check the document, then tag it and describe it for screen readers. */
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, saveDerived, withBusy } from './document';
import { checkAccessibility, listFigures, makeAccessible, type AccessCheck, type FigureInfo, type FixOptions } from '@/lib/pdf/accessibility';
import { renderPageToCanvas } from '@/lib/pdf/convert';
import { openPdf } from '@/lib/pdf/pdfService';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';

export interface AccessReport {
  checks: AccessCheck[];
  figures: FigureInfo[];
  title: string;
  lang: string;
  tagged: boolean;
}

export async function checkCurrentAccessibility(): Promise<AccessReport | undefined> {
  return withBusy('Checking accessibility…', async () => {
    const bytes = await exportCurrentPdf();
    const [checks, figures] = await Promise.all([checkAccessibility(bytes), listFigures(bytes)]);
    const { PDFDocument, PDFName, PDFString, PDFHexString } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const lang = doc.catalog.lookup(PDFName.of('Lang'));
    return {
      checks,
      figures,
      title: doc.getTitle() ?? '',
      lang: lang instanceof PDFString || lang instanceof PDFHexString ? lang.decodeText() : '',
      tagged: !!doc.catalog.lookup(PDFName.of('StructTreeRoot')),
    };
  });
}

/** Small pictures of the figures (the page cropped to each one), by key. */
export async function figurePreviews(figures: FigureInfo[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const withBox = figures.filter((f) => f.bbox && f.page > 0).slice(0, 60);
  if (!withBox.length) return out;
  const pdf = await openPdf(await exportCurrentPdf());
  try {
    const byPage = new Map<number, FigureInfo[]>();
    for (const f of withBox) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);
    for (const [pageNo, list] of byPage) {
      const { canvas, viewport } = await renderPageToCanvas(pdf, pageNo, 60);
      for (const f of list) {
        const [x0, y0, x1, y1] = f.bbox!;
        const [ax, ay] = viewport.convertToViewportPoint(x0, y1);
        const [bx, by] = viewport.convertToViewportPoint(x1, y0);
        const w = Math.max(1, Math.abs(bx - ax));
        const h = Math.max(1, Math.abs(by - ay));
        const c = document.createElement('canvas');
        const k = Math.min(1, 96 / Math.max(w, h));
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d')?.drawImage(canvas as HTMLCanvasElement, Math.min(ax, bx), Math.min(ay, by), w, h, 0, 0, c.width, c.height);
        out[f.key] = c.toDataURL('image/png');
      }
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

export async function makeCurrentAccessible(opts: FixOptions): Promise<boolean> {
  const store = usePDFStore.getState();
  const res = await withBusy('Making the document accessible…', async () => {
    const bytes = await exportCurrentPdf();
    if (isPdfEncrypted(bytes)) throw new Error('Remove the password protection first.');
    return makeAccessible(bytes, opts);
  });
  if (!res) return false;
  if (!(await saveDerived(res.bytes, '-accessible', true))) return false;
  store.toast(res.tagged ? `Accessible copy saved: ${res.elements} structure elements, title and language set.` : 'Accessible copy saved: title, language and descriptions set.', 'success');
  return true;
}
