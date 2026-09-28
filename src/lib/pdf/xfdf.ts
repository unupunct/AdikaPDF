/**
 * Comments > Import / Export, the way Acrobat and Foxit do it:
 *  - XFDF (ISO 19444-1): <xfdf><annots>…</annots><f href="file.pdf"/></xfdf>
 *  - FDF: a "%FDF-1.2" file whose /Root holds /FDF << /Annots [...] /F (file.pdf) >>,
 *    each annotation dictionary carrying its 0-based /Page.
 *
 * "Comments" are markup annotations (sticky notes, free text, text markup,
 * shapes, lines, ink, stamps, carets, file attachments) with their popup and
 * in-reply-to (IRT) relationships. Links, form widgets and stand-alone popups
 * are never exported or imported.
 *
 * Both formats go through one neutral model (CommentRecord):
 *   PDF → records → XFDF / FDF        (export)
 *   XFDF / FDF → records → PDF        (import)
 * Imported annotations are real PDF annotations with their own appearance
 * stream (/AP /N), so they render in viewers that do not build appearances.
 * An annotation is skipped when its page does not exist, when the page already
 * has one with the same /NM (or, lacking /NM, the same type, rect and text), or
 * when it cannot be rebuilt (file attachments: the file itself is not carried).
 *
 * Browser-compatible: only pdf-lib and plain strings/typed arrays, no DOM or Node APIs.
 */
import {
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFPage,
  PDFParser,
  PDFRef,
  PDFString,
  PDFWriter,
  StandardFonts,
  appendBezierCurve,
  beginText,
  clip,
  closePath,
  endPath,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveText,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setDashPattern,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
  type PDFOperator,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from './fontEmbed';
import { hexToRgbTuple, pdfDate } from './annotations';

export interface CommentExportOptions {
  /** Name of the PDF the comments belong to; written as <f href="..."/> (XFDF) or /F (FDF). */
  fileName: string;
}

export interface CommentImportResult {
  bytes: Uint8Array;
  /** Annotations created (popups not counted). */
  added: number;
  /** Annotations not imported: page out of range, duplicate, unsupported or malformed. */
  skipped: number;
}

type RGB = [number, number, number];
type Rect = [number, number, number, number];

export type CommentSubtype =
  | 'Text'
  | 'FreeText'
  | 'Highlight'
  | 'Underline'
  | 'StrikeOut'
  | 'Squiggly'
  | 'Square'
  | 'Circle'
  | 'Line'
  | 'Polygon'
  | 'PolyLine'
  | 'Ink'
  | 'Stamp'
  | 'Caret'
  | 'FileAttachment';

/** One comment, independent of PDF / XFDF / FDF syntax. Coordinates are PDF user space of its page. */
export interface CommentRecord {
  subtype: CommentSubtype;
  /** 0-based page index. */
  page: number;
  rect: Rect;
  color?: RGB;
  interiorColor?: RGB;
  /** Author (/T). */
  title?: string;
  subject?: string;
  /** Unique name (/NM). */
  name?: string;
  /** Modification date (/M), PDF date format. */
  date?: string;
  creationDate?: string;
  flags?: number;
  opacity?: number;
  width?: number;
  /** /BS /S: S (solid), D (dashed), B, I, U. */
  borderStyle?: string;
  dashes?: number[];
  contents?: string;
  /** Rich text (/RC), an XHTML fragment. */
  richText?: string;
  /** /Name: note icon, stamp name or attachment icon. */
  icon?: string;
  intent?: string;
  state?: string;
  stateModel?: string;
  quadPoints?: number[];
  vertices?: number[];
  /** Line /L: x1 y1 x2 y2. */
  line?: [number, number, number, number];
  lineEndings?: [string, string];
  inkList?: number[][];
  /** FreeText default appearance (/DA) and default style (/DS). */
  da?: string;
  ds?: string;
  /** FreeText /Q: 0 left, 1 centred, 2 right. */
  justification?: number;
  /** Caret /Sy. */
  symbol?: string;
  /** /NM of the annotation this one replies to. */
  inReplyTo?: string;
  replyType?: 'R' | 'Group';
  popup?: { rect: Rect; open: boolean; flags?: number };
  /** FileAttachment: file name (metadata only). */
  fileName?: string;
}

const XFDF_NAME: Record<CommentSubtype, string> = {
  Text: 'text',
  FreeText: 'freetext',
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
  Square: 'square',
  Circle: 'circle',
  Line: 'line',
  Polygon: 'polygon',
  PolyLine: 'polyline',
  Ink: 'ink',
  Stamp: 'stamp',
  Caret: 'caret',
  FileAttachment: 'fileattachment',
};
const SUBTYPE_BY_XFDF = new Map(Object.entries(XFDF_NAME).map(([k, v]) => [v, k as CommentSubtype]));
const COMMENT_SUBTYPES = new Set<string>(Object.keys(XFDF_NAME));
const TEXT_MARKUP = new Set<CommentSubtype>(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

const FLAG_NAMES: [number, string][] = [
  [1, 'invisible'],
  [2, 'hidden'],
  [4, 'print'],
  [8, 'nozoom'],
  [16, 'norotate'],
  [32, 'noview'],
  [64, 'readonly'],
  [128, 'locked'],
  [256, 'togglenoview'],
  [512, 'lockedcontents'],
];

const BORDER_STYLE: Record<string, string> = { S: 'solid', D: 'dash', B: 'bevelled', I: 'inset', U: 'underline' };
const BORDER_STYLE_BY_XFDF = new Map(Object.entries(BORDER_STYLE).map(([k, v]) => [v, k]));

// ------------------------------------------------------------------ small helpers

const N = (s: string) => PDFName.of(s);

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
}

function numList(s: string | undefined): number[] {
  if (!s) return [];
  return s
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function normRect(r: number[]): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function parseColor(s: string | undefined): RGB | undefined {
  if (!s || !/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s.trim())) return undefined;
  return hexToRgbTuple(s.trim());
}

/** /C or /IC array → RGB (gray, RGB and CMYK accepted; empty = transparent). */
function colorFromArray(a: number[] | undefined): RGB | undefined {
  if (!a) return undefined;
  if (a.length === 1) return [a[0], a[0], a[0]];
  if (a.length === 3) return [a[0], a[1], a[2]];
  if (a.length === 4) return [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])];
  return undefined;
}

function isPdfDate(s: string | undefined): s is string {
  return !!s && /^(D:)?\d{4}/.test(s);
}

function textObj(s: string): PDFHexString {
  return PDFHexString.fromText(s);
}

// ------------------------------------------------------------------ PDF / FDF dictionary → record

function lookupStr(d: PDFDict, key: string): string | undefined {
  const v = d.lookup(N(key));
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  if (v instanceof PDFName) return v.decodeText();
  return undefined;
}

function lookupNum(d: PDFDict, key: string): number | undefined {
  const v = d.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function lookupNums(d: PDFDict, key: string): number[] | undefined {
  const v = d.lookup(N(key));
  return v instanceof PDFArray ? arrayNums(d.context, v) : undefined;
}

function arrayNums(ctx: PDFContext, a: PDFArray): number[] {
  const out: number[] = [];
  for (const x of a.asArray()) {
    const o = ctx.lookup(x);
    if (o instanceof PDFNumber) out.push(o.asNumber());
  }
  return out;
}

function lookupBool(d: PDFDict, key: string): boolean | undefined {
  const v = d.lookup(N(key));
  return v instanceof PDFBool ? v.asBoolean() : undefined;
}

type NameOf = (d: PDFDict) => string | undefined;

/** Reads one annotation dictionary. Returns null for non-comments (Link, Widget, Popup, …). */
function readAnnot(d: PDFDict, page: number, nameOf: NameOf): CommentRecord | null {
  const subtype = lookupStr(d, 'Subtype');
  if (!subtype || !COMMENT_SUBTYPES.has(subtype)) return null;
  const rectNums = lookupNums(d, 'Rect');
  if (!rectNums || rectNums.length < 4) return null;
  const rec: CommentRecord = { subtype: subtype as CommentSubtype, page, rect: normRect(rectNums) };
  rec.color = colorFromArray(lookupNums(d, 'C'));
  rec.interiorColor = colorFromArray(lookupNums(d, 'IC'));
  rec.title = lookupStr(d, 'T');
  rec.subject = lookupStr(d, 'Subj');
  rec.name = nameOf(d);
  rec.date = lookupStr(d, 'M');
  rec.creationDate = lookupStr(d, 'CreationDate');
  rec.flags = lookupNum(d, 'F');
  rec.opacity = lookupNum(d, 'CA');
  rec.contents = lookupStr(d, 'Contents');
  rec.richText = lookupStr(d, 'RC');
  rec.icon = lookupStr(d, 'Name');
  rec.intent = lookupStr(d, 'IT');
  rec.state = lookupStr(d, 'State');
  rec.stateModel = lookupStr(d, 'StateModel');
  const bs = d.lookup(N('BS'));
  if (bs instanceof PDFDict) {
    rec.width = lookupNum(bs, 'W');
    rec.borderStyle = lookupStr(bs, 'S');
    rec.dashes = lookupNums(bs, 'D');
  } else {
    const border = lookupNums(d, 'Border');
    if (border && border.length >= 3) rec.width = border[2];
  }
  if (TEXT_MARKUP.has(rec.subtype)) rec.quadPoints = lookupNums(d, 'QuadPoints');
  if (rec.subtype === 'Polygon' || rec.subtype === 'PolyLine') rec.vertices = lookupNums(d, 'Vertices');
  if (rec.subtype === 'Line') {
    const l = lookupNums(d, 'L');
    if (l && l.length >= 4) rec.line = [l[0], l[1], l[2], l[3]];
  }
  if (rec.subtype === 'Line' || rec.subtype === 'PolyLine') {
    const le = d.lookup(N('LE'));
    if (le instanceof PDFArray && le.size() >= 2) {
      const names = le.asArray().map((x) => d.context.lookup(x));
      rec.lineEndings = names.map((x) => (x instanceof PDFName ? x.decodeText() : 'None')).slice(0, 2) as [string, string];
    }
  }
  if (rec.subtype === 'Ink') {
    const ink = d.lookup(N('InkList'));
    if (ink instanceof PDFArray) {
      rec.inkList = ink
        .asArray()
        .map((x) => d.context.lookup(x))
        .filter((x): x is PDFArray => x instanceof PDFArray)
        .map((a) => arrayNums(d.context, a));
    }
  }
  if (rec.subtype === 'FreeText') {
    rec.da = lookupStr(d, 'DA');
    rec.ds = lookupStr(d, 'DS');
    rec.justification = lookupNum(d, 'Q');
  }
  if (rec.subtype === 'Caret') rec.symbol = lookupStr(d, 'Sy');
  if (rec.subtype === 'FileAttachment') {
    const fs = d.lookup(N('FS'));
    if (fs instanceof PDFDict) rec.fileName = lookupStr(fs, 'UF') ?? lookupStr(fs, 'F');
    else if (fs instanceof PDFString || fs instanceof PDFHexString) rec.fileName = fs.decodeText();
  }
  const irt = d.lookup(N('IRT'));
  if (irt instanceof PDFDict) {
    rec.inReplyTo = nameOf(irt);
    rec.replyType = lookupStr(d, 'RT') === 'Group' ? 'Group' : 'R';
  }
  const popup = d.lookup(N('Popup'));
  if (popup instanceof PDFDict) {
    const pr = lookupNums(popup, 'Rect');
    if (pr && pr.length >= 4) rec.popup = { rect: normRect(pr), open: lookupBool(popup, 'Open') ?? false, flags: lookupNum(popup, 'F') };
  }
  return rec;
}

/** /NM of a dictionary; dictionaries without one get a stable generated name so replies can refer to them. */
function makeNameOf(ctx: PDFContext): NameOf {
  const generated = new Map<PDFDict, string>();
  const refOf = new Map<PDFDict, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (obj instanceof PDFDict) refOf.set(obj, ref);
  return (d) => {
    const nm = lookupStr(d, 'NM');
    if (nm) return nm;
    let g = generated.get(d);
    if (!g) {
      const ref = refOf.get(d);
      g = ref ? `adika-obj-${ref.objectNumber}-${ref.generationNumber}` : `adika-annot-${generated.size + 1}`;
      generated.set(d, g);
    }
    return g;
  };
}

async function loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(pdfBytes, { updateMetadata: false });
}

function pageAnnotDicts(page: PDFPage): PDFDict[] {
  const annots = page.node.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return [];
  return annots
    .asArray()
    .map((x) => page.node.context.lookup(x))
    .filter((x): x is PDFDict => x instanceof PDFDict);
}

/** Every comment in the document, page by page, in /Annots order. */
export async function readComments(pdfBytes: Uint8Array): Promise<CommentRecord[]> {
  const doc = await loadPdf(pdfBytes);
  const nameOf = makeNameOf(doc.context);
  const out: CommentRecord[] = [];
  doc.getPages().forEach((page, i) => {
    for (const d of pageAnnotDicts(page)) {
      const rec = readAnnot(d, i, nameOf);
      if (rec) out.push(rec);
    }
  });
  return out;
}

export async function countComments(pdfBytes: Uint8Array): Promise<number> {
  const doc = await loadPdf(pdfBytes);
  let n = 0;
  for (const page of doc.getPages()) {
    for (const d of pageAnnotDicts(page)) {
      const st = lookupStr(d, 'Subtype');
      if (st && COMMENT_SUBTYPES.has(st)) n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ minimal XML reader

interface XmlElement {
  /** Local name, lower-case. */
  name: string;
  /** Attributes by lower-case local name. */
  attrs: Record<string, string>;
  children: (XmlElement | string)[];
  /** Inner XML as written in the source. */
  raw: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

const localName = (s: string) => s.slice(s.lastIndexOf(':') + 1).toLowerCase();

function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], raw: src };
  const stack: { el: XmlElement; qname: string; start: number }[] = [{ el: root, qname: '', start: 0 }];
  const top = () => stack[stack.length - 1].el;
  const until = (from: number, token: string) => {
    const e = src.indexOf(token, from);
    if (e < 0) throw new Error('XFDF: unexpected end of file');
    return e;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().children.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      i = until(lt + 4, '-->') + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = until(lt + 9, ']]>');
      top().children.push(src.slice(lt + 9, e));
      i = e + 3;
    } else if (src.startsWith('<?', lt)) {
      i = until(lt + 2, '?>') + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...]
      let depth = 0;
      let j = lt + 2;
      for (; j < src.length; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const gt = until(lt, '>');
      const qname = src.slice(lt + 2, gt).trim();
      const cur = stack[stack.length - 1];
      if (stack.length === 1 || cur.qname !== qname) throw new Error(`XFDF: unexpected </${qname}>`);
      cur.el.raw = src.slice(cur.start, lt);
      stack.pop();
      i = gt + 1;
    } else {
      // Start tag: scan to '>' outside quotes.
      let j = lt + 1;
      let quote = '';
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= src.length) throw new Error('XFDF: unterminated tag');
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^[^\s/>]+/.exec(body);
      if (!m) throw new Error('XFDF: malformed tag');
      const qname = m[0];
      const attrs: Record<string, string> = {};
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      const rest = body.slice(qname.length);
      while ((a = re.exec(rest))) attrs[localName(a[1])] = decodeEntities((a[2] ?? a[3] ?? '').replace(/[\t\n\r]/g, ' '));
      const el: XmlElement = { name: localName(qname), attrs, children: [], raw: '' };
      top().children.push(el);
      if (!selfClosing) stack.push({ el, qname, start: j + 1 });
      i = j + 1;
    }
  }
  if (stack.length > 1) throw new Error(`XFDF: <${stack[stack.length - 1].qname}> is not closed`);
  return root;
}

const childEls = (e: XmlElement, name?: string) =>
  e.children.filter((c): c is XmlElement => typeof c !== 'string' && (!name || c.name === name));

function textOf(e: XmlElement): string {
  return e.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

// ------------------------------------------------------------------ XFDF writer / reader

function escXml(s: string, attr: boolean): string {
  // Characters XML 1.0 cannot carry are dropped.
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
  if (attr) out = out.replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
  return out;
}

function flagsToNames(f: number): string {
  return FLAG_NAMES.filter(([bit]) => f & bit)
    .map(([, n]) => n)
    .join(',');
}

function namesToFlags(s: string): number {
  if (/^\d+$/.test(s.trim())) return parseInt(s, 10);
  const names = new Set(s.toLowerCase().split(/[\s,]+/));
  return FLAG_NAMES.reduce((acc, [bit, n]) => (names.has(n) ? acc | bit : acc), 0);
}

function pairs(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(`${fmt(nums[i])},${fmt(nums[i + 1])}`);
  return out.join(';');
}

/** Rich text as an embeddable XML fragment, or null if it is not well-formed. */
function richTextFragment(rc: string): string | null {
  const s = rc.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/i, '').trim();
  if (!s.startsWith('<')) return null;
  try {
    parseXml(s);
    return s;
  } catch {
    return null;
  }
}

function recordToXfdf(r: CommentRecord): string {
  const attrs: [string, string | undefined][] = [
    ['page', String(r.page)],
    ['rect', r.rect.map(fmt).join(',')],
    ['color', r.color && rgbToHex(r.color)],
    ['interior-color', r.interiorColor && rgbToHex(r.interiorColor)],
    ['title', r.title],
    ['subject', r.subject],
    ['name', r.name],
    ['date', r.date],
    ['creationdate', r.creationDate],
    ['flags', r.flags !== undefined ? flagsToNames(r.flags) : undefined],
    ['opacity', r.opacity !== undefined ? fmt(r.opacity) : undefined],
    ['width', r.width !== undefined ? fmt(r.width) : undefined],
    ['style', r.borderStyle ? BORDER_STYLE[r.borderStyle] : undefined],
    ['dashes', r.dashes?.length ? r.dashes.map(fmt).join(',') : undefined],
    ['intent', r.intent],
    ['inreplyto', r.inReplyTo],
    ['replyType', r.inReplyTo ? (r.replyType === 'Group' ? 'group' : 'reply') : undefined],
  ];
  if (r.subtype === 'Text' || r.subtype === 'Stamp' || r.subtype === 'FileAttachment') attrs.push(['icon', r.icon]);
  if (r.subtype === 'Text') attrs.push(['state', r.state], ['statemodel', r.stateModel]);
  if (r.quadPoints?.length) attrs.push(['coords', r.quadPoints.map(fmt).join(',')]);
  if (r.line) attrs.push(['start', `${fmt(r.line[0])},${fmt(r.line[1])}`], ['end', `${fmt(r.line[2])},${fmt(r.line[3])}`]);
  if (r.lineEndings) attrs.push(['head', r.lineEndings[0]], ['tail', r.lineEndings[1]]);
  if (r.subtype === 'FreeText' && r.justification !== undefined) attrs.push(['justification', ['left', 'centered', 'right'][r.justification] ?? 'left']);
  if (r.subtype === 'Caret') attrs.push(['symbol', r.symbol === 'P' ? 'paragraph' : r.symbol ? 'none' : undefined]);
  if (r.subtype === 'FileAttachment') attrs.push(['file', r.fileName]);

  const children: string[] = [];
  if (r.contents) children.push(`<contents>${escXml(r.contents, false)}</contents>`);
  const rich = r.richText ? richTextFragment(r.richText) : null;
  if (rich) children.push(`<contents-richtext>${rich}</contents-richtext>`);
  if (r.subtype === 'FreeText') {
    if (r.da) children.push(`<defaultappearance>${escXml(r.da, false)}</defaultappearance>`);
    if (r.ds) children.push(`<defaultstyle>${escXml(r.ds, false)}</defaultstyle>`);
  }
  if (r.vertices?.length) children.push(`<vertices>${pairs(r.vertices)}</vertices>`);
  if (r.inkList?.length) children.push(`<inklist>${r.inkList.map((g) => `<gesture>${pairs(g)}</gesture>`).join('')}</inklist>`);
  if (r.popup) {
    const p = r.popup;
    const pf = p.flags !== undefined ? ` flags="${flagsToNames(p.flags)}"` : '';
    children.push(`<popup page="${r.page}" rect="${p.rect.map(fmt).join(',')}" open="${p.open ? 'yes' : 'no'}"${pf}/>`);
  }
  const attrText = attrs
    .filter((a): a is [string, string] => a[1] !== undefined && a[1] !== '')
    .map(([k, v]) => ` ${k}="${escXml(v, true)}"`)
    .join('');
  const tag = XFDF_NAME[r.subtype];
  return children.length ? `<${tag}${attrText}>${children.join('')}</${tag}>` : `<${tag}${attrText}/>`;
}

export function buildXfdf(records: CommentRecord[], fileName: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
    '<annots>',
    ...records.map(recordToXfdf),
    '</annots>',
    `<f href="${escXml(fileName, true)}"/>`,
    '</xfdf>',
    '',
  ];
  return lines.join('\n');
}

function xfdfToRecord(e: XmlElement): CommentRecord | null {
  const subtype = SUBTYPE_BY_XFDF.get(e.name);
  if (!subtype) return null;
  const a = e.attrs;
  const rectNums = numList(a.rect);
  const page = parseInt(a.page ?? '0', 10);
  if (rectNums.length < 4 || !Number.isFinite(page)) return null;
  const rec: CommentRecord = { subtype, page, rect: normRect(rectNums) };
  rec.color = parseColor(a.color);
  rec.interiorColor = parseColor(a['interior-color']);
  rec.title = a.title;
  rec.subject = a.subject;
  rec.name = a.name;
  rec.date = a.date;
  rec.creationDate = a.creationdate;
  if (a.flags !== undefined) rec.flags = namesToFlags(a.flags);
  const num = (s: string | undefined) => (s !== undefined && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);
  rec.opacity = num(a.opacity);
  rec.width = num(a.width);
  if (a.style) rec.borderStyle = BORDER_STYLE_BY_XFDF.get(a.style.toLowerCase());
  if (a.dashes) rec.dashes = numList(a.dashes);
  rec.intent = a.intent;
  if (a.inreplyto) {
    rec.inReplyTo = a.inreplyto;
    rec.replyType = a.replytype?.toLowerCase() === 'group' ? 'Group' : 'R';
  }
  rec.icon = a.icon;
  rec.state = a.state;
  rec.stateModel = a.statemodel;
  if (TEXT_MARKUP.has(subtype)) rec.quadPoints = numList(a.coords);
  if (subtype === 'Line') {
    const s = numList(a.start);
    const en = numList(a.end);
    if (s.length >= 2 && en.length >= 2) rec.line = [s[0], s[1], en[0], en[1]];
  }
  if ((subtype === 'Line' || subtype === 'PolyLine') && (a.head || a.tail)) rec.lineEndings = [a.head ?? 'None', a.tail ?? 'None'];
  if (subtype === 'FreeText') {
    const j = (a.justification ?? '').toLowerCase();
    if (j) rec.justification = j === 'centered' || j === 'center' ? 1 : j === 'right' ? 2 : 0;
  }
  if (subtype === 'Caret' && a.symbol) rec.symbol = a.symbol.toLowerCase() === 'paragraph' ? 'P' : 'None';
  if (subtype === 'FileAttachment') rec.fileName = a.file;
  for (const c of childEls(e)) {
    if (c.name === 'contents') rec.contents = textOf(c);
    else if (c.name === 'contents-richtext') rec.richText = c.raw.trim();
    else if (c.name === 'defaultappearance') rec.da = textOf(c).trim();
    else if (c.name === 'defaultstyle') rec.ds = textOf(c).trim();
    else if (c.name === 'vertices') rec.vertices = numList(textOf(c));
    else if (c.name === 'inklist') rec.inkList = childEls(c, 'gesture').map((g) => numList(textOf(g)));
    else if (c.name === 'popup') {
      const pr = numList(c.attrs.rect);
      if (pr.length >= 4) {
        rec.popup = {
          rect: normRect(pr),
          open: (c.attrs.open ?? '').toLowerCase() === 'yes' || c.attrs.open === 'true',
          flags: c.attrs.flags !== undefined ? namesToFlags(c.attrs.flags) : undefined,
        };
      }
    }
  }
  if (!rec.vertices && a.vertices) rec.vertices = numList(a.vertices);
  return rec;
}

/** Parses XFDF. `invalid` counts annotation elements that are not comments this engine can take. */
export function parseXfdf(xfdf: string): { records: CommentRecord[]; invalid: number } {
  const doc = parseXml(xfdf.replace(/^﻿/, ''));
  const root = childEls(doc, 'xfdf')[0];
  if (!root) throw new Error('Not an XFDF file (no <xfdf> element).');
  const records: CommentRecord[] = [];
  let invalid = 0;
  for (const annots of childEls(root, 'annots')) {
    for (const e of childEls(annots)) {
      if (e.name === 'popup') continue; // popups ride along with their parent
      const rec = xfdfToRecord(e);
      if (rec) records.push(rec);
      else invalid++;
    }
  }
  return { records, invalid };
}

// ------------------------------------------------------------------ record → annotation dictionary

/** The syntax-level dictionary shared by FDF export and PDF import (no /P, /Page, /AP, /Popup, /IRT). */
function recordToDict(ctx: PDFContext, r: CommentRecord): PDFDict {
  const d = ctx.obj({ Type: 'Annot', Subtype: r.subtype, Rect: r.rect }) as PDFDict;
  const set = (k: string, v: PDFObject | undefined) => {
    if (v !== undefined) d.set(N(k), v);
  };
  const str = (s: string | undefined) => (s ? textObj(s) : undefined);
  const date = (s: string | undefined) => (isPdfDate(s) ? PDFString.of(s.replace(/[()\\]/g, '')) : undefined);
  set('Contents', str(r.contents));
  set('T', str(r.title));
  set('Subj', str(r.subject));
  set('NM', str(r.name));
  set('M', date(r.date));
  set('CreationDate', date(r.creationDate));
  set('F', r.flags !== undefined ? PDFNumber.of(r.flags) : undefined);
  set('C', r.color ? ctx.obj(r.color) : undefined);
  set('IC', r.interiorColor ? ctx.obj(r.interiorColor) : undefined);
  set('CA', r.opacity !== undefined ? PDFNumber.of(r.opacity) : undefined);
  set('RC', str(r.richText));
  set('Name', r.icon ? N(r.icon) : undefined);
  set('IT', r.intent ? N(r.intent) : undefined);
  set('State', str(r.state));
  set('StateModel', str(r.stateModel));
  if (r.width !== undefined || r.borderStyle || r.dashes?.length) {
    const bs = ctx.obj({ Type: 'Border' }) as PDFDict;
    if (r.width !== undefined) bs.set(N('W'), PDFNumber.of(r.width));
    if (r.borderStyle) bs.set(N('S'), N(r.borderStyle));
    if (r.dashes?.length) bs.set(N('D'), ctx.obj(r.dashes));
    d.set(N('BS'), bs);
  }
  if (r.quadPoints?.length) set('QuadPoints', ctx.obj(r.quadPoints));
  if (r.vertices?.length) set('Vertices', ctx.obj(r.vertices));
  if (r.line) set('L', ctx.obj(r.line));
  if (r.lineEndings) set('LE', ctx.obj(r.lineEndings.map((n) => N(n))));
  if (r.inkList?.length) set('InkList', ctx.obj(r.inkList));
  if (r.subtype === 'FreeText') {
    set('DA', PDFString.of((r.da ?? '0 0 0 rg /Helv 12 Tf').replace(/[()\\]/g, '')));
    set('DS', str(r.ds));
    set('Q', r.justification !== undefined ? PDFNumber.of(r.justification) : undefined);
  }
  if (r.subtype === 'Caret' && r.symbol) set('Sy', N(r.symbol));
  if (r.subtype === 'FileAttachment' && r.fileName) set('FS', ctx.obj({ Type: 'Filespec', F: textObj(r.fileName), UF: textObj(r.fileName) }));
  return d;
}

function popupDict(ctx: PDFContext, r: CommentRecord): PDFDict {
  const rect = r.popup?.rect ?? [r.rect[2], r.rect[3] - 110, r.rect[2] + 200, r.rect[3]];
  return ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: rect, Open: r.popup?.open ?? false, F: r.popup?.flags ?? 28 }) as PDFDict;
}

// ------------------------------------------------------------------ appearance streams

interface Fonts {
  regular(): Promise<PDFFont>;
  bold(): Promise<PDFFont>;
}

interface Appearance {
  ops: PDFOperator[];
  bbox: Rect;
  resources?: Record<string, unknown>;
}

const KAPPA = 0.5522847498;

function gsRef(doc: PDFDocument, opacity: number, blend: 'Normal' | 'Multiply' = 'Normal'): PDFRef {
  return doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity, BM: blend }));
}

/** Speech-bubble note icon in a 20×20 box, as annotations.ts draws it. */
function noteIconOps(color: RGB): PDFOperator[] {
  const outline = [moveTo(2, 18), lineTo(18, 18), lineTo(18, 6), lineTo(9, 6), lineTo(5, 2), lineTo(5, 6), lineTo(2, 6), closePath()];
  return [
    pushGraphicsState(),
    setFillingRgbColor(...color),
    setStrokingRgbColor(0.25, 0.25, 0.25),
    setLineWidth(0.8),
    ...outline,
    fillAndStroke(),
    setStrokingRgbColor(0.2, 0.2, 0.2),
    setLineWidth(1),
    moveTo(5, 14),
    lineTo(15, 14),
    stroke(),
    moveTo(5, 10),
    lineTo(13, 10),
    stroke(),
    popGraphicsState(),
  ];
}

function ellipseOps(cx: number, cy: number, rx: number, ry: number): PDFOperator[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
    closePath(),
  ];
}

function polyOps(pts: number[], close: boolean): PDFOperator[] {
  const ops: PDFOperator[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) ops.push(i === 0 ? moveTo(pts[0], pts[1]) : lineTo(pts[i], pts[i + 1]));
  if (close && ops.length) ops.push(closePath());
  return ops;
}

/** Arrow head at (x, y) pointing away from (fx, fy). */
function lineEndingOps(kind: string, x: number, y: number, fx: number, fy: number, w: number): PDFOperator[] {
  const len = Math.hypot(x - fx, y - fy) || 1;
  const ux = (x - fx) / len;
  const uy = (y - fy) / len;
  const s = Math.max(6, w * 4);
  const bx = x - ux * s;
  const by = y - uy * s;
  const px = -uy * s * 0.5;
  const py = ux * s * 0.5;
  if (kind === 'OpenArrow') return [moveTo(bx + px, by + py), lineTo(x, y), lineTo(bx - px, by - py), stroke()];
  if (kind === 'ClosedArrow') return [moveTo(bx + px, by + py), lineTo(x, y), lineTo(bx - px, by - py), closePath(), fillAndStroke()];
  if (kind === 'Circle') return [...ellipseOps(x, y, s / 3, s / 3), fillAndStroke()];
  if (kind === 'Square') return [rectangle(x - s / 3, y - s / 3, (s * 2) / 3, (s * 2) / 3), fillAndStroke()];
  if (kind === 'Butt') return [moveTo(x + px, y + py), lineTo(x - px, y - py), stroke()];
  return [];
}

/** Helvetica can only show WinAnsi; others fall back to their base letter (ș → s) or '?'. */
function fontSafe(font: PDFFont, s: string): string {
  const supported = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (supported.has(cp)) out += ch;
    else if (/\s/.test(ch)) out += ' ';
    else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += base && [...base].every((c) => supported.has(c.codePointAt(0)!)) ? base : '?';
    }
  }
  return out;
}

function wrapLines(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    const words = fontSafe(font, para).split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line && font.widthOfTextAtSize(next.trimEnd(), size) > maxWidth) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function parseDa(da: string | undefined, ds: string | undefined): { size: number; color: RGB } {
  let size = 12;
  let color: RGB = [0, 0, 0];
  const tf = da && /([\d.]+)\s+Tf/.exec(da);
  if (tf && Number(tf[1]) > 0) size = Number(tf[1]);
  const rg = da && /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const g = da && /([\d.]+)\s+g(?![a-z])/.exec(da);
  if (rg) color = [Number(rg[1]), Number(rg[2]), Number(rg[3])];
  else if (g) color = [Number(g[1]), Number(g[1]), Number(g[1])];
  else if (ds) {
    const c = /color\s*:\s*(#[0-9a-f]{3,6})/i.exec(ds);
    if (c) color = hexToRgbTuple(c[1]);
  }
  if (!tf && ds) {
    const fs = /(?:font-size\s*:\s*|font\s*:[^;]*?)([\d.]+)pt/i.exec(ds);
    if (fs && Number(fs[1]) > 0) size = Number(fs[1]);
  }
  return { size, color };
}

async function buildAppearance(doc: PDFDocument, r: CommentRecord, fonts: Fonts): Promise<Appearance | null> {
  const [x1, y1, x2, y2] = r.rect;
  const W = x2 - x1;
  const H = y2 - y1;
  const color: RGB = r.color ?? (r.subtype === 'Highlight' ? [1, 1, 0] : r.subtype === 'Stamp' ? [0.8, 0.1, 0.1] : [0, 0, 0]);
  const w = r.width ?? 1;
  const opacity = r.opacity ?? 1;
  const ops: PDFOperator[] = [pushGraphicsState()];
  const resources: Record<string, unknown> = {};
  const bbox: Rect = [x1, y1, x2, y2];
  if (r.subtype === 'Highlight') {
    resources.ExtGState = { GS0: gsRef(doc, 0.4 * opacity, 'Multiply') };
  } else if (opacity < 1) {
    resources.ExtGState = { GS0: gsRef(doc, opacity) };
  }
  if (resources.ExtGState) ops.push(setGraphicsState(N('GS0')));
  const strokeSetup = () => {
    ops.push(setStrokingRgbColor(...color), setLineWidth(w), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
    if (r.borderStyle === 'D') ops.push(setDashPattern(r.dashes?.length ? r.dashes : [3], 0));
  };
  const drawPath = (path: PDFOperator[]) => {
    if (r.interiorColor) ops.push(setFillingRgbColor(...r.interiorColor), ...path, w > 0 ? fillAndStroke() : fill());
    else if (w > 0) ops.push(...path, stroke());
  };

  switch (r.subtype) {
    case 'Text':
      return { ops: noteIconOps(color), bbox: [0, 0, 20, 20], resources: undefined };
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const q = r.quadPoints ?? [];
      if (q.length < 8) return null;
      if (r.subtype === 'Highlight') ops.push(setFillingRgbColor(...color));
      else ops.push(setStrokingRgbColor(...color));
      for (let i = 0; i + 7 < q.length; i += 8) {
        // QuadPoints order (reader convention): TL, TR, BL, BR.
        const tl = [q[i], q[i + 1]];
        const tr = [q[i + 2], q[i + 3]];
        const bl = [q[i + 4], q[i + 5]];
        const br = [q[i + 6], q[i + 7]];
        const h = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
        const at = (fx: number, fy: number): [number, number] => {
          // fx along the line, fy up from the bottom edge.
          const lx = bl[0] + (tl[0] - bl[0]) * fy;
          const ly = bl[1] + (tl[1] - bl[1]) * fy;
          const rx = br[0] + (tr[0] - br[0]) * fy;
          const ry = br[1] + (tr[1] - br[1]) * fy;
          return [lx + (rx - lx) * fx, ly + (ry - ly) * fx];
        };
        const thick = Math.max(0.6, h * 0.07);
        if (r.subtype === 'Highlight') {
          ops.push(moveTo(tl[0], tl[1]), lineTo(tr[0], tr[1]), lineTo(br[0], br[1]), lineTo(bl[0], bl[1]), closePath(), fill());
        } else if (r.subtype === 'Underline' || r.subtype === 'StrikeOut') {
          const fy = r.subtype === 'Underline' ? 0.07 : 0.45;
          ops.push(setLineWidth(thick), moveTo(...at(0, fy)), lineTo(...at(1, fy)), stroke());
        } else {
          const len = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
          const waves = Math.max(2, Math.round(len / Math.max(2, h * 0.25)));
          ops.push(setLineWidth(thick), moveTo(...at(0, 0.03)));
          for (let k = 1; k <= waves; k++) ops.push(lineTo(...at(k / waves, k % 2 ? 0.14 : 0.03)));
          ops.push(stroke());
        }
      }
      // Quads may poke outside a tight /Rect; grow the box to cover them.
      for (let i = 0; i + 1 < q.length; i += 2) {
        bbox[0] = Math.min(bbox[0], q[i]);
        bbox[1] = Math.min(bbox[1], q[i + 1]);
        bbox[2] = Math.max(bbox[2], q[i]);
        bbox[3] = Math.max(bbox[3], q[i + 1]);
      }
      break;
    }
    case 'Square':
      strokeSetup();
      drawPath([rectangle(x1 + w / 2, y1 + w / 2, Math.max(0, W - w), Math.max(0, H - w))]);
      break;
    case 'Circle':
      strokeSetup();
      drawPath(ellipseOps((x1 + x2) / 2, (y1 + y2) / 2, Math.max(0, (W - w) / 2), Math.max(0, (H - w) / 2)));
      break;
    case 'Polygon':
    case 'PolyLine': {
      const v = r.vertices ?? [];
      if (v.length < 4) return null;
      strokeSetup();
      if (r.subtype === 'Polygon') drawPath(polyOps(v, true));
      else {
        ops.push(...polyOps(v, false), stroke());
        if (r.lineEndings) {
          ops.push(setFillingRgbColor(...(r.interiorColor ?? color)), setDashPattern([], 0));
          ops.push(...lineEndingOps(r.lineEndings[0], v[0], v[1], v[2], v[3], w));
          const n = v.length;
          ops.push(...lineEndingOps(r.lineEndings[1], v[n - 2], v[n - 1], v[n - 4], v[n - 3], w));
        }
      }
      break;
    }
    case 'Line': {
      if (!r.line) return null;
      const [lx1, ly1, lx2, ly2] = r.line;
      strokeSetup();
      ops.push(moveTo(lx1, ly1), lineTo(lx2, ly2), stroke());
      if (r.lineEndings) {
        ops.push(setFillingRgbColor(...(r.interiorColor ?? color)), setDashPattern([], 0));
        ops.push(...lineEndingOps(r.lineEndings[0], lx1, ly1, lx2, ly2, w));
        ops.push(...lineEndingOps(r.lineEndings[1], lx2, ly2, lx1, ly1, w));
      }
      break;
    }
    case 'Ink': {
      const ink = r.inkList ?? [];
      if (!ink.some((g) => g.length >= 2)) return null;
      strokeSetup();
      for (const g of ink) {
        if (g.length === 2) ops.push(moveTo(g[0], g[1]), lineTo(g[0] + 0.01, g[1]), stroke());
        else if (g.length > 2) ops.push(...polyOps(g, false), stroke());
      }
      break;
    }
    case 'Caret':
      ops.push(setFillingRgbColor(...color), moveTo(x1, y1), lineTo(x2, y1), lineTo((x1 + x2) / 2, y2), closePath(), fill());
      break;
    case 'FreeText': {
      const font = await fonts.regular();
      const { size, color: textColor } = parseDa(r.da, r.ds);
      const pad = 2 + Math.max(0, r.width ?? 0);
      if (r.color) ops.push(setFillingRgbColor(...r.color), rectangle(x1, y1, W, H), fill());
      if ((r.width ?? 0) > 0) ops.push(setStrokingRgbColor(...textColor), setLineWidth(w), rectangle(x1 + w / 2, y1 + w / 2, W - w, H - w), stroke());
      ops.push(rectangle(x1, y1, W, H), clip(), endPath(), setFillingRgbColor(...textColor));
      const lines = wrapLines(font, r.contents ?? '', size, Math.max(1, W - 2 * pad));
      let baseline = y2 - pad - size * 0.85;
      for (const line of lines) {
        if (line) {
          const lw = font.widthOfTextAtSize(line, size);
          const q = r.justification ?? 0;
          const x = q === 1 ? x1 + (W - lw) / 2 : q === 2 ? x2 - pad - lw : x1 + pad;
          ops.push(beginText(), setFontAndSize(N('Helv'), size), moveText(x, baseline), showText(font.encodeText(line)), endText());
        }
        baseline -= size * 1.15;
      }
      resources.Font = { Helv: font.ref };
      break;
    }
    case 'Stamp': {
      const font = await fonts.bold();
      const label = fontSafe(font, (r.icon ?? 'Draft').replace(/^#/, '').replace(/^S[BH](?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase());
      const bw = Math.max(1.5, Math.min(W, H) * 0.06);
      ops.push(setStrokingRgbColor(...color), setLineWidth(bw), rectangle(x1 + bw / 2, y1 + bw / 2, W - bw, H - bw), stroke());
      const unit = font.widthOfTextAtSize(label, 1) || 1;
      const size = Math.max(4, Math.min(H * 0.55, (W - 4 * bw) / unit));
      const lw = font.widthOfTextAtSize(label, size);
      ops.push(setFillingRgbColor(...color), beginText(), setFontAndSize(N('HelvB'), size), moveText(x1 + (W - lw) / 2, y1 + (H - size * 0.72) / 2), showText(font.encodeText(label)), endText());
      resources.Font = { HelvB: font.ref };
      break;
    }
    default:
      return null;
  }
  ops.push(popGraphicsState());
  return { ops, bbox, resources };
}

// ------------------------------------------------------------------ import

interface ExistingAnnot {
  name?: string;
  subtype?: string;
  rect?: number[];
  contents?: string;
  ref?: PDFRef;
}

function sameRect(a: number[] | undefined, b: number[]): boolean {
  if (!a || a.length < 4) return false;
  const n = normRect(a);
  return n.every((v, i) => Math.abs(v - b[i]) <= 0.5);
}

/** Font loader for appearances (the app passes its Noto fonts so every character shows; default Helvetica). */
export type ImportFontLoader = (v: { family: 'sans'; bold: boolean; italic: false }) => Promise<Uint8Array>;

async function applyRecords(pdfBytes: Uint8Array, records: CommentRecord[], invalid: number, loadFont?: ImportFontLoader): Promise<CommentImportResult> {
  const doc = await loadPdf(pdfBytes);
  const pages = doc.getPages();
  let regular: Promise<PDFFont> | null = null;
  let bold: Promise<PDFFont> | null = null;
  const texts = records.flatMap((r) => [r.contents ?? '', r.subject ?? '', r.icon ?? '']);
  const embed = async (isBold: boolean): Promise<PDFFont> => {
    if (loadFont) {
      doc.registerFontkit(fontkit);
      return embedFontForText(doc, await loadFont({ family: 'sans', bold: isBold, italic: false }), texts);
    }
    return doc.embedFont(isBold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  };
  const fonts: Fonts = {
    regular: () => (regular ??= embed(false)),
    bold: () => (bold ??= embed(true)),
  };
  const existing = new Map<number, ExistingAnnot[]>();
  const existingOn = (pageIndex: number): ExistingAnnot[] => {
    let list = existing.get(pageIndex);
    if (!list) {
      const page = pages[pageIndex];
      const annots = page.node.lookup(N('Annots'));
      list = [];
      if (annots instanceof PDFArray) {
        for (const x of annots.asArray()) {
          const d = doc.context.lookup(x);
          if (!(d instanceof PDFDict)) continue;
          list.push({
            name: lookupStr(d, 'NM'),
            subtype: lookupStr(d, 'Subtype'),
            rect: lookupNums(d, 'Rect'),
            contents: lookupStr(d, 'Contents'),
            ref: x instanceof PDFRef ? x : undefined,
          });
        }
      }
      existing.set(pageIndex, list);
    }
    return list;
  };

  let added = 0;
  let skipped = invalid;
  const replies: { rec: CommentRecord; dict: PDFDict }[] = [];
  for (const rec of records) {
    if (!Number.isInteger(rec.page) || rec.page < 0 || rec.page >= pages.length || rec.subtype === 'FileAttachment') {
      skipped++;
      continue;
    }
    const list = existingOn(rec.page);
    const dup = rec.name
      ? list.some((e) => e.name === rec.name)
      : list.some((e) => !e.name && e.subtype === rec.subtype && sameRect(e.rect, rec.rect) && (e.contents ?? '') === (rec.contents ?? ''));
    if (dup) {
      skipped++;
      continue;
    }
    const page = pages[rec.page];
    const ap = await buildAppearance(doc, rec, fonts);
    if (!ap && rec.subtype !== 'Text') {
      skipped++;
      continue;
    }
    const dict = recordToDict(doc.context, rec);
    if (rec.subtype === 'Highlight' && rec.opacity === undefined) dict.set(N('CA'), PDFNumber.of(1));
    if (rec.flags === undefined) dict.set(N('F'), PDFNumber.of(rec.subtype === 'Text' ? 28 : 4));
    dict.set(N('P'), page.ref);
    if (!dict.has(N('M'))) dict.set(N('M'), PDFString.of(pdfDate(new Date().toISOString())));
    if (ap) {
      const stream = doc.context.formXObject(ap.ops, {
        BBox: ap.bbox,
        Matrix: [1, 0, 0, 1, 0, 0],
        Resources: doc.context.obj((ap.resources ?? {}) as never),
      });
      dict.set(N('AP'), doc.context.obj({ N: doc.context.register(stream) }));
    }
    const ref = doc.context.register(dict);
    page.node.addAnnot(ref);
    list.push({ name: rec.name, subtype: rec.subtype, rect: rec.rect, contents: rec.contents, ref });
    added++;
    if (rec.popup || rec.subtype === 'Text') {
      const pd = popupDict(doc.context, rec);
      pd.set(N('Parent'), ref);
      pd.set(N('P'), page.ref);
      const pref = doc.context.register(pd);
      dict.set(N('Popup'), pref);
      page.node.addAnnot(pref);
    }
    if (rec.inReplyTo) replies.push({ rec, dict });
  }
  // Replies point at their parent by reference; parents may come later in the file or already be in the PDF.
  for (const { rec, dict } of replies) {
    const parent = existingOn(rec.page).find((e) => e.name === rec.inReplyTo && e.ref);
    if (!parent?.ref) continue;
    dict.set(N('IRT'), parent.ref);
    if (rec.replyType === 'Group') dict.set(N('RT'), N('Group'));
  }
  const bytes = added ? await doc.save({ useObjectStreams: true, updateFieldAppearances: false }) : pdfBytes;
  return { bytes, added, skipped };
}

export async function importXfdf(pdfBytes: Uint8Array, xfdf: string, loadFont?: ImportFontLoader): Promise<CommentImportResult> {
  const { records, invalid } = parseXfdf(xfdf);
  return applyRecords(pdfBytes, records, invalid, loadFont);
}

// ------------------------------------------------------------------ FDF

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

export async function importFdf(pdfBytes: Uint8Array, fdf: Uint8Array, loadFont?: ImportFontLoader): Promise<CommentImportResult> {
  // pdf-lib's parser wants a %PDF- header; FDF is the same syntax under %FDF-.
  const bytes = fdf.slice();
  const head = ascii(bytes, 0, 1024);
  const at = head.indexOf('%FDF-');
  if (at < 0) throw new Error('Not an FDF file (no %FDF- header).');
  bytes[at + 1] = 0x50; // 'P'
  const ctx = await PDFParser.forBytesWithOptions(bytes, Infinity, false).parseDocument();
  let root = ctx.trailerInfo.Root ? ctx.lookup(ctx.trailerInfo.Root) : undefined;
  if (!(root instanceof PDFDict) || !(root.lookup(N('FDF')) instanceof PDFDict)) {
    root = ctx
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .find((o) => o instanceof PDFDict && o.lookup(N('FDF')) instanceof PDFDict);
  }
  if (!(root instanceof PDFDict)) throw new Error('FDF file has no /FDF dictionary.');
  const fdfDict = root.lookup(N('FDF'), PDFDict);
  const annots = fdfDict.lookup(N('Annots'));
  const nameOf = makeNameOf(ctx);
  const records: CommentRecord[] = [];
  let invalid = 0;
  if (annots instanceof PDFArray) {
    for (const x of annots.asArray()) {
      const d = ctx.lookup(x);
      if (!(d instanceof PDFDict)) continue;
      if (lookupStr(d, 'Subtype') === 'Popup') continue;
      const rec = readAnnot(d, lookupNum(d, 'Page') ?? 0, nameOf);
      if (rec) records.push(rec);
      else invalid++;
    }
  }
  return applyRecords(pdfBytes, records, invalid, loadFont);
}

export async function buildFdf(records: CommentRecord[], fileName: string): Promise<Uint8Array> {
  const ctx = PDFContext.create();
  const refs = new Map<string, PDFRef>();
  const annots: PDFRef[] = [];
  const entries = records.map((rec) => {
    const dict = recordToDict(ctx, rec);
    dict.set(N('Page'), PDFNumber.of(rec.page));
    const ref = ctx.register(dict);
    annots.push(ref);
    if (rec.name) refs.set(`${rec.page}\u0000${rec.name}`, ref);
    if (rec.popup) {
      const pd = popupDict(ctx, rec);
      pd.set(N('Parent'), ref);
      pd.set(N('Page'), PDFNumber.of(rec.page));
      const pref = ctx.register(pd);
      dict.set(N('Popup'), pref);
      annots.push(pref);
    }
    return { rec, dict };
  });
  for (const { rec, dict } of entries) {
    const parent = rec.inReplyTo ? refs.get(`${rec.page}\u0000${rec.inReplyTo}`) : undefined;
    if (!parent) continue;
    dict.set(N('IRT'), parent);
    if (rec.replyType === 'Group') dict.set(N('RT'), N('Group'));
  }
  const fdf = ctx.obj({ Annots: annots }) as PDFDict;
  if (fileName) fdf.set(N('F'), /^[\x20-\x7e]*$/.test(fileName) && !/[()\\]/.test(fileName) ? PDFString.of(fileName) : textObj(fileName));
  ctx.trailerInfo.Root = ctx.register(ctx.obj({ FDF: fdf }));
  const out = await PDFWriter.forContext(ctx, Infinity).serializeToBuffer();
  // "%PDF-1.7" → "%FDF-1.2": same length, so the xref offsets stay valid.
  const header = '%FDF-1.2';
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ export

export async function exportXfdf(pdfBytes: Uint8Array, opts: CommentExportOptions): Promise<string> {
  return buildXfdf(await readComments(pdfBytes), opts.fileName);
}

export async function exportFdf(pdfBytes: Uint8Array, opts: CommentExportOptions): Promise<Uint8Array> {
  return buildFdf(await readComments(pdfBytes), opts.fileName);
}
