// PDF -> Word (.docx). `collectDocxGraphics` reads what the text layer lacks
// (embedded images, thin rules, text colour and underlines) from pdf.js in
// the browser; `exportToDocx` lays each page out with `layoutPage` and
// writes either flowing, editable text ("flow") or paragraphs pinned to their
// PDF position ("exact").

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import {
  AlignmentType,
  BorderStyle,
  ColumnBreak,
  Document,
  Footer,
  FrameAnchorType,
  Header,
  HeadingLevel,
  HeightRule,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LineRuleType,
  OverlapType,
  Packer,
  PageNumber,
  Paragraph,
  SectionType,
  ShadingType,
  Tab,
  TabStopType,
  Table,
  TableAnchorType,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  TextWrappingSide,
  TextWrappingType,
  VerticalPositionRelativeFrom,
  WidthType,
  type ISectionOptions,
} from 'docx';
import {
  bodyFontSize,
  median,
  canvasToBlob,
  makeCanvas,
  mulMat,
  releaseCanvas,
  renderPageToCanvas,
  stripInvalidXmlChars,
  type AnyCanvas,
  type PageText,
  type ProgressFn,
  type TextCell,
  type TextLine,
  type TextSpan,
} from './convert';
import { blockBottom, blockTop, detectRunningLines, layoutPage, type Block, type FloatImage, type Box, type ImageBlock, type PageLayout, type ParaBlock, type RunningLines, type TableBlock } from './wordLayout';

export interface DocxImage {
  box: Box;
  data: Uint8Array;
  type: 'png' | 'jpg';
}

export interface DocxPageGraphics {
  images: DocxImage[];
  rules: Box[];
  /** Solid backgrounds behind text: box and RRGGBB. */
  shades?: { box: Box; color: string }[];
}

export type DocxLayoutMode = 'flow' | 'exact';

export interface DocxOptions {
  /** "flow" (default): editable paragraphs; "exact": every block pinned to its PDF position. */
  layout?: DocxLayoutMode;
  /** Per page, from `collectDocxGraphics`; without it the document has text only. */
  graphics?: DocxPageGraphics[];
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const tw = (pt: number) => Math.round(pt * 20);
const emu = (pt: number) => Math.round(pt * 12700);
/** docx image sizes are CSS pixels (96 per inch). */
const px = (pt: number) => Math.max(1, Math.round((pt * 96) / 72));

// ---------------------------------------------------------------------------
// Graphics collection (browser: pdf.js operator list + a rendered page)
// ---------------------------------------------------------------------------

type Mat = number[];

/** pdf.js operator codes (`OPS` in pdfjs-dist; kept local so this module loads in node). */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  constructPath: 91,
} as const;

interface PdfImageData {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: ImageBitmap;
}

const PAINT_OPS = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const STROKE_OPS = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

function boxOf(m: Mat, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  return {
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  };
}

interface FoundImage {
  box: Box;
  m: Mat;
  img: PdfImageData | null;
}

interface ScanResult {
  images: FoundImage[];
  rules: Box[];
  /** Filled, non-thin shapes (chart bars, bullets drawn as dots, panels). */
  fills: Box[];
}

function scanOperators(page: PDFPageProxy, ops: { fnArray: number[]; argsArray: unknown[][] }, viewport: PageViewport): ScanResult {
  const vt = viewport.transform as Mat;
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  const images: FoundImage[] = [];
  const rules: Box[] = [];
  const fills: Box[] = [];
  const getObj = (id: unknown): PdfImageData | null => {
    if (typeof id !== 'string') return (id as PdfImageData) ?? null;
    try {
      const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
      return objs.has(id) ? (objs.get(id) as PdfImageData) : null;
    } catch {
      return null;
    }
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] ?? [];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = mulMat(ctm, args as Mat);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0])) ctm = mulMat(ctm, args[0] as Mat);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        const m = mulMat(vt, ctm);
        const img = fn === OPS.paintImageMaskXObject ? null : getObj(args[0]);
        images.push({ box: boxOf(m, 0, 0, 1, 1), m, img });
        break;
      }
      case OPS.constructPath: {
        const [op, , minMax] = args as [number, unknown, ArrayLike<number> | null];
        if (!PAINT_OPS.has(op) || !minMax || minMax.length < 4 || !Number.isFinite(minMax[0])) break;
        const b = boxOf(mulMat(vt, ctm), minMax[0], minMax[1], minMax[2], minMax[3]);
        const w = b.x1 - b.x0;
        const h = b.y1 - b.y0;
        if ((h <= 2.5 && w >= 6) || (w <= 2.5 && h >= 6)) rules.push(b);
        else if (STROKE_OPS.has(op) && w >= 6 && h >= 6) {
          // Stroked rectangles (cell borders): keep their edges.
          rules.push({ ...b, y1: b.y0 + 0.5 }, { ...b, y0: b.y1 - 0.5 }, { ...b, x1: b.x0 + 0.5 }, { ...b, x0: b.x1 - 0.5 });
        } else if (!STROKE_OPS.has(op) && w >= 1.5 && h >= 1.5) fills.push(b);
        break;
      }
      default:
        break;
    }
  }
  return { images, rules, fills };
}

/**
 * Bullets that the PDF draws as small filled dots (browsers do this) become
 * a "•" cell in front of the line they belong to. Returns the dots used.
 */
export function addDotBullets(page: PageText, fills: Box[]): Set<Box> {
  const used = new Set<Box>();
  for (const d of fills) {
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    if (w > 8 || h > 8 || w / h > 1.6 || h / w > 1.6) continue;
    const cy = (d.y0 + d.y1) / 2;
    const line = page.lines.find((l) => w <= 0.7 * l.fontSize && cy <= l.y && cy >= l.y - l.fontSize && d.x1 <= l.x && l.x - d.x1 <= 3 * l.fontSize);
    if (!line || line.cells[0].text === '•') continue;
    const cell: TextCell = {
      x: d.x0,
      text: '•',
      width: w,
      spans: [{ text: '•', x: d.x0, width: w, fontSize: line.fontSize, bold: false, italic: false }],
    };
    line.cells.unshift(cell);
    line.width = (line.width ?? 0) + (line.x - d.x0);
    line.x = d.x0;
    line.text = line.cells.map((c) => c.text).join('\t');
    used.add(d);
  }
  return used;
}

function unionBox(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Groups filled shapes into figures (charts, diagrams, logos drawn as
 * vectors). A group that holds running text is a text box or shading, not a
 * figure, and is skipped; short labels inside a figure are baked into it.
 */
export function vectorFigures(page: PageText, fills: Box[], rules: Box[]): { box: Box; labels: Set<TextLine> }[] {
  const area = page.width * page.height;
  const pad = 3;
  let groups = fills.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) < 0.8 * area).map((b) => ({ ...b, n: 1 }));
  // Merge touching boxes until stable.
  for (let changed = true; changed; ) {
    changed = false;
    const next: (Box & { n: number })[] = [];
    for (const b of groups) {
      const hit = next.find((n) => b.x0 <= n.x1 + pad && n.x0 <= b.x1 + pad && b.y0 <= n.y1 + pad && n.y0 <= b.y1 + pad);
      if (hit) {
        Object.assign(hit, unionBox(hit, b), { n: hit.n + b.n });
        changed = true;
      } else next.push({ ...b });
    }
    groups = next;
  }
  const out: { box: Box; labels: Set<TextLine> }[] = [];
  for (const g of groups) {
    const w = g.x1 - g.x0;
    const h = g.y1 - g.y0;
    if (w < 30 || h < 20) continue;
    const labels = new Set<TextLine>();
    let inkArea = 0;
    let longText = false;
    let partial = false;
    for (const l of page.lines) {
      const lb = { x0: l.x, y0: l.y - 0.8 * l.fontSize, x1: l.x + (l.width ?? 0), y1: l.y + 0.25 * l.fontSize };
      const overlaps = lb.x0 < g.x1 && g.x0 < lb.x1 && lb.y0 < g.y1 && g.y0 < lb.y1;
      if (!overlaps) continue;
      const within = lb.x0 >= g.x0 - 2 && lb.x1 <= g.x1 + 2 && lb.y0 >= g.y0 - 2 && lb.y1 <= g.y1 + 2;
      if (!within) partial = true;
      labels.add(l);
      inkArea += (lb.x1 - lb.x0) * (lb.y1 - lb.y0);
      if (l.text.length > 60) longText = true;
    }
    if (partial || longText || inkArea > 0.15 * w * h) continue;
    // One plain rectangle behind text is a panel (shading), not a figure.
    if (labels.size && g.n === 1) continue;
    // Shaded table cells sit among the table's borders.
    if (labels.size && rules.filter((r) => r.x0 < g.x1 && g.x0 < r.x1 && r.y0 <= g.y1 && g.y0 <= r.y1).length >= 2) continue;
    out.push({ box: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 }, labels });
  }
  return out;
}

/** Colour along the edge of a box, if it is one solid colour. */
function solidRing(rgba: Uint8ClampedArray, W: number, H: number, x0: number, y0: number, x1: number, y1: number): string | undefined {
  const px: number[][] = [];
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (y * W + x) * 4;
    px.push([rgba[k], rgba[k + 1], rgba[k + 2]]);
  };
  for (let x = x0; x < x1; x += 2) {
    add(x, y0);
    add(x, y1 - 1);
  }
  for (let y = y0; y < y1; y += 2) {
    add(x0, y);
    add(x1 - 1, y);
  }
  if (px.length < 8) return undefined;
  const m = [0, 1, 2].map((c) => median(px.map((p) => p[c])));
  const same = px.filter((p) => Math.abs(p[0] - m[0]) + Math.abs(p[1] - m[1]) + Math.abs(p[2] - m[2]) <= 24).length;
  if (same < 0.85 * px.length || Math.min(...m) > 245) return undefined;
  return m.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Filled rectangles with text on them (code blocks, shaded cells and notes) and their colour. */
function shadeBoxes(page: PageText, fills: Box[], render: { canvas: AnyCanvas; scale: number }): { box: Box; color: string }[] {
  const ctx = render.canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) return [];
  const W = render.canvas.width;
  const H = render.canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const s = render.scale;
  const out: { box: Box; color: string }[] = [];
  for (const b of fills) {
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (w < 20 || h < 8 || w * h > 0.8 * page.width * page.height) continue;
    const hasText = page.lines.some((l) => {
      const mid = l.y - 0.35 * l.fontSize;
      return mid > b.y0 && mid < b.y1 && l.x >= b.x0 - 2 && l.x < b.x1;
    });
    if (!hasText) continue;
    const color = solidRing(data, W, H, Math.ceil(b.x0 * s) + 2, Math.ceil(b.y0 * s) + 2, Math.floor(b.x1 * s) - 2, Math.floor(b.y1 * s) - 2);
    if (color) out.push({ box: b, color });
  }
  return out;
}

/** True when a crop is one flat colour (an empty panel is not worth a picture). */
function isFlat(render: { canvas: AnyCanvas; scale: number }, box: Box): boolean {
  const ctx = render.canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) return true;
  const s = render.scale;
  const x = Math.max(0, Math.floor(box.x0 * s));
  const y = Math.max(0, Math.floor(box.y0 * s));
  const w = Math.max(1, Math.min(render.canvas.width - x, Math.ceil((box.x1 - box.x0) * s)));
  const h = Math.max(1, Math.min(render.canvas.height - y, Math.ceil((box.y1 - box.y0) * s)));
  const d = ctx.getImageData(x, y, w, h).data;
  const [r0, g0, b0] = [d[0], d[1], d[2]];
  let off = 0;
  const n = d.length / 4;
  for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - r0) + Math.abs(d[k + 1] - g0) + Math.abs(d[k + 2] - b0) > 24) off++;
  return off < 0.02 * n;
}

/** Converts pdf.js decoded image data to RGBA. Returns [rgba, hasAlpha]. */
function toRgba(img: PdfImageData): [Uint8ClampedArray, boolean] | null {
  const { width: w, height: h, data, kind } = img;
  if (!data) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  if (kind === 3) {
    out.set(data.subarray(0, out.length));
    let alpha = false;
    for (let k = 3; k < out.length; k += 4) if (out[k] < 250) { alpha = true; break; }
    return [out, alpha];
  }
  if (kind === 2) {
    for (let s = 0, d = 0; d < out.length; s += 3, d += 4) {
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = 255;
    }
    return [out, false];
  }
  if (kind === 1) {
    // 1 bit per pixel, rows padded to whole bytes; a set bit is white.
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const d = (y * w + x) * 4;
        out[d] = out[d + 1] = out[d + 2] = v;
        out[d + 3] = 255;
      }
    }
    return [out, false];
  }
  return null;
}

async function encode(c: AnyCanvas, alpha: boolean): Promise<{ data: Uint8Array; type: 'png' | 'jpg' }> {
  const big = c.width * c.height > 250_000;
  const type = alpha || !big ? 'png' : 'jpg';
  const blob = await canvasToBlob(c, type === 'png' ? 'image/png' : 'image/jpeg', 0.9);
  return { data: new Uint8Array(await blob.arrayBuffer()), type };
}

function hasTransparency(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let k = 3; k < d.length; k += 16) if (d[k] < 250) return true;
  return false;
}

/** Draws the decoded image upright at no more than 300 dpi of its placed size. */
async function encodeImage(found: FoundImage): Promise<{ data: Uint8Array; type: 'png' | 'jpg' } | null> {
  const img = found.img;
  if (!img || !img.width || !img.height) return null;
  const m = found.m;
  // Rotated or skewed placements are handled by cropping the rendered page instead.
  if (Math.abs(m[1]) > 1e-3 * Math.abs(m[0]) || Math.abs(m[2]) > 1e-3 * Math.abs(m[3])) return null;
  const boxW = found.box.x1 - found.box.x0;
  const boxH = found.box.y1 - found.box.y0;
  const scale = Math.min(1, (boxW * 300) / 72 / img.width, (boxH * 300) / 72 / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = makeCanvas(img.width, img.height);
  const out = makeCanvas(w, h);
  try {
    const sctx = src.getContext('2d') as CanvasRenderingContext2D | null;
    const octx = out.getContext('2d') as CanvasRenderingContext2D | null;
    if (!sctx || !octx) return null;
    let alpha = false;
    if (img.bitmap) {
      sctx.drawImage(img.bitmap, 0, 0);
      alpha = hasTransparency(sctx, img.width, img.height);
    } else {
      const conv = toRgba(img);
      if (!conv) return null;
      sctx.putImageData(new ImageData(conv[0] as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
      alpha = conv[1];
    }
    // Row 0 of the image is its top edge; flip when the placement mirrors it.
    const flipV = m[3] > 0;
    const flipH = m[0] < 0;
    octx.save();
    octx.translate(flipH ? w : 0, flipV ? h : 0);
    octx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(src as CanvasImageSource, 0, 0, w, h);
    octx.restore();
    if (!alpha) {
      // JPEG has no alpha channel: flatten onto white.
      octx.globalCompositeOperation = 'destination-over';
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, w, h);
    }
    return await encode(out, alpha);
  } finally {
    releaseCanvas(src);
    releaseCanvas(out);
  }
}

async function cropRendered(render: { canvas: AnyCanvas; scale: number }, box: Box): Promise<{ data: Uint8Array; type: 'png' | 'jpg' } | null> {
  const s = render.scale;
  const x = Math.max(0, Math.floor(box.x0 * s));
  const y = Math.max(0, Math.floor(box.y0 * s));
  const w = Math.min(render.canvas.width - x, Math.ceil((box.x1 - box.x0) * s));
  const h = Math.min(render.canvas.height - y, Math.ceil((box.y1 - box.y0) * s));
  if (w < 2 || h < 2) return null;
  const c = makeCanvas(w, h);
  try {
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(render.canvas as CanvasImageSource, x, y, w, h, 0, 0, w, h);
    return await encode(c, false);
  } finally {
    releaseCanvas(c);
  }
}

/**
 * Text colour under a span: the most common colour in its box that clearly
 * differs from the most common one (the background). Undefined for black-ish.
 */
export function sampleInkColor(
  rgba: Uint8ClampedArray,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  /** Background colour measured around the span; bold text can cover more pixels than its background. */
  background?: [number, number, number],
): string | undefined {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y * stride + x) * 4;
      const r = rgba[k];
      const g = rgba[k + 1];
      const b = rgba[k + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = bins.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else bins.set(key, { n: 1, r, g, b });
      total++;
    }
  }
  if (!total) return undefined;
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  const avg = (e: { n: number; r: number; g: number; b: number }) => [e.r / e.n, e.g / e.n, e.b / e.n];
  const [br, bgG, bb] = background ?? avg(sorted[0]);
  // Anti-aliased edges lie between paper and ink, so the true ink is the significant colour farthest from the paper.
  const dist = (e: { n: number; r: number; g: number; b: number }) => {
    const [r, g, b] = avg(e);
    return Math.hypot(r - br, g - bgG, b - bb);
  };
  const ink = sorted.filter((e) => e.n >= Math.max(2, 0.03 * total) && dist(e) > 90).sort((a, b) => dist(b) - dist(a))[0];
  if (!ink) return undefined;
  const [r, g, b] = avg(ink).map(Math.round);
  if (r < 64 && g < 64 && b < 64) return undefined;
  // A pale neutral grey on paper is almost always thin black text seen through anti-aliasing;
  // showing black as near-invisible grey would be far worse than missing a light-grey caption.
  if (Math.max(r, g, b) - Math.min(r, g, b) < 16 && r + g + b > 3 * 150 && br + bgG + bb > 3 * 230) return undefined;
  return [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Most common colour on a ring just outside a box (the paper or panel the text sits on). */
export function backgroundAround(rgba: Uint8ClampedArray, W: number, H: number, x0: number, y0: number, x1: number, y1: number): [number, number, number] | undefined {
  const count = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (y * W + x) * 4;
    const key = ((rgba[k] >> 4) << 8) | ((rgba[k + 1] >> 4) << 4) | (rgba[k + 2] >> 4);
    const e = count.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += rgba[k];
    e.g += rgba[k + 1];
    e.b += rgba[k + 2];
    count.set(key, e);
  };
  const h = y1 - y0;
  const above = y0 - Math.max(2, Math.round(0.35 * h));
  const below = y1 + Math.max(2, Math.round(0.45 * h));
  for (let x = x0; x < x1; x++) {
    add(x, above);
    add(x, below);
  }
  for (let y = y0; y < y1; y++) {
    add(x0 - 3, y);
    add(x1 + 2, y);
  }
  let best: { n: number; r: number; g: number; b: number } | undefined;
  for (const e of count.values()) if (!best || e.n > best.n) best = e;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : undefined;
}

function spansOfLine(l: TextLine): TextSpan[] {
  return l.cells.flatMap((c) => c.spans ?? []);
}

/**
 * Reads images, rules, text colours and underlines for each page of `pages`
 * (mutating the spans in `pages`). Best effort: a page whose graphics cannot
 * be read keeps its text.
 */
export async function collectDocxGraphics(pdf: PDFDocumentProxy, pages: PageText[], onProgress?: ProgressFn): Promise<DocxPageGraphics[]> {
  const out: DocxPageGraphics[] = [];
  onProgress?.(0, pages.length);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const result: DocxPageGraphics = { images: [], rules: [] };
    let render: { canvas: AnyCanvas; scale: number } | null = null;
    try {
      const page = await pdf.getPage(p.pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      const scan = scanOperators(page, ops as unknown as { fnArray: number[]; argsArray: unknown[][] }, viewport);
      result.rules = scan.rules;
      const dots = addDotBullets(p, scan.fills);
      try {
        const r = await renderPageToCanvas(pdf, p.pageNumber, 144);
        render = { canvas: r.canvas, scale: r.scale };
      } catch {
        render = null;
      }
      if (render) {
        for (const fig of vectorFigures(p, scan.fills.filter((f) => !dots.has(f)), scan.rules)) {
          if (isFlat(render, fig.box)) continue;
          const enc = await cropRendered(render, fig.box).catch(() => null);
          if (!enc) continue;
          result.images.push({ box: fig.box, ...enc });
          // Labels are part of the picture now.
          if (fig.labels.size) p.lines = p.lines.filter((l) => !fig.labels.has(l));
        }
      }
      for (const found of scan.images) {
        const b = found.box;
        if (b.x1 - b.x0 < 6 || b.y1 - b.y0 < 6) continue;
        const clipped = { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(p.width, b.x1), y1: Math.min(p.height, b.y1) };
        if (clipped.x1 - clipped.x0 < 6 || clipped.y1 - clipped.y0 < 6) continue;
        let enc: { data: Uint8Array; type: 'png' | 'jpg' } | null = null;
        const exact = clipped.x0 === b.x0 && clipped.y0 === b.y0 && clipped.x1 === b.x1 && clipped.y1 === b.y1;
        try {
          if (exact) enc = await encodeImage(found);
        } catch {
          enc = null;
        }
        if (!enc && render) enc = await cropRendered(render, clipped).catch(() => null);
        if (enc) result.images.push({ box: clipped, ...enc });
      }
      if (render) {
        const ctx = render.canvas.getContext('2d') as CanvasRenderingContext2D | null;
        const W = render.canvas.width;
        const H = render.canvas.height;
        const data = ctx?.getImageData(0, 0, W, H).data;
        const s = render.scale;
        for (const l of p.lines) {
          for (const sp of spansOfLine(l)) {
            if (!sp.text.trim() || !data) continue;
            const x0 = Math.max(0, Math.floor(sp.x * s));
            const x1 = Math.min(W, Math.ceil((sp.x + sp.width) * s));
            const y0 = Math.max(0, Math.floor((l.y - 0.7 * sp.fontSize) * s));
            const y1 = Math.min(H, Math.ceil((l.y + 0.02 * sp.fontSize) * s));
            if (x1 - x0 >= 2 && y1 - y0 >= 2) sp.color = sampleInkColor(data, W, x0, y0, x1, y1, backgroundAround(data, W, H, x0, y0, x1, y1));
          }
        }
      }
      if (render) result.shades = shadeBoxes(p, scan.fills.filter((f) => !dots.has(f)), render);
      markUnderlines(p, result.rules);
      page.cleanup();
    } catch {
      // keep whatever was collected
    } finally {
      if (render) releaseCanvas(render.canvas);
    }
    out.push(result);
    onProgress?.(i + 1, pages.length);
  }
  return out;
}

/** Character index in a span nearest to page x, snapped to a word boundary. */
function wordIndexAt(sp: TextSpan, x: number, end: boolean): number {
  const len = sp.text.length;
  const est = Math.round(((x - sp.x) / Math.max(1e-6, sp.width)) * len);
  let best = end ? len : 0;
  let bestD = Infinity;
  for (let i = 0; i <= len; i++) {
    const boundary = end ? i === len || /\s/.test(sp.text[i]) : i === 0 || /\s/.test(sp.text[i - 1]);
    if (boundary && Math.abs(i - est) < bestD) [best, bestD] = [i, Math.abs(i - est)];
  }
  return best;
}

/** Splits spans that an underline covers only in part (producers that write a whole line as one piece). */
function splitForUnderlines(l: TextLine, flat: Box[]): void {
  for (const cell of l.cells) {
    if (!cell.spans) continue;
    const out: TextSpan[] = [];
    for (const sp of cell.spans) {
      const fs = sp.fontSize;
      const r = flat.find((r) => r.y0 >= l.y - 0.05 * fs && r.y0 <= l.y + 0.35 * fs && r.x0 > sp.x + 0.5 * fs && r.x0 < sp.x + sp.width && r.x1 - r.x0 >= 2 * fs);
      const r2 = r ?? flat.find((r) => r.y0 >= l.y - 0.05 * fs && r.y0 <= l.y + 0.35 * fs && r.x0 <= sp.x + 0.5 * fs && r.x1 < sp.x + sp.width - 0.5 * fs && r.x1 > sp.x + 2 * fs);
      if (!r2 || sp.text.length < 4) {
        out.push(sp);
        continue;
      }
      const a = r2.x0 <= sp.x + 0.5 * fs ? 0 : wordIndexAt(sp, r2.x0, false);
      const b = Math.max(a, r2.x1 >= sp.x + sp.width - 0.5 * fs ? sp.text.length : wordIndexAt(sp, r2.x1, true));
      const at = (i: number) => sp.x + (sp.width * i) / sp.text.length;
      const piece = (i: number, j: number): TextSpan => ({ ...sp, text: sp.text.slice(i, j), x: at(i), width: at(j) - at(i) });
      if (a > 0) out.push(piece(0, a));
      out.push({ ...piece(a, b), underline: true });
      if (b < sp.text.length) out.push(piece(b, sp.text.length));
    }
    cell.spans = out.filter((s) => s.text.length > 0);
  }
}

/** Marks spans with a thin rule just under their baseline, about as wide as the span. */
export function markUnderlines(page: PageText, rules: Box[]): void {
  const flat = rules.filter((r) => r.y1 - r.y0 <= 2.5 && r.x1 - r.x0 >= 3);
  if (!flat.length) return;
  for (const l of page.lines) splitForUnderlines(l, flat);
  for (const l of page.lines) {
    for (const cell of l.cells) for (const sp of cell.spans ?? []) {
      if (!sp.text.trim()) continue;
      const fs = sp.fontSize;
      const cellWidth = cell.width ?? sp.width;
      const hit = flat.some(
        (r) =>
          r.y0 >= l.y - 0.05 * fs &&
          r.y0 <= l.y + 0.35 * fs &&
          r.x0 <= sp.x + Math.max(2, 0.3 * fs) &&
          r.x1 >= sp.x + sp.width - Math.max(2, 0.3 * fs) &&
          r.x1 - r.x0 <= cellWidth + 2 * fs,
      );
      if (hit) sp.underline = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number;
  font?: string;
  color?: string;
}

export type Piece = { tab: true } | { tab?: false; text: string; style: RunStyle };

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.size === b.size && a.font === b.font && a.color === b.color;
}

export function cellPieces(c: TextCell, l: TextLine, paraSize: number, defaultFont: string | undefined): Piece[] {
  const spans = c.spans?.length ? c.spans : [{ text: c.text, x: c.x, width: c.width ?? 0, fontSize: l.fontSize, bold: l.bold, italic: false }];
  return spans.flatMap((s): Piece[] => {
    const fs = Math.abs(s.fontSize - paraSize) <= 0.05 * paraSize ? paraSize : s.fontSize;
    const style: RunStyle = {
      bold: !!s.bold,
      italic: !!s.italic,
      underline: !!s.underline,
      size: Math.max(2, Math.round(fs * 2)),
      font: s.family && s.family !== defaultFont ? s.family : undefined,
      color: s.color,
    };
    const text = stripInvalidXmlChars(s.text);
    // The joining space after an underlined word is not underlined.
    const m = style.underline ? /^(.*?)(\s+)$/s.exec(text) : null;
    if (m && m[1]) return [{ text: m[1], style }, { text: m[2], style: { ...style, underline: false } }];
    return [{ text, style }];
  });
}

/** Joins neighbouring pieces with the same style (one run per styled stretch, not per PDF word). */
export function mergePieces(pieces: Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (!p.tab && last && !last.tab && sameStyle(last.style, p.style)) last.text += p.text;
    else merged.push(p.tab ? p : { ...p });
  }
  return merged;
}

function toRuns(pieces: Piece[]): TextRun[] {
  const merged = mergePieces(pieces);
  let style: RunStyle | undefined;
  return merged.map((p) => {
    if (p.tab) return new TextRun({ children: [new Tab()], ...(style ? runProps(style) : {}) });
    style = p.style;
    return new TextRun({ text: p.text, ...runProps(p.style) });
  });
}

function runProps(s: RunStyle) {
  return {
    bold: s.bold || undefined,
    italics: s.italic || undefined,
    underline: s.underline ? {} : undefined,
    size: s.size,
    font: s.font,
    color: s.color,
  };
}

/** Pieces of a paragraph: lines joined with spaces (or de-hyphenated), cells with tabs. */
export function paraPieces(b: ParaBlock, defaultFont: string | undefined): Piece[] {
  const pieces: Piece[] = [];
  b.lines.forEach((l, k) => {
    if (k > 0) {
      const last = [...pieces].reverse().find((p): p is Extract<Piece, { text: string }> => !p.tab);
      const next = l.cells[0].text;
      if (last && /\p{L}-$/u.test(last.text) && /^\p{Ll}/u.test(next)) last.text = last.text.slice(0, -1);
      else if (last && !/\s$/.test(last.text)) {
        if (last.style.underline) pieces.push({ text: ' ', style: { ...last.style, underline: false } });
        else last.text += ' ';
      }
    }
    l.cells.forEach((c, ci) => {
      if (ci > 0) pieces.push({ tab: true });
      pieces.push(...cellPieces(c, l, b.fontSize, defaultFont));
    });
  });
  return pieces;
}

// ---------------------------------------------------------------------------
// Blocks -> docx
// ---------------------------------------------------------------------------

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
} as const;

const HEADING = [undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;

interface BuildCtx {
  defaultFont?: string;
  images: DocxImage[];
  pageWidth: number;
}

function indentOf(left: number, firstLine: number, right = 0) {
  return {
    left: tw(left),
    ...(right > 0.5 ? { right: tw(right) } : {}),
    ...(firstLine > 0.5 ? { firstLine: tw(firstLine) } : firstLine < -0.5 ? { hanging: tw(-firstLine) } : {}),
  };
}

function paragraphFor(b: ParaBlock, ctx: BuildCtx, exact?: { refLeft: number }, pictures: ImageRun[] = []): Paragraph {
  const top = blockTop(b);
  // Wrapped paragraphs keep the PDF width so lines break in the same places; single lines get
  // slack (substituted fonts can be wider) on the side away from their alignment.
  const w = b.box.x1 - b.box.x0;
  const slack = b.lines.length > 1 ? 0.5 : Math.min(0.15 * w + b.fontSize, ctx.pageWidth);
  let frameX = b.box.x0;
  if (b.align === 'right') frameX -= slack;
  else if (b.align === 'center') frameX -= slack / 2;
  frameX = Math.max(0, frameX);
  const frameWidth = Math.min(ctx.pageWidth - frameX, w + slack);
  const shift = exact ? exact.refLeft - frameX : 0;
  return new Paragraph({
    heading: HEADING[b.heading],
    alignment: ALIGN[b.align],
    indent: exact ? indentOf(b.align === 'center' || b.align === 'right' ? 0 : Math.max(0, b.indentLeft + shift), b.firstLine) : indentOf(Math.max(-720, b.indentLeft), b.firstLine, b.indentRight),
    spacing: {
      before: exact ? 0 : tw(b.spaceBefore),
      after: 0,
      ...(b.lineSpacing ? { line: tw(b.lineSpacing), lineRule: LineRuleType.AT_LEAST } : {}),
    },
    ...(b.shading ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: b.shading } } : {}),
    tabStops: b.tabs.map((t) => ({ type: t.right ? TabStopType.RIGHT : TabStopType.LEFT, position: Math.max(0, tw(t.pos + shift)) })),
    ...(exact
      ? {
          frame: {
            type: 'absolute' as const,
            position: { x: tw(frameX), y: tw(top) },
            width: tw(Math.max(frameWidth, 12)),
            height: tw(Math.max(blockBottom(b) - top, b.fontSize)),
            rule: HeightRule.ATLEAST,
            anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
          },
        }
      : {}),
    children: [...pictures, ...toRuns(paraPieces(b, ctx.defaultFont))],
  });
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const THIN_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'auto' };

function tableFor(b: TableBlock & { refLeft: number }, ctx: BuildCtx, exact: boolean): Table {
  const n = b.cols.length;
  const widths = b.cols.map((x, k) => Math.max(18, (k + 1 < n ? b.cols[k + 1] : b.right) - x));
  const border = b.bordered ? THIN_BORDER : NO_BORDER;
  const pad = 2;
  const cellProps = (w: number) => ({ width: { size: tw(w), type: WidthType.DXA }, margins: { top: 0, bottom: 0, left: tw(pad), right: tw(pad) } });
  const rows = b.grid
    ? b.grid.cells.map(
        (row, r) =>
          new TableRow({
            height: { value: tw(b.grid!.rowHeights[r]), rule: HeightRule.ATLEAST },
            children: widths.map(
              (w, c) =>
                new TableCell({
                  ...cellProps(w),
                  ...(b.grid!.shading?.[r]?.[c] ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: b.grid!.shading[r][c] } } : {}),
                  children: row[c]?.length ? row[c].map((p) => paragraphFor(p, ctx)) : [new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })],
                }),
            ),
          }),
      )
    : b.lines.map(
    (l) =>
      new TableRow({
        height: { value: tw(b.rowHeight), rule: HeightRule.ATLEAST },
        children: widths.map((w, c) => {
          const cells = l.cells.filter((cell) => cell.col === c);
          const pieces: Piece[] = [];
          cells.forEach((cell, k) => {
            if (k > 0) pieces.push({ text: ' ', style: { bold: false, italic: false, underline: false, size: Math.round(b.fontSize * 2) } });
            pieces.push(...cellPieces(cell, l, b.fontSize, ctx.defaultFont));
          });
          return new TableCell({
            width: { size: tw(w), type: WidthType.DXA },
            margins: { top: 0, bottom: 0, left: tw(pad), right: tw(pad) },
            ...(b.shading ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: b.shading } } : {}),
            children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: toRuns(pieces) })],
          });
        }),
      }),
  );
  const top = blockTop(b);
  return new Table({
    rows,
    columnWidths: widths.map(tw),
    width: { size: widths.reduce((s, w) => s + tw(w), 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    ...(exact
      ? {
          float: {
            horizontalAnchor: TableAnchorType.PAGE,
            absoluteHorizontalPosition: tw(b.cols[0] - pad),
            verticalAnchor: TableAnchorType.PAGE,
            absoluteVerticalPosition: tw(top),
            overlap: OverlapType.OVERLAP,
          },
        }
      : { indent: { size: tw(b.cols[0] - b.refLeft - pad), type: WidthType.DXA } }),
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
  });
}

/** `anchorTop`: page y of the paragraph the picture is anchored to, so it moves with that text. */
function imageRun(img: DocxImage, box: Box, floating?: { behind: boolean; wrap: boolean; anchorTop?: number }): ImageRun {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  return new ImageRun({
    type: img.type,
    data: img.data,
    transformation: { width: px(w), height: px(h) },
    ...(floating
      ? {
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(box.x0) },
            verticalPosition:
              floating.anchorTop === undefined
                ? { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(box.y0) }
                : { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: emu(box.y0 - floating.anchorTop) },
            behindDocument: floating.behind,
            allowOverlap: true,
            lockAnchor: true,
            wrap: floating.wrap ? { type: TextWrappingType.SQUARE, side: TextWrappingSide.BOTH_SIDES } : { type: TextWrappingType.NONE },
            margins: floating.wrap ? { left: emu(6), right: emu(6), top: emu(2), bottom: emu(2) } : undefined,
          },
        }
      : {}),
  });
}

/** A 1 pt tall paragraph: anchors floating images / carries a column break without moving the text. */
function tinyParagraph(children: (ImageRun | ColumnBreak)[]): Paragraph {
  return new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [...children, new TextRun({ text: '', size: 2 })] });
}

function spacer(pt: number): Paragraph | null {
  if (pt < 1) return null;
  return new Paragraph({ spacing: { before: 0, after: 0, line: tw(pt), lineRule: LineRuleType.EXACT }, children: [new TextRun({ text: '', size: 2 })] });
}

export function refLefts(layout: PageLayout): number[][] {
  // Word's text-area left edge per stream (indents in blocks are relative to it).
  const textWidth = layout.width - layout.margin.left - layout.margin.right;
  return layout.segments.map((s) => (s.columns === 1 ? [layout.margin.left] : [layout.margin.left, layout.margin.left + (textWidth - s.gap) / 2 + s.gap]));
}

function pageProps(layout: PageLayout, hf?: HeaderFooter) {
  return {
    size: { width: tw(layout.width), height: tw(layout.height) },
    margin: {
      top: tw(layout.margin.top),
      bottom: tw(layout.margin.bottom),
      left: tw(layout.margin.left),
      right: tw(layout.margin.right),
      header: tw(hf?.headerDistance ?? 0),
      footer: tw(hf?.footerDistance ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Headers and footers
// ---------------------------------------------------------------------------

interface HeaderFooter {
  header?: Header;
  footer?: Footer;
  headerDistance?: number;
  footerDistance?: number;
}

export type FieldPiece = Piece | { field: 'page' | 'pages'; style: RunStyle };

/** Running-text pieces with the page number (and "of N" page count) turned into fields. */
export function fieldPieces(pieces: Piece[], pageNumber: number, total: number): FieldPiece[] {
  let seen = ''; // text of the earlier pieces ("Page 3 of" split into words)
  const out: FieldPiece[] = [];
  for (const p of mergePieces(pieces)) {
    if (p.tab) {
      out.push(p);
      continue;
    }
    const re = /\d+/g;
    let last = 0;
    for (let m = re.exec(p.text); m; m = re.exec(p.text)) {
      const n = Number(m[0]);
      const before = seen + p.text.slice(0, m.index);
      const field = n === pageNumber ? 'page' : n === total && total !== pageNumber && /(of|din|von|de|\/)\s*$/i.test(before) ? 'pages' : null;
      if (!field) continue;
      if (m.index > last) out.push({ text: p.text.slice(last, m.index), style: p.style });
      out.push({ field, style: p.style });
      last = m.index + m[0].length;
    }
    if (last < p.text.length) out.push({ text: p.text.slice(last), style: p.style });
    seen += p.text;
  }
  return out;
}

export interface RunningLine {
  align: 'left' | 'center' | 'right';
  /** Left indent (points from the left margin) for left-aligned lines. */
  indent: number;
  tabs: { pos: number; right: boolean }[];
  pieces: FieldPiece[];
}

/** Header/footer lines as format-neutral paragraphs. */
export function runningLines(info: NonNullable<RunningLines['header']>, total: number, margin: PageLayout['margin'], defaultFont?: string): RunningLine[] {
  const W = info.width;
  const left = margin.left;
  const right = W - margin.right;
  return [...info.lines]
    .sort((a, b) => a.y - b.y)
    .map((l) => {
      const x1 = l.x + (l.width ?? 0);
      const pieces: Piece[] = [];
      l.cells.forEach((c, k) => {
        if (k) pieces.push({ tab: true });
        pieces.push(...cellPieces(c, l, l.fontSize, defaultFont));
      });
      const tabs = l.cells.slice(1).map((c, k, all) => {
        const r = c.x + (c.width ?? 0);
        return k === all.length - 1 && right - r < 12 ? { pos: r - left, right: true } : { pos: c.x - left, right: false };
      });
      const single = l.cells.length === 1;
      const align = single && Math.abs((l.x + x1) / 2 - W / 2) < 24 ? 'center' : single && right - x1 < 12 ? 'right' : 'left';
      return { align, indent: Math.max(0, l.x - left), tabs, pieces: fieldPieces(pieces, info.pageNumber, total) };
    });
}

/** Distance of the header from the page top / the footer from the page bottom (points). */
export function headerDistance(info: NonNullable<RunningLines['header']>): number {
  return Math.max(6, Math.min(...info.lines.map((l) => l.y - 0.92 * l.fontSize)));
}
export function footerDistance(info: NonNullable<RunningLines['footer']>): number {
  return Math.max(6, info.height - Math.max(...info.lines.map((l) => l.y + 0.3 * l.fontSize)));
}

function runningParagraphs(info: NonNullable<RunningLines['header']>, total: number, margin: PageLayout['margin'], defaultFont?: string): Paragraph[] {
  return runningLines(info, total, margin, defaultFont).map(
    (r) =>
      new Paragraph({
        alignment: r.align === 'center' ? AlignmentType.CENTER : r.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
        indent: r.align === 'left' ? { left: tw(r.indent) } : undefined,
        tabStops: r.tabs.map((t) => ({ type: t.right ? TabStopType.RIGHT : TabStopType.LEFT, position: tw(t.pos) })),
        spacing: { before: 0, after: 0 },
        children: r.pieces.map((p) =>
          'field' in p
            ? new TextRun({ children: [p.field === 'page' ? PageNumber.CURRENT : PageNumber.TOTAL_PAGES], ...runProps(p.style) })
            : p.tab
              ? new TextRun({ children: [new Tab()] })
              : new TextRun({ text: p.text, ...runProps(p.style) }),
        ),
      }),
  );
}

function headerFooter(run: RunningLines, total: number, margin: PageLayout['margin'], defaultFont?: string): HeaderFooter | undefined {
  if (!run.header && !run.footer) return undefined;
  const hf: HeaderFooter = {};
  if (run.header) {
    hf.header = new Header({ children: runningParagraphs(run.header, total, margin, defaultFont) });
    hf.headerDistance = headerDistance(run.header);
  }
  if (run.footer) {
    hf.footer = new Footer({ children: runningParagraphs(run.footer, total, margin, defaultFont) });
    hf.footerDistance = footerDistance(run.footer);
  }
  return hf;
}

export interface AnchoredFloat extends FloatImage {
  /** Text wraps around it (tiny pictures and pictures under text do not push text aside). */
  wrap: boolean;
}

/** Floating pictures ride on the paragraph just above them, so they stay with their text when it flows on. */
export function floatAnchors(layout: PageLayout, images: DocxImage[]): { anchored: Map<ParaBlock, AnchoredFloat[]>; loose: AnchoredFloat[] } {
  const paras = layout.segments.flatMap((s) => s.streams.flat()).filter((b): b is ParaBlock => b.kind === 'para');
  const anchored = new Map<ParaBlock, AnchoredFloat[]>();
  const loose: AnchoredFloat[] = [];
  for (const f of layout.floats.filter((f) => images[f.index])) {
    const above = paras.filter((p) => blockTop(p) <= f.box.y0 + 1);
    const anchor = above.length ? above.reduce((a, b) => (blockTop(b) > blockTop(a) ? b : a)) : paras[0];
    const tiny = f.box.x1 - f.box.x0 < 40 && f.box.y1 - f.box.y0 < 40;
    const af = { ...f, wrap: !f.behind && !tiny };
    if (anchor) anchored.set(anchor, [...(anchored.get(anchor) ?? []), af]);
    else loose.push(af);
  }
  return { anchored, loose };
}

function flowSections(layout: PageLayout, ctx: BuildCtx, firstType: (typeof SectionType)[keyof typeof SectionType] = SectionType.NEXT_PAGE, hf?: HeaderFooter): ISectionOptions[] {
  const lefts = refLefts(layout);
  const anchors = floatAnchors(layout, ctx.images);
  const anchored = new Map<ParaBlock, ImageRun[]>();
  for (const [p, fs] of anchors.anchored) anchored.set(p, fs.map((f) => imageRun(ctx.images[f.index], f.box, { behind: f.behind, wrap: f.wrap, anchorTop: blockTop(p) })));
  const loose = anchors.loose.map((f) => imageRun(ctx.images[f.index], f.box, { behind: f.behind, wrap: f.wrap }));
  const sections: ISectionOptions[] = [];
  layout.segments.forEach((seg, si) => {
    const children: (Paragraph | Table)[] = [];
    if (si === 0 && loose.length) children.push(tinyParagraph(loose));
    seg.streams.forEach((stream, col) => {
      if (col === 1) children.push(tinyParagraph([new ColumnBreak()]));
      const extra = (si === 0 && loose.length && col === 0 ? 1 : 0) + (col === 1 ? 1 : 0);
      stream.forEach((b, k) => {
        if (k === 0 && extra) b.spaceBefore = Math.max(0, b.spaceBefore - extra);
        if (b.kind === 'para') children.push(paragraphFor(b, ctx, undefined, anchored.get(b)));
        else children.push(...blockToDocx(b, ctx, lefts[si][col]));
      });
    });
    if (!children.length || children[children.length - 1] instanceof Table) children.push(tinyParagraph([]));
    sections.push({
      properties: {
        type: si === 0 ? firstType : SectionType.CONTINUOUS,
        page: pageProps(layout, hf),
        ...(seg.columns === 2 ? { column: { count: 2, space: tw(seg.gap), equalWidth: true } } : {}),
      },
      ...(si === 0 && hf?.header ? { headers: { default: hf.header } } : {}),
      ...(si === 0 && hf?.footer ? { footers: { default: hf.footer } } : {}),
      children,
    });
  });
  if (!sections.length) {
    sections.push({
      properties: { type: firstType, page: pageProps(layout, hf) },
      ...(hf?.header ? { headers: { default: hf.header } } : {}),
      ...(hf?.footer ? { footers: { default: hf.footer } } : {}),
      children: [loose.length ? tinyParagraph(loose) : new Paragraph({ children: [] })],
    });
  }
  return sections;
}

function blockToDocx(b: Block, ctx: BuildCtx, refLeft: number): (Paragraph | Table)[] {
  if (b.kind === 'para') return [paragraphFor(b, ctx)];
  if (b.kind === 'table') {
    const sp = spacer(b.spaceBefore);
    return [...(sp ? [sp] : []), tableFor({ ...b, refLeft }, ctx, false)];
  }
  const img = ctx.images[b.index];
  if (!img) return [];
  return [
    new Paragraph({
      indent: { left: tw(Math.max(0, b.indentLeft)) },
      spacing: { before: tw(b.spaceBefore), after: 0 },
      children: [imageRun(img, b.box)],
    }),
  ];
}

function exactSection(layout: PageLayout, ctx: BuildCtx): ISectionOptions {
  const lefts = refLefts(layout);
  const children: (Paragraph | Table)[] = [];
  const pictures: ImageRun[] = [];
  for (const f of layout.floats) if (ctx.images[f.index]) pictures.push(imageRun(ctx.images[f.index], f.box, { behind: f.behind, wrap: false }));
  layout.segments.forEach((seg, si) =>
    seg.streams.forEach((stream, col) => {
      for (const b of stream) {
        if (b.kind === 'image') {
          const img = ctx.images[(b as ImageBlock).index];
          if (img) pictures.push(imageRun(img, b.box, { behind: false, wrap: false }));
        } else if (b.kind === 'para') {
          children.push(paragraphFor(b, ctx, { refLeft: lefts[si][col] }));
        } else {
          children.push(tableFor({ ...b, refLeft: lefts[si][col] }, ctx, true));
          children.push(tinyParagraph([])); // keeps consecutive floating tables apart
        }
      }
    }),
  );
  children.unshift(tinyParagraph(pictures));
  children.push(tinyParagraph([]));
  return { properties: { type: SectionType.NEXT_PAGE, page: pageProps(layout) }, children };
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function dominantFamily(pages: PageText[]): string | undefined {
  const count = new Map<string, number>();
  for (const p of pages) for (const l of p.lines) for (const s of spansOfLine(l)) if (s.family) count.set(s.family, (count.get(s.family) ?? 0) + s.text.length);
  let best: string | undefined;
  let n = 0;
  for (const [f, c] of count) if (c > n) [best, n] = [f, c];
  return best;
}

export interface PagePlan {
  layout: PageLayout;
  images: DocxImage[];
  /** Starts a new page in the word processor (otherwise the text runs on from the previous PDF page). */
  newPage: boolean;
}

export interface DocumentPlan {
  pages: PagePlan[];
  body: number;
  defaultFont: string;
  running: RunningLines;
  total: number;
}

/** Lays out every page for a word-processor export (shared by DOCX, ODT and RTF). */
export function planDocument(pages: PageText[], graphics: DocxPageGraphics[] | undefined, exact = false): DocumentPlan {
  const body = bodyFontSize(pages);
  const defaultFont = dominantFamily(pages) ?? 'Arial';
  // Flowing text: page numbers and running titles go to the header/footer, so the text can run on across pages.
  const running = exact ? { running: new Set<TextLine>() } : detectRunningLines(pages);
  const plans: PagePlan[] = [];
  let prev: PageLayout | undefined;
  pages.forEach((p, k) => {
    const g = graphics?.[k] ?? { images: [], rules: [] };
    const bodyPage = running.running.size ? { ...p, lines: p.lines.filter((l) => !running.running.has(l)) } : p;
    const layout = layoutPage(bodyPage, { images: g.images.map((i) => i.box), rules: g.rules, shades: g.shades }, body, defaultFont);
    // A new PDF page continues the text unless it must start a new page: another page size, or a previous
    // page that ended early (a chapter end).
    const newPage = exact || !prev || prev.width !== layout.width || prev.height !== layout.height || prev.contentBottom < 0.7 * prev.height;
    plans.push({ layout, images: g.images, newPage });
    prev = layout;
  });
  return { pages: plans, body, defaultFont, running, total: pages.length };
}

export async function exportToDocx(pages: PageText[], title: string, opts: DocxOptions = {}): Promise<Blob> {
  const exact = opts.layout === 'exact';
  const plan = planDocument(pages, opts.graphics, exact);
  const { body, defaultFont, running } = plan;
  const sections: ISectionOptions[] = [];
  plan.pages.forEach(({ layout, images, newPage }, k) => {
    const ctx: BuildCtx = { defaultFont, images, pageWidth: layout.width };
    if (exact) sections.push(exactSection(layout, ctx));
    else {
      const hf = k === 0 ? headerFooter(running, plan.total, layout.margin, defaultFont) : undefined;
      sections.push(...flowSections(layout, ctx, newPage ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS, hf));
    }
  });
  if (!sections.length) sections.push({ children: [new Paragraph({ children: [] })] });
  // Headings keep the PDF's own look (the library's defaults are blue and resized). No keep-with-next:
  // the PDF already fixed the page breaks, and a heading at the foot of a page would jump to the next.
  const heading = (outlineLevel: number) => ({ run: {}, paragraph: { outlineLevel, spacing: { before: 0, after: 0 } } });
  const doc = new Document({
    title: stripInvalidXmlChars(title),
    creator: 'Adika PDF Editor',
    styles: {
      default: {
        document: { run: { font: defaultFont, size: Math.round(body * 2) }, paragraph: { spacing: { before: 0, after: 0 } } },
        heading1: heading(0),
        heading2: heading(1),
        heading3: heading(2),
      },
    },
    sections,
  });
  return Packer.toBlob(doc);
}
