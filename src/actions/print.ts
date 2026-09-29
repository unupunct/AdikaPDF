/**
 * Printing. The current document (with all edits) is handed to the
 * WebView2/Edge PDF engine in a hidden frame, which shows the standard
 * Windows print dialog (printer, pages, copies, duplex, scale) and prints
 * vector output. If the PDF engine is unavailable, pages are printed as
 * 300 DPI images instead.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, withBusy } from './document';
import { rasterizePage, canvasToBytes } from '@/lib/pdf/pdfService';
import type { PrintLayout } from '@/lib/pdf/impose';

export interface PrintOptions {
  layout?: PrintLayout;
  /** 0-based page indices; undefined = all. */
  pages?: number[];
}

async function prepare(opts: PrintOptions): Promise<Uint8Array | null> {
  const store = usePDFStore.getState();
  const bytes = store.readOnlyReason
    ? null // protected files print from their original bytes (edits are impossible anyway)
    : await withBusy('Preparing to print…', (p) => exportCurrentPdf({}, p));
  const data = bytes ?? Object.values(store.sources)[0]?.bytes;
  if (!data) return null;
  const layout = opts.layout ?? { kind: 'normal' };
  if (layout.kind === 'normal' && !opts.pages) return data;
  const { layOut } = await import('@/lib/pdf/impose');
  return (await withBusy('Laying out the sheets…', () => layOut(data, layout, opts.pages))) ?? null;
}

/** Saves the laid-out sheets (booklet, several per sheet, poster) as a PDF. */
export async function saveLaidOut(opts: PrintOptions): Promise<void> {
  const data = await prepare(opts);
  if (!data) return;
  const { saveDerived } = await import('./document');
  await saveDerived(data, `-${opts.layout?.kind === 'nup' ? `${opts.layout.perSheet}-up` : (opts.layout?.kind ?? 'print')}`, false);
}

/** Test hook: when set, receives the prepared PDF instead of opening the print dialog. */
let printInterceptor: ((bytes: Uint8Array) => void) | null = null;
export function e2eInterceptPrint(fn: ((bytes: Uint8Array) => void) | null): void {
  printInterceptor = fn;
}

/** Prints the document (all edits), optionally only some pages or laid out on sheets. */
export async function printDocument(opts: PrintOptions = {}): Promise<void> {
  const store = usePDFStore.getState();
  if (store.pages.length === 0) return;
  const data = await prepare(opts);
  if (!data) return;
  if (printInterceptor) {
    printInterceptor(data);
    return;
  }
  try {
    await printViaPdfEngine(data);
  } catch {
    await printAsImages();
  }
}

function printViaPdfEngine(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/pdf' }));
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    const cleanup = () => {
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('PDF engine did not load'));
    }, 15_000);
    frame.onload = () => {
      clearTimeout(timer);
      // The PDF viewer needs a moment to lay out before print().
      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
          cleanup();
          resolve();
        } catch (e) {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, 400);
    };
    frame.src = url;
    document.body.appendChild(frame);
  });
}

/** Fallback: prints 300 DPI page images through the page's own print dialog. */
async function printAsImages(): Promise<void> {
  const store = usePDFStore.getState();
  const images = await withBusy('Preparing pages for printing…', async (progress) => {
    const out: string[] = [];
    for (let i = 0; i < store.pages.length; i++) {
      progress(`Rendering page ${i + 1} of ${store.pages.length}`, i / store.pages.length);
      const canvas = await rasterizePage(store.pages[i], 300);
      const bytes = await canvasToBytes(canvas, 'image/jpeg', 0.92);
      out.push(URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/jpeg' })));
      canvas.width = canvas.height = 0;
    }
    return out;
  });
  if (!images) return;
  const holder = document.createElement('div');
  holder.id = 'adika-print-pages';
  for (const src of images) {
    const img = document.createElement('img');
    img.src = src;
    holder.appendChild(img);
  }
  const style = document.createElement('style');
  style.textContent = `@media print { body > *:not(#adika-print-pages) { display: none !important; } #adika-print-pages img { width: 100%; page-break-after: always; display: block; } @page { margin: 0; } } @media screen { #adika-print-pages { display: none; } }`;
  document.body.append(style, holder);
  await Promise.all([...holder.querySelectorAll('img')].map((i) => i.decode().catch(() => undefined)));
  window.print();
  holder.remove();
  style.remove();
  images.forEach((u) => URL.revokeObjectURL(u));
}
