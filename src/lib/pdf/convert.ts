// PDF -> other formats (images, TIFF, text, XLSX, PPTX, SVG, HTML,
// Markdown). Everything runs locally; nothing is fetched at runtime.
//
// Pure helpers (text grouping, table columns, SpreadsheetML, TIFF encoding,
// Markdown) are exported separately so they can be unit-tested in node.

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import JSZip from 'jszip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawTextItem {
  str: string;
  /** Left edge, top-left page origin, points. */
  x: number;
  /** Baseline, top-left page origin, points (grows downwards). */
  y: number;
  /** Advance width in points. */
  width: number;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  /** Word-friendly font family name ("Times New Roman"), when known. */
  family?: string;
}

/** A styled piece of a cell (one or more text items with the same font). */
export interface TextSpan {
  text: string;
  x: number;
  width: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  family?: string;
  /** RRGGBB, set by the DOCX exporter from the rendered page; undefined = black/auto. */
  color?: string;
  /** Set by the DOCX exporter when a thin rule runs under the span. */
  underline?: boolean;
}

export interface TextCell {
  x: number;
  text: string;
  width?: number;
  /** Table column index, set by `assignTableColumns` for tabular blocks. */
  col?: number;
  /** Styled pieces of `text` (same characters, in order). */
  spans?: TextSpan[];
}

export interface TextLine {
  y: number;
  x: number;
  text: string;
  fontSize: number;
  bold: boolean;
  cells: TextCell[];
  /** Total line width in points. */
  width?: number;
}

export interface PageText {
  pageNumber: number;
  width: number;
  height: number;
  lines: TextLine[];
}

export type ProgressFn = (done: number, total: number) => void;

// ---------------------------------------------------------------------------
// XML helpers (pure)
// ---------------------------------------------------------------------------

const INVALID_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

export function stripInvalidXmlChars(s: string): string {
  return s.replace(INVALID_XML, '');
}

export function xmlEscape(s: string): string {
  return stripInvalidXmlChars(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Text grouping (pure)
// ---------------------------------------------------------------------------

/** Trims a cell's spans like `text.trim()` trims its text and drops empty ones. */
function trimSpans(spans: TextSpan[]): TextSpan[] {
  const out = spans.map((s) => ({ ...s }));
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  }
  return out.filter((s) => s.text.length > 0);
}

const FONT_ALIASES: Record<string, string> = {
  helvetica: 'Arial',
  helveticaneue: 'Helvetica Neue',
  arial: 'Arial',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  timesnewroman: 'Times New Roman',
  courier: 'Courier New',
  couriernew: 'Courier New',
  dejavusans: 'DejaVu Sans',
  dejavuserif: 'DejaVu Serif',
  dejavusansmono: 'DejaVu Sans Mono',
  liberationsans: 'Liberation Sans',
  liberationserif: 'Liberation Serif',
};

const FONT_STYLE_SUFFIX = /(Bold|Italic|Oblique|Regular|Roman|Book|Medium|Light|Semibold|SemiBold|Demi|Black|Heavy)+$/;

/**
 * Word font family from a PDF font name: drops the subset tag and style
 * suffixes and spaces out camel case ("ABCDEF+TimesNewRomanPS-BoldMT" ->
 * "Times New Roman"). Undefined for synthetic names ("F1", "g_d0_f3").
 */
export function fontFamilyFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let n = name.replace(/^[A-Z]{6}\+/, '').split(/[-,+_]/)[0].replace(/(PSMT|PS|MT)$/, '');
  const alias = (s: string) => FONT_ALIASES[s.toLowerCase()];
  if (alias(n)) return alias(n);
  const stripped = n.replace(FONT_STYLE_SUFFIX, '');
  if (stripped.length >= 3) n = stripped;
  if (alias(n)) return alias(n);
  if (n.length < 3 || !/^[A-Za-z][A-Za-z0-9 ]*$/.test(n) || /^[A-Z]{1,3}\d+$/.test(n) || !/[a-z]/.test(n)) return undefined;
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/**
 * Groups positioned text items into lines (baseline tolerance ~0.5 * font
 * size), orders each line by x, inserts spaces for gaps > 0.25em and splits
 * cells at gaps > 2em.
 */
export function groupTextItems(items: RawTextItem[]): TextLine[] {
  const usable = items.filter((it) => it.str.length > 0 && Number.isFinite(it.x) && Number.isFinite(it.y));
  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);
  const buckets: { y: number; size: number; items: RawTextItem[] }[] = [];
  for (const it of sorted) {
    const fs = it.fontSize > 0 ? it.fontSize : 10;
    let target: (typeof buckets)[number] | undefined;
    // Only recent buckets can match because items are sorted by y.
    for (let i = buckets.length - 1; i >= 0 && i >= buckets.length - 4; i--) {
      const b = buckets[i];
      const tol = 0.5 * Math.max(b.size, fs);
      if (Math.abs(b.y - it.y) <= tol) {
        target = b;
        break;
      }
    }
    if (target) {
      target.items.push(it);
      // Keep the baseline of the dominant (largest) text.
      if (fs > target.size) {
        target.size = fs;
        target.y = it.y;
      }
    } else {
      buckets.push({ y: it.y, size: fs, items: [it] });
    }
  }

  const lines: TextLine[] = [];
  for (const b of buckets) {
    const its = b.items.sort((a, c) => a.x - c.x);
    const cells: TextCell[] = [];
    let cur: { x: number; text: string; end: number; spans: TextSpan[] } | undefined;
    let boldChars = 0;
    let chars = 0;
    let maxSize = 0;
    const span = (it: RawTextItem, fs: number): TextSpan => ({
      text: it.str,
      x: it.x,
      width: it.width,
      fontSize: fs,
      bold: !!it.bold,
      italic: !!it.italic,
      family: it.family,
    });
    const space = (c: NonNullable<typeof cur>) => {
      c.text += ' ';
      c.spans[c.spans.length - 1].text += ' ';
    };
    const finish = (c: NonNullable<typeof cur>) => cells.push({ x: c.x, text: c.text.trim(), width: c.end - c.x, spans: trimSpans(c.spans) });
    // Where the ink of an item ends: some producers (Word) pad words with trailing spaces.
    const inkEnd = (it: RawTextItem) => {
      const kept = it.str.replace(/\s+$/, '').length;
      return it.x + (it.str.length && kept < it.str.length ? (it.width * kept) / it.str.length : it.width);
    };
    for (const it of its) {
      const fs = it.fontSize > 0 ? it.fontSize : 10;
      maxSize = Math.max(maxSize, fs);
      const n = it.str.trim().length;
      chars += n;
      if (it.bold) boldChars += n;
      if (!cur) {
        if (!it.str.trim()) continue;
        cur = { x: it.x, text: it.str, end: inkEnd(it), spans: [span(it, fs)] };
        continue;
      }
      if (!it.str.trim()) {
        // Whitespace-only runs (pdf.js emits one spanning each gap) do not
        // advance the text end, so the real gap can still split cells.
        if (!/\s$/.test(cur.text)) space(cur);
        continue;
      }
      const gap = it.x - cur.end;
      if (gap > 2 * fs) {
        finish(cur);
        cur = { x: it.x, text: it.str, end: inkEnd(it), spans: [span(it, fs)] };
        continue;
      }
      if (gap > 0.25 * fs && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) space(cur);
      cur.text += it.str;
      cur.spans.push(span(it, fs));
      cur.end = Math.max(cur.end, inkEnd(it));
    }
    if (cur && cur.text.trim()) finish(cur);
    if (!cells.length) continue;
    const last = cells[cells.length - 1];
    lines.push({
      y: b.y,
      x: cells[0].x,
      text: cells.map((c) => c.text).join('\t'),
      fontSize: Math.round(maxSize * 100) / 100,
      bold: chars > 0 && boldChars / chars > 0.5,
      cells,
      width: last.x + (last.width ?? 0) - cells[0].x,
    });
  }
  return lines;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Clusters the cell x-starts of a block of lines into shared column
 * boundaries. Returns ascending column start positions (points); an empty
 * array when the block is not tabular (fewer than two multi-cell lines).
 */
export function detectTableColumns(lines: TextLine[]): number[] {
  const multi = lines.filter((l) => l.cells.length >= 2);
  if (multi.length < 2) return [];
  const fs = median(multi.map((l) => l.fontSize)) || 10;
  const tol = Math.max(4, 0.8 * fs);
  const xs = multi.flatMap((l) => l.cells.map((c) => c.x)).sort((a, b) => a - b);
  const clusters: { min: number; sum: number; count: number }[] = [];
  for (const x of xs) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.sum / c.count <= tol) {
      c.sum += x;
      c.count++;
    } else {
      clusters.push({ min: x, sum: x, count: 1 });
    }
  }
  // A column must be used by at least two lines (or be the first column).
  const cols = clusters.filter((c, i) => c.count >= 2 || i === 0).map((c) => Math.round(c.min * 100) / 100);
  return cols.length >= 2 ? cols : [];
}

/** Column index for x given column starts (largest start <= x + tol). */
function columnFor(cols: number[], x: number, tol: number): number {
  let idx = 0;
  for (let i = 0; i < cols.length; i++) if (cols[i] <= x + tol) idx = i;
  return idx;
}

/**
 * Finds blocks of consecutive multi-cell lines and assigns every cell a
 * `col` index from the block's shared columns. Mutates and returns `lines`.
 */
export function assignTableColumns(lines: TextLine[]): TextLine[] {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].cells.length < 2) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].cells.length >= 2) j++;
    const block = lines.slice(i, j);
    const cols = detectTableColumns(block);
    if (cols.length) {
      const tol = Math.max(4, 0.8 * (median(block.map((l) => l.fontSize)) || 10));
      for (const line of block) {
        let prev = -1;
        for (const cell of line.cells) {
          let c = columnFor(cols, cell.x, tol);
          if (c <= prev) c = prev + 1; // never merge two cells into one column
          cell.col = c;
          prev = c;
        }
      }
    }
    i = j;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering helpers (browser)
// ---------------------------------------------------------------------------

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

export async function canvasToBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  const blob = await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, type, quality));
  if (!blob) throw new Error('Canvas encoding failed');
  return blob;
}

export function releaseCanvas(c: AnyCanvas): void {
  c.width = 0;
  c.height = 0;
}

const MAX_SIDE = 14000;
const MAX_AREA = 120_000_000;

/**
 * Renders a page onto a fresh canvas at `dpi`. `rotation` overrides the page
 * rotation (use 0 for unrotated page space). The caller owns the canvas.
 */
export async function renderPageToCanvas(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  dpi: number,
  rotation?: number,
): Promise<{ canvas: AnyCanvas; viewport: PageViewport; page: PDFPageProxy; scale: number }> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1, rotation: rotation ?? page.rotate });
  let scale = Math.max(0.05, dpi / 72);
  const side = Math.max(base.width, base.height) * scale;
  if (side > MAX_SIDE) scale *= MAX_SIDE / side;
  const area = base.width * base.height * scale * scale;
  if (area > MAX_AREA) scale *= Math.sqrt(MAX_AREA / area);
  const viewport = page.getViewport({ scale, rotation: rotation ?? page.rotate });
  const canvas = makeCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const isDom = typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
  await page.render({
    canvas: isDom ? (canvas as HTMLCanvasElement) : null,
    canvasContext: ctx,
    viewport,
  }).promise;
  return { canvas, viewport, page, scale };
}

async function renderPageBlob(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  dpi: number,
  type: 'image/png' | 'image/jpeg',
  quality = 0.9,
): Promise<{ blob: Blob; widthPt: number; heightPt: number; widthPx: number; heightPx: number }> {
  const { canvas, viewport, scale } = await renderPageToCanvas(pdf, pageNumber, dpi);
  try {
    const blob = await canvasToBlob(canvas, type, quality);
    return {
      blob,
      widthPt: viewport.width / scale,
      heightPt: viewport.height / scale,
      widthPx: canvas.width,
      heightPx: canvas.height,
    };
  } finally {
    releaseCanvas(canvas);
  }
}

async function blobToDataUri(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function pageList(pdf: PDFDocumentProxy, pageNumbers?: number[]): number[] {
  const all = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  if (!pageNumbers?.length) return all;
  return [...new Set(pageNumbers)].filter((n) => n >= 1 && n <= pdf.numPages).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// TIFF encoder (pure)
// ---------------------------------------------------------------------------

export interface TiffPage {
  width: number;
  height: number;
  /** RGBA (4 bytes/pixel) or RGB (3 bytes/pixel) pixels, row-major. */
  data: Uint8Array | Uint8ClampedArray;
  channels?: 3 | 4;
  dpi?: number;
}

/** Encodes one or more pages as an uncompressed baseline RGB (multi-page) TIFF. */
export function encodeTiff(pages: TiffPage[]): Uint8Array {
  if (!pages.length) throw new Error('No pages to encode');
  const TAGS = 13;
  const ifdSize = 2 + TAGS * 12 + 4;
  let size = 8;
  const layout = pages.map((p) => {
    const strip = p.width * p.height * 3;
    const dataOff = size;
    size += strip + (strip & 1);
    const bpsOff = size;
    size += 6 + 2; // 3 shorts + pad
    const xresOff = size;
    size += 8;
    const yresOff = size;
    size += 8;
    const ifdOff = size;
    size += ifdSize;
    return { strip, dataOff, bpsOff, xresOff, yresOff, ifdOff };
  });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49; // "II" little endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, layout[0].ifdOff, true);

  pages.forEach((p, idx) => {
    const L = layout[idx];
    const ch = p.channels ?? (p.data.length >= p.width * p.height * 4 ? 4 : 3);
    // Pixels
    let o = L.dataOff;
    const n = p.width * p.height;
    for (let i = 0, s = 0; i < n; i++, s += ch) {
      out[o++] = p.data[s];
      out[o++] = p.data[s + 1];
      out[o++] = p.data[s + 2];
    }
    for (let k = 0; k < 3; k++) dv.setUint16(L.bpsOff + k * 2, 8, true);
    const dpi = Math.max(1, Math.round(p.dpi ?? 72));
    dv.setUint32(L.xresOff, dpi, true);
    dv.setUint32(L.xresOff + 4, 1, true);
    dv.setUint32(L.yresOff, dpi, true);
    dv.setUint32(L.yresOff + 4, 1, true);

    let e = L.ifdOff;
    dv.setUint16(e, TAGS, true);
    e += 2;
    const entry = (tag: number, type: number, count: number, value: number) => {
      dv.setUint16(e, tag, true);
      dv.setUint16(e + 2, type, true);
      dv.setUint32(e + 4, count, true);
      if (type === 3 && count === 1) dv.setUint16(e + 8, value, true);
      else dv.setUint32(e + 8, value, true);
      e += 12;
    };
    const SHORT = 3;
    const LONG = 4;
    const RATIONAL = 5;
    entry(256, LONG, 1, p.width); // ImageWidth
    entry(257, LONG, 1, p.height); // ImageLength
    entry(258, SHORT, 3, L.bpsOff); // BitsPerSample
    entry(259, SHORT, 1, 1); // Compression: none
    entry(262, SHORT, 1, 2); // Photometric: RGB
    entry(273, LONG, 1, L.dataOff); // StripOffsets
    entry(277, SHORT, 1, 3); // SamplesPerPixel
    entry(278, LONG, 1, p.height); // RowsPerStrip
    entry(279, LONG, 1, L.strip); // StripByteCounts
    entry(282, RATIONAL, 1, L.xresOff); // XResolution
    entry(283, RATIONAL, 1, L.yresOff); // YResolution
    entry(284, SHORT, 1, 1); // PlanarConfiguration: chunky
    entry(296, SHORT, 1, 2); // ResolutionUnit: inch
    dv.setUint32(e, idx + 1 < pages.length ? layout[idx + 1].ifdOff : 0, true);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Page images
// ---------------------------------------------------------------------------

/**
 * Renders pages to images. `png`/`jpeg` return a ZIP of page-001.png ...;
 * `tiff` returns a single multi-page TIFF file (uncompressed, so large).
 */
export async function exportPagesAsImages(
  pdf: PDFDocumentProxy,
  opts: { format: 'png' | 'jpeg' | 'tiff'; dpi: number; pageNumbers?: number[]; quality?: number },
  onProgress?: ProgressFn,
): Promise<Blob> {
  const pages = pageList(pdf, opts.pageNumbers);
  onProgress?.(0, pages.length);
  if (opts.format === 'tiff') {
    const tiffPages: TiffPage[] = [];
    for (let i = 0; i < pages.length; i++) {
      const { canvas } = await renderPageToCanvas(pdf, pages[i], opts.dpi);
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      tiffPages.push({ width: img.width, height: img.height, data: img.data, channels: 4, dpi: opts.dpi });
      releaseCanvas(canvas);
      onProgress?.(i + 1, pages.length);
    }
    return new Blob([encodeTiff(tiffPages) as BlobPart], { type: 'image/tiff' });
  }
  const zip = new JSZip();
  const type = opts.format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = opts.format === 'png' ? 'png' : 'jpg';
  for (let i = 0; i < pages.length; i++) {
    const { blob } = await renderPageBlob(pdf, pages[i], opts.dpi, type, opts.quality ?? 0.92);
    zip.file(`page-${pad3(pages[i])}.${ext}`, await blob.arrayBuffer());
    onProgress?.(i + 1, pages.length);
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

// ---------------------------------------------------------------------------
// Structured text extraction
// ---------------------------------------------------------------------------

type Mat = number[];
export function mulMat(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

interface PositionedItem extends RawTextItem {
  angle: number;
  fontFamily: string;
  ascent: number;
}

interface FontStyle {
  bold: boolean;
  italic: boolean;
  family?: string;
}

async function fontStyles(page: PDFPageProxy, names: Set<string>): Promise<Map<string, FontStyle>> {
  const out = new Map<string, FontStyle>();
  try {
    await page.getOperatorList(); // makes the worker ship fonts to commonObjs
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      if (!page.commonObjs.has(n)) continue;
      const f = page.commonObjs.get(n) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean; fallbackName?: string } | null;
      const name = f?.name ?? '';
      let family = fontFamilyFromName(name);
      if (!family && f?.fallbackName === 'serif') family = 'Times New Roman';
      if (!family && f?.fallbackName === 'monospace') family = 'Courier New';
      out.set(n, {
        bold: !!(f?.bold || f?.black || /bold|black|heavy|semibold|demi/i.test(name)),
        italic: !!(f?.italic || /italic|oblique/i.test(name)),
        family,
      });
    } catch {
      // ignore
    }
  }
  return out;
}

async function positionedItems(page: PDFPageProxy, detectBold: boolean): Promise<{ items: PositionedItem[]; viewport: PageViewport }> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, TextStyle>;
  const textItems = content.items.filter((it): it is TextItem => 'str' in it);
  const fonts = detectBold ? await fontStyles(page, new Set(textItems.map((t) => t.fontName))) : new Map<string, FontStyle>();
  const items: PositionedItem[] = [];
  for (const it of textItems) {
    if (!it.str) continue;
    const tx = mulMat(viewport.transform, it.transform as number[]);
    const fontSize = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const style = styles[it.fontName];
    const vertical = !!style?.vertical;
    // Item width is in text space; scale it through the viewport (scale 1).
    const width = vertical ? it.height : it.width;
    let fontFamily = style?.fontFamily ?? 'sans-serif';
    if (!/serif|sans|mono|cursive|fantasy/i.test(fontFamily)) fontFamily = 'sans-serif';
    items.push({
      str: it.str,
      x: tx[4],
      y: tx[5],
      width: Math.abs(width),
      fontSize,
      bold: fonts.get(it.fontName)?.bold ?? false,
      italic: fonts.get(it.fontName)?.italic ?? false,
      family: fonts.get(it.fontName)?.family,
      angle,
      fontFamily,
      ascent: style?.ascent && style.ascent > 0 ? style.ascent : 0.8,
    });
  }
  return { items, viewport };
}

export async function extractStructuredText(
  pdf: PDFDocumentProxy,
  onProgress?: ProgressFn,
  opts: { detectBold?: boolean; pageNumbers?: number[] } = {},
): Promise<PageText[]> {
  const pages = pageList(pdf, opts.pageNumbers);
  const out: PageText[] = [];
  onProgress?.(0, pages.length);
  for (let i = 0; i < pages.length; i++) {
    const page = await pdf.getPage(pages[i]);
    const { items, viewport } = await positionedItems(page, opts.detectBold ?? true);
    // Only horizontal text takes part in line grouping.
    const horizontal = items.filter((it) => Math.abs(it.angle) < 0.05);
    const lines = assignTableColumns(groupTextItems(horizontal));
    out.push({ pageNumber: pages[i], width: viewport.width, height: viewport.height, lines });
    page.cleanup();
    onProgress?.(i + 1, pages.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain text / Markdown (pure)
// ---------------------------------------------------------------------------

export function exportPlainText(pages: PageText[]): string {
  return pages
    .map((p) => p.lines.map((l) => l.cells.map((c) => c.text).join('\t')).join('\n'))
    .join('\n\n\f\n');
}

export function bodyFontSize(pages: PageText[]): number {
  const sizes: number[] = [];
  for (const p of pages) for (const l of p.lines) for (let k = 0; k < Math.min(40, l.text.length); k++) sizes.push(l.fontSize);
  return median(sizes) || 11;
}

export function headingLevel(size: number, body: number, textLen: number): 0 | 1 | 2 | 3 {
  if (textLen > 200) return 0;
  const r = size / body;
  if (r >= 1.6) return 1;
  if (r >= 1.3) return 2;
  if (r >= 1.12) return 3;
  return 0;
}

// ---------------------------------------------------------------------------
// XLSX (hand-written SpreadsheetML)
// ---------------------------------------------------------------------------

export function columnLetter(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A worksheet part with inline strings; numeric-looking cells become numbers. */
export function buildSheetXml(rows: string[][]): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheetData>',
  ];
  rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((raw, c) => {
      const v = stripInvalidXmlChars(raw ?? '');
      if (!v.length) return;
      const ref = `${columnLetter(c)}${r + 1}`;
      const t = v.trim();
      // Leading zeros ("007") and very long digit strings stay text.
      if (NUMERIC.test(t) && !/^[+-]?0\d/.test(t) && t.replace(/\D/g, '').length <= 15) {
        cells.push(`<c r="${ref}"><v>${Number(t)}</v></c>`);
      } else {
        const text = xmlEscape(v.length > 32767 ? v.slice(0, 32767) : v);
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`);
      }
    });
    out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  out.push('</sheetData>', '</worksheet>');
  return out.join('');
}

/** Converts page lines to sheet rows, honouring table column indices. Pure. */
export function pageToRows(page: PageText): string[][] {
  return page.lines.map((l) => {
    const row: string[] = [];
    l.cells.forEach((c, i) => {
      const idx = c.col ?? i;
      row[idx] = row[idx] ? `${row[idx]} ${c.text}` : c.text;
    });
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    return row;
  });
}

function sheetName(n: number): string {
  return `Page ${n}`.slice(0, 31);
}

const XLSX_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** One sheet per page; `rows` (per page, e.g. from `layoutRows`) replaces the line-by-line rows. */
export async function exportToXlsx(pages: PageText[], rows?: string[][][]): Promise<Blob> {
  const zip = new JSZip();
  const sheets = pages.length ? pages : [{ pageNumber: 1, width: 0, height: 0, lines: [] }];
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  zip.file(
    '[Content_Types].xml',
    XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    XML +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((p, i) => `<sheet name="${xmlEscape(sheetName(p.pageNumber))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  zip.file('xl/styles.xml', XLSX_STYLES);
  sheets.forEach((p, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, buildSheetXml(rows?.[i] ?? pageToRows(p))));
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  });
}

// ---------------------------------------------------------------------------
// PPTX (hand-written PresentationML: picture per slide + notes with text)
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PNS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const EMU_PER_PT = 12700;

function rels(list: [id: string, type: string, target: string][]): string {
  return (
    XMLH +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map(([id, t, target]) => `<Relationship Id="${id}" Type="${REL}/${t}" Target="${target}"/>`).join('') +
    '</Relationships>'
  );
}

const EMPTY_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function themeXml(name: string): string {
  const sys = (tag: string, val: string, last: string) => `<a:${tag}><a:sysClr val="${val}" lastClr="${last}"/></a:${tag}>`;
  const srgb = (tag: string, v: string) => `<a:${tag}><a:srgbClr val="${v}"/></a:${tag}>`;
  const fontSet = (latin: string) => `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/></a:ln>`;
  const eff = '<a:effectStyle><a:effectLst/></a:effectStyle>';
  return (
    XMLH +
    `<a:theme xmlns:a="${NS_A}" name="${name}"><a:themeElements>` +
    '<a:clrScheme name="Office">' +
    sys('dk1', 'windowText', '000000') +
    sys('lt1', 'window', 'FFFFFF') +
    srgb('dk2', '44546A') +
    srgb('lt2', 'E7E6E6') +
    srgb('accent1', '4472C4') +
    srgb('accent2', 'ED7D31') +
    srgb('accent3', 'A5A5A5') +
    srgb('accent4', 'FFC000') +
    srgb('accent5', '5B9BD5') +
    srgb('accent6', '70AD47') +
    srgb('hlink', '0563C1') +
    srgb('folHlink', '954F72') +
    '</a:clrScheme>' +
    `<a:fontScheme name="Office"><a:majorFont>${fontSet('Calibri Light')}</a:majorFont><a:minorFont>${fontSet('Calibri')}</a:minorFont></a:fontScheme>` +
    '<a:fmtScheme name="Office">' +
    `<a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${eff}${eff}${eff}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst>` +
    '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}

function notesParagraphs(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((l) =>
      l.trim()
        ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlEscape(l)}</a:t></a:r></a:p>`
        : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>',
    )
    .join('');
}

export interface PptxSlideInput {
  /** Image file name inside ppt/media (png or jpeg). */
  image: string;
  imageBytes: Uint8Array | ArrayBuffer;
  widthPt: number;
  heightPt: number;
  notes: string;
}

/** Slide size in EMU clamped to PowerPoint's allowed range, keeping aspect. Pure. */
export function pptxSlideSize(widthPt: number, heightPt: number): { cx: number; cy: number } {
  const MIN = 914400;
  const MAX = 51206400;
  let cx = Math.max(1, widthPt) * EMU_PER_PT;
  let cy = Math.max(1, heightPt) * EMU_PER_PT;
  const down = Math.min(1, MAX / cx, MAX / cy);
  cx *= down;
  cy *= down;
  const up = Math.max(1, MIN / cx, MIN / cy);
  cx = Math.min(MAX, cx * up);
  cy = Math.min(MAX, cy * up);
  return { cx: Math.round(cx), cy: Math.round(cy) };
}

/** Builds all PPTX parts (pure, except for the image bytes it passes through). */
export function buildPptxParts(slides: PptxSlideInput[], title = 'Presentation'): Map<string, string | Uint8Array | ArrayBuffer> {
  const parts = new Map<string, string | Uint8Array | ArrayBuffer>();
  const first = slides[0] ?? { widthPt: 720, heightPt: 540 };
  const { cx, cy } = pptxSlideSize(first.widthPt, first.heightPt);
  const exts = new Set(slides.map((s) => s.image.split('.').pop()!.toLowerCase()));

  parts.set(
    '[Content_Types].xml',
    XMLH +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (exts.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      (exts.has('jpg') ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
      (exts.has('jpeg') ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>' +
      '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>' +
      '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      slides
        .map(
          (_, i) =>
            `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
            `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
        )
        .join('') +
      '</Types>',
  );

  parts.set(
    '_rels/.rels',
    XMLH +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
  );
  parts.set(
    'docProps/core.xml',
    XMLH +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>Adika PDF Editor</dc:creator>` +
      '</cp:coreProperties>',
  );
  parts.set(
    'docProps/app.xml',
    XMLH +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
      `<Application>Adika PDF Editor</Application><Slides>${slides.length}</Slides>` +
      '</Properties>',
  );

  parts.set(
    'ppt/presentation.xml',
    XMLH +
      `<p:presentation ${PNS} saveSubsetFonts="1">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' +
      '<p:sldIdLst>' +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('') +
      '</p:sldIdLst>' +
      `<p:sldSz cx="${cx}" cy="${cy}"/>` +
      '<p:notesSz cx="6858000" cy="9144000"/>' +
      '<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle>' +
      '</p:presentation>',
  );
  parts.set(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
      ['rId3', 'theme', 'theme/theme1.xml'],
      ['rId4', 'presProps', 'presProps.xml'],
      ['rId5', 'viewProps', 'viewProps.xml'],
      ['rId6', 'tableStyles', 'tableStyles.xml'],
      ...slides.map((_, i): [string, string, string] => [`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]),
    ]),
  );
  parts.set('ppt/presProps.xml', XMLH + `<p:presentationPr ${PNS}/>`);
  parts.set(
    'ppt/viewProps.xml',
    XMLH +
      `<p:viewPr ${PNS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>` +
      '<p:gridSpacing cx="76200" cy="76200"/></p:viewPr>',
  );
  parts.set('ppt/tableStyles.xml', XMLH + `<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  parts.set('ppt/theme/theme1.xml', themeXml('Adika'));
  parts.set('ppt/theme/theme2.xml', themeXml('Adika Notes'));

  parts.set(
    'ppt/slideMasters/slideMaster1.xml',
    XMLH +
      `<p:sldMaster ${PNS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_GROUP}</p:spTree></p:cSld>` +
      `<p:clrMap ${CLR_MAP}/>` +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '</p:sldMaster>',
  );
  parts.set(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
  );
  parts.set(
    'ppt/slideLayouts/slideLayout1.xml',
    XMLH +
      `<p:sldLayout ${PNS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_GROUP}</p:spTree></p:cSld>` +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
  );
  parts.set('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));

  const notesBodySp = (txBody: string, withXfrm: boolean) =>
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    (withXfrm
      ? '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      : '<p:spPr/>') +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${txBody}</p:txBody></p:sp>`;

  parts.set(
    'ppt/notesMasters/notesMaster1.xml',
    XMLH +
      `<p:notesMaster ${PNS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_GROUP}` +
      notesBodySp('<a:p><a:endParaRPr lang="en-US"/></a:p>', true) +
      `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/></p:notesMaster>`,
  );
  parts.set('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([['rId1', 'theme', '../theme/theme2.xml']]));

  slides.forEach((s, i) => {
    const n = i + 1;
    // Fit the page picture into the slide, centred.
    const k = Math.min(cx / (s.widthPt * EMU_PER_PT), cy / (s.heightPt * EMU_PER_PT));
    const w = Math.round(s.widthPt * EMU_PER_PT * k);
    const h = Math.round(s.heightPt * EMU_PER_PT * k);
    const x = Math.round((cx - w) / 2);
    const y = Math.round((cy - h) / 2);
    parts.set(
      `ppt/slides/slide${n}.xml`,
      XMLH +
        `<p:sld ${PNS}><p:cSld><p:spTree>${EMPTY_GROUP}` +
        `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${n}" descr="Page ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
        '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
        `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    );
    parts.set(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', `../media/${s.image}`],
        ['rId3', 'notesSlide', `../notesSlides/notesSlide${n}.xml`],
      ]),
    );
    parts.set(
      `ppt/notesSlides/notesSlide${n}.xml`,
      XMLH +
        `<p:notes ${PNS}><p:cSld><p:spTree>${EMPTY_GROUP}` +
        notesBodySp(notesParagraphs(s.notes || ''), false) +
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>',
    );
    parts.set(
      `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
      rels([
        ['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
        ['rId2', 'slide', `../slides/slide${n}.xml`],
      ]),
    );
    parts.set(`ppt/media/${s.image}`, s.imageBytes);
  });
  return parts;
}

export async function exportToPptx(
  pdf: PDFDocumentProxy,
  pages: PageText[],
  opts: { dpi: number; title?: string },
  onProgress?: ProgressFn,
): Promise<Blob> {
  const byNumber = new Map(pages.map((p) => [p.pageNumber, p]));
  const numbers = pages.length ? pages.map((p) => p.pageNumber) : pageList(pdf);
  const slides: PptxSlideInput[] = [];
  onProgress?.(0, numbers.length);
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    const r = await renderPageBlob(pdf, n, opts.dpi, 'image/jpeg', 0.9);
    const text = byNumber.get(n);
    slides.push({
      image: `image${i + 1}.jpg`,
      imageBytes: await r.blob.arrayBuffer(),
      widthPt: r.widthPt,
      heightPt: r.heightPt,
      notes: text ? text.lines.map((l) => l.cells.map((c) => c.text).join('  ')).join('\n') : '',
    });
    onProgress?.(i + 1, numbers.length);
  }
  const zip = new JSZip();
  for (const [name, data] of buildPptxParts(slides, opts.title ?? 'Presentation')) zip.file(name, data);
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    compression: 'DEFLATE',
  });
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * SVG export.
 *
 * Limitation: pdf.js no longer ships an SVG backend, so vector graphics
 * cannot be reproduced. The page (graphics and glyphs) is embedded as a PNG
 * raster at `dpi`, and every text run is added as a real <text> element
 * positioned from getTextContent so it is selectable/searchable. By default
 * that text is transparent (the raster already shows it); pass
 * `visibleText: true` to paint it instead, which may double up with the
 * raster glyphs and uses substitute fonts.
 */
export async function exportToSvg(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  opts: { dpi: number; visibleText?: boolean },
): Promise<string> {
  const r = await renderPageBlob(pdf, pageNumber, opts.dpi, 'image/png');
  const uri = await blobToDataUri(r.blob);
  const page = await pdf.getPage(pageNumber);
  const { items, viewport } = await positionedItems(page, false);
  const W = +viewport.width.toFixed(3);
  const H = +viewport.height.toFixed(3);
  const fill = opts.visibleText ? '#000' : 'transparent';
  const texts = items
    .filter((it) => it.str.trim())
    .map((it) => {
      const deg = (it.angle * 180) / Math.PI;
      const tf = `translate(${it.x.toFixed(2)} ${it.y.toFixed(2)})${Math.abs(deg) > 0.01 ? ` rotate(${deg.toFixed(2)})` : ''}`;
      const len = it.width > 0 ? ` textLength="${it.width.toFixed(2)}" lengthAdjust="spacingAndGlyphs"` : '';
      return `<text transform="${tf}" font-size="${it.fontSize.toFixed(2)}" font-family="${xmlEscape(it.fontFamily)}"${
        it.bold ? ' font-weight="bold"' : ''
      }${len} xml:space="preserve">${xmlEscape(it.str)}</text>`;
    })
    .join('\n');
  page.cleanup();
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}pt" height="${H}pt" viewBox="0 0 ${W} ${H}">\n` +
    `<image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" href="${uri}" xlink:href="${uri}"/>\n` +
    `<g fill="${fill}">\n${texts}\n</g>\n</svg>\n`
  );
}

export async function exportAllSvgZip(
  pdf: PDFDocumentProxy,
  opts: { dpi: number; visibleText?: boolean; pageNumbers?: number[] },
  onProgress?: ProgressFn,
): Promise<Blob> {
  const pages = pageList(pdf, opts.pageNumbers);
  const zip = new JSZip();
  onProgress?.(0, pages.length);
  for (let i = 0; i < pages.length; i++) {
    zip.file(`page-${pad3(pages[i])}.svg`, await exportToSvg(pdf, pages[i], opts));
    onProgress?.(i + 1, pages.length);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Builds the self-contained HTML document. Pure given image data URIs. */
export function buildHtmlDocument(title: string, pages: { page: PageText; imageUri: string }[]): string {
  const pct = (v: number, of: number) => ((v / of) * 100).toFixed(3);
  const body = pages
    .map(({ page, imageUri }) => {
      const W = page.width || 1;
      const H = page.height || 1;
      const spans = page.lines
        .flatMap((l) =>
          l.cells.map((c) => {
            const top = l.y - l.fontSize * 0.8;
            const style = `left:${pct(c.x, W)}%;top:${pct(top, H)}%;font-size:${pct(l.fontSize, W)}cqw${l.bold ? ';font-weight:700' : ''}`;
            const w = c.width && c.width > 0 ? ` data-w="${pct(c.width, W)}"` : '';
            return `<span style="${style}"${w}>${xmlEscape(c.text)}</span>`;
          }),
        )
        .join('');
      return (
        `<section class="page" id="page-${page.pageNumber}" style="aspect-ratio:${W.toFixed(2)} / ${H.toFixed(2)}">` +
        `<img src="${imageUri}" alt="Page ${page.pageNumber}">` +
        `<div class="text">${spans}</div></section>`
      );
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Adika PDF Editor">
<title>${xmlEscape(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:16px;background:#e9ebee;font-family:Helvetica,Arial,sans-serif}
.page{position:relative;width:100%;max-width:1000px;margin:0 auto 16px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);container-type:inline-size;overflow:hidden}
.page img{position:absolute;inset:0;width:100%;height:100%;display:block;user-select:none}
.text{position:absolute;inset:0}
.text span{position:absolute;white-space:pre;color:transparent;line-height:1;transform-origin:0 0}
.text span::selection{background:rgba(0,100,255,.3);color:transparent}
@media print{body{padding:0;background:#fff}.page{box-shadow:none;margin:0;break-after:page;max-width:none}}
</style>
</head>
<body>
${body}
<script>
(function(){
  function fit(){
    document.querySelectorAll('.text span[data-w]').forEach(function(s){
      s.style.transform='';
      var page=s.closest('.page');if(!page)return;
      var target=parseFloat(s.getAttribute('data-w'))/100*page.clientWidth;
      var actual=s.getBoundingClientRect().width;
      if(actual>0&&target>0)s.style.transform='scaleX('+(target/actual)+')';
    });
  }
  var t;window.addEventListener('resize',function(){clearTimeout(t);t=setTimeout(fit,100);});
  if(document.readyState==='complete')fit();else window.addEventListener('load',fit);
})();
</script>
</body>
</html>
`;
}

export async function exportToHtml(
  pdf: PDFDocumentProxy,
  pages: PageText[],
  opts: { dpi: number; title?: string },
  onProgress?: ProgressFn,
): Promise<Blob> {
  const out: { page: PageText; imageUri: string }[] = [];
  onProgress?.(0, pages.length);
  for (let i = 0; i < pages.length; i++) {
    const r = await renderPageBlob(pdf, pages[i].pageNumber, opts.dpi, 'image/jpeg', 0.85);
    out.push({ page: pages[i], imageUri: await blobToDataUri(r.blob) });
    onProgress?.(i + 1, pages.length);
  }
  return new Blob([buildHtmlDocument(opts.title ?? 'Document', out)], { type: 'text/html;charset=utf-8' });
}
