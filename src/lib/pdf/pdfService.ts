/**
 * pdf.js integration: one PDFDocumentProxy per source document, page proxy
 * and text-content caches, and page rasterisation helpers used by the
 * viewer, thumbnails, redaction and the export engines.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { OptionalContentConfig } from 'pdfjs-dist/types/src/display/optional_content_config';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageRef } from '@/types';
import { totalRotation } from '@/lib/geometry';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

const docs = new Map<string, Promise<PDFDocumentProxy>>();
const pages = new Map<string, Promise<PDFPageProxy>>();
const texts = new Map<string, Promise<TextItem[]>>();
const textContents = new Map<string, Promise<TextContent>>();
const annotations = new Map<string, Promise<PageAnnotation[]>>();
const layerConfigs = new Map<string, Promise<OptionalContentConfig>>();

export class SourceClosedError extends Error {
  constructor(sourceId: string) {
    super(`Source ${sourceId} is not loaded`);
    this.name = 'SourceClosedError';
  }
}

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
  // A rejected promise (not a throw): late async work for a closed document
  // then fails quietly inside its own promise chain.
  if (!d) return Promise.reject(new SourceClosedError(sourceId));
  return d;
}

export async function releaseSource(sourceId: string): Promise<void> {
  const d = docs.get(sourceId);
  docs.delete(sourceId);
  for (const key of [...pages.keys()]) if (key.startsWith(`${sourceId}:`)) pages.delete(key);
  for (const key of [...texts.keys()]) if (key.startsWith(`${sourceId}:`)) texts.delete(key);
  for (const key of [...textContents.keys()]) if (key.startsWith(`${sourceId}:`)) textContents.delete(key);
  for (const key of [...annotations.keys()]) if (key.startsWith(`${sourceId}:`)) annotations.delete(key);
  layerConfigs.delete(sourceId);
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

/** Full text content (for the selectable text layer). */
export function getTextContent(sourceId: string, index: number): Promise<TextContent> {
  const key = `${sourceId}:${index}`;
  let t = textContents.get(key);
  if (!t) {
    t = getPdfPage(sourceId, index).then((p) => p.getTextContent());
    textContents.set(key, t);
  }
  return t;
}

/** Subset of pdf.js annotation data the reader uses (links, attachments). */
export interface PageAnnotation {
  subtype: string;
  rect: [number, number, number, number];
  url?: string;
  unsafeUrl?: string;
  dest?: string | unknown[] | null;
  action?: string;
  attachment?: { filename: string; content?: Uint8Array };
}

export function getAnnotations(sourceId: string, index: number): Promise<PageAnnotation[]> {
  const key = `${sourceId}:${index}`;
  let a = annotations.get(key);
  if (!a) {
    a = getPdfPage(sourceId, index).then((p) => p.getAnnotations({ intent: 'display' }) as Promise<PageAnnotation[]>);
    annotations.set(key, a);
  }
  return a;
}

export interface OutlineNode {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
}

export async function getOutline(sourceId: string): Promise<OutlineNode[]> {
  const doc = await getSourceDoc(sourceId);
  return ((await doc.getOutline()) ?? []) as unknown as OutlineNode[];
}

export async function getPageLabels(sourceId: string): Promise<string[] | null> {
  const doc = await getSourceDoc(sourceId);
  return doc.getPageLabels();
}

/** Resolves a PDF destination to a 0-based page index and optional top y (PDF units). */
export async function resolveDestination(sourceId: string, dest: string | unknown[] | null | undefined): Promise<{ index: number; left: number | null; top: number | null } | null> {
  if (!dest) return null;
  const doc = await getSourceDoc(sourceId);
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const target = explicit[0] as unknown;
  let index: number;
  if (typeof target === 'number') index = target;
  else if (target && typeof target === 'object') index = await doc.getPageIndex(target as Parameters<typeof doc.getPageIndex>[0]);
  else return null;
  const kind = (explicit[1] as { name?: string } | undefined)?.name;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  if (kind === 'XYZ') return { index, left: num(explicit[2]), top: num(explicit[3]) };
  if (kind === 'FitH' || kind === 'FitBH') return { index, left: null, top: num(explicit[2]) };
  if (kind === 'FitR') return { index, left: num(explicit[2]), top: num(explicit[5]) };
  return { index, left: null, top: null };
}

export interface EmbeddedFile {
  filename: string;
  description: string | null;
  content: Uint8Array;
}

export async function getEmbeddedFiles(sourceId: string): Promise<EmbeddedFile[]> {
  const doc = await getSourceDoc(sourceId);
  const raw = await doc.getAttachments();
  if (!raw) return [];
  // pdf.js 6 lists attachments lazily: content is fetched per id when absent.
  const out: EmbeddedFile[] = [];
  for (const [id, a] of raw) {
    const content = a.content ?? (await doc.getAttachmentContent(id).catch(() => null)) ?? new Uint8Array(0);
    out.push({ filename: a.filename, description: a.description || null, content });
  }
  return out;
}

/** Per-source optional content (layers) state shared by the viewer and the Layers panel. */
export function getLayerConfig(sourceId: string): Promise<OptionalContentConfig> {
  let c = layerConfigs.get(sourceId);
  if (!c) {
    c = getSourceDoc(sourceId).then((d) => d.getOptionalContentConfig());
    layerConfigs.set(sourceId, c);
  }
  return c;
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
    task = p.render({
      canvas: off,
      canvasContext: offCtx,
      viewport,
      annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
      optionalContentConfigPromise: getLayerConfig(page.sourceId),
    });
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
export type { PDFDocumentProxy, PDFPageProxy, TextItem, TextContent, OptionalContentConfig };
