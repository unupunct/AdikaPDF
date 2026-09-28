/**
 * Page marks: watermark, header & footer (with page and Bates numbers) and
 * background, the Acrobat/Foxit "Edit > Watermark / Header & Footer / Bates
 * numbering / Background" family.
 *
 *  - Every mark is its own content stream appended to (or, for marks behind
 *    the content, prepended to) the page's /Contents, wrapped in
 *    `/Artifact <</Type /Pagination /Subtype /… /AdikaMark true>> BDC … EMC`
 *    and `q … Q`. The stream dictionary also carries `/AdikaMark true`, so
 *    removePageMarks can drop exactly our streams and nothing else.
 *  - Marks are laid out in an upright "visual" frame: the page as the user
 *    sees it (CropBox, /Rotate applied), origin bottom-left, y up. One `cm`
 *    maps that frame to PDF user space, so text stays upright and in the
 *    right corner on rotated and cropped pages.
 *  - Fonts are the bundled Noto TTFs, embedded unsubset with unused glyph
 *    outlines pruned (see fontEmbed.ts), so ă â î ș ț render and extract.
 */
import {
  PDFArray,
  PDFBool,
  PDFContentStream,
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  beginText,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  endText,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setTextMatrix,
  showText,
  type PDFFont,
  type PDFImage,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from './fontEmbed';

export interface MarkFont {
  family: 'sans' | 'serif' | 'mono';
  bold: boolean;
  italic: boolean;
}

export interface WatermarkOptions {
  kind: 'text' | 'image';
  /** May contain Romanian diacritics and any Unicode the font covers. */
  text?: string;
  font?: MarkFont;
  /** Points; default 60. */
  fontSize?: number;
  /** #rrggbb; default grey. */
  color?: string;
  imageBytes?: Uint8Array;
  imageType?: 'png' | 'jpg';
  /** Image width as a fraction of the visible page width; default 0.5. */
  imageScale?: number;
  /** 0..1 */
  opacity: number;
  /** Degrees counter-clockwise as seen on screen (45 = diagonal). */
  rotation: number;
  position: 'center' | 'top' | 'bottom';
  /** true = under the page content, false = on top. */
  behind: boolean;
  /** Distance from the visible edge for position top/bottom; default 36 pt. */
  edgeMargin?: number;
}

export interface HeaderFooterOptions {
  // Six slots; each is text with tokens: {page} {pages} {date} {file} {bates}
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
  font?: MarkFont;
  fontSize: number;
  color: string;
  /** Points from the visible page edge to the text. */
  margins: { top: number; bottom: number; left: number; right: number };
  /** {page} of the first marked page (default 1); counts marked pages. */
  startNumber?: number;
  bates?: { prefix: string; suffix: string; digits: number; start: number };
  /** {date} value, formatted dd.mm.yyyy; default now. */
  date?: Date;
  /** 0..1, default 1. */
  opacity?: number;
}

export interface BackgroundOptions {
  color: string;
  opacity: number;
}

export interface PageMarksOptions {
  /** 1-based page numbers to mark; undefined = all. */
  pages?: number[];
  watermark?: WatermarkOptions;
  headerFooter?: HeaderFooterOptions;
  background?: BackgroundOptions;
  /** {file} */
  fileName?: string;
}

export type LoadFont = (v: MarkFont) => Promise<Uint8Array>;

export interface MarkTokenContext {
  page: number;
  pages: number;
  date: Date;
  file: string;
  bates: string;
}

type MarkSubtype = 'Watermark' | 'Header' | 'Footer' | 'Background';
type Matrix = [number, number, number, number, number, number];

const MARK_KEY = 'AdikaMark';
/** Our q / Q streams around the existing content (removed with the marks). */
const WRAP_KEY = 'AdikaMarkWrap';
const DEFAULT_FONT: MarkFont = { family: 'sans', bold: false, italic: false };
/** Noto cap height (714/1000 em), used to centre text vertically. */
const CAP_HEIGHT = 0.714;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Replaces {page} {pages} {date} {file} {bates}; unknown tokens are kept. */
export function expandMarkTokens(template: string, ctx: MarkTokenContext): string {
  return template.replace(/\{(page|pages|date|file|bates)\}/gi, (_m, name: string) => {
    switch (name.toLowerCase()) {
      case 'page':
        return String(ctx.page);
      case 'pages':
        return String(ctx.pages);
      case 'date':
        return formatDate(ctx.date);
      case 'file':
        return ctx.file;
      default:
        return ctx.bates;
    }
  });
}

export function batesNumber(b: NonNullable<HeaderFooterOptions['bates']>, index: number): string {
  const n = Math.max(0, Math.floor(b.start + index));
  return `${b.prefix}${String(n).padStart(Math.max(0, Math.floor(b.digits)), '0')}${b.suffix}`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface VisualFrame {
  /** Visible width and height as seen on screen. */
  width: number;
  height: number;
  /** Visual (y up, origin bottom-left of what the user sees) -> PDF user space. */
  toPdf: Matrix;
}

function normRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

function visualFrame(page: PDFPage): VisualFrame {
  const { x, y, width: w, height: h } = page.getCropBox();
  // /Rotate turns the page clockwise for display.
  switch (normRotation(page.getRotation().angle)) {
    case 90:
      return { width: h, height: w, toPdf: [0, 1, -1, 0, x + w, y] };
    case 180:
      return { width: w, height: h, toPdf: [-1, 0, 0, -1, x + w, y + h] };
    case 270:
      return { width: h, height: w, toPdf: [0, -1, 1, 0, x, y + h] };
    default:
      return { width: w, height: h, toPdf: [1, 0, 0, 1, x, y] };
  }
}

function rotationMatrix(deg: number, cx: number, cy: number): Matrix {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, s, -s, c, cx, cy];
}

const r3 = (n: number) => +n.toFixed(3);
const cm = (m: Matrix) => concatTransformationMatrix(...(m.map(r3) as Matrix));

function parseColor(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

// ---------------------------------------------------------------------------
// Marked-content streams
// ---------------------------------------------------------------------------

function markStream(doc: PDFDocument, subtype: MarkSubtype, frame: VisualFrame, body: PDFOperator[]): PDFRef {
  const ctx = doc.context;
  const props = ctx.obj({ Type: 'Pagination', Subtype: subtype, [MARK_KEY]: true });
  const ops = [
    // pdf-lib's operand type omits dicts, but they serialise fine inline.
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('Artifact'), props as unknown as PDFName]),
    pushGraphicsState(),
    cm(frame.toPdf),
    ...body,
    popGraphicsState(),
    PDFOperator.of(PDFOperatorNames.EndMarkedContent),
  ];
  return ctx.register(ctx.contentStream(ops, { [MARK_KEY]: true }));
}

function opacityOps(doc: PDFDocument, page: PDFPage, opacity: number): PDFOperator[] {
  const a = clamp01(opacity);
  if (a >= 1) return [];
  const gs = doc.context.obj({ Type: 'ExtGState', CA: a, ca: a });
  return [setGraphicsState(page.node.newExtGState('AdkGS', gs))];
}

/** One text run; `m` is the text matrix in the visual frame (baseline origin). */
function textOps(fontKey: PDFName, font: PDFFont, text: string, size: number, m: Matrix): PDFOperator[] {
  return [
    beginText(),
    setFontAndSize(fontKey, size),
    setTextMatrix(...(m.map(r3) as Matrix)),
    showText(font.encodeText(text)),
    endText(),
  ];
}

/** Drops characters the font cannot draw (they would render as boxes). */
function fitToFont(text: string, supported: Set<number>): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (supported.has(cp)) out += ch;
    else if (/\s/.test(ch)) out += ' ';
  }
  return out;
}

function streamBytes(stream: PDFStream): Uint8Array | undefined {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
  } catch {
    // undecodable filter: treat as foreign content
  }
  return undefined;
}

function streamText(stream: PDFStream): string | undefined {
  const bytes = streamBytes(stream);
  if (!bytes) return undefined;
  // Only the head matters: our streams begin with the BDC properties.
  let s = '';
  for (let i = 0; i < Math.min(bytes.length, 400); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => isWhite(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

/**
 * How many `q` the content leaves open (content that never restores its
 * graphics state). Skips strings, comments and inline image data.
 */
export function openSaveDepth(bytes: Uint8Array): number {
  let depth = 0;
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (isWhite(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; // % comment
    } else if (c === 0x28) {
      // (literal string) with nesting and escapes
      let level = 0;
      for (; i < n; i++) {
        const b = bytes[i];
        if (b === 0x5c) i++;
        else if (b === 0x28) level++;
        else if (b === 0x29 && --level === 0) break;
      }
      i++;
    } else if (c === 0x3c && bytes[i + 1] !== 0x3c) {
      while (i < n && bytes[i] !== 0x3e) i++; // <hex string>
      i++;
    } else {
      const start = i;
      i++;
      // A /Name runs to the next delimiter too, so /q is not an operator.
      if (!isDelim(c) || c === 0x2f) while (i < n && !isDelim(bytes[i])) i++;
      const len = i - start;
      if (len === 1 && c === 0x71) depth++;
      else if (len === 1 && c === 0x51) depth = Math.max(0, depth - 1);
      else if (len === 2 && c === 0x49 && bytes[start + 1] === 0x44) {
        // ID … EI: skip binary inline image data up to a whitespace-delimited EI.
        i++;
        while (i < n && !(bytes[i] === 0x45 && bytes[i + 1] === 0x49 && isWhite(bytes[i - 1]) && (i + 2 >= n || isDelim(bytes[i + 2])))) i++;
        i += 2;
      }
    }
  }
  return depth;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

type StreamKind ='mark' | 'wrap' | 'other';

function classify(doc: PDFDocument, ref: unknown): StreamKind {
  const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  if (!(obj instanceof PDFStream)) return 'other';
  if (obj.dict.get(PDFName.of(MARK_KEY)) === PDFBool.True) return 'mark';
  if (obj.dict.get(PDFName.of(WRAP_KEY)) === PDFBool.True) return 'wrap';
  // Fallback when a tool rewrote the stream dictionaries but kept the content.
  const head = streamText(obj);
  if (head && /^\s*\/Artifact\s*<<[^]*?\/AdikaMark\s+true[^]*?>>\s*BDC/.test(head)) return 'mark';
  return 'other';
}

function contentRefs(doc: PDFDocument, page: PDFPage): unknown[] {
  const contents = page.node.get(PDFName.Contents);
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  if (resolved instanceof PDFArray) return resolved.asArray();
  return contents ? [contents] : [];
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

interface FontSlot {
  variant: MarkFont;
  texts: string[];
  font?: PDFFont;
  supported?: Set<number>;
}

const fontId = (v: MarkFont) => `${v.family}-${v.bold ? 1 : 0}-${v.italic ? 1 : 0}`;

interface PagePlan {
  page: PDFPage;
  index: number;
  hf?: Array<{ slot: (typeof HF_SLOTS)[number]; text: string }>;
}

const HF_SLOTS = ['headerLeft', 'headerCenter', 'headerRight', 'footerLeft', 'footerCenter', 'footerRight'] as const;

export async function addPageMarks(pdfBytes: Uint8Array, opts: PageMarksOptions, loadFont: LoadFont): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();
  const total = pages.length;
  const wanted = opts.pages
    ? [...new Set(opts.pages)].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
    : pages.map((_p, i) => i + 1);
  const { watermark: wm, headerFooter: hf, background: bg } = opts;

  // Expand the header/footer text first so each font only keeps the glyphs it needs.
  const fonts = new Map<string, FontSlot>();
  const fontSlot = (v: MarkFont | undefined) => {
    const variant = v ?? DEFAULT_FONT;
    const id = fontId(variant);
    let s = fonts.get(id);
    if (!s) fonts.set(id, (s = { variant, texts: [] }));
    return s;
  };
  const wmText = wm?.kind === 'text' ? (wm.text ?? '').trim() : '';
  const wmFont = wmText ? fontSlot(wm!.font) : undefined;
  wmFont?.texts.push(wmText);
  const hfFont = hf ? fontSlot(hf.font) : undefined;
  const date = hf?.date ?? new Date();

  const plans: PagePlan[] = wanted.map((n, index) => {
    const plan: PagePlan = { page: pages[n - 1], index };
    if (hf) {
      const ctx: MarkTokenContext = {
        page: (hf.startNumber ?? 1) + index,
        pages: total,
        date,
        file: opts.fileName ?? '',
        bates: hf.bates ? batesNumber(hf.bates, index) : '',
      };
      plan.hf = [];
      for (const slot of HF_SLOTS) {
        const tpl = hf[slot];
        if (!tpl) continue;
        const text = expandMarkTokens(tpl, ctx);
        if (!text.trim()) continue;
        plan.hf.push({ slot, text });
        hfFont!.texts.push(text);
      }
    }
    return plan;
  });

  for (const s of fonts.values()) {
    if (!s.texts.length) continue;
    s.font = await embedFontForText(doc, await loadFont(s.variant), s.texts);
    s.supported = new Set(s.font.getCharacterSet());
  }

  let image: PDFImage | undefined;
  if (wm?.kind === 'image' && wm.imageBytes?.length) {
    const b = wm.imageBytes;
    const isPng = wm.imageType ? wm.imageType === 'png' : b[0] === 0x89 && b[1] === 0x50;
    image = isPng ? await doc.embedPng(b) : await doc.embedJpg(b);
  }

  for (const plan of plans) {
    const { page } = plan;
    const frame = visualFrame(page);
    const under: PDFRef[] = [];
    const over: PDFRef[] = [];

    if (bg) {
      under.push(
        markStream(doc, 'Background', frame, [
          ...opacityOps(doc, page, bg.opacity),
          setFillingRgbColor(...parseColor(bg.color, [1, 1, 1])),
          rectangle(0, 0, r3(frame.width), r3(frame.height)),
          fill(),
        ]),
      );
    }

    const wmOps = wm ? watermarkOps(page, frame, wm, wmText, wmFont, image) : undefined;
    if (wmOps?.length) {
      const ref = markStream(doc, 'Watermark', frame, [...opacityOps(doc, page, wm!.opacity), ...wmOps]);
      (wm!.behind ? under : over).push(ref);
    }

    if (hf && plan.hf?.length && hfFont?.font) {
      const font = hfFont.font;
      const fontKey = page.node.newFontDictionary('AdkF', font.ref);
      const size = hf.fontSize > 0 ? hf.fontSize : 10;
      const ascent = font.heightAtSize(size, { descender: false });
      const color = parseColor(hf.color, [0, 0, 0]);
      const header: PDFOperator[] = [];
      const footer: PDFOperator[] = [];
      for (const { slot, text: raw } of plan.hf) {
        const text = fitToFont(raw, hfFont.supported!);
        if (!text.trim()) continue;
        const w = font.widthOfTextAtSize(text, size);
        const isHeader = slot.startsWith('header');
        const x = slot.endsWith('Left')
          ? hf.margins.left
          : slot.endsWith('Right')
            ? frame.width - hf.margins.right - w
            : (frame.width - w) / 2;
        // Header: text top (font ascent) at the top margin. Footer: baseline at the bottom margin.
        const y = isHeader ? frame.height - hf.margins.top - ascent : hf.margins.bottom;
        (isHeader ? header : footer).push(...textOps(fontKey, font, text, size, [1, 0, 0, 1, x, y]));
      }
      const common = [...opacityOps(doc, page, hf.opacity ?? 1), setFillingRgbColor(...color)];
      if (header.length) over.push(markStream(doc, 'Header', frame, [...common, ...header]));
      if (footer.length) over.push(markStream(doc, 'Footer', frame, [...common, ...footer]));
    }

    if (!under.length && !over.length) continue;
    // normalize() turns /Contents into an array and resolves /Resources.
    page.node.normalize();
    const ctx = doc.context;
    let contents = page.node.Contents();
    if (!(contents instanceof PDFArray)) {
      contents = ctx.obj([]);
      page.node.set(PDFName.Contents, contents);
    }
    if (over.length && contents.size()) {
      // Isolate the existing content so a leaked CTM or colour cannot move ours;
      // extra Q close any q the content itself leaves open.
      let open = 0;
      const all: Uint8Array[] = [];
      for (const r of contents.asArray()) {
        const s = r instanceof PDFRef ? ctx.lookup(r) : r;
        const b = s instanceof PDFStream ? streamBytes(s) : undefined;
        if (b) all.push(b, new Uint8Array([0x0a]));
      }
      if (all.length) open = openSaveDepth(concat(all));
      const start = ctx.register(ctx.contentStream([pushGraphicsState()], { [WRAP_KEY]: true }));
      const pops = Array.from({ length: open + 1 }, () => popGraphicsState());
      const end = ctx.register(ctx.contentStream(pops, { [WRAP_KEY]: true }));
      contents.insert(0, start);
      contents.push(end);
    }
    for (let i = under.length - 1; i >= 0; i--) contents.insert(0, under[i]);
    for (const ref of over) contents.push(ref);
  }

  return doc.save({ useObjectStreams: true });
}

function watermarkOps(
  page: PDFPage,
  frame: VisualFrame,
  wm: WatermarkOptions,
  text: string,
  slot: FontSlot | undefined,
  image: PDFImage | undefined,
): PDFOperator[] | undefined {
  const rot = Number.isFinite(wm.rotation) ? wm.rotation : 0;
  const t = (rot * Math.PI) / 180;
  const edge = wm.edgeMargin ?? 36;
  // Anchor: centre of the rotated mark's bounding box.
  const anchor = (w: number, h: number): [number, number] => {
    const halfH = (w * Math.abs(Math.sin(t)) + h * Math.abs(Math.cos(t))) / 2;
    const cx = frame.width / 2;
    if (wm.position === 'top') return [cx, frame.height - edge - halfH];
    if (wm.position === 'bottom') return [cx, edge + halfH];
    return [cx, frame.height / 2];
  };

  if (wm.kind === 'image') {
    if (!image) return undefined;
    const w = frame.width * (wm.imageScale && wm.imageScale > 0 ? wm.imageScale : 0.5);
    const h = (w * image.height) / image.width;
    const [cx, cy] = anchor(w, h);
    const name = page.node.newXObject('AdkImg', image.ref);
    return [cm(rotationMatrix(rot, cx, cy)), cm([w, 0, 0, h, -w / 2, -h / 2]), drawObject(name)];
  }

  const font = slot?.font;
  if (!font || !text) return undefined;
  const clean = fitToFont(text, slot.supported!);
  if (!clean.trim()) return undefined;
  const size = wm.fontSize && wm.fontSize > 0 ? wm.fontSize : 60;
  const w = font.widthOfTextAtSize(clean, size);
  const [cx, cy] = anchor(w, size * CAP_HEIGHT);
  const fontKey = page.node.newFontDictionary('AdkF', font.ref);
  // Rotate around the anchor, then start the baseline so the text is centred on it.
  const m = rotationMatrix(rot, cx, cy);
  const dx = -w / 2;
  const dy = (-size * CAP_HEIGHT) / 2;
  const tm: Matrix = [m[0], m[1], m[2], m[3], cx + m[0] * dx + m[2] * dy, cy + m[1] * dx + m[3] * dy];
  return [setFillingRgbColor(...parseColor(wm.color, [0.5, 0.5, 0.5])), ...textOps(fontKey, font, clean, size, tm)];
}

// ---------------------------------------------------------------------------
// Removing / detecting
// ---------------------------------------------------------------------------

/** Removes every mark stream added by addPageMarks; returns how many were removed. */
export async function removePageMarks(pdfBytes: Uint8Array): Promise<{ bytes: Uint8Array; removed: number }> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  let removed = 0;
  for (const page of doc.getPages()) {
    const refs = contentRefs(doc, page);
    const kinds = refs.map((r) => classify(doc, r));
    const marks = kinds.filter((k) => k === 'mark').length;
    if (!marks && !kinds.includes('wrap')) continue;
    removed += marks;
    const keep = refs.filter((_r, i) => kinds[i] === 'other') as PDFRef[];
    page.node.set(PDFName.Contents, doc.context.obj(keep));
  }
  if (!removed) return { bytes: pdfBytes, removed: 0 };
  return { bytes: await doc.save({ useObjectStreams: true }), removed };
}

export async function hasPageMarks(pdfBytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  return doc.getPages().some((page) => contentRefs(doc, page).some((r) => classify(doc, r) === 'mark'));
}

/** True when a page dictionary's content includes one of our mark streams. */
export function pageHasMarks(doc: PDFDocument, page: PDFPage): boolean {
  return contentRefs(doc, page).some((r) => classify(doc, r) === 'mark');
}
