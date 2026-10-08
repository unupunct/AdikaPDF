/**
 * Export engine: turns the editor model (page list + objects + form values)
 * into a real PDF with pdf-lib.
 *
 *  - The first source document is edited in place, so its outlines, forms,
 *    metadata and structure survive; pages from other sources are copied in
 *    and their form fields re-attached to the AcroForm.
 *  - Each object is drawn inside `q … Q` with a CTM mapping its local box to
 *    PDF user space (page /Rotate, CropBox origin and the object's own
 *    rotation all folded into one matrix), so what you see is what you get.
 *  - Pages with redactions are re-rendered to an image with the redaction
 *    boxes burned in, so the covered text and graphics are really gone.
 */
import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFOperator,
  appendBezierCurve,
  closePath,
  lineTo,
  moveTo,
  setFillingRgbColor,
  setGraphicsState,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFFont,
  PDFImage,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFRef,
  PDFStream,
  PDFHexString,
  PDFString,
  PDFTextField,
  StandardFonts,
  clip,
  clipEvenOdd,
  concatTransformationMatrix,
  degrees,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type Color,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type {
  BookmarkItem,
  EditorObject,
  FieldObject,
  ImageObject,
  LineObject,
  PageRef,
  PenObject,
  VectorObject,
  Rotation,
  ShapeObject,
  SignatureObject,
  SourceDoc,
  TextObject,
} from '@/types';
import {
  displaySize,
  objectDisplayBounds,
  displayToPdfMatrix,
  multiply,
  rotateCw,
  totalRotation,
  transformRectBounds,
  translate,
  type Matrix,
  type Rect,
} from '@/lib/geometry';
import { loadFontBytes, type FontVariant } from '@/lib/fonts';
import { layoutText, canvasMeasure, type Measure } from '@/lib/textLayout';
import { embedFontForText } from './fontEmbed';
import { writeFreeText, writeMarkup, writeNote } from './annotations';
import { addReviewReply, type ReviewState } from './review';
import { writeAttachment, writeLink, writeMeasure, writePoly, writeStamp } from './commentAnnots';
import { prepareFileAnnotEdits } from './fileAnnots';
import { writeOutline } from './outline';
import { dropUnreachableObjects } from './prune';
import { retargetPageRefs, scrubStructTree } from './redactCleanup';

import { removeGlyphs, type Box, type EditFonts, type LineEdit } from './textRemoval';
import { attachFallbacks, defaultFallbackSources, type FallbackSources } from './fontFallback';
import { readFieldLogic, writeCalcOrder, writeFieldLogic } from './formScripts';
import { readXfaPackets, restoreStaticXfa, xfaKindOf } from './xfa';
import { parseSvgPath } from './vectorEdit';
import { layerForContent } from './layers';
import { pressureWidth } from '@/lib/objectFactory';

/** Objects drawn as page content (others are annotations or form fields). */
const LAYERED = new Set<EditorObject['type']>(['text', 'image', 'signature', 'rect', 'ellipse', 'highlight', 'line', 'arrow', 'pen', 'vector']);
import { calcOrder, calculate, displayValue, parseNumber } from '@/lib/formLogic';
import type { FieldValue } from '@/store/usePDFStore';

export interface ExportInput {
  sources: Record<string, SourceDoc>;
  pages: PageRef[];
  objects: EditorObject[];
  fieldValues: Record<string, FieldValue>;
  /** Edited bookmarks; null/undefined keeps the file's own outline. */
  outline?: BookmarkItem[] | null;
  /**
   * The document the edits are made to (the opened file): it stays the base
   * even when another file's page comes first, so its outline, attachments,
   * metadata, tags, page labels and layers are kept. Default: the first page's source.
   */
  baseSourceId?: string | null;
}

/** The source a document is written into: the requested base while it still has pages, else the first page's. */
export function baseSourceOf(pages: PageRef[], wanted?: string | null): string | null {
  if (wanted && pages.some((p) => p.kind === 'source' && p.sourceId === wanted)) return wanted;
  return pages.find((p) => p.kind === 'source')?.sourceId ?? null;
}

export interface RasterResult {
  bytes: Uint8Array;
  format: 'jpeg' | 'png';
}

export interface ExportOptions {
  /** Renders a page (display orientation) with the given rects blacked out. */
  rasterizeRedactedPage?: (page: PageRef, rects: Array<Rect & { fill: string }>) => Promise<RasterResult>;
  measure?: (variant: FontVariant, size: number) => Measure;
  loadFont?: (variant: FontVariant) => Promise<Uint8Array>;
  /** Flatten every form field and annotation into page content. */
  flatten?: boolean;
  title?: string;
  /** Document properties edited by the user (Properties dialog). */
  meta?: import('@/store/usePDFStore').DocMeta | null;
  onProgress?: (message: string, fraction: number) => void;
  /** Text shown in fields whose value a form script formatted ("sourceId::name" -> text); the value itself stays plain. */
  fieldDisplay?: Record<string, string>;
  /** Where fonts for letters a document's font lacks come from (null: draw such edits in Adika's font). */
  fallbackFonts?: FallbackSources | null;
  /** Called with the edits that had letters drawn in a fallback font. */
  onFontFallback?: (notes: FontFallbackNote[]) => void;
}

/** Edited text written in the document's font, with some letters in another font. */
export interface FontFallbackNote {
  objectId: string;
  text: string;
  fallback: EditFonts['fallback'];
}

export class ExportError extends Error {}

// ---------------------------------------------------------------- helpers

export function hexToRgb(hex: string): Color {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new ExportError('Unsupported image data');
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, mime: m[1] };
}

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

/** Copies inherited page attributes onto the leaf so it can move in the tree. */
function pinInheritedAttributes(page: PDFPage): void {
  for (const key of INHERITABLE) {
    const name = PDFName.of(key);
    if (page.node.get(name) === undefined) {
      const inherited = page.node.getInheritableAttribute(name);
      if (inherited !== undefined) page.node.set(name, inherited);
    }
  }
}

function visibleBox(page: PDFPage): Rect {
  const b = page.getCropBox();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function lookupDict(doc: PDFDocument, obj: unknown): PDFDict | undefined {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFDict ? v : undefined;
}

function acroFormFields(doc: PDFDocument, create: boolean): PDFArray | undefined {
  let acro = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
  if (!acro) {
    if (!create) return undefined;
    acro = doc.context.obj({ Fields: [] });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
  }
  let fields = acro.lookup(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray)) {
    fields = doc.context.obj([]);
    acro.set(PDFName.of('Fields'), fields);
  }
  return fields as PDFArray;
}

/** Top-level field ref for a widget annotation (walking /Parent). */
function rootFieldRef(doc: PDFDocument, widgetRef: PDFRef): PDFRef | undefined {
  let ref: PDFRef = widgetRef;
  for (let depth = 0; depth < 32; depth++) {
    const dict = lookupDict(doc, ref);
    if (!dict) return undefined;
    const parent = dict.get(PDFName.of('Parent'));
    if (parent instanceof PDFRef) ref = parent;
    else return dict.get(PDFName.of('T')) || dict.get(PDFName.of('FT')) ? ref : undefined;
  }
  return undefined;
}

function widgetRefs(doc: PDFDocument, page: PDFPage): PDFRef[] {
  const annots = page.node.Annots();
  if (!annots) return [];
  const out: PDFRef[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const d = lookupDict(doc, ref);
    if (d?.get(PDFName.of('Subtype')) === PDFName.of('Widget')) out.push(ref);
  }
  return out;
}

/** Removes AcroForm fields none of whose widgets are on a live page. */
function pruneOrphanFields(doc: PDFDocument): void {
  const fields = acroFormFields(doc, false);
  if (!fields) return;
  const live = new Set<string>();
  for (const page of doc.getPages()) for (const w of widgetRefs(doc, page)) live.add(w.toString());
  const hasLiveWidget = (ref: PDFRef, depth = 0): boolean => {
    if (depth > 32) return false;
    if (live.has(ref.toString())) return true;
    const kids = lookupDict(doc, ref)?.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) return false;
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.get(i);
      if (k instanceof PDFRef && hasLiveWidget(k, depth + 1)) return true;
    }
    return false;
  };
  for (let i = fields.size() - 1; i >= 0; i--) {
    const ref = fields.get(i);
    if (ref instanceof PDFRef && !hasLiveWidget(ref)) fields.remove(i);
  }
}

function attachCopiedFields(doc: PDFDocument, page: PDFPage): void {
  const widgets = widgetRefs(doc, page);
  if (widgets.length === 0) return;
  const fields = acroFormFields(doc, true)!;
  const existing = new Set<string>();
  for (let i = 0; i < fields.size(); i++) existing.add(String(fields.get(i)));
  for (const w of widgets) {
    const root = rootFieldRef(doc, w);
    if (root && !existing.has(root.toString())) {
      fields.push(root);
      existing.add(root.toString());
    }
  }
}

/** Field-level keys of a field dictionary merged with its widget (ISO 32000 12.7.4). */
const FIELD_KEYS = ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'Opt', 'TI', 'I', 'MaxLen', 'Lock', 'SV'];

function fieldTypeOf(dict: PDFDict): PDFName | undefined {
  for (let d: PDFDict | undefined = dict, depth = 0; d && depth < 32; depth++) {
    const ft = d.lookup(PDFName.of('FT'));
    if (ft instanceof PDFName) return ft;
    const parent: unknown = d.lookup(PDFName.of('Parent'));
    d = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/**
 * The terminal field of a widget. A widget merged with its field is split
 * first (field keys moved to a new field dictionary that has it as a kid), so
 * further widgets can join the same field.
 */
function terminalField(doc: PDFDocument, widgetRef: PDFRef, widget: PDFDict): PDFRef {
  if (!widget.has(PDFName.of('T'))) {
    const parent = widget.get(PDFName.of('Parent'));
    if (parent instanceof PDFRef) return parent;
  }
  const field = doc.context.obj({}) as PDFDict;
  for (const k of FIELD_KEYS) {
    const v = widget.get(PDFName.of(k));
    if (v === undefined) continue;
    field.set(PDFName.of(k), v);
    widget.delete(PDFName.of(k));
  }
  const up = widget.get(PDFName.of('Parent'));
  if (up) field.set(PDFName.of('Parent'), up);
  field.set(PDFName.of('Kids'), doc.context.obj([widgetRef]));
  const fieldRef = doc.context.register(field);
  widget.set(PDFName.of('Parent'), fieldRef);
  // The new field takes the widget's place in its parent's kids (or the form's top-level fields).
  const parentDict = up ? lookupDict(doc, up) : undefined;
  const siblings = parentDict ? parentDict.lookup(PDFName.of('Kids')) : acroFormFields(doc, true);
  if (siblings instanceof PDFArray) {
    let found = false;
    for (let i = 0; i < siblings.size(); i++) {
      if (String(siblings.get(i)) === widgetRef.toString()) {
        siblings.set(i, fieldRef);
        found = true;
      }
    }
    if (!found && !parentDict) siblings.push(fieldRef);
  }
  return fieldRef;
}

/**
 * A second copy of a page of the base document. Its form fields are the same
 * fields as on the original (as in Acrobat when a page is duplicated: same
 * name, same value): each copied widget becomes another kid of the
 * original's field. Other annotations are copied (without their pop-ups);
 * signature fields are not duplicated.
 */
/** For each duplicated page: which copy stands for which original annotation (by the original's ref). */
const annotCopies = new WeakMap<PDFPage, Map<string, PDFRef>>();

async function duplicateBasePage(doc: PDFDocument, original: PDFPage, index: number): Promise<PDFPage> {
  const ANNOTS = PDFName.of('Annots');
  const annots = original.node.get(ANNOTS);
  // Copy the page without its annotations (the copier would follow widgets into their whole field tree).
  original.node.delete(ANNOTS);
  let copy: PDFPage;
  try {
    [copy] = await doc.copyPages(doc, [index]);
  } finally {
    if (annots) original.node.set(ANNOTS, annots);
  }
  const list = original.node.Annots();
  if (!list) return copy;
  const out = doc.context.obj([]) as PDFArray;
  const copies = new Map<string, PDFRef>();
  annotCopies.set(copy, copies);
  for (let i = 0; i < list.size(); i++) {
    const ref = list.get(i);
    const dict = lookupDict(doc, ref);
    if (!dict) continue;
    const subtype = dict.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Popup')) continue;
    if (subtype === PDFName.of('Widget')) {
      if (!(ref instanceof PDFRef) || fieldTypeOf(dict) === PDFName.of('Sig')) continue;
      const fieldRef = terminalField(doc, ref, dict);
      const clone = dict.clone(doc.context);
      clone.set(PDFName.of('P'), copy.ref);
      clone.set(PDFName.of('Parent'), fieldRef);
      const cloneRef = doc.context.register(clone);
      const field = lookupDict(doc, fieldRef);
      let kids = field?.lookup(PDFName.of('Kids'));
      if (field && !(kids instanceof PDFArray)) {
        kids = doc.context.obj([]);
        field.set(PDFName.of('Kids'), kids);
      }
      (kids as PDFArray).push(cloneRef);
      out.push(cloneRef);
      copies.set(ref.toString(), cloneRef);
    } else {
      const clone = dict.clone(doc.context);
      clone.set(PDFName.of('P'), copy.ref);
      clone.delete(PDFName.of('Popup'));
      const cloneRef = doc.context.register(clone);
      out.push(cloneRef);
      if (ref instanceof PDFRef) copies.set(ref.toString(), cloneRef);
    }
  }
  if (out.size()) copy.node.set(ANNOTS, out);
  return copy;
}

function removeAnnotations(page: PDFPage): void {
  page.node.delete(PDFName.of('Annots'));
}

// ---------------------------------------------------------------- drawing

interface DrawContext {
  doc: PDFDocument;
  fonts: Map<string, PDFFont>;
  /** Every string drawn per font variant, so each font keeps just those glyphs. */
  fontTexts: Map<string, string[]>;
  images: Map<string, PDFImage>;
  opts: Required<Pick<ExportOptions, 'measure' | 'loadFont'>>;
  fieldFont: PDFFont | null;
  /** Names of the fields created from objects (for formulas). */
  fieldNames: string[];
  /** The fields created from objects (barcode templates read their values). */
  fieldObjects: FieldObject[];
}

function variantKey(v: FontVariant): string {
  return `${v.family}-${v.bold}-${v.italic}`;
}

async function fontFor(ctx: DrawContext, v: FontVariant): Promise<PDFFont> {
  const key = variantKey(v);
  let f = ctx.fonts.get(key);
  if (!f) {
    f = await embedFontForText(ctx.doc, await ctx.opts.loadFont(v), ctx.fontTexts.get(key) ?? []);
    ctx.fonts.set(key, f);
  }
  return f;
}

/** Strings each font variant will draw (text boxes and signature captions). */
function collectFontTexts(objects: EditorObject[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (v: FontVariant, s: string) => {
    const k = variantKey(v);
    const list = out.get(k) ?? [];
    list.push(s);
    out.set(k, list);
  };
  for (const o of objects) {
    if (o.type === 'text') add({ family: o.fontFamily, bold: o.bold, italic: o.italic }, o.text);
    if (o.type === 'signature' && o.showCaption) add({ family: 'sans', bold: false, italic: false }, `${signatureCaption(o)}…`);
    if (o.type === 'measure') add({ family: 'sans', bold: false, italic: false }, `0123456789.,- ${o.scale.realUnit}²`);
    if (o.type === 'stamp' && !o.src) {
      add({ family: 'sans', bold: true, italic: false }, o.label);
      add({ family: 'sans', bold: false, italic: false }, o.subtitle);
    }
  }
  return out;
}

async function imageFor(ctx: DrawContext, src: string): Promise<PDFImage> {
  let img = ctx.images.get(src);
  if (!img) {
    const { bytes, mime } = dataUrlBytes(src);
    img = mime === 'image/jpeg' || mime === 'image/jpg' ? await ctx.doc.embedJpg(bytes) : await ctx.doc.embedPng(bytes);
    ctx.images.set(src, img);
  }
  return img;
}

function withMatrix(page: PDFPage, m: Matrix, draw: () => void): void {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
  draw();
  page.pushOperators(popGraphicsState());
}

/** Local object frame (y down) → PDF user space. */
function objectMatrix(pageMatrix: Matrix, obj: EditorObject): Matrix {
  return multiply(pageMatrix, multiply(translate(obj.x, obj.y), rotateCw(obj.rotation)));
}

/** y-up frame whose origin is the bottom-left of a box of height h. */
function boxFrame(m: Matrix, h: number): Matrix {
  return multiply(m, [1, 0, 0, -1, 0, h]);
}

/** Width of a one-line text object's text (NaN when it wraps: no line reflow then). */
function singleLineWidth(o: TextObject, measure: (v: FontVariant, size: number) => Measure): number {
  const m = measure({ family: o.fontFamily, bold: o.bold, italic: o.italic }, o.fontSize);
  if (o.text.includes('\n') || layoutText(o, m).lines.length > 1) return Number.NaN;
  return m(o.text);
}

async function drawText(ctx: DrawContext, page: PDFPage, pm: Matrix, o: TextObject, hScale = 1): Promise<void> {
  const variant: FontVariant = { family: o.fontFamily, bold: o.bold, italic: o.italic };
  const font = await fontFor(ctx, variant);
  const layout = layoutText(o, ctx.opts.measure(variant, o.fontSize));
  const height = Math.max(o.height, layout.contentHeight);
  // hScale < 1: a replacement condensed horizontally to fit its line.
  withMatrix(page, multiply(boxFrame(objectMatrix(pm, o), height), [hScale, 0, 0, 1, 0, 0]), () => {
    if (o.background) {
      page.drawRectangle({ x: 0, y: 0, width: o.width, height, color: hexToRgb(o.background), opacity: o.opacity });
    }
    for (const line of layout.lines) {
      if (!line.text) continue;
      page.drawText(line.text, {
        x: line.x,
        y: height - line.baseline,
        size: o.fontSize,
        font,
        color: hexToRgb(o.color),
        opacity: o.opacity,
      });
    }
  });
}

async function drawImage(ctx: DrawContext, page: PDFPage, pm: Matrix, o: ImageObject | SignatureObject): Promise<void> {
  const img = await imageFor(ctx, o.src);
  const captionH = o.type === 'signature' && o.showCaption ? SIGNATURE_CAPTION_HEIGHT : 0;
  const inkH = Math.max(1, o.height - captionH);
  withMatrix(page, boxFrame(objectMatrix(pm, o), o.height), () => {
    const crop = o.type === 'image' ? o.crop : null;
    if (crop && crop.width > 0 && crop.height > 0) {
      const sx = o.width / crop.width;
      const sy = o.height / crop.height;
      // Clip to the box, then place the whole image so the crop fills it.
      page.pushOperators(pushGraphicsState(), rectangle(0, 0, o.width, o.height), clip(), endPath());
      page.drawImage(img, {
        x: -crop.x * sx,
        y: o.height - (-crop.y * sy + o.naturalHeight * sy),
        width: o.naturalWidth * sx,
        height: o.naturalHeight * sy,
        opacity: o.opacity,
      });
      page.pushOperators(popGraphicsState());
    } else {
      page.drawImage(img, { x: 0, y: captionH, width: o.width, height: inkH, opacity: o.opacity });
    }
  });
  if (o.type === 'signature' && o.showCaption) {
    const caption = signatureCaption(o);
    const size = SIGNATURE_CAPTION_FONT;
    const variant: FontVariant = { family: 'sans', bold: false, italic: false };
    const font = await fontFor(ctx, variant);
    withMatrix(page, boxFrame(objectMatrix(pm, o), o.height), () => {
      page.drawLine({ start: { x: 0, y: captionH - 1 }, end: { x: o.width, y: captionH - 1 }, thickness: 0.5, color: rgb(0.4, 0.45, 0.55), opacity: o.opacity });
      page.drawText(fitCaption(caption, o.width, ctx.opts.measure(variant, size)), {
        x: 1,
        y: 2.5,
        size,
        font,
        color: rgb(0.2, 0.25, 0.35),
        opacity: o.opacity,
      });
    });
  }
}

export const SIGNATURE_CAPTION_HEIGHT = 11;
export const SIGNATURE_CAPTION_FONT = 6.5;

export function signatureCaption(o: Pick<SignatureObject, 'signerName' | 'signedAt'>): string {
  const d = new Date(o.signedAt);
  const when = Number.isNaN(d.getTime()) ? o.signedAt : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `${o.signerName ? `Signed by ${o.signerName}` : 'Signed'} · ${when}`;
}

export function fitCaption(text: string, width: number, measure: Measure): string {
  if (measure(text) <= width - 2) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`) > width - 2) t = t.slice(0, -1);
  return `${t}…`;
}

function drawShape(page: PDFPage, pm: Matrix, o: ShapeObject): void {
  withMatrix(page, boxFrame(objectMatrix(pm, o), o.height), () => {
    if (o.type === 'highlight') {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: o.width,
        height: o.height,
        color: hexToRgb(o.fill ?? '#facc15'),
        opacity: o.opacity,
        blendMode: BlendMode.Multiply,
      });
      return;
    }
    const common = {
      color: o.fill ? hexToRgb(o.fill) : undefined,
      borderColor: o.stroke ? hexToRgb(o.stroke) : undefined,
      borderWidth: o.stroke ? o.strokeWidth : 0,
      opacity: o.opacity,
      borderOpacity: o.opacity,
    };
    if (o.type === 'rect') page.drawRectangle({ x: 0, y: 0, width: o.width, height: o.height, ...common });
    else page.drawEllipse({ x: o.width / 2, y: o.height / 2, xScale: o.width / 2, yScale: o.height / 2, ...common });
  });
}

export function arrowHead(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): number[] {
  const len = Math.max(8, strokeWidth * 4);
  const a = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    x2,
    y2,
    x2 - len * Math.cos(a - spread),
    y2 - len * Math.sin(a - spread),
    x2 - len * Math.cos(a + spread),
    y2 - len * Math.sin(a + spread),
  ];
}

function drawLine(page: PDFPage, pm: Matrix, o: LineObject): void {
  const [x1, y1, x2, y2] = o.points;
  const color = hexToRgb(o.stroke);
  withMatrix(page, multiply(objectMatrix(pm, o), [1, 0, 0, -1, 0, 0]), () => {
    let ex = x2;
    let ey = y2;
    if (o.type === 'arrow') {
      const head = arrowHead(x1, y1, x2, y2, o.strokeWidth);
      // Stop the shaft inside the head so the tip stays sharp.
      const back = Math.max(8, o.strokeWidth * 4) * 0.6;
      const a = Math.atan2(y2 - y1, x2 - x1);
      ex = x2 - back * Math.cos(a);
      ey = y2 - back * Math.sin(a);
      page.drawSvgPath(`M ${head[0]} ${head[1]} L ${head[2]} ${head[3]} L ${head[4]} ${head[5]} Z`, {
        x: 0,
        y: 0,
        color,
        opacity: o.opacity,
      });
    }
    page.drawLine({
      start: { x: x1, y: -y1 },
      end: { x: ex, y: -ey },
      thickness: o.strokeWidth,
      color,
      opacity: o.opacity,
      lineCap: LineCapStyle.Round,
    });
  });
}

/** A drawing lifted from the page: its path scaled to the object's box, with its colours and line width. */
function drawVector(page: PDFPage, pm: Matrix, o: VectorObject): void {
  const cmds = parseSvgPath(o.path);
  if (!cmds.length || (!o.fill && !o.stroke)) return;
  const sx = o.width / (o.naturalWidth || 1);
  const sy = o.height / (o.naturalHeight || 1);
  // Local frame (y down) -> PDF; the path is scaled, the line width is not.
  withMatrix(page, objectMatrix(pm, o), () => {
    const P = (x: number, y: number) => [x * sx, y * sy];
    const ops: PDFOperator[] = [];
    const gs = (page as unknown as { maybeEmbedGraphicsState(o: { opacity?: number; borderOpacity?: number }): PDFName | undefined }).maybeEmbedGraphicsState({ opacity: o.opacity, borderOpacity: o.opacity });
    if (gs) ops.push(setGraphicsState(gs));
    if (o.fill) {
      const c = hexToRgb(o.fill) as { red: number; green: number; blue: number };
      ops.push(setFillingRgbColor(c.red, c.green, c.blue));
    }
    if (o.stroke) {
      const c = hexToRgb(o.stroke) as { red: number; green: number; blue: number };
      ops.push(setStrokingRgbColor(c.red, c.green, c.blue), setLineWidth(o.strokeWidth), setLineJoin(LineJoinStyle.Round));
    }
    for (const c of cmds) {
      if (c.c === 'M') ops.push(moveTo(...(P(c.p[0], c.p[1]) as [number, number])));
      else if (c.c === 'L') ops.push(lineTo(...(P(c.p[0], c.p[1]) as [number, number])));
      else if (c.c === 'C') ops.push(appendBezierCurve(...([...P(c.p[0], c.p[1]), ...P(c.p[2], c.p[3]), ...P(c.p[4], c.p[5])] as [number, number, number, number, number, number])));
      else ops.push(closePath());
    }
    const paint = o.fill && o.stroke ? (o.evenOdd ? 'B*' : 'B') : o.fill ? (o.evenOdd ? 'f*' : 'f') : 'S';
    ops.push(PDFOperator.of(paint as never));
    page.pushOperators(...ops);
  });
}

function drawPen(page: PDFPage, pm: Matrix, o: PenObject): void {
  if (o.points.length < 4) return;
  if (o.pressures?.length) {
    // Pen pressure: each segment with its own width, round ends joining them smoothly.
    withMatrix(page, multiply(objectMatrix(pm, o), [1, 0, 0, -1, 0, 0]), () => {
      for (let i = 2; i < o.points.length; i += 2) {
        const p = ((o.pressures![i / 2 - 1] ?? 0.5) + (o.pressures![i / 2] ?? 0.5)) / 2;
        page.drawLine({ start: { x: o.points[i - 2], y: -o.points[i - 1] }, end: { x: o.points[i], y: -o.points[i + 1] }, thickness: pressureWidth(o.strokeWidth, p), color: hexToRgb(o.stroke), opacity: o.opacity, lineCap: LineCapStyle.Round });
      }
    });
    return;
  }
  let d = `M ${o.points[0]} ${o.points[1]}`;
  for (let i = 2; i < o.points.length; i += 2) d += ` L ${o.points[i]} ${o.points[i + 1]}`;
  withMatrix(page, multiply(objectMatrix(pm, o), [1, 0, 0, -1, 0, 0]), () => {
    page.drawSvgPath(d, {
      x: 0,
      y: 0,
      borderColor: hexToRgb(o.stroke),
      borderWidth: o.strokeWidth,
      borderOpacity: o.opacity,
      borderLineCap: LineCapStyle.Round,
    });
  });
}

// ---------------------------------------------------------------- redaction

/** Objects whose content cannot be cut: under a redaction box they are left out. */
const CLIPPABLE = new Set<EditorObject['type']>(['rect', 'ellipse', 'highlight', 'line', 'arrow']);

/**
 * What happens to an object under a redaction box: plain shapes and lines are
 * clipped out of the boxes; text, pictures, ink, drawings, comments and
 * fields are dropped (their data would otherwise stay in the file), and so
 * are comments taken over from the file.
 */
export function redactionFate(o: EditorObject, rects: Rect[]): 'keep' | 'clip' | 'drop' {
  if (o.type === 'redact') return 'keep';
  const b = objectDisplayBounds(o);
  const eps = 0.01;
  const hit = rects.some((r) => b.x < r.x + r.width - eps && r.x < b.x + b.width - eps && b.y < r.y + r.height - eps && r.y < b.y + b.height - eps);
  if (!hit) return 'keep';
  // A comment taken over from the file is written back as an annotation, which a clip cannot cut.
  return CLIPPABLE.has(o.type) && !o.fileAnnot ? 'clip' : 'drop';
}

/** The objects of a redacted page: those under a box dropped, the boxes themselves last so nothing is drawn over them. */
function orderForRedaction(list: EditorObject[], rects: Rect[]): EditorObject[] {
  return [...list.filter((o) => o.type !== 'redact' && redactionFate(o, rects) !== 'drop'), ...list.filter((o) => o.type === 'redact')];
}

/** Full names of the form fields with a widget overlapping one of `boxes` (PDF user space). */
function fieldsUnder(doc: PDFDocument, page: PDFPage, boxes: Box[]): string[] {
  const out: string[] = [];
  for (const ref of widgetRefs(doc, page)) {
    const w = lookupDict(doc, ref);
    const rect = w?.lookup(PDFName.of('Rect'));
    if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
    const r = [0, 1, 2, 3].map((k) => (rect.lookup(k) as PDFNumber).asNumber());
    const b = { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
    if (!boxes.some((x) => x.x0 < b.x1 && b.x0 < x.x1 && x.y0 < b.y1 && b.y0 < x.y1)) continue;
    const parts: string[] = [];
    let d: PDFDict | undefined = w;
    for (let depth = 0; d && depth < 32; depth++) {
      const t = d.lookup(PDFName.of('T'));
      if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText());
      d = lookupDict(doc, d.get(PDFName.of('Parent')));
    }
    if (parts.length) out.push(parts.join('.'));
  }
  return out;
}

/** Opens a graphics state whose clip leaves out every redaction box (closed with Q). */
function clipOutRedactions(page: PDFPage, pm: Matrix, rects: Rect[]): void {
  page.pushOperators(pushGraphicsState());
  // One even-odd clip per box: the clips intersect, so overlapping boxes stay out too.
  for (const d of rects) {
    const r = transformRectBounds(pm, d);
    page.pushOperators(rectangle(-1e5, -1e5, 2e5, 2e5), rectangle(r.x, r.y, r.width, r.height), clipEvenOdd(), endPath());
  }
}

// ---------------------------------------------------------------- forms

/** The value of a form field as text (fields created from objects first, then the document's own). */
function fieldText(ctx: DrawContext, name: string): string | null {
  const obj = ctx.fieldObjects.find((f) => f.name === name && f.fieldKind !== 'button' && f.fieldKind !== 'barcode');
  try {
    const f = ctx.doc.getForm().getField(name);
    if (f instanceof PDFTextField) return f.getText() ?? '';
    if (f instanceof PDFCheckBox) return f.isChecked() ? 'Yes' : 'No';
    if (f instanceof PDFDropdown || f instanceof PDFOptionList) return f.getSelected().join(', ');
    if (f instanceof PDFRadioGroup) return f.getSelected() ?? '';
  } catch {
    /* not (yet) in the document */
  }
  if (obj) return obj.fieldKind === 'checkbox' ? (obj.value === 'checked' ? 'Yes' : 'No') : obj.value;
  return null;
}

/** The PDF action of a button. */
function buttonAction(doc: PDFDocument, o: FieldObject): PDFDict | null {
  const a = o.action;
  const ctx = doc.context;
  if (!a) return null;
  switch (a.kind) {
    case 'submit': {
      // SubmitPDF (bit 9): the whole filled form is sent, as most mail programs can attach it.
      const url = `mailto:${a.email.trim()}${a.subject ? `?subject=${encodeURIComponent(a.subject)}` : ''}`;
      return ctx.obj({ Type: 'Action', S: 'SubmitForm', F: { FS: 'URL', F: PDFString.of(url) }, Flags: 256 }) as PDFDict;
    }
    case 'reset':
      return ctx.obj({ Type: 'Action', S: 'ResetForm' }) as PDFDict;
    case 'print':
      return ctx.obj({ Type: 'Action', S: 'Named', N: 'Print' }) as PDFDict;
    case 'url':
      return ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(a.url) }) as PDFDict;
    case 'showhide':
      return ctx.obj({ Type: 'Action', S: 'Hide', T: ctx.obj(a.fields.map((f) => PDFString.of(f))), H: a.hide }) as PDFDict;
    case 'page': {
      const target = doc.getPages()[Math.max(0, Math.min(doc.getPageCount() - 1, a.page - 1))];
      return target ? (ctx.obj({ Type: 'Action', S: 'GoTo', D: [target.ref, PDFName.of('Fit')] }) as PDFDict) : null;
    }
  }
}

function uniqueFieldName(doc: PDFDocument, wanted: string): string {
  const names = new Set(doc.getForm().getFields().map((f) => f.getName()));
  const base = wanted.trim().replace(/\./g, '_') || 'Field';
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

async function addFormField(ctx: DrawContext, page: PDFPage, pm: Matrix, rotation: Rotation, o: FieldObject): Promise<void> {
  const form = ctx.doc.getForm();
  const r = transformRectBounds(multiply(pm, translate(o.x, o.y)), { x: 0, y: 0, width: o.width, height: o.height });
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height, rotate: degrees(rotation) };
  const look = {
    borderColor: rgb(0.45, 0.55, 0.7),
    borderWidth: 1,
    backgroundColor: rgb(0.94, 0.97, 1),
  };
  switch (o.fieldKind) {
    case 'text': {
      const f = form.createTextField(uniqueFieldName(ctx.doc, o.name));
      if (o.multiline) f.enableMultiline();
      if (o.value) f.setText(o.value);
      if (o.required) f.enableRequired();
      f.addToPage(page, { ...rect, ...look, font: ctx.fieldFont ?? undefined });
      f.setFontSize(o.fontSize || 0);
      if (o.logic && (o.logic.format || o.logic.range || o.logic.calc)) writeFieldLogic(ctx.doc, f, o.logic, ctx.fieldNames);
      break;
    }
    case 'checkbox': {
      const f = form.createCheckBox(uniqueFieldName(ctx.doc, o.name));
      f.addToPage(page, { ...rect, ...look });
      if (o.value === 'checked') f.check();
      if (o.required) f.enableRequired();
      break;
    }
    case 'radio': {
      let group: PDFRadioGroup;
      try {
        group = form.getRadioGroup(o.name);
      } catch {
        group = form.createRadioGroup(uniqueFieldName(ctx.doc, o.name));
      }
      group.addOptionToPage(o.value || `Option${group.getOptions().length + 1}`, page, { ...rect, ...look });
      if (o.required) group.enableRequired();
      break;
    }
    case 'dropdown': {
      const f = form.createDropdown(uniqueFieldName(ctx.doc, o.name));
      const options = o.options.filter((s) => s.trim() !== '');
      f.addOptions(options.length ? options : ['Option 1']);
      if (o.value && options.includes(o.value)) f.select(o.value);
      if (o.required) f.enableRequired();
      f.addToPage(page, { ...rect, ...look, font: ctx.fieldFont ?? undefined });
      break;
    }
    case 'button': {
      const f = form.createButton(uniqueFieldName(ctx.doc, o.name));
      f.addToPage(o.value || 'Button', page, { ...rect, borderColor: rgb(0.2, 0.45, 0.75), borderWidth: 1, backgroundColor: rgb(0.88, 0.95, 1), textColor: rgb(0.03, 0.2, 0.4), font: ctx.fieldFont ?? undefined });
      const action = buttonAction(ctx.doc, o);
      if (action) for (const w of f.acroField.getWidgets()) w.dict.set(PDFName.of('A'), action);
      break;
    }
    case 'barcode': {
      const { barcodeRects, fillTemplate } = await import('@/lib/barcode/draw');
      const spec = o.barcode ?? { symbology: 'qr' as const, template: '' };
      const text = fillTemplate(spec.template, (name) => fieldText(ctx, name));
      page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: rgb(1, 1, 1) });
      let rects: ReturnType<typeof barcodeRects>;
      try {
        rects = barcodeRects(spec.symbology, text || ' ', r.width / Math.max(1, r.height));
      } catch {
        rects = []; // too long for a QR code
      }
      for (const q of rects) page.drawRectangle({ x: r.x + q.x * r.width, y: r.y + r.height - (q.y + q.h) * r.height, width: q.w * r.width + 0.02, height: q.h * r.height + 0.02, color: rgb(0, 0, 0) });
      break;
    }
    case 'signature': {
      // pdf-lib has no signature-field builder: create an unsigned /Sig field.
      const doc = ctx.doc;
      const widget = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of(uniqueFieldName(doc, o.name)),
        Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
        F: 4,
        P: page.ref,
        MK: { BC: [0.45, 0.55, 0.7], BG: [0.94, 0.97, 1], R: rotation },
      });
      const ref = doc.context.register(widget);
      let annots = page.node.Annots();
      if (!annots) {
        annots = doc.context.obj([]);
        page.node.set(PDFName.of('Annots'), annots);
      }
      annots.push(ref);
      acroFormFields(doc, true)!.push(ref);
      break;
    }
  }
}

function applyFieldValues(doc: PDFDocument, values: Record<string, FieldValue>, sourceId: string): boolean {
  const prefix = `${sourceId}::`;
  let changed = false;
  const form = doc.getForm();
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    let field;
    try {
      field = form.getField(name);
    } catch {
      continue;
    }
    try {
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) (value === true ? field.check() : field.uncheck());
      else if (field instanceof PDFDropdown) {
        if (Array.isArray(value)) field.select(value);
        else if (value) field.select(String(value));
        else field.clear();
      } else if (field instanceof PDFOptionList) {
        if (Array.isArray(value)) field.select(value);
        else if (value) field.select(String(value));
        else field.clear();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(String(value));
        else field.clear();
      } else continue;
      changed = true;
    } catch {
      /* value not valid for this field (e.g. option removed) — skip it */
    }
  }
  return changed;
}

// ---------------------------------------------------------------- main

interface PlannedPage {
  ref: PageRef;
  page: PDFPage;
  /** True when this page was replaced by a redaction raster. */
  rasterized: boolean;
}

export async function buildPdf(input: ExportInput, options: ExportOptions = {}): Promise<Uint8Array> {
  const { sources, pages, objects } = input;
  if (pages.length === 0) throw new ExportError('The document has no pages.');
  const progress = options.onProgress ?? (() => undefined);
  const opts = {
    measure: options.measure ?? canvasMeasure,
    loadFont: options.loadFont ?? loadFontBytes,
  };

  // 1. Base document: the opened file (or the first page's source), edited in place.
  const baseSourceId = baseSourceOf(pages, input.baseSourceId);
  let doc: PDFDocument;
  if (baseSourceId) {
    const src = sources[baseSourceId];
    if (!src) throw new ExportError('A source document is missing.');
    try {
      doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    } catch (e) {
      if (e instanceof Error && /encrypt/i.test(e.message)) {
        throw new ExportError('This PDF is encrypted. Remove its password protection before editing.');
      }
      throw e;
    }
  } else {
    doc = await PDFDocument.create({ updateMetadata: false });
  }
  doc.registerFontkit(fontkit);
  // A static XFA form: pdf-lib drops the XFA as soon as the form is touched; it is put back at the end.
  const staticXfa = baseSourceId && xfaKindOf(doc) === 'static' ? readXfaPackets(doc) : null;

  const baseOriginal = baseSourceId ? doc.getPages() : [];
  baseOriginal.forEach(pinInheritedAttributes);
  const baseUsed = new Set<number>();
  const foreignDocs = new Map<string, PDFDocument>();

  // 2. Build the ordered page list.
  const redactsByPage = new Map<string, Array<Rect & { fill: string }>>();
  for (const o of objects) {
    if (o.type !== 'redact') continue;
    const list = redactsByPage.get(o.pageId) ?? [];
    list.push({ ...transformRectBounds(multiply(translate(o.x, o.y), rotateCw(o.rotation)), { x: 0, y: 0, width: o.width, height: o.height }), fill: o.fill });
    redactsByPage.set(o.pageId, list);
  }

  const planned: PlannedPage[] = [];
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    progress('Assembling pages', (i / pages.length) * 0.4);
    if (ref.kind === 'blank' || !ref.sourceId) {
      const page = PDFPage.create(doc);
      page.setSize(ref.width, ref.height);
      planned.push({ ref, page, rasterized: false });
      continue;
    }
    if (ref.sourceId === baseSourceId) {
      if (!baseUsed.has(ref.sourceIndex)) {
        baseUsed.add(ref.sourceIndex);
        planned.push({ ref, page: baseOriginal[ref.sourceIndex], rasterized: false });
      } else {
        planned.push({ ref, page: await duplicateBasePage(doc, baseOriginal[ref.sourceIndex], ref.sourceIndex), rasterized: false });
      }
      continue;
    }
    let foreign = foreignDocs.get(ref.sourceId);
    if (!foreign) {
      const src = sources[ref.sourceId];
      if (!src) throw new ExportError('A merged document is missing.');
      foreign = await PDFDocument.load(src.bytes, { updateMetadata: false });
      foreignDocs.set(ref.sourceId, foreign);
    }
    const [copy] = await doc.copyPages(foreign, [ref.sourceIndex]);
    planned.push({ ref, page: copy, rasterized: false });
  }

  // 2b. Delete the letters under redactions and replaced text from the page
  // content itself (the rest of the page stays real, selectable text). A
  // redacted page whose area holds anything the engine cannot clean safely
  // (images, drawings, form XObjects, form fields…) is rebuilt from a raster.
  const replacersByPage = new Map<string, TextObject[]>();
  for (const o of objects) {
    if (o.type === 'text' && o.replaces?.length) replacersByPage.set(o.pageId, [...(replacersByPage.get(o.pageId) ?? []), o]);
  }
  // Pages where replaced text could not be removed: draw a white cover under the new text.
  const coverReplaced = new Set<string>();
  // Replacement text moved along its line by other replacements before it (points).
  const replacerShift = new Map<string, number>();
  // Replacement text condensed to fit before the next column / the page margin.
  const replacerScale = new Map<string, number>();
  // Replacements the engine wrote into the page in the document's own font.
  const replacerNative = new Set<string>();
  // Redacted letters' marked-content ids per page, and annotations taken off (for the structure tree).
  const redactedMcids = new Map<string, Set<number>>();
  const goneAnnots = new Set<string>();
  const redactedFields = new Set<string>();
  const noteRemoval = (page: PDFPage, res: { mcids: number[]; removedAnnotRefs: string[] }) => {
    if (res.mcids.length) redactedMcids.set(page.ref.toString(), new Set([...(redactedMcids.get(page.ref.toString()) ?? []), ...res.mcids]));
    for (const r of res.removedAnnotRefs) goneAnnots.add(r);
  };
  const pdfBoxes = (ref: PageRef, page: PDFPage) => {
    const pm = displayToPdfMatrix(totalRotation(ref), visibleBox(page));
    return (r: Rect): Box => {
      const b = transformRectBounds(pm, r);
      return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
    };
  };
  // Single-line replacements tell the engine their width so the rest of the line makes room.
  const lineEdits = (replacers: TextObject[], toPdf: (r: Rect) => Box): LineEdit[] =>
    replacers.map((o) => {
      const newWidth = singleLineWidth(o, opts.measure);
      // Plain one-line text can be written in the document's own font, also in another colour or
      // size; another typeface, bold or italic needs Adika's font.
      const og = o.original;
      const sameFace = !og || (og.fontFamily === o.fontFamily && og.bold === o.bold && og.italic === o.italic);
      const native = Number.isFinite(newWidth) && o.opacity >= 1 && !o.background && sameFace;
      return {
        boxes: o.replaces!.map(toPdf),
        newWidth,
        text: native ? o.text : undefined,
        color: og && og.color.toLowerCase() !== o.color.toLowerCase() ? o.color : undefined,
        sizeRatio: og && og.fontSize > 0 && Math.abs(og.fontSize - o.fontSize) > 0.05 ? o.fontSize / og.fontSize : undefined,
      };
    });
  // Letters the document's fonts lack: codes added for glyphs they have, fonts embedded for the rest.
  const editsByPage = new Map<string, LineEdit[]>();
  for (const { ref, page } of planned) {
    const replacers = replacersByPage.get(ref.id);
    if (replacers?.length && ref.kind === 'source' && ref.sourceId) editsByPage.set(ref.id, lineEdits(replacers, pdfBoxes(ref, page)));
  }
  const fallbackSources = options.fallbackFonts === undefined ? defaultFallbackSources(opts.loadFont) : options.fallbackFonts;
  if (fallbackSources && editsByPage.size) {
    const pagesWithEdits = planned.filter((p) => editsByPage.has(p.ref.id)).map((p) => ({ page: p.page, edits: editsByPage.get(p.ref.id)! }));
    try {
      await attachFallbacks(doc, pagesWithEdits, fallbackSources);
    } catch {
      /* no fallback fonts: such edits are drawn in Adika's font */
    }
  }
  const fontNotes: FontFallbackNote[] = [];
  for (let k = 0; k < planned.length; k++) {
    const { ref, page } = planned[k];
    const redactions = redactsByPage.get(ref.id);
    const replacers = replacersByPage.get(ref.id);
    if (!redactions?.length && !replacers?.length) continue;
    const toPdf = pdfBoxes(ref, page);
    const editable = ref.kind === 'source' && !!ref.sourceId;
    if (redactions?.length) {
      // Static XFA keeps its own copy of the values: fields under a box are emptied there too.
      if (staticXfa) for (const name of fieldsUnder(doc, page, redactions.map(toPdf))) redactedFields.add(name);
      const res = editable ? removeGlyphs(doc, page, redactions.map(toPdf), 'redact') : null;
      if (res?.ok) noteRemoval(page, res);
      if (!res?.ok) {
        if (!options.rasterizeRedactedPage) throw new ExportError('Redaction needs a page rasterizer.');
        const raster = await options.rasterizeRedactedPage(ref, redactions);
        const size = displaySize(ref);
        const rp = PDFPage.create(doc);
        rp.setSize(size.width, size.height);
        const img = raster.format === 'jpeg' ? await doc.embedJpg(raster.bytes) : await doc.embedPng(raster.bytes);
        rp.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
        planned[k] = { ref, page: rp, rasterized: true };
        if (replacers?.length) coverReplaced.add(ref.id);
        continue;
      }
    }
    if (replacers?.length) {
      const edits = editsByPage.get(ref.id) ?? lineEdits(replacers, toPdf);
      const res = editable ? removeGlyphs(doc, page, edits.flatMap((e) => e.boxes), 'replace', edits) : null;
      if (res?.ok) noteRemoval(page, res);
      if (!res?.ok || res.coversImage) coverReplaced.add(ref.id);
      else {
        replacers.forEach((o, i) => {
          if (res.editShifts[i]) replacerShift.set(o.id, res.editShifts[i]);
          if (res.editScales[i] < 1) replacerScale.set(o.id, res.editScales[i]);
          if (res.editNative[i]) replacerNative.add(o.id);
          const fonts = res.editNative[i] ? res.editFonts[i] : null;
          if (fonts?.fallback.length) fontNotes.push({ objectId: o.id, text: o.text, fallback: fonts.fallback });
        });
      }
    }
  }

  // 3. Replace the page tree contents with the planned order.
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  for (const p of planned) {
    doc.addPage(p.page);
    if (!p.rasterized) p.page.setRotation(degrees(totalRotation(p.ref)));
    else p.page.setRotation(degrees(0));
    if (p.ref.sourceId && p.ref.sourceId !== baseSourceId && !p.rasterized) attachCopiedFields(doc, p.page);
  }
  pruneOrphanFields(doc);

  // 3b. Comments of the file that were edited or deleted (fileAnnots.ts).
  const fileEdits = prepareFileAnnotEdits(
    planned.map((p) => ({
      ref: p.ref,
      page: p.page,
      origin: p.rasterized || !p.ref.sourceId ? null : p.ref.sourceId === baseSourceId ? baseOriginal[p.ref.sourceIndex] : (foreignDocs.get(p.ref.sourceId)?.getPage(p.ref.sourceIndex) ?? null),
      copies: annotCopies.get(p.page),
    })),
    objects,
  );

  // 4. Existing form values.
  let formTouched = false;
  if (baseSourceId) formTouched = applyFieldValues(doc, input.fieldValues, baseSourceId) || formTouched;
  for (const id of foreignDocs.keys()) formTouched = applyFieldValues(doc, input.fieldValues, id) || formTouched;

  // 5. Objects.
  const needsFieldFont = objects.some((o) => o.type === 'field') || formTouched;
  const ctx: DrawContext = { doc, fonts: new Map(), fontTexts: collectFontTexts(objects), images: new Map(), opts, fieldFont: null, fieldNames: objects.filter((o): o is FieldObject => o.type === 'field').map((o) => o.name), fieldObjects: objects.filter((o): o is FieldObject => o.type === 'field') };
  if (needsFieldFont) {
    // Full (non-subset) font so recipients can type any character later.
    ctx.fieldFont = await doc.embedFont(await opts.loadFont({ family: 'sans', bold: false, italic: false }), { subset: false });
  }
  const byPage = new Map<string, EditorObject[]>();
  for (const o of objects) {
    const list = byPage.get(o.pageId) ?? [];
    list.push(o);
    byPage.set(o.pageId, list);
  }
  const pageById = new Map(planned.map((p) => [p.ref.id, p.page]));
  for (let i = 0; i < planned.length; i++) {
    const { ref, page, rasterized } = planned[i];
    progress('Applying edits', 0.4 + (i / planned.length) * 0.5);
    const list = byPage.get(ref.id);
    if (!list) continue;
    const rotation: Rotation = rasterized ? 0 : totalRotation(ref);
    const pm = displayToPdfMatrix(rotation, visibleBox(page));
    const redactRects = redactsByPage.get(ref.id) ?? [];
    if (redactRects.length && coverReplaced.has(ref.id)) {
      // Replacement text under a box is left out; the old letters it should have covered still are.
      for (const o of list) {
        if (o.type !== 'text' || !o.replaces?.length || redactionFate(o, redactRects) !== 'drop') continue;
        withMatrix(page, pm, () => {
          for (const r of o.replaces!) page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: rgb(1, 1, 1) });
        });
      }
    }
    for (const o of redactRects.length ? orderForRedaction(list, redactRects) : list) {
      if (fileEdits.skip(o)) continue;
      const review = (o as { reviewStatus?: ReviewState }).reviewStatus;
      const annotsBefore = page.node.Annots()?.size() ?? 0;
      const clipped = redactRects.length > 0 && redactionFate(o, redactRects) === 'clip';
      if (clipped) clipOutRedactions(page, pm, redactRects);
      // An object in a layer: its page content is marked as that layer's.
      const layer = o.layer && LAYERED.has(o.type) && !(o.type === 'text' && o.annotation) ? layerForContent(ctx.doc, page, o.layer) : null;
      if (layer) page.pushOperators(PDFOperator.of('BDC' as never, [PDFName.of('OC'), PDFName.of(layer)]));
      if (!fileEdits.write(ctx.doc, page, pm, o)) await writeObject(o);
      if (layer) page.pushOperators(PDFOperator.of('EMC' as never));
      if (clipped) page.pushOperators(popGraphicsState());
      const original = fileEdits.adopt(ctx.doc, page, o, annotsBefore);
      if (review && review !== 'None' && original) addReviewReply(ctx.doc, page, original, review, (o as { author?: string }).author ?? '');
      else if (review && review !== 'None') {
        // The comment's annotation: the first one added for it that is not its popup.
        const annots = page.node.Annots();
        for (let k = annotsBefore; annots && k < annots.size(); k++) {
          const ref = annots.get(k);
          const d = annots.lookup(k);
          if (ref instanceof PDFRef && d instanceof PDFDict && d.lookup(PDFName.of('Subtype')) !== PDFName.of('Popup')) {
            addReviewReply(ctx.doc, page, ref, review, (o as { author?: string }).author ?? '');
            break;
          }
        }
      }
    }
    async function writeObject(o: EditorObject): Promise<void> {
      switch (o.type) {
        case 'text':
          if (replacerNative.has(o.id)) break; // already written into the page content
          if (o.replaces?.length && coverReplaced.has(ref.id)) {
            // The old letters are still there (or burned into a raster): cover them.
            withMatrix(page, pm, () => {
              for (const r of o.replaces!) page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: rgb(1, 1, 1) });
            });
          }
          if (o.annotation) {
            const v = { family: o.fontFamily, bold: o.bold, italic: o.italic };
            writeFreeText(ctx.doc, page, pm, o, await fontFor(ctx, v), ctx.opts.measure(v, o.fontSize));
          } else {
            const sh = replacerShift.get(o.id);
            const a = (o.rotation * Math.PI) / 180;
            await drawText(ctx, page, pm, sh ? { ...o, x: o.x + Math.cos(a) * sh, y: o.y + Math.sin(a) * sh } : o, replacerScale.get(o.id) ?? 1);
          }
          break;
        case 'note':
          writeNote(ctx.doc, page, pm, o);
          break;
        case 'markup':
          writeMarkup(ctx.doc, page, pm, o);
          break;
        case 'image':
        case 'signature':
          await drawImage(ctx, page, pm, o);
          break;
        case 'rect':
        case 'ellipse':
        case 'highlight':
          drawShape(page, pm, o);
          break;
        case 'line':
        case 'arrow':
          drawLine(page, pm, o);
          break;
        case 'pen':
          drawPen(page, pm, o);
          break;
        case 'vector':
          drawVector(page, pm, o);
          break;
        case 'field':
          await addFormField(ctx, page, pm, rotation, o);
          break;
        case 'stamp':
          writeStamp(
            ctx.doc,
            page,
            pm,
            o,
            await fontFor(ctx, { family: 'sans', bold: false, italic: false }),
            await fontFor(ctx, { family: 'sans', bold: true, italic: false }),
            o.src ? await imageFor(ctx, o.src) : null,
          );
          break;
        case 'poly':
          writePoly(ctx.doc, page, pm, o);
          break;
        case 'attachment':
          writeAttachment(ctx.doc, page, pm, o);
          break;
        case 'measure':
          writeMeasure(ctx.doc, page, pm, o, await fontFor(ctx, { family: 'sans', bold: false, italic: false }));
          break;
        case 'link':
          writeLink(ctx.doc, page, pm, o, o.target.kind === 'page' ? (pageById.get(o.target.pageId) ?? null) : null);
          break;
        case 'redact':
          // Rasterised pages have the box burned in; otherwise the letters are gone, draw the box.
          if (!rasterized) {
            withMatrix(page, boxFrame(objectMatrix(pm, o), o.height), () => {
              page.drawRectangle({ x: 0, y: 0, width: o.width, height: o.height, color: hexToRgb(o.fill) });
            });
          }
          break;
      }
    }
  }

  // 6. Bookmarks edited in the panel replace the file's outline.
  if (input.outline) writeOutline(doc, input.outline, pageById);

  // 7. Form appearances, flattening, metadata.
  finishForm(doc, ctx.fieldFont, options.fieldDisplay, baseSourceId);
  if (options.flatten) flattenDocument(doc, ctx.fieldFont);

  if (options.title) doc.setTitle(options.title);
  if (options.meta) {
    const m = options.meta;
    if (m.title !== undefined) doc.setTitle(m.title);
    if (m.author !== undefined) doc.setAuthor(m.author);
    if (m.subject !== undefined) doc.setSubject(m.subject);
    if (m.keywords !== undefined) doc.setKeywords(m.keywords.split(/[,;]\s*/).filter(Boolean));
  }
  doc.setProducer('Adika PDF Editor');
  doc.setModificationDate(new Date());
  if (options.meta) {
    // Edited properties: the XMP metadata says the same as the Info dictionary.
    const { readXmpFields, writeXmp } = await import('./xmp');
    const m = options.meta;
    const old = readXmpFields(doc);
    const authors = (m.author ?? doc.getAuthor() ?? '').split(/;\s*/).filter(Boolean);
    writeXmp(
      doc,
      {
        title: m.title ?? doc.getTitle() ?? '',
        authors,
        description: m.subject ?? doc.getSubject() ?? '',
        keywords: m.keywords ?? doc.getKeywords() ?? '',
        rightsStatus: m.rightsStatus ?? old?.rightsStatus ?? 'unknown',
        copyright: m.copyright ?? old?.copyright ?? '',
        copyrightUrl: m.copyrightUrl ?? old?.copyrightUrl ?? '',
      },
      { producer: 'Adika PDF Editor', custom: m.custom },
    );
  }
  progress('Writing file', 0.95);
  let keepXfa = false;
  if (staticXfa && !options.flatten) {
    // Field updates first (they would drop the XFA again), then the XFA with the filled values in its data.
    try {
      doc.getForm().updateFieldAppearances(ctx.fieldFont ?? undefined);
    } catch {
      /* odd appearance: keep it */
    }
    const prefix = `${baseSourceId}::`;
    const values = Object.fromEntries(Object.entries(input.fieldValues).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    for (const name of redactedFields) values[name] = '';
    keepXfa = restoreStaticXfa(doc, staticXfa, values) === 'synced';
  }
  // Nothing may keep a deleted or rasterised page (and its text) alive: tags, bookmarks, links, open action.
  cleanUpGonePages(doc, baseOriginal, planned, baseSourceId, redactedMcids, goneAnnots);
  // Embed fonts/images first, then drop orphans (replaced or deleted pages).
  await doc.flush();
  dropUnreachableObjects(doc);
  const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: !keepXfa });
  if (fontNotes.length) options.onFontFallback?.(fontNotes);
  return out;
}

/** Original pages no longer in the document: their references move to the page that replaced them, or go. */
function cleanUpGonePages(doc: PDFDocument, original: PDFPage[], planned: PlannedPage[], baseSourceId: string | null, mcids: Map<string, Set<number>>, goneAnnots: Set<string>): void {
  const live = new Set(planned.map((p) => p.page.ref.toString()));
  const fates = new Map<string, PDFRef | null>();
  original.forEach((page, i) => {
    if (live.has(page.ref.toString())) return;
    const next = planned.find((p) => p.ref.sourceId === baseSourceId && p.ref.sourceIndex === i);
    fates.set(page.ref.toString(), next ? next.page.ref : null);
  });
  scrubStructTree(doc, { gonePages: new Set(fates.keys()), goneObjs: goneAnnots, mcids });
  retargetPageRefs(doc, fates);
  // The calculation order may still name fields that were removed with their pages.
  const acro = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
  const co = acro?.lookup(PDFName.of('CO'));
  if (acro && co instanceof PDFArray) {
    const inTree = new Set<string>();
    const walk = (ref: unknown, depth = 0) => {
      if (!(ref instanceof PDFRef) || depth > 32 || inTree.has(ref.toString())) return;
      inTree.add(ref.toString());
      const kids = lookupDict(doc, ref)?.lookup(PDFName.of('Kids'));
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
    };
    const fields = acroFormFields(doc, false);
    for (let i = 0; fields && i < fields.size(); i++) walk(fields.get(i));
    for (let i = co.size() - 1; i >= 0; i--) if (!inTree.has(String(co.get(i)))) co.remove(i);
  }
}

/** Calculated values, formatted display text and appearances of the form's fields. */
function finishForm(doc: PDFDocument, fieldFont: PDFFont | null, fieldDisplay: Record<string, string> | undefined, baseSourceId: string | null): void {
  const form = doc.getForm();
  if (form.getFields().length === 0) return;
  const acro = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
  const logic = readFieldLogic(doc);
  writeCalcOrder(doc, logic);
  // Calculated fields get their values now, so the file is right even where form scripts do not run.
  const names = form.getFields().map((f) => f.getName());
  for (const name of calcOrder(logic)) {
    const l = logic[name];
    const get = (n: string) => {
      try {
        return parseNumber(form.getTextField(n).getText() ?? '');
      } catch {
        return NaN;
      }
    };
    const v = calculate(l.calc!, names, get);
    const dec = l.format && l.format.kind !== 'date' ? l.format.decimals + (l.format.kind === 'percent' ? 2 : 0) : 6;
    try {
      const f = form.getTextField(name);
      const text = Number.isFinite(v) ? String(Math.round(v * 10 ** dec) / 10 ** dec) : '';
      if ((f.getText() ?? '') !== text) f.setText(text);
    } catch {
      /* not a text field */
    }
  }
  if (fieldFont) {
    // Formatted fields show "1.234,50 lei" on the page but keep the plain value (1234.5) as the PDF standard asks.
    const raw = new Map<PDFTextField, string>();
    for (const [name, l] of Object.entries(logic)) {
      if (!l.format) continue;
      try {
        const f = form.getTextField(name);
        const v = f.getText() ?? '';
        if (!v) continue;
        raw.set(f, v);
        f.setText(displayValue(l.format, v));
      } catch {
        /* not a text field */
      }
    }
    for (const [key, shown] of Object.entries(fieldDisplay ?? {})) {
      if (!baseSourceId || !key.startsWith(`${baseSourceId}::`)) continue;
      const name = key.slice(baseSourceId.length + 2);
      if (logic[name]?.format) continue;
      try {
        const f = form.getTextField(name);
        const v = f.getText() ?? '';
        if (!v || v === shown || raw.has(f)) continue;
        raw.set(f, v);
        f.setText(shown);
      } catch {
        /* not a text field */
      }
    }
    try {
      form.updateFieldAppearances(fieldFont);
    } catch {
      /* a field with an odd appearance stream: keep its original look */
    }
    for (const [f, v] of raw) f.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(v));
  }
  acro?.set(PDFName.of('NeedAppearances'), PDFBool.False);
}

// ---------------------------------------------------------------- incremental save

/** Objects saved as annotations (not page content), so an incremental update can add them. */
function isAnnotationObject(o: EditorObject): boolean {
  switch (o.type) {
    case 'note':
    case 'markup':
    case 'stamp':
    case 'poly':
    case 'attachment':
    case 'measure':
    case 'link':
      return true;
    case 'text':
      return !!o.annotation && !o.replaces?.length;
    default:
      return false;
  }
}

/**
 * Whether the edits can be saved as an incremental update of the opened file:
 * only comments, form values and bookmarks, on the file's own pages in their
 * order (no page content, page changes, redactions, text edits or new fields).
 * Returns why not, or null when they can.
 */
export function incrementalBlocker(input: ExportInput, meta?: import('@/store/usePDFStore').DocMeta | null, removingProtection = false): string | null {
  const base = baseSourceOf(input.pages, input.baseSourceId);
  const src = base ? input.sources[base] : undefined;
  if (!src || !src.original) return 'The document was rewritten since it was opened.';
  // An encrypted file is updated with objects encrypted like its own; one Adika could not decrypt is not.
  if (src.password && !src.encryption) return 'The document is encrypted.';
  if (removingProtection) return 'The password protection is being removed.';
  if (input.pages.length !== src.pageCount || input.pages.some((p, i) => p.kind !== 'source' || p.sourceId !== base || p.sourceIndex !== i || p.userRotation !== 0)) {
    return 'Pages were added, removed, moved or rotated.';
  }
  // Comments taken over from the file are rewritten in place (or removed), which only a full save does.
  if (input.pages.some((p) => p.takenAnnots?.length)) return 'Comments from the file were edited.';
  if (input.objects.some((o) => !isAnnotationObject(o))) return 'The page content was edited.';
  if (Object.keys(input.fieldValues).some((k) => !k.startsWith(`${base}::`))) return 'Form values of another document.';
  if (meta) return 'The document properties were changed.';
  return null;
}

/**
 * Saves comments, form values and bookmarks as an incremental update
 * appended to the opened file: the original bytes stay as they are, so
 * digital signatures stay valid (as Acrobat does). Check `incrementalBlocker` first.
 */
export async function buildIncrementalPdf(input: ExportInput, options: ExportOptions = {}): Promise<Uint8Array> {
  const why = incrementalBlocker(input);
  if (why) throw new ExportError(why);
  const baseSourceId = baseSourceOf(input.pages, input.baseSourceId)!;
  const opts = { measure: options.measure ?? canvasMeasure, loadFont: options.loadFont ?? loadFontBytes };
  const { incrementalUpdate } = await import('./incremental');
  const src = input.sources[baseSourceId];
  const encrypted = src.encryption ? { plain: src.bytes, unlocked: src.encryption.unlocked } : undefined;
  const res = await incrementalUpdate(src.encryption?.file ?? src.bytes, async (doc) => {
    doc.registerFontkit(fontkit);
    if (xfaKindOf(doc)) throw new ExportError('XFA forms are saved in full.');
    const docPages = doc.getPages();
    const prefix = `${baseSourceId}::`;
    const formTouched = Object.keys(input.fieldValues).some((k) => k.startsWith(prefix)) && applyFieldValues(doc, input.fieldValues, baseSourceId);
    const ctx: DrawContext = { doc, fonts: new Map(), fontTexts: collectFontTexts(input.objects), images: new Map(), opts, fieldFont: null, fieldNames: [], fieldObjects: [] };
    if (formTouched) ctx.fieldFont = await doc.embedFont(await opts.loadFont({ family: 'sans', bold: false, italic: false }), { subset: false });
    const pageById = new Map(input.pages.map((p, i) => [p.id, docPages[i]]));
    const sans = () => fontFor(ctx, { family: 'sans', bold: false, italic: false });
    for (let i = 0; i < input.pages.length; i++) {
      const ref = input.pages[i];
      const page = docPages[i];
      const list = input.objects.filter((o) => o.pageId === ref.id);
      if (!list.length) continue;
      options.onProgress?.('Applying edits', i / input.pages.length);
      const pm = displayToPdfMatrix(totalRotation(ref), visibleBox(page));
      for (const o of list) {
        const review = (o as { reviewStatus?: ReviewState }).reviewStatus;
        const annotsBefore = page.node.Annots()?.size() ?? 0;
        switch (o.type) {
          case 'text': {
            const v = { family: o.fontFamily, bold: o.bold, italic: o.italic };
            writeFreeText(doc, page, pm, o, await fontFor(ctx, v), opts.measure(v, o.fontSize));
            break;
          }
          case 'note':
            writeNote(doc, page, pm, o);
            break;
          case 'markup':
            writeMarkup(doc, page, pm, o);
            break;
          case 'stamp':
            writeStamp(doc, page, pm, o, await sans(), await fontFor(ctx, { family: 'sans', bold: true, italic: false }), o.src ? await imageFor(ctx, o.src) : null);
            break;
          case 'poly':
            writePoly(doc, page, pm, o);
            break;
          case 'attachment':
            writeAttachment(doc, page, pm, o);
            break;
          case 'measure':
            writeMeasure(doc, page, pm, o, await sans());
            break;
          case 'link':
            writeLink(doc, page, pm, o, o.target.kind === 'page' ? (pageById.get(o.target.pageId) ?? null) : null);
            break;
        }
        if (review && review !== 'None') {
          const annots = page.node.Annots();
          for (let k = annotsBefore; annots && k < annots.size(); k++) {
            const r = annots.get(k);
            const d = annots.lookup(k);
            if (r instanceof PDFRef && d instanceof PDFDict && d.lookup(PDFName.of('Subtype')) !== PDFName.of('Popup')) {
              addReviewReply(doc, page, r, review, (o as { author?: string }).author ?? '');
              break;
            }
          }
        }
      }
    }
    if (input.outline) writeOutline(doc, input.outline, pageById);
    if (formTouched) {
      // Only values and appearances change (what filling in means after signing): each field keeps its own /DA.
      const DA = PDFName.of('DA');
      const kept = doc.getForm().getFields().map((f) => [f.acroField.dict, f.acroField.dict.get(DA)] as const);
      finishForm(doc, ctx.fieldFont, options.fieldDisplay, baseSourceId);
      for (const [dict, da] of kept) {
        if (da) dict.set(DA, da);
        else dict.delete(DA);
      }
    }
  }, encrypted);
  return res.bytes;
}

/**
 * Flattens form fields (via pdf-lib) and bakes every remaining annotation
 * that has a normal appearance into the page content, then removes it.
 */
export function flattenDocument(doc: PDFDocument, font: PDFFont | null = null): void {
  const form = doc.getForm();
  try {
    if (font) form.updateFieldAppearances(font);
    form.flatten({ updateFieldAppearances: !font });
  } catch {
    // Fall back to a best-effort flatten without regenerating appearances.
    try {
      form.flatten({ updateFieldAppearances: false });
    } catch {
      /* ignore — annotations below still get baked */
    }
  }
  doc.catalog.delete(PDFName.of('AcroForm'));

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = lookupDict(doc, annots.get(i));
      if (!annot) continue;
      const subtype = annot.get(PDFName.of('Subtype'));
      if (subtype === PDFName.of('Link') || subtype === PDFName.of('Popup')) continue;
      const flags = annot.lookup(PDFName.of('F'));
      const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
      if (f & 2 || f & 1) continue; // hidden / invisible
      const ap = annot.lookup(PDFName.of('AP'));
      if (!(ap instanceof PDFDict)) continue;
      let normal = ap.get(PDFName.of('N'));
      if (!(doc.context.lookup(normal) instanceof PDFStream)) {
        // Appearance sub-dictionary keyed by state (checkboxes, radios): pick /AS.
        const states = lookupDict(doc, normal);
        const as = annot.get(PDFName.of('AS'));
        normal = states && as instanceof PDFName ? states.get(as) : undefined;
      }
      if (!(normal instanceof PDFRef) || !(doc.context.lookup(normal) instanceof PDFStream)) continue;
      const rect = annot.lookup(PDFName.of('Rect'));
      if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
      const [x1, y1, x2, y2] = [0, 1, 2, 3].map((k) => (rect.lookup(k) as PDFNumber).asNumber());
      const xobj = doc.context.lookup(normal) as PDFStream;
      const bboxArr = xobj.dict.lookup(PDFName.of('BBox'));
      if (!(bboxArr instanceof PDFArray)) continue;
      const [bx1, by1, bx2, by2] = [0, 1, 2, 3].map((k) => (bboxArr.lookup(k) as PDFNumber).asNumber());
      const bw = bx2 - bx1 || 1;
      const bh = by2 - by1 || 1;
      const sx = (Math.max(x1, x2) - Math.min(x1, x2)) / bw;
      const sy = (Math.max(y1, y2) - Math.min(y1, y2)) / bh;
      const name = page.node.newXObject('AdikaFlat', normal);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(sx, 0, 0, sy, Math.min(x1, x2) - bx1 * sx, Math.min(y1, y2) - by1 * sy),
        drawObject(name),
        popGraphicsState(),
      );
    }
    const keep = doc.context.obj([]);
    for (let i = 0; i < annots.size(); i++) {
      const annot = lookupDict(doc, annots.get(i));
      if (annot?.get(PDFName.of('Subtype')) === PDFName.of('Link')) keep.push(annots.get(i));
    }
    if (keep.size() > 0) page.node.set(PDFName.of('Annots'), keep);
    else removeAnnotations(page);
  }
}

export { StandardFonts };
