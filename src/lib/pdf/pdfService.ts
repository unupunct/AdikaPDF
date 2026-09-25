/**
 * pdf.js integration: one PDFDocumentProxy per source document, page proxy
 * and text-content caches, and page rasterisation helpers used by the
 * viewer, thumbnails, redaction and the export engines.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageRef } from '@/types';
import { totalRotation } from '@/lib/geometry';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

const docs = new Map<string, Promise<PDFDocumentProxy>>();
const pages = new Map<string, Promise<PDFPageProxy>>();
const texts = new Map<string, Promise<TextItem[]>>();

export class PasswordRequiredError extends Error {
  constructor(public readonly incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'This PDF is password protected');
  }
}

/** Opens a PDF. pdf.js transfers the buffer it gets, so it receives a copy. */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
    enableXfa: false,
  });
  try {
    return await task.promise;
  } catch (e) {
    if (e instanceof Error && e.name === 'PasswordException') {
      const code = (e as Error & { code?: number }).code;
      throw new PasswordRequiredError(code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    }
    throw e;
  }
}

export function registerSource(sourceId: string, doc: PDFDocumentProxy): void {
  docs.set(sourceId, Promise.resolve(doc));
}

export function getSourceDoc(sourceId: string): Promise<PDFDocumentProxy> {
  const d = docs.get(sourceId);
  if (!d) throw new Error(`Source ${sourceId} is not loaded`);
  return d;
}

export async function releaseSource(sourceId: string): Promise<void> {
  const d = docs.get(sourceId);
  docs.delete(sourceId);
  for (const key of [...pages.keys()]) if (key.startsWith(`${sourceId}:`)) pages.delete(key);
  for (const key of [...texts.keys()]) if (key.startsWith(`${sourceId}:`)) texts.delete(key);
  if (d) await (await d).loadingTask.destroy().catch(() => undefined);
}

export function getPdfPage(sourceId: string, index: number): Promise<PDFPageProxy> {
  const key = `${sourceId}:${index}`;
  let p = pages.get(key);
  if (!p) {
    p = getSourceDoc(sourceId).then((d) => d.getPage(index + 1));
    pages.set(key, p);
  }
  return p;
}

export function getTextItems(sourceId: string, index: number): Promise<TextItem[]> {
  const key = `${sourceId}:${index}`;
  let t = texts.get(key);
  if (!t) {
    t = getPdfPage(sourceId, index)
      .then((p) => p.getTextContent())
      .then((c) => c.items.filter((i): i is TextItem => 'str' in i));
    texts.set(key, t);
  }
  return t;
}

/** Page viewport at `scale` with the PageRef's total rotation. */
export async function pageViewport(page: PageRef, scale: number) {
  if (page.kind !== 'source' || !page.sourceId) return null;
  const p = await getPdfPage(page.sourceId, page.sourceIndex);
  return p.getViewport({ scale, rotation: totalRotation(page) });
}

export interface RenderHandle {
  promise: Promise<void>;
  cancel: () => void;
}

/** Renders a page into `canvas` at `scale` (CSS px per point) × devicePixelRatio. */
export function renderPageToCanvas(
  page: PageRef,
  canvas: HTMLCanvasElement,
  scale: number,
  pixelRatio = window.devicePixelRatio || 1,
): RenderHandle {
  let cancelled = false;
  let task: ReturnType<PDFPageProxy['render']> | null = null;
  const promise = (async () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    if (page.kind === 'blank' || !page.sourceId) {
      const w = (totalRotation(page) % 180 === 0 ? page.width : page.height) * scale;
      const h = (totalRotation(page) % 180 === 0 ? page.height : page.width) * scale;
      canvas.width = Math.round(w * pixelRatio);
      canvas.height = Math.round(h * pixelRatio);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const p = await getPdfPage(page.sourceId, page.sourceIndex);
    if (cancelled) return;
    const viewport = p.getViewport({ scale: scale * pixelRatio, rotation: totalRotation(page) });
    // Render off-screen first so the visible canvas never flashes blank.
    const off = document.createElement('canvas');
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    const offCtx = off.getContext('2d');
    if (!offCtx) throw new Error('Canvas unavailable');
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, off.width, off.height);
    task = p.render({ canvas: off, canvasContext: offCtx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE });
    try {
      await task.promise;
    } catch (e) {
      if (e instanceof Error && e.name === 'RenderingCancelledException') return;
      throw e;
    }
    if (cancelled) return;
    canvas.width = off.width;
    canvas.height = off.height;
    ctx.drawImage(off, 0, 0);
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

/** Rasterises a page (display orientation) to a canvas at a given DPI. */
export async function rasterizePage(page: PageRef, dpi: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  await renderPageToCanvas(page, canvas, dpi / 72, 1).promise;
  return canvas;
}

export function canvasToBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality = 0.92): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error('Image encoding failed'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      type,
      quality,
    );
  });
}

/**
 * Pushes a form value into pdf.js' annotation storage so the page raster
 * shows the filled-in value immediately (the export writes the real value).
 */
export async function setViewerFieldValue(sourceId: string, name: string, value: string | boolean | string[]): Promise<void> {
  const doc = await getSourceDoc(sourceId);
  const fields = (await doc.getFieldObjects()) as Record<string, Array<{ id: string; type: string; exportValues?: string }>> | null;
  const widgets = fields?.[name];
  if (!widgets) return;
  for (const w of widgets) {
    if (!w.id) continue;
    if (w.type === 'checkbox') doc.annotationStorage.setValue(w.id, { value: value === true });
    else if (w.type === 'radiobutton') doc.annotationStorage.setValue(w.id, { value: w.exportValues === value });
    else if (w.type === 'combobox' || w.type === 'listbox') doc.annotationStorage.setValue(w.id, { value: Array.isArray(value) ? value : [String(value)] });
    else doc.annotationStorage.setValue(w.id, { value: String(value) });
  }
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, TextItem };
