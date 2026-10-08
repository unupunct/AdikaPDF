/** Convert → Print production: preflight (PDF/X, PDF/A), colour conversion, output preview, bleed and printer marks. */
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, saveDerived, withBusy } from './document';
import { openPdf } from '@/lib/pdf/pdfService';
import { renderPageToCanvas } from '@/lib/pdf/convert';
import type { ConvertHooks } from '@/lib/print/convertColors';
import type { PdfXLevel, PreflightIssue } from '@/lib/print/pdfx';
import type { MarksOptions } from '@/lib/print/marks';

export type PreflightProfile = PdfXLevel | 'pdfa';

export async function preflightCurrent(profile: PreflightProfile): Promise<PreflightIssue[] | undefined> {
  return withBusy('Checking the document…', async () => {
    const bytes = await exportCurrentPdf();
    if (profile === 'pdfa') {
      const { pdfaWarnings } = await import('@/lib/pdf/pdfa');
      return (await pdfaWarnings(bytes, '2b')).map((w) => ({ rule: 'PDF/A-2b', detail: w, fixable: true }));
    }
    const { preflightPdfX } = await import('@/lib/print/pdfx');
    return preflightPdfX(bytes, profile);
  });
}

/** Browser codecs for the colour conversion (photos). */
export const colorHooks: ConvertHooks = {
  decodeJpeg: async (bytes) => {
    try {
      const bmp = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const rgb = new Uint8Array(c.width * c.height * 3);
      for (let i = 0; i < c.width * c.height; i++) {
        rgb[i * 3] = d[i * 4];
        rgb[i * 3 + 1] = d[i * 4 + 1];
        rgb[i * 3 + 2] = d[i * 4 + 2];
      }
      return { data: rgb, width: c.width, height: c.height, channels: 3 };
    } catch {
      return null;
    }
  },
  encodeGrayJpeg: async (gray, width, height) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(width, height);
    for (let i = 0; i < gray.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i];
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  },
};

export async function convertCurrentToPdfX(level: PdfXLevel): Promise<string[] | undefined> {
  const title = (usePDFStore.getState().fileName ?? 'Document').replace(/\.pdf$/i, '');
  const out = await withBusy(`Converting to ${level === 'x4' ? 'PDF/X-4' : 'PDF/X-1a'}…`, async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    const { convertToPdfX, rgbaToCmyk } = await import('@/lib/print/pdfx');
    const pdf = await openPdf(bytes);
    try {
      return await convertToPdfX(bytes, {
        level,
        title,
        hooks: colorHooks,
        rasterCmyk: async (i, dpi) => {
          progress(`Rasterising page ${i + 1}…`, null);
          const { canvas } = await renderPageToCanvas(pdf, i + 1, dpi);
          const d = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height);
          canvas.width = canvas.height = 0;
          return { data: rgbaToCmyk(d.data, d.width, d.height), width: d.width, height: d.height };
        },
      });
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
  if (!out) return undefined;
  await saveDerived(out.bytes, level === 'x4' ? '-pdfx4' : '-pdfx1a', true);
  return out.notes;
}

export async function convertCurrentColors(target: 'gray' | 'cmyk'): Promise<string[] | undefined> {
  const out = await withBusy(target === 'gray' ? 'Converting to grey…' : 'Converting to CMYK…', async (progress) => {
    const { convertColors } = await import('@/lib/print/convertColors');
    return convertColors(await exportCurrentPdf({}, progress), target, colorHooks);
  });
  if (!out) return undefined;
  if (!(await saveDerived(out.bytes, target === 'gray' ? '-grayscale' : '-cmyk', true))) return undefined;
  usePDFStore
    .getState()
    .toast(`Converted: ${out.report.images} image${out.report.images === 1 ? '' : 's'}, ${out.report.shadings} gradient${out.report.shadings === 1 ? '' : 's'}.${out.report.kept.length ? ` Kept: ${out.report.kept.join('; ')}.` : ''}`, out.report.kept.length ? 'info' : 'success');
  return out.report.kept;
}

export async function addMarksToCurrent(opts: MarksOptions): Promise<void> {
  const out = await withBusy('Adding bleed and printer marks…', async (progress) => {
    const { addPrinterMarks } = await import('@/lib/print/marks');
    return addPrinterMarks(await exportCurrentPdf({}, progress), { ...opts, label: usePDFStore.getState().fileName ?? undefined });
  });
  if (out) await saveDerived(out, '-print', true);
}

export interface InkPreview {
  width: number;
  height: number;
  plates: Uint8Array[];
  total: Uint16Array;
  stats: import('@/lib/print/marks').InkStats;
}

/** Estimated separations of one page (rendered at 72 DPI). */
export async function inkPreview(pageNumber: number, limit: number): Promise<InkPreview | undefined> {
  return withBusy('Reading the inks…', async () => {
    const { inkCoverage } = await import('@/lib/print/marks');
    const pdf = await openPdf(await exportCurrentPdf());
    try {
      const { canvas } = await renderPageToCanvas(pdf, pageNumber, 72);
      const d = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height);
      const r = inkCoverage(d.data, d.width, d.height, limit);
      return { width: d.width, height: d.height, ...r };
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
}
