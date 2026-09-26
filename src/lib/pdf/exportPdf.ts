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
  PDFString,
  PDFTextField,
  StandardFonts,
  clip,
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
  EditorObject,
  FieldObject,
  ImageObject,
  LineObject,
  PageRef,
  PenObject,
  Rotation,
  ShapeObject,
  SignatureObject,
  SourceDoc,
  TextObject,
} from '@/types';
import {
  displaySize,
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
import type { FieldValue } from '@/store/usePDFStore';

export interface ExportInput {
  sources: Record<string, SourceDoc>;
  pages: PageRef[];
  objects: EditorObject[];
  fieldValues: Record<string, FieldValue>;
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
  onProgress?: (message: string, fraction: number) => void;
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

async function drawText(ctx: DrawContext, page: PDFPage, pm: Matrix, o: TextObject): Promise<void> {
  const variant: FontVariant = { family: o.fontFamily, bold: o.bold, italic: o.italic };
  const font = await fontFor(ctx, variant);
  const layout = layoutText(o, ctx.opts.measure(variant, o.fontSize));
  const height = Math.max(o.height, layout.contentHeight);
  withMatrix(page, boxFrame(objectMatrix(pm, o), height), () => {
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

function drawPen(page: PDFPage, pm: Matrix, o: PenObject): void {
  if (o.points.length < 4) return;
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

// ---------------------------------------------------------------- forms

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

  // 1. Base document: the first page's source, edited in place.
  const baseSourceId = pages.find((p) => p.kind === 'source')?.sourceId ?? null;
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
    const redactions = redactsByPage.get(ref.id);
    if (redactions && redactions.length > 0) {
      if (!options.rasterizeRedactedPage) throw new ExportError('Redaction needs a page rasterizer.');
      const raster = await options.rasterizeRedactedPage(ref, redactions);
      const size = displaySize(ref);
      const page = PDFPage.create(doc);
      page.setSize(size.width, size.height);
      const img = raster.format === 'jpeg' ? await doc.embedJpg(raster.bytes) : await doc.embedPng(raster.bytes);
      page.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
      planned.push({ ref, page, rasterized: true });
      continue;
    }
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
        const [copy] = await doc.copyPages(doc, [ref.sourceIndex]);
        planned.push({ ref, page: copy, rasterized: false });
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

  // 3. Replace the page tree contents with the planned order.
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  for (const p of planned) {
    doc.addPage(p.page);
    if (!p.rasterized) p.page.setRotation(degrees(totalRotation(p.ref)));
    else p.page.setRotation(degrees(0));
    if (p.ref.sourceId && p.ref.sourceId !== baseSourceId && !p.rasterized) attachCopiedFields(doc, p.page);
  }
  pruneOrphanFields(doc);

  // 4. Existing form values.
  let formTouched = false;
  if (baseSourceId) formTouched = applyFieldValues(doc, input.fieldValues, baseSourceId) || formTouched;
  for (const id of foreignDocs.keys()) formTouched = applyFieldValues(doc, input.fieldValues, id) || formTouched;

  // 5. Objects.
  const needsFieldFont = objects.some((o) => o.type === 'field') || formTouched;
  const ctx: DrawContext = { doc, fonts: new Map(), fontTexts: collectFontTexts(objects), images: new Map(), opts, fieldFont: null };
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
  for (let i = 0; i < planned.length; i++) {
    const { ref, page, rasterized } = planned[i];
    progress('Applying edits', 0.4 + (i / planned.length) * 0.5);
    const list = byPage.get(ref.id);
    if (!list) continue;
    const rotation: Rotation = rasterized ? 0 : totalRotation(ref);
    const pm = displayToPdfMatrix(rotation, visibleBox(page));
    for (const o of list) {
      switch (o.type) {
        case 'text':
          await drawText(ctx, page, pm, o);
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
        case 'field':
          await addFormField(ctx, page, pm, rotation, o);
          break;
        case 'redact':
          break; // already burned into the raster
      }
    }
  }

  // 6. Form appearances, flattening, metadata.
  const form = doc.getForm();
  if (form.getFields().length > 0) {
    const acro = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
    if (ctx.fieldFont) {
      try {
        form.updateFieldAppearances(ctx.fieldFont);
      } catch {
        /* a field with an odd appearance stream: keep its original look */
      }
    }
    acro?.set(PDFName.of('NeedAppearances'), PDFBool.False);
  }
  if (options.flatten) flattenDocument(doc, ctx.fieldFont);

  if (options.title) doc.setTitle(options.title);
  doc.setProducer('Adika PDF Editor');
  doc.setModificationDate(new Date());
  progress('Writing file', 0.95);
  return doc.save({ useObjectStreams: true });
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
