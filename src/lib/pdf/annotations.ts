/**
 * Writes comments as real PDF annotations, so Acrobat, Foxit, Edge and
 * others can show, reply to, edit or delete them:
 *  - NoteObject        → /Text (sticky note) + /Popup
 *  - MarkupObject      → /Highlight, /Underline, /StrikeOut, /Squiggly with QuadPoints
 *  - TextObject.annotation (typewriter, text box, callout) → /FreeText
 * Every annotation gets an appearance stream (/AP /N) so it renders the same
 * everywhere, including apps that do not generate appearances themselves.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  beginText,
  closePath,
  endText,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
  moveText,
  type PDFOperator,
} from 'pdf-lib';
import type { MarkupObject, NoteObject, TextObject } from '@/types';
import { applyMatrix, multiply, rotateCw, transformRectBounds, translate, type Matrix } from '@/lib/geometry';
import { layoutText, type Measure } from '@/lib/textLayout';

type RGB = [number, number, number];

export function hexToRgbTuple(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** PDF date string: D:YYYYMMDDHHmmSS+HH'mm' */
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `D:${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

export function text(s: string): PDFHexString {
  return PDFHexString.fromText(s);
}

export function addToPage(doc: PDFDocument, page: PDFPage, ref: PDFRef): void {
  let annots = page.node.Annots();
  if (!annots) {
    annots = doc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
}

/** Linear part of a matrix (the appearance /Matrix; translation comes from /Rect). */
export function linear(m: Matrix): Matrix {
  return [m[0], m[1], m[2], m[3], 0, 0];
}

export function appearance(doc: PDFDocument, ops: PDFOperator[], bbox: [number, number, number, number], matrix: Matrix, resources?: PDFDict): PDFRef {
  const stream = doc.context.formXObject(ops, {
    BBox: bbox,
    Matrix: matrix,
    Resources: resources ?? doc.context.obj({}),
  });
  return doc.context.register(stream);
}

export function transparency(doc: PDFDocument, opacity: number, blend: 'Normal' | 'Multiply' = 'Normal'): PDFRef {
  return doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity, BM: blend }));
}

// ------------------------------------------------------------------ sticky note

/** A speech-bubble icon in a 20×20 box (y up). */
function noteIconOps(color: RGB): PDFOperator[] {
  return [
    pushGraphicsState(),
    setFillingRgbColor(...color),
    setStrokingRgbColor(0.25, 0.25, 0.25),
    setLineWidth(0.8),
    moveTo(2, 18),
    lineTo(18, 18),
    lineTo(18, 6),
    lineTo(9, 6),
    lineTo(5, 2),
    lineTo(5, 6),
    lineTo(2, 6),
    closePath(),
    fill(),
    moveTo(2, 18),
    lineTo(18, 18),
    lineTo(18, 6),
    lineTo(9, 6),
    lineTo(5, 2),
    lineTo(5, 6),
    lineTo(2, 6),
    closePath(),
    stroke(),
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

export function writeNote(doc: PDFDocument, page: PDFPage, pm: Matrix, o: NoteObject): void {
  const m = multiply(pm, multiply(translate(o.x, o.y), [1, 0, 0, -1, 0, 20]));
  const r = transformRectBounds(multiply(pm, translate(o.x, o.y)), { x: 0, y: 0, width: 20, height: 20 });
  const color = hexToRgbTuple(o.color);
  const ap = appearance(doc, noteIconOps(color), [0, 0, 20, 20], linear(m));
  const noteRef = doc.context.nextRef();
  const popupRef = doc.context.nextRef();
  doc.context.assign(
    noteRef,
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      Contents: text(o.text),
      T: text(o.author),
      M: PDFString.of(pdfDate(o.modifiedAt)),
      CreationDate: PDFString.of(pdfDate(o.createdAt)),
      NM: PDFString.of(o.id),
      C: color,
      Name: 'Comment',
      Open: false,
      F: 28, // Print | NoZoom | NoRotate
      P: page.ref,
      Popup: popupRef,
      AP: { N: ap },
    }),
  );
  const pw = 200;
  const ph = 110;
  doc.context.assign(
    popupRef,
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Popup',
      Rect: [r.x + r.width, r.y + r.height - ph, r.x + r.width + pw, r.y + r.height],
      Parent: noteRef,
      Open: false,
      F: 28,
      P: page.ref,
    }),
  );
  addToPage(doc, page, noteRef);
  addToPage(doc, page, popupRef);
}

// ------------------------------------------------------------------ text markup

const MARKUP_SUBTYPE = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' } as const;

export function writeMarkup(doc: PDFDocument, page: PDFPage, pm: Matrix, o: MarkupObject): void {
  const base = translate(o.x, o.y);
  const color = hexToRgbTuple(o.color);
  const quadPoints: number[] = [];
  const ops: PDFOperator[] = [pushGraphicsState()];
  const gs = o.kind === 'highlight' ? transparency(doc, 0.4 * o.opacity + 0.0, 'Multiply') : transparency(doc, o.opacity);
  ops.push(setGraphicsState(PDFName.of('GS0')));
  if (o.kind === 'highlight') ops.push(setFillingRgbColor(...color));
  else ops.push(setStrokingRgbColor(...color));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of o.quads) {
    // Corners in display space → PDF space. QuadPoints order: TL, TR, BL, BR (reader convention).
    const m = multiply(pm, base);
    const tl = applyMatrix(m, q.x, q.y);
    const tr = applyMatrix(m, q.x + q.width, q.y);
    const bl = applyMatrix(m, q.x, q.y + q.height);
    const br = applyMatrix(m, q.x + q.width, q.y + q.height);
    quadPoints.push(tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1]);
    for (const p of [tl, tr, bl, br]) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    const thickness = Math.max(0.6, q.height * 0.07);
    const at = (fx: number, fy: number) => {
      // Point at fraction fx along the line, fy down the line (display), in PDF space.
      const x = q.x + q.width * fx;
      const y = q.y + q.height * fy;
      return applyMatrix(m, x, y);
    };
    if (o.kind === 'highlight') {
      ops.push(moveTo(...tl), lineTo(...tr), lineTo(...br), lineTo(...bl), closePath(), fill());
    } else if (o.kind === 'underline' || o.kind === 'strikeout') {
      const fy = o.kind === 'underline' ? 0.93 : 0.55;
      ops.push(setLineWidth(thickness), moveTo(...at(0, fy)), lineTo(...at(1, fy)), stroke());
    } else {
      // Squiggly: a zig-zag along the bottom of the line.
      const waves = Math.max(2, Math.round(q.width / Math.max(2, q.height * 0.25)));
      ops.push(setLineWidth(thickness));
      ops.push(moveTo(...at(0, 0.97)));
      for (let k = 1; k <= waves; k++) ops.push(lineTo(...at(k / waves, k % 2 ? 0.86 : 0.97)));
      ops.push(stroke());
    }
  }
  ops.push(popGraphicsState());
  if (!Number.isFinite(minX)) return;
  const pad = 1;
  const rect: [number, number, number, number] = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  const ap = appearance(doc, ops, rect, [1, 0, 0, 1, 0, 0], doc.context.obj({ ExtGState: { GS0: gs } }));
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: MARKUP_SUBTYPE[o.kind],
      Rect: rect,
      QuadPoints: quadPoints,
      C: color,
      CA: o.kind === 'highlight' ? 1 : o.opacity,
      Contents: text(o.text || o.selectedText),
      T: text(o.author),
      M: PDFString.of(pdfDate(o.modifiedAt)),
      CreationDate: PDFString.of(pdfDate(o.createdAt)),
      NM: PDFString.of(o.id),
      F: 4, // Print
      P: page.ref,
      AP: { N: ap },
    }),
  );
  addToPage(doc, page, ref);
}

// ------------------------------------------------------------------ typewriter, text box, callout

/** Where a callout's leader line leaves the box: the box point nearest the anchor (local display coords). */
export function calloutKnee(w: number, h: number, anchor: { x: number; y: number }): { x: number; y: number } {
  const x = Math.min(w, Math.max(0, anchor.x));
  const y = Math.min(h, Math.max(0, anchor.y));
  if (x > 0 && x < w && y > 0 && y < h) return { x: 0, y: h / 2 }; // anchor inside the box
  // Leave from the middle of the nearest side.
  if (anchor.x < 0) return { x: 0, y: Math.min(h, Math.max(0, h / 2)) };
  if (anchor.x > w) return { x: w, y: h / 2 };
  return { x: w / 2, y: anchor.y < 0 ? 0 : h };
}

export function writeFreeText(doc: PDFDocument, page: PDFPage, pm: Matrix, o: TextObject, font: PDFFont, measure: Measure): void {
  const layout = layoutText(o, measure);
  const h = Math.max(o.height, layout.contentHeight);
  const local = multiply(pm, multiply(translate(o.x, o.y), rotateCw(o.rotation)));
  const frame = multiply(local, [1, 0, 0, -1, 0, h]);
  const anchor = o.callout ?? null;
  // The appearance covers the box and, for callouts, the leader line (display-local coordinates).
  const pad = anchor ? 4 : 0;
  const bx0 = anchor ? Math.min(0, anchor.x) - pad : 0;
  const by0 = anchor ? Math.min(0, anchor.y) - pad : 0;
  const bx1 = anchor ? Math.max(o.width, anchor.x) + pad : o.width;
  const by1 = anchor ? Math.max(h, anchor.y) + pad : h;
  const r = transformRectBounds(local, { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0 });
  const color = hexToRgbTuple(o.color);
  const fontName = PDFName.of('F1');
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (o.background) ops.push(setFillingRgbColor(...hexToRgbTuple(o.background)), rectangle(0, 0, o.width, h), fill());
  const border = o.border ? hexToRgbTuple(o.border) : null;
  if (border) ops.push(setStrokingRgbColor(...border), setLineWidth(1), rectangle(0.5, 0.5, o.width - 1, h - 1), stroke());
  if (anchor) {
    // Leader line in the appearance frame (y up): knee on the box edge → anchor, with an open arrow head.
    const knee = calloutKnee(o.width, h, anchor);
    const ax = anchor.x;
    const ay = h - anchor.y;
    const kx = knee.x;
    const ky = h - knee.y;
    const ang = Math.atan2(ay - ky, ax - kx);
    const len = 7;
    const lc = border ?? color;
    ops.push(setStrokingRgbColor(...lc), setLineWidth(1), moveTo(kx, ky), lineTo(ax, ay), stroke());
    ops.push(
      moveTo(ax - len * Math.cos(ang - 0.45), ay - len * Math.sin(ang - 0.45)),
      lineTo(ax, ay),
      lineTo(ax - len * Math.cos(ang + 0.45), ay - len * Math.sin(ang + 0.45)),
      stroke(),
    );
  }
  ops.push(setFillingRgbColor(...color));
  for (const line of layout.lines) {
    if (!line.text) continue;
    ops.push(beginText(), setFontAndSize(fontName, o.fontSize), moveText(line.x, h - line.baseline), showText(font.encodeText(line.text)), endText());
  }
  ops.push(popGraphicsState());
  const gsRef = o.opacity < 1 ? transparency(doc, o.opacity) : null;
  if (gsRef) ops.unshift(setGraphicsState(PDFName.of('GS0')));
  // BBox in the flipped appearance frame: display-local y maps to h - y.
  const bbox: [number, number, number, number] = [bx0, h - by1, bx1, h - by0];
  const ap = appearance(doc, ops, bbox, linear(frame), doc.context.obj(gsRef ? { Font: { F1: font.ref }, ExtGState: { GS0: gsRef } } : { Font: { F1: font.ref } }));
  const [cr, cg, cb] = color;
  const intent = anchor ? 'FreeTextCallout' : border ? null : 'FreeTextTypeWriter';
  const extra: Record<string, unknown> = {};
  if (anchor) {
    const knee = calloutKnee(o.width, h, anchor);
    const toPage = (x: number, y: number) => applyMatrix(local, x, y);
    const [a0, a1] = toPage(anchor.x, anchor.y);
    const [k0, k1] = toPage(knee.x, knee.y);
    extra.CL = [a0, a1, k0, k1];
    extra.LE = 'OpenArrow';
    const box = transformRectBounds(local, { x: 0, y: 0, width: o.width, height: h });
    // RD: how far the text box lies inside Rect on each side (left, bottom, right, top).
    extra.RD = [box.x - r.x, box.y - r.y, r.x + r.width - (box.x + box.width), r.y + r.height - (box.y + box.height)];
  }
  if (o.background) extra.IC = hexToRgbTuple(o.background);
  if (border) extra.C = border;
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      Contents: text(o.text),
      T: text(o.author ?? ''),
      M: PDFString.of(pdfDate(new Date().toISOString())),
      NM: PDFString.of(o.id),
      // Default appearance lets other apps re-flow the text when edited.
      DA: PDFString.of(`${cr.toFixed(3)} ${cg.toFixed(3)} ${cb.toFixed(3)} rg /Helv ${o.fontSize} Tf`),
      Q: o.align === 'center' ? 1 : o.align === 'right' ? 2 : 0,
      ...(intent ? { IT: intent } : {}),
      BS: { W: border ? 1 : 0 },
      ...extra,
      F: 4,
      P: page.ref,
      AP: { N: ap },
    }),
  );
  addToPage(doc, page, ref);
}

export { rgb };
