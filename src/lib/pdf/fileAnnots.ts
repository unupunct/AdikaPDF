/**
 * Comments that were already in the file, edited or deleted in Adika.
 *
 * Nothing is converted up front: an annotation stays in the file exactly as
 * it is until the user takes it over (Edit in the Comments panel, or a click
 * with the Select tool). It then becomes an ordinary editor object whose
 * `fileAnnot` points back at it, and its id goes into the page's
 * `takenAnnots` so pdf.js stops drawing it. When saving:
 *  - an object that was not changed leaves the annotation alone;
 *  - an edited object is written by the app's own annotation writers and the
 *    result is merged into the original dictionary, so its object number,
 *    /NM, author, creation date, popup and replies (/IRT) all stay;
 *  - a taken-over annotation without an object is deleted, with its popup
 *    and its replies.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  appendBezierCurve,
  closePath,
  decodePDFRawStream,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  LineCapStyle,
  LineJoinStyle,
  type PDFOperator,
} from 'pdf-lib';
import type {
  EditorObject,
  FileAnnotLink,
  LineObject,
  LinkObject,
  MarkupKind,
  MarkupObject,
  NoteObject,
  PageRef,
  PolyObject,
  ShapeObject,
  StampObject,
  TextObject,
  VectorObject,
} from '@/types';
import { applyMatrix, displayToPdfMatrix, multiply, normalizeAngle, rotateCw, totalRotation, transformRectBounds, translate, type Matrix, type Rect } from '@/lib/geometry';
import { uid } from '@/lib/uid';
import { addToPage, appearance, hexToRgbTuple, linear, pdfDate, rotateEntry, text, transparency } from './annotations';
import { parseSvgPath } from './vectorEdit';
import { parseCss, parseRichText, type RunStyle } from '@/lib/richText';
import { viewBox } from './viewBox';

// ------------------------------------------------------------------ ids

/** pdf.js' id of an annotation object ("12R", or "12R3" for generation 3). */
export function annotId(ref: PDFRef): string {
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

export function parseAnnotId(id: string): PDFRef | null {
  const m = /^(\d+)R(\d*)$/.exec(id);
  return m ? PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0) : null;
}

function sameRef(a: unknown, b: PDFRef): boolean {
  return a instanceof PDFRef && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;
}

// ------------------------------------------------------------------ reading values

function name(d: PDFDict, key: string): string | null {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : null;
}

function num(d: PDFDict, key: string): number | null {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

function nums(d: PDFDict | PDFArray, key?: string): number[] | null {
  const v = key && d instanceof PDFDict ? d.lookup(PDFName.of(key)) : d;
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const n = v.lookup(i);
    if (n instanceof PDFNumber) out.push(n.asNumber());
  }
  return out;
}

function str(d: PDFDict, key: string): string {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
}

/** A text string, or a text stream (/RC may be either). */
function textOrStream(d: PDFDict, key: string): string {
  const v = d.lookup(PDFName.of(key));
  if (v instanceof PDFRawStream) {
    try {
      const b = decodePDFRawStream(v).decode();
      if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
      return new TextDecoder().decode(b);
    } catch {
      return '';
    }
  }
  return str(d, key);
}

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** A /C or /IC colour (grey, RGB or CMYK) as #rrggbb; null when absent or empty (transparent). */
function color(d: PDFDict, key: string): string | null {
  const c = nums(d, key);
  if (!c?.length) return null;
  let rgb: number[];
  if (c.length === 1) rgb = [c[0], c[0], c[0]];
  else if (c.length === 4) rgb = [0, 1, 2].map((i) => (1 - c[i]) * (1 - c[3]));
  else rgb = c.slice(0, 3);
  return `#${rgb.map(hex2).join('')}`;
}

/** PDF date (D:YYYYMMDDHHmmSS+HH'mm') → ISO; null when absent or unreadable. */
export function pdfDateToIso(s: string): string | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = '01', da = '01', h = '00', mi = '00', se = '00', tz, th = '00', tm = '00'] = m;
  const zone = !tz ? '' : tz === 'Z' || tz === 'z' ? 'Z' : `${tz}${th}:${tm}`;
  const d = new Date(`${y}-${mo}-${da}T${h}:${mi}:${se}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function strokeWidth(d: PDFDict): number {
  const bs = d.lookup(PDFName.of('BS'));
  if (bs instanceof PDFDict) {
    const w = num(bs, 'W');
    if (w !== null) return w;
  }
  const border = nums(d, 'Border');
  if (border && border.length >= 3) return border[2];
  return 1;
}

function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ------------------------------------------------------------------ stamp appearances

interface StampForm {
  /** /AP /N as it is referenced (a ref, or the stream itself). */
  normal: PDFRef | PDFStream;
  bbox: [number, number, number, number];
  /** Its /Matrix. */
  matrix: Matrix;
  /** The turn the matrix gives (radians, counter-clockwise in user space). */
  angle: number;
}

function stampForm(d: PDFDict): StampForm | null {
  const ap = d.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return null;
  const normal = ap.get(PDFName.of('N'));
  const stream = ap.lookup(PDFName.of('N'));
  if (!(stream instanceof PDFStream) || !(normal instanceof PDFRef || normal instanceof PDFStream)) return null;
  const b = nums(stream.dict, 'BBox');
  if (!b || b.length < 4) return null;
  const mx = nums(stream.dict, 'Matrix');
  const matrix: Matrix = mx && mx.length === 6 ? (mx as Matrix) : [1, 0, 0, 1, 0, 0];
  return { normal, bbox: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])], matrix, angle: Math.atan2(matrix[1], matrix[0]) };
}

/** The appearance with its turn taken out (y up), and the box it then covers. */
function uprightForm(f: StampForm): { cm: Matrix; width: number; height: number } {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const unturn: Matrix = [c, -s, s, c, 0, 0];
  const [x0, y0, x1, y1] = f.bbox;
  const m = multiply(unturn, f.matrix);
  const pts = [applyMatrix(m, x0, y0), applyMatrix(m, x1, y0), applyMatrix(m, x1, y1), applyMatrix(m, x0, y1)];
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const width = Math.max(1e-3, Math.max(...pts.map((p) => p[0])) - minX);
  const height = Math.max(1e-3, Math.max(...pts.map((p) => p[1])) - minY);
  return { cm: multiply(translate(-minX, -minY), unturn), width, height };
}

/**
 * Where a stamp of the file sits as an editor object: its unturned size, and
 * the turn of its appearance (/Matrix; Acrobat's /Rotate says the same) as the
 * object's rotation, so the editor shows it as viewers draw it.
 */
function stampPlacement(d: PDFDict, inv: Matrix): { x: number; y: number; width: number; height: number; rotation: number } | null {
  const f = stampForm(d);
  const r = nums(d, 'Rect');
  if (!f || !r || r.length < 4) return null;
  const up = uprightForm(f);
  // The appearance (turned) is fitted into /Rect: the same factor for the unturned box.
  const c = Math.abs(Math.cos(f.angle));
  const s = Math.abs(Math.sin(f.angle));
  const turnedW = up.width * c + up.height * s;
  const turnedH = up.width * s + up.height * c;
  const k = Math.sqrt((Math.abs(r[2] - r[0]) / turnedW) * (Math.abs(r[3] - r[1]) / turnedH)) || 1;
  const width = up.width * k;
  const height = up.height * k;
  // The turn on screen: user space y-up → display y-down; rotateCw(rot) · flip = that linear map.
  const lin = multiply([inv[0], inv[1], inv[2], inv[3], 0, 0], [Math.cos(f.angle), Math.sin(f.angle), -Math.sin(f.angle), Math.cos(f.angle), 0, 0]);
  const rotation = normalizeAngle(Math.round(((Math.atan2(lin[1], lin[0]) * 180) / Math.PI) * 100) / 100);
  const [cx, cy] = applyMatrix(inv, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
  const [hx, hy] = applyMatrix(rotateCw(rotation), width / 2, height / 2);
  return { x: cx - hx, y: cy - hy, width, height, rotation };
}

function pageMatrix(page: PDFPage, ref: PageRef): Matrix {
  const b = viewBox(page);
  return displayToPdfMatrix(totalRotation(ref), { x: b.x, y: b.y, width: b.width, height: b.height });
}

// ------------------------------------------------------------------ the page's annotations

export interface FileAnnot {
  /** pdf.js id ("12R"). */
  id: string;
  subtype: string;
  /** Bounds on the page, display points. */
  rect: Rect;
  author: string;
  text: string;
  inReplyTo: string | null;
  /** Replies (any depth) and popups: they go when it is deleted. */
  related: string[];
  /** What it becomes when taken over; null = it can only be deleted. */
  object: EditorObject | null;
  /** A stamp: its own appearance has to be drawn into `object.src` (see stampPicturePdf). */
  needsPicture?: boolean;
}

const MARKUP: Record<string, MarkupKind> = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly' };

/**
 * The annotations of one source page (popups and form widgets left out),
 * each with the editor object it turns into when taken over.
 * `pageIdForIndex` maps a link's destination page (0-based source index) to a working page.
 */
export function readPageAnnots(doc: PDFDocument, pageIndex: number, ref: PageRef, pageIdForIndex: (i: number) => string | null = () => null): FileAnnot[] {
  const page = doc.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) return [];
  const inv = invert(pageMatrix(page, ref));
  const entries: Array<{ id: string; dict: PDFDict; subtype: string }> = [];
  for (let i = 0; i < annots.size(); i++) {
    const r = annots.get(i);
    const dict = annots.lookup(i);
    if (!(r instanceof PDFRef) || !(dict instanceof PDFDict)) continue;
    entries.push({ id: annotId(r), dict, subtype: name(dict, 'Subtype') ?? '' });
  }
  // Replies and popups of each annotation.
  const children = new Map<string, string[]>();
  const link = (parent: unknown, child: string) => {
    if (!(parent instanceof PDFRef)) return;
    const k = annotId(parent);
    children.set(k, [...(children.get(k) ?? []), child]);
  };
  for (const e of entries) {
    link(e.dict.get(PDFName.of('IRT')), e.id);
    if (e.subtype === 'Popup') link(e.dict.get(PDFName.of('Parent')), e.id);
    const popup = e.dict.get(PDFName.of('Popup'));
    if (popup instanceof PDFRef) {
      const k = annotId(popup);
      children.set(e.id, [...(children.get(e.id) ?? []), k]);
    }
  }
  const closure = (id: string): string[] => {
    const out = new Set<string>();
    const walk = (k: string) => {
      for (const c of children.get(k) ?? []) {
        if (out.has(c) || c === id) continue;
        out.add(c);
        walk(c);
      }
    };
    walk(id);
    return [...out];
  };
  const out: FileAnnot[] = [];
  for (const e of entries) {
    if (e.subtype === 'Popup' || e.subtype === 'Widget') continue;
    const r = nums(e.dict, 'Rect');
    if (!r || r.length < 4) continue;
    const rect = transformRectBounds(inv, { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) });
    const irt = e.dict.get(PDFName.of('IRT'));
    const fa: FileAnnot = {
      id: e.id,
      subtype: e.subtype,
      rect,
      author: str(e.dict, 'T'),
      text: str(e.dict, 'Contents'),
      inReplyTo: irt instanceof PDFRef ? annotId(irt) : null,
      related: closure(e.id),
      object: null,
    };
    try {
      fa.object = toObject(doc, e.dict, e.subtype, inv, rect, ref.id, pageIdForIndex);
    } catch {
      fa.object = null; // malformed: it can still be deleted
    }
    if (fa.object?.type === 'stamp') fa.needsPicture = true;
    out.push(fa);
  }
  return out;
}

function toObject(doc: PDFDocument, d: PDFDict, subtype: string, inv: Matrix, rect: Rect, pageId: string, pageIdForIndex: (i: number) => string | null): EditorObject | null {
  const now = new Date().toISOString();
  const meta = {
    author: str(d, 'T'),
    createdAt: pdfDateToIso(str(d, 'CreationDate')) ?? pdfDateToIso(str(d, 'M')) ?? now,
    modifiedAt: pdfDateToIso(str(d, 'M')) ?? now,
  };
  const base = { id: uid('obj'), pageId, rotation: 0, opacity: num(d, 'CA') ?? 1 };
  const contents = str(d, 'Contents');
  const P = (x: number, y: number) => applyMatrix(inv, x, y);
  const measured = d.has(PDFName.of('Measure')) || /Dimension$/.test(name(d, 'IT') ?? '');
  const sw = strokeWidth(d);
  switch (subtype) {
    case 'Text':
      return { ...base, ...meta, type: 'note', x: rect.x, y: rect.y, width: 20, height: 20, text: contents, color: color(d, 'C') ?? '#facc15' } satisfies NoteObject;
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const qp = nums(d, 'QuadPoints') ?? [];
      const boxes: Rect[] = [];
      for (let i = 0; i + 7 < qp.length; i += 8) {
        const pts = [0, 2, 4, 6].map((k) => P(qp[i + k], qp[i + k + 1]));
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        boxes.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
      }
      if (!boxes.length) boxes.push(rect);
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const kind = MARKUP[subtype];
      return {
        ...base,
        ...meta,
        opacity: kind === 'highlight' ? 1 : base.opacity,
        type: 'markup',
        kind,
        x,
        y,
        width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
        height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
        quads: boxes.map((b) => ({ x: b.x - x, y: b.y - y, width: b.width, height: b.height })),
        color: color(d, 'C') ?? '#facc15',
        selectedText: '',
        text: contents,
      } satisfies MarkupObject;
    }
    case 'FreeText': {
      const da = str(d, 'DA');
      const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) || 12;
      const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
      const grey = /([\d.]+)\s+g(?:\s|$)/.exec(da);
      const fg = rgb ? `#${[rgb[1], rgb[2], rgb[3]].map((v) => hex2(Number(v))).join('')}` : grey ? `#${hex2(Number(grey[1])).repeat(3)}` : '#000000';
      // The text box: Rect less /RD (a callout's Rect also covers the leader line).
      const r = nums(d, 'Rect')!;
      const rd = nums(d, 'RD');
      const [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      const inner = rd && rd.length === 4 ? { x: x0 + rd[0], y: y0 + rd[1], width: x1 - x0 - rd[0] - rd[2], height: y1 - y0 - rd[1] - rd[3] } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      const box = transformRectBounds(inv, inner);
      const cl = nums(d, 'CL');
      const callout = cl && cl.length >= 4 ? (([ax, ay]) => ({ x: ax - box.x, y: ay - box.y }))(P(cl[0], cl[1])) : null;
      const q = num(d, 'Q') ?? 0;
      const bw = strokeWidth(d);
      // Rich text (/RC) and default style (/DS): bold, italic, colours and sizes of parts are kept.
      const fallback: RunStyle = { family: 'sans', bold: false, italic: false, underline: false, strike: false, color: fg, size };
      const ds = str(d, 'DS');
      const rc = textOrStream(d, 'RC');
      const rich = rc ? parseRichText(rc, ds, fallback) : null;
      const style = rich?.base ?? { ...fallback, ...parseCss(ds) };
      const runs = rich?.runs && rich.text.trim() ? rich.runs : undefined;
      return {
        ...base,
        type: 'text',
        x: box.x,
        y: box.y,
        width: Math.max(10, box.width),
        height: Math.max(style.size * 1.25, box.height),
        text: runs ? rich!.text : contents,
        ...(runs ? { runs } : {}),
        fontFamily: style.family,
        bold: style.bold,
        italic: style.italic,
        fontSize: style.size,
        color: style.color,
        align: q === 1 ? 'center' : q === 2 ? 'right' : 'left',
        lineHeight: 1.25,
        background: color(d, 'IC'),
        annotation: true,
        author: meta.author,
        border: bw > 0 ? color(d, 'C') : null,
        callout,
      } satisfies TextObject;
    }
    case 'Square':
    case 'Circle': {
      const r = nums(d, 'Rect')!;
      const rd = nums(d, 'RD');
      const [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      const ins = rd && rd.length === 4 ? rd : [sw / 2, sw / 2, sw / 2, sw / 2];
      const box = transformRectBounds(inv, { x: x0 + ins[0], y: y0 + ins[1], width: Math.max(1, x1 - x0 - ins[0] - ins[2]), height: Math.max(1, y1 - y0 - ins[1] - ins[3]) });
      const be = d.lookup(PDFName.of('BE'));
      if (subtype === 'Square' && be instanceof PDFDict && name(be, 'S') === 'C') {
        const { x, y, width: w, height: h } = box;
        return { ...base, ...meta, type: 'poly', kind: 'cloud', x, y, width: w, height: h, points: [0, 0, w, 0, w, h, 0, h], stroke: color(d, 'C') ?? '#e11d48', strokeWidth: sw, fill: color(d, 'IC'), text: contents } satisfies PolyObject;
      }
      return { ...base, type: subtype === 'Square' ? 'rect' : 'ellipse', x: box.x, y: box.y, width: box.width, height: box.height, stroke: color(d, 'C'), strokeWidth: sw, fill: color(d, 'IC') } satisfies ShapeObject;
    }
    case 'Line': {
      const l = nums(d, 'L');
      if (measured || !l || l.length < 4) return null;
      let a = P(l[0], l[1]);
      let b = P(l[2], l[3]);
      const le = d.lookup(PDFName.of('LE'));
      const ends = le instanceof PDFArray ? [0, 1].map((i) => (le.lookup(i) instanceof PDFName ? (le.lookup(i) as PDFName).decodeText() : 'None')) : ['None', 'None'];
      // Adika's arrow has its head at the end point.
      if (ends[1] === 'None' && ends[0] !== 'None') [a, b] = [b, a];
      const x = Math.min(a[0], b[0]);
      const y = Math.min(a[1], b[1]);
      return { ...base, type: ends.some((e) => e !== 'None') ? 'arrow' : 'line', x, y, points: [a[0] - x, a[1] - y, b[0] - x, b[1] - y], stroke: color(d, 'C') ?? '#000000', strokeWidth: sw } satisfies LineObject;
    }
    case 'Polygon':
    case 'PolyLine': {
      const v = nums(d, 'Vertices');
      if (measured || !v || v.length < 4) return null;
      const pts: number[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push(...P(v[i], v[i + 1]));
      const xs = pts.filter((_, i) => i % 2 === 0);
      const ys = pts.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return {
        ...base,
        ...meta,
        type: 'poly',
        kind: subtype === 'Polygon' ? 'polygon' : 'polyline',
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
        points: pts.map((p, i) => p - (i % 2 === 0 ? x : y)),
        stroke: color(d, 'C') ?? '#e11d48',
        strokeWidth: sw,
        fill: subtype === 'Polygon' ? color(d, 'IC') : null,
        text: contents,
      } satisfies PolyObject;
    }
    case 'Ink': {
      const list = d.lookup(PDFName.of('InkList'));
      if (!(list instanceof PDFArray)) return null;
      const strokes: Array<Array<[number, number]>> = [];
      for (let i = 0; i < list.size(); i++) {
        const s = list.lookup(i);
        const n = s instanceof PDFArray ? (nums(s) ?? []) : [];
        const pts: Array<[number, number]> = [];
        for (let k = 0; k + 1 < n.length; k += 2) pts.push(P(n[k], n[k + 1]));
        if (pts.length) strokes.push(pts);
      }
      if (!strokes.length) return null;
      const all = strokes.flat();
      const x = Math.min(...all.map((p) => p[0]));
      const y = Math.min(...all.map((p) => p[1]));
      const w = Math.max(1, Math.max(...all.map((p) => p[0])) - x);
      const h = Math.max(1, Math.max(...all.map((p) => p[1])) - y);
      const f = (v: number) => String(Math.round(v * 100) / 100);
      const path = strokes.map((s) => s.map((p, i) => `${i ? 'L' : 'M'} ${f(p[0] - x)} ${f(p[1] - y)}`).join(' ')).join(' ');
      return { ...base, type: 'vector', x, y, width: w, height: h, path, naturalWidth: w, naturalHeight: h, fill: null, stroke: color(d, 'C') ?? '#000000', strokeWidth: sw, evenOdd: false } satisfies VectorObject;
    }
    case 'Stamp': {
      const place = stampPlacement(d, inv);
      if (!place) return null;
      return { ...base, ...meta, type: 'stamp', ...place, label: '', subtitle: '', color: color(d, 'C') ?? '#b91c1c', name: name(d, 'Name') ?? 'Draft', text: contents } satisfies StampObject;
    }
    case 'Link': {
      const target = linkTarget(doc, d, pageIdForIndex);
      if (!target) return null;
      return { ...base, opacity: 1, type: 'link', x: rect.x, y: rect.y, width: rect.width, height: rect.height, target } satisfies LinkObject;
    }
    default:
      return null;
  }
}

/** A web link or a jump to a page of this document; anything else (scripts, named destinations…) is not simple. */
function linkTarget(doc: PDFDocument, d: PDFDict, pageIdForIndex: (i: number) => string | null): LinkObject['target'] | null {
  const a = d.lookup(PDFName.of('A'));
  let dest = d.lookup(PDFName.of('Dest'));
  if (a instanceof PDFDict) {
    const s = name(a, 'S');
    if (s === 'URI') {
      const uri = a.lookup(PDFName.of('URI'));
      const url = uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : '';
      return url ? { kind: 'url', url } : null;
    }
    if (s !== 'GoTo') return null;
    dest = a.lookup(PDFName.of('D'));
  }
  if (!(dest instanceof PDFArray) || dest.size() === 0) return null;
  const target = dest.get(0);
  const index = doc.getPages().findIndex((p) => sameRef(target, p.ref));
  const pageId = index >= 0 ? pageIdForIndex(index) : null;
  return pageId ? { kind: 'page', pageId } : null;
}

// ------------------------------------------------------------------ taking over

function comparable(o: EditorObject): string {
  const { id: _id, pageId: _page, fileAnnot: _link, ...rest } = o;
  return JSON.stringify(rest);
}

/** Links the object to its annotation; called once it is complete (a stamp with its picture). */
export function linkToFile(o: EditorObject, fa: Pick<FileAnnot, 'id' | 'subtype'>): EditorObject {
  const fileAnnot: FileAnnotLink = { ref: fa.id, subtype: fa.subtype, base: comparable(o) };
  return { ...o, fileAnnot } as EditorObject;
}

/** True when the object is still exactly as it was taken over from the file. */
export function isUntouched(o: EditorObject): boolean {
  return !!o.fileAnnot && comparable(o) === o.fileAnnot.base;
}

/**
 * A one-page PDF holding just the stamp's own appearance, upright (its turn
 * is the object's rotation), for rendering it into a picture with pdf.js.
 */
export async function stampPicturePdf(doc: PDFDocument, id: string): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const ref = parseAnnotId(id);
  const d = ref ? doc.context.lookup(ref) : null;
  if (!(d instanceof PDFDict)) return null;
  const f = stampForm(d);
  if (!f) return null;
  const up = uprightForm(f);
  const out = await PDFDocument.create();
  const page = out.addPage([up.width, up.height]);
  const copied = PDFObjectCopier.for(doc.context, out.context).copy(f.normal);
  const form = copied instanceof PDFRef ? out.context.lookup(copied) : copied;
  if (form instanceof PDFStream) form.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  const formRef = copied instanceof PDFRef ? copied : out.context.register(copied);
  const content = out.context.stream(`q ${up.cm.map((v) => +v.toFixed(6)).join(' ')} cm /S Do Q`);
  page.node.set(PDFName.of('Contents'), out.context.register(content));
  page.node.set(PDFName.of('Resources'), out.context.obj({ XObject: { S: formRef } }));
  return { bytes: await out.save(), width: up.width, height: up.height };
}

// ------------------------------------------------------------------ writers for taken-over shapes

type RGB = [number, number, number];

function frame(pm: Matrix, o: { x: number; y: number; rotation: number }): Matrix {
  return multiply(pm, multiply(translate(o.x, o.y), rotateCw(o.rotation)));
}

function bounds(points: Array<[number, number]>, pad: number): [number, number, number, number] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

function register(doc: PDFDocument, page: PDFPage, dict: Record<string, unknown>): void {
  addToPage(doc, page, doc.context.register(doc.context.obj({ Type: 'Annot', F: 4, P: page.ref, ...dict })));
}

/** /Square or /Circle from a rectangle or ellipse of the file. */
function writeShape(doc: PDFDocument, page: PDFPage, pm: Matrix, o: ShapeObject): void {
  const m = frame(pm, o);
  const P = (x: number, y: number) => applyMatrix(m, x, y);
  const { width: w, height: h } = o;
  const sw = o.stroke ? o.strokeWidth : 0;
  const strokeC: RGB | null = o.stroke ? hexToRgbTuple(o.stroke) : null;
  const fillC: RGB | null = o.fill ? hexToRgbTuple(o.fill) : null;
  const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(PDFName.of('GS0'))];
  if (strokeC) ops.push(setStrokingRgbColor(...strokeC), setLineWidth(sw));
  if (fillC) ops.push(setFillingRgbColor(...fillC));
  if (o.type === 'ellipse') {
    const k = 0.5523;
    const rx = w / 2;
    const ry = h / 2;
    ops.push(
      moveTo(...P(w, ry)),
      appendBezierCurve(...P(w, ry + ry * k), ...P(rx + rx * k, h), ...P(rx, h)),
      appendBezierCurve(...P(rx - rx * k, h), ...P(0, ry + ry * k), ...P(0, ry)),
      appendBezierCurve(...P(0, ry - ry * k), ...P(rx - rx * k, 0), ...P(rx, 0)),
      appendBezierCurve(...P(rx + rx * k, 0), ...P(w, ry - ry * k), ...P(w, ry)),
    );
  } else {
    ops.push(moveTo(...P(0, 0)), lineTo(...P(w, 0)), lineTo(...P(w, h)), lineTo(...P(0, h)));
  }
  ops.push(closePath(), fillC && strokeC ? fillAndStroke() : fillC ? fill() : stroke(), popGraphicsState());
  const corners: Array<[number, number]> = [P(0, 0), P(w, 0), P(w, h), P(0, h)];
  const rect = bounds(corners, sw / 2 + 1);
  const inner = bounds(corners, 0);
  register(doc, page, {
    Subtype: o.type === 'ellipse' ? 'Circle' : 'Square',
    Rect: rect,
    ...(strokeC ? { C: strokeC } : { C: [] }),
    ...(fillC ? { IC: fillC } : {}),
    CA: o.opacity,
    BS: { W: sw, S: 'S' },
    RD: [inner[0] - rect[0], inner[1] - rect[1], rect[2] - inner[2], rect[3] - inner[3]],
    AP: { N: appearance(doc, ops, rect, [1, 0, 0, 1, 0, 0], doc.context.obj({ ExtGState: { GS0: transparency(doc, o.opacity) } })) },
  });
}

/** /Line from a line or arrow of the file (an arrow has a closed head at its end). */
function writeLineAnnot(doc: PDFDocument, page: PDFPage, pm: Matrix, o: LineObject): void {
  const m = frame(pm, o);
  const a = applyMatrix(m, o.points[0], o.points[1]);
  const b = applyMatrix(m, o.points[2], o.points[3]);
  const c = hexToRgbTuple(o.stroke);
  const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(PDFName.of('GS0')), setStrokingRgbColor(...c), setFillingRgbColor(...c), setLineWidth(o.strokeWidth), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
  const pts: Array<[number, number]> = [a, b];
  let end = b;
  if (o.type === 'arrow') {
    const len = Math.max(8, o.strokeWidth * 4);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = Math.PI / 7;
    const h1: [number, number] = [b[0] - len * Math.cos(ang - s), b[1] - len * Math.sin(ang - s)];
    const h2: [number, number] = [b[0] - len * Math.cos(ang + s), b[1] - len * Math.sin(ang + s)];
    ops.push(moveTo(...b), lineTo(...h1), lineTo(...h2), closePath(), fill());
    end = [b[0] - len * 0.6 * Math.cos(ang), b[1] - len * 0.6 * Math.sin(ang)];
    pts.push(h1, h2);
  }
  ops.push(moveTo(...a), lineTo(...end), stroke(), popGraphicsState());
  const rect = bounds(pts, o.strokeWidth + 2);
  register(doc, page, {
    Subtype: 'Line',
    Rect: rect,
    L: [...a, ...b],
    LE: ['None', o.type === 'arrow' ? 'ClosedArrow' : 'None'],
    C: c,
    ...(o.type === 'arrow' ? { IC: c } : {}),
    CA: o.opacity,
    BS: { W: o.strokeWidth, S: 'S' },
    AP: { N: appearance(doc, ops, rect, [1, 0, 0, 1, 0, 0], doc.context.obj({ ExtGState: { GS0: transparency(doc, o.opacity) } })) },
  });
}

/** /Ink from a freehand drawing of the file (its strokes as path subpaths). */
function writeInk(doc: PDFDocument, page: PDFPage, pm: Matrix, o: VectorObject): void {
  const m = multiply(frame(pm, o), [o.width / (o.naturalWidth || 1), 0, 0, o.height / (o.naturalHeight || 1), 0, 0]);
  const P = (x: number, y: number) => applyMatrix(m, x, y);
  const c = hexToRgbTuple(o.stroke ?? '#000000');
  const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(PDFName.of('GS0')), setStrokingRgbColor(...c), setLineWidth(o.strokeWidth), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
  const inkList: number[][] = [];
  const all: Array<[number, number]> = [];
  for (const cmd of parseSvgPath(o.path)) {
    if (cmd.c === 'Z') continue;
    const end = P(cmd.p[cmd.p.length - 2], cmd.p[cmd.p.length - 1]);
    if (cmd.c === 'M') {
      inkList.push([]);
      ops.push(moveTo(...end));
    } else if (cmd.c === 'L') ops.push(lineTo(...end));
    else {
      const [c1x, c1y, c2x, c2y] = cmd.p as number[];
      ops.push(appendBezierCurve(...P(c1x, c1y), ...P(c2x, c2y), ...end));
    }
    if (!inkList.length) inkList.push([]);
    inkList[inkList.length - 1].push(...end);
    all.push(end);
  }
  if (!all.length) return;
  ops.push(stroke(), popGraphicsState());
  const rect = bounds(all, o.strokeWidth + 1);
  register(doc, page, {
    Subtype: 'Ink',
    Rect: rect,
    InkList: inkList,
    C: c,
    CA: o.opacity,
    BS: { W: o.strokeWidth, S: 'S' },
    AP: { N: appearance(doc, ops, rect, [1, 0, 0, 1, 0, 0], doc.context.obj({ ExtGState: { GS0: transparency(doc, o.opacity) } })) },
  });
}

/**
 * A stamp keeps its own appearance. Not turned (before or after): only where
 * it is and its comment change (the appearance scales to /Rect). Turned: a new
 * appearance draws the original one upright, turned by its /Matrix, with /Rect
 * the turned box and /Rotate for Acrobat.
 */
function writeStampPlace(doc: PDFDocument, page: PDFPage, pm: Matrix, o: StampObject, target: PDFRef): void {
  const local = frame(pm, o);
  const r = transformRectBounds(local, { x: 0, y: 0, width: o.width, height: o.height });
  const rect = [r.x, r.y, r.x + r.width, r.y + r.height];
  const original = doc.context.lookup(target);
  const f = original instanceof PDFDict ? stampForm(original) : null;
  const flipped = multiply(local, [1, 0, 0, -1, 0, o.height]);
  const turned = (m: Matrix) => Math.abs(Math.atan2(m[1], m[0])) > 1e-4;
  if (!f || (!turned(f.matrix) && !turned(flipped))) {
    register(doc, page, { Subtype: 'Stamp', Rect: rect, Contents: text(o.text) });
    return;
  }
  const up = uprightForm(f);
  const normal = f.normal instanceof PDFRef ? f.normal : doc.context.register(f.normal);
  const fit = multiply([o.width / up.width, 0, 0, o.height / up.height, 0, 0], up.cm);
  const ops = `q /GS0 gs ${fit.map((v) => +v.toFixed(6)).join(' ')} cm /S Do Q`;
  const ap = doc.context.register(
    doc.context.stream(ops, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, o.width, o.height],
      Matrix: linear(flipped),
      Resources: { XObject: { S: normal }, ExtGState: { GS0: transparency(doc, o.opacity) } },
    }),
  );
  const rotate = rotateEntry(flipped);
  const keep = original instanceof PDFDict ? original.get(PDFName.of('C')) : undefined;
  register(doc, page, { Subtype: 'Stamp', Rect: rect, Contents: text(o.text), CA: o.opacity, ...(keep ? { C: keep } : {}), ...(rotate ? { Rotate: rotate } : {}), AP: { N: ap } });
}

// ------------------------------------------------------------------ saving

/** Entries of the original that are kept whatever the edit (identity, thread, structure). */
const KEEP = new Set(['Type', 'Subtype', 'NM', 'T', 'CreationDate', 'Popup', 'IRT', 'RT', 'P', 'StructParent', 'OC', 'F', 'Name', 'Open', 'State', 'StateModel', 'Subj', 'Measure']);
/** Entries an annotation writer owns: stale when a new appearance was written without them. */
const OWNED = ['Rect', 'Contents', 'RC', 'DS', 'C', 'IC', 'CA', 'ca', 'BS', 'Border', 'BE', 'RD', 'AP', 'AS', 'QuadPoints', 'Vertices', 'L', 'LE', 'InkList', 'CL', 'DA', 'Q', 'A', 'Dest', 'H', 'Path', 'Rotate'];

function annotsOf(page: PDFPage): PDFArray | null {
  return page.node.Annots() ?? null;
}

function indexOfRef(annots: PDFArray, ref: PDFRef): number {
  for (let i = 0; i < annots.size(); i++) if (sameRef(annots.get(i), ref)) return i;
  return -1;
}

/** Deletes an annotation from the page with its popup and replies (any depth). Returns how many entries went. */
export function deleteAnnotation(page: PDFPage, ref: PDFRef): number {
  const annots = annotsOf(page);
  if (!annots) return 0;
  const gone = new Set<string>([annotId(ref)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i);
      const d = annots.lookup(i);
      if (!(r instanceof PDFRef) || !(d instanceof PDFDict) || gone.has(annotId(r))) continue;
      const parent = d.get(PDFName.of('IRT')) ?? (name(d, 'Subtype') === 'Popup' ? d.get(PDFName.of('Parent')) : undefined);
      if (parent instanceof PDFRef && gone.has(annotId(parent))) {
        gone.add(annotId(r));
        grew = true;
      }
    }
  }
  for (let i = 0; i < annots.size(); i++) {
    const d = annots.lookup(i);
    const r = annots.get(i);
    if (r instanceof PDFRef && gone.has(annotId(r)) && d instanceof PDFDict) {
      const popup = d.get(PDFName.of('Popup'));
      if (popup instanceof PDFRef) gone.add(annotId(popup));
    }
  }
  let removed = 0;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const r = annots.get(i);
    if (r instanceof PDFRef && gone.has(annotId(r))) {
      annots.remove(i);
      removed++;
    }
  }
  return removed;
}

/**
 * Moves what a writer just added to the page (from index `before` on) into
 * the original annotation `target`: its new geometry, colours, text and
 * appearance replace the old ones, everything else of the original stays.
 */
export function mergeIntoOriginal(doc: PDFDocument, page: PDFPage, before: number, target: PDFRef): void {
  const annots = annotsOf(page);
  const original = doc.context.lookup(target);
  if (!annots || !(original instanceof PDFDict)) return;
  const added: Array<{ ref: PDFRef; dict: PDFDict }> = [];
  for (let i = before; i < annots.size(); i++) {
    const r = annots.get(i);
    const d = annots.lookup(i);
    if (r instanceof PDFRef && d instanceof PDFDict) added.push({ ref: r, dict: d });
  }
  for (let i = annots.size() - 1; i >= before; i--) annots.remove(i);
  const main = added.find((a) => name(a.dict, 'Subtype') !== 'Popup');
  if (main) {
    const n = main.dict;
    if (n.has(PDFName.of('AP'))) {
      for (const k of OWNED) if (!n.has(PDFName.of(k))) original.delete(PDFName.of(k));
      if (name(original, 'Subtype') === 'FreeText' && !n.has(PDFName.of('IT'))) original.delete(PDFName.of('IT'));
    }
    if (n.has(PDFName.of('Contents'))) original.delete(PDFName.of('RC'));
    for (const [k, v] of n.entries()) {
      if (KEEP.has(k.decodeText())) continue;
      if (k.decodeText() === 'IT' && name(original, 'Subtype') !== 'FreeText') continue;
      original.set(k, v);
    }
  }
  original.set(PDFName.of('M'), PDFString.of(pdfDate(new Date().toISOString())));
  // A sticky note written fresh brings a popup: kept only when the original had none.
  const popup = added.find((a) => name(a.dict, 'Subtype') === 'Popup');
  if (popup && !(original.get(PDFName.of('Popup')) instanceof PDFRef)) {
    popup.dict.set(PDFName.of('Parent'), target);
    original.set(PDFName.of('Popup'), popup.ref);
    annots.push(popup.ref);
  }
}

export interface PlannedAnnotPage {
  ref: PageRef;
  page: PDFPage;
  /** The page the annotations were read from (the source page itself when edited in place); null when the page was rebuilt (raster). */
  origin: PDFPage | null;
  /** For a copied page: which copy (value) stands for which original annotation (key, its ref as text). */
  copies?: Map<string, PDFRef>;
}

export interface FileAnnotEdits {
  /** Objects whose original stays as it is (taken over but not changed): nothing to write. */
  skip(o: EditorObject): boolean;
  /** Writes objects from the file that need their own annotation writer; false = the normal writer. */
  write(doc: PDFDocument, page: PDFPage, pm: Matrix, o: EditorObject): boolean;
  /** After `o` was written (annotations from index `before` on): moves it into its original. Returns the original's ref. */
  adopt(doc: PDFDocument, page: PDFPage, o: EditorObject, before: number): PDFRef | null;
}

/**
 * Deletes the taken-over annotations that no object stands for any more and
 * works out where each edited object goes. Call after the pages are in
 * place and before the objects are written.
 */
export function prepareFileAnnotEdits(planned: PlannedAnnotPage[], objects: EditorObject[]): FileAnnotEdits {
  const skip = new Set<string>();
  const targets = new Map<string, PDFRef>();
  // All targets first: a copied page finds its annotations by their place in the original page's /Annots.
  const work: Array<{ ref: PageRef; page: PDFPage; resolved: Array<{ id: string; target: PDFRef | null }> }> = [];
  for (const { ref, page, origin, copies } of planned) {
    if (!ref.takenAnnots?.length || !origin) continue;
    const annots = annotsOf(page);
    const originAnnots = annotsOf(origin);
    if (!annots || !originAnnots) continue;
    const resolve = (id: string): PDFRef | null => {
      const r = parseAnnotId(id);
      if (!r) return null;
      if (origin === page) return indexOfRef(annots, r) >= 0 ? r : null;
      if (copies) return copies.get(r.toString()) ?? null;
      // A copied page: same position in its /Annots.
      const k = indexOfRef(originAnnots, r);
      const copy = k >= 0 ? annots.get(k) : undefined;
      return copy instanceof PDFRef ? copy : null;
    };
    work.push({ ref, page, resolved: ref.takenAnnots.map((id) => ({ id, target: resolve(id) })) });
  }
  for (const { ref, page, resolved } of work) {
    for (const { id, target } of resolved) {
      if (!target) continue;
      const adopter = objects.find((o) => o.pageId === ref.id && o.fileAnnot?.ref === id && !targets.has(o.id) && !skip.has(o.id));
      if (!adopter) deleteAnnotation(page, target);
      else if (isUntouched(adopter)) skip.add(adopter.id);
      else targets.set(adopter.id, target);
    }
  }
  return {
    skip: (o) => skip.has(o.id),
    write: (doc, page, pm, o) => {
      if (!o.fileAnnot) return false;
      switch (o.type) {
        case 'rect':
        case 'ellipse':
          writeShape(doc, page, pm, o);
          return true;
        case 'line':
        case 'arrow':
          writeLineAnnot(doc, page, pm, o);
          return true;
        case 'vector':
          if (o.fileAnnot.subtype !== 'Ink') return false;
          writeInk(doc, page, pm, o);
          return true;
        case 'stamp':
          // Into its original: only the place changes. Elsewhere (a copy) the picture is written as a new stamp.
          if (!targets.has(o.id)) return false;
          writeStampPlace(doc, page, pm, o, targets.get(o.id)!);
          return true;
        default:
          return false;
      }
    },
    adopt: (doc, page, o, before) => {
      const target = targets.get(o.id);
      if (!target) return null;
      mergeIntoOriginal(doc, page, before, target);
      return target;
    },
  };
}
