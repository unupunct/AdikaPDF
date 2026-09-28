/**
 * PDF annotations for the Acrobat/Foxit comment tools beyond notes and
 * markup, each with an appearance stream so every viewer draws it:
 *  - StampObject      → /Stamp (word box with an optional second line, or a picture)
 *  - PolyObject       → /Polygon, /PolyLine, or /Square with a cloudy border (/BE /S /C)
 *  - AttachmentObject → /FileAttachment carrying an embedded file
 *  - LinkObject       → /Link to a URL or to a page of the document
 *  - MeasureObject    → /Line, /PolyLine or /Polygon with a /Measure dictionary (Acrobat measurements)
 */
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  appendBezierCurve,
  beginText,
  closePath,
  drawObject,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveText,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
  LineJoinStyle,
  concatTransformationMatrix,
  type PDFOperator,
} from 'pdf-lib';
import type { AttachmentObject, LinkObject, MeasureObject, PolyObject, StampObject } from '@/types';
import { measureValue, realPerPoint, scaleText } from '@/lib/measure';
import { applyMatrix, multiply, rotateCw, transformRectBounds, translate, type Matrix } from '@/lib/geometry';
import { cloudScallops } from '@/lib/cloud';
import { addToPage, appearance, hexToRgbTuple, linear, pdfDate, text, transparency } from './annotations';

/** Local (display, y-down) frame of an object → PDF user space, and the y-up appearance frame for a w × h box. */
function frames(pm: Matrix, o: { x: number; y: number; rotation: number }, h: number): { local: Matrix; flipped: Matrix } {
  const local = multiply(pm, multiply(translate(o.x, o.y), rotateCw(o.rotation)));
  return { local, flipped: multiply(local, [1, 0, 0, -1, 0, h]) };
}

function commentDict(o: { id: string; author: string; createdAt: string; modifiedAt: string }, contents: string) {
  return {
    Contents: text(contents),
    T: text(o.author),
    M: PDFString.of(pdfDate(o.modifiedAt)),
    CreationDate: PDFString.of(pdfDate(o.createdAt)),
    NM: PDFString.of(o.id),
  };
}

// ------------------------------------------------------------------ stamp

/** Largest font size (≤ max) at which `s` fits in `width`. */
function fitSize(font: PDFFont, s: string, width: number, max: number): number {
  const w = font.widthOfTextAtSize(s, max);
  return w > width ? Math.max(4, (max * width) / w) : max;
}

export function writeStamp(doc: PDFDocument, page: PDFPage, pm: Matrix, o: StampObject, font: PDFFont, bold: PDFFont, image: PDFImage | null): void {
  const { width: w, height: h } = o;
  const { local, flipped } = frames(pm, o, h);
  const r = transformRectBounds(local, { x: 0, y: 0, width: w, height: h });
  const color = hexToRgbTuple(o.color);
  const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(PDFName.of('GS0'))];
  const resources: { ExtGState: { GS0: PDFRef }; XObject?: { Im0: PDFRef }; Font?: { F1: PDFRef; F2: PDFRef } } = { ExtGState: { GS0: transparency(doc, o.opacity) } };
  if (image) {
    ops.push(concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject(PDFName.of('Im0')));
    resources.XObject = { Im0: image.ref };
  } else {
    // Rounded double-line frame with the word (and the second line) centred, like Acrobat's stamps.
    const rad = Math.min(8, h / 4);
    const box = (inset: number) => {
      const x0 = inset;
      const y0 = inset;
      const x1 = w - inset;
      const y1 = h - inset;
      const k = rad * 0.5523;
      return [
        moveTo(x0 + rad, y0),
        lineTo(x1 - rad, y0),
        appendBezierCurve(x1 - rad + k, y0, x1, y0 + rad - k, x1, y0 + rad),
        lineTo(x1, y1 - rad),
        appendBezierCurve(x1, y1 - rad + k, x1 - rad + k, y1, x1 - rad, y1),
        lineTo(x0 + rad, y1),
        appendBezierCurve(x0 + rad - k, y1, x0, y1 - rad + k, x0, y1 - rad),
        lineTo(x0, y0 + rad),
        appendBezierCurve(x0, y0 + rad - k, x0 + rad - k, y0, x0 + rad, y0),
        closePath(),
      ];
    };
    ops.push(setStrokingRgbColor(...color), setLineWidth(2), ...box(1.5), stroke(), setLineWidth(0.75), ...box(4), stroke());
    ops.push(setFillingRgbColor(...color));
    const inner = w - 14;
    const mainSize = fitSize(bold, o.label, inner, o.subtitle ? h * 0.42 : h * 0.55);
    const mainW = bold.widthOfTextAtSize(o.label, mainSize);
    const mainY = o.subtitle ? h * 0.46 : (h - mainSize * 0.7) / 2;
    ops.push(beginText(), setFontAndSize(PDFName.of('F2'), mainSize), moveText((w - mainW) / 2, mainY), showText(bold.encodeText(o.label)), endText());
    if (o.subtitle) {
      const subSize = fitSize(font, o.subtitle, inner, h * 0.2);
      const subW = font.widthOfTextAtSize(o.subtitle, subSize);
      ops.push(beginText(), setFontAndSize(PDFName.of('F1'), subSize), moveText((w - subW) / 2, h * 0.18), showText(font.encodeText(o.subtitle)), endText());
    }
    resources.Font = { F1: font.ref, F2: bold.ref };
  }
  ops.push(popGraphicsState());
  const ap = appearance(doc, ops, [0, 0, w, h], linear(flipped), doc.context.obj(resources));
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Stamp',
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      Name: o.name || 'Draft',
      C: color,
      CA: o.opacity,
      Subj: text(o.label || 'Stamp'),
      ...commentDict(o, o.text || [o.label, o.subtitle].filter(Boolean).join(' – ')),
      F: 4,
      P: page.ref,
      AP: { N: ap },
    }),
  );
  addToPage(doc, page, ref);
}

// ------------------------------------------------------------------ polygon, polyline, cloud

export function writePoly(doc: PDFDocument, page: PDFPage, pm: Matrix, o: PolyObject): void {
  const { local } = frames(pm, o, o.height);
  const pad = o.strokeWidth + (o.kind === 'cloud' ? 8 : 1);
  const r = transformRectBounds(local, { x: -pad, y: -pad, width: o.width + pad * 2, height: o.height + pad * 2 });
  const stroke_ = hexToRgbTuple(o.stroke);
  const fill_ = o.fill ? hexToRgbTuple(o.fill) : null;
  // The appearance is drawn directly in PDF user space (identity /Matrix), from the page-space points.
  const P = (x: number, y: number) => applyMatrix(local, x, y);
  const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(PDFName.of('GS0')), setLineWidth(o.strokeWidth), setLineJoin(LineJoinStyle.Round), setStrokingRgbColor(...stroke_)];
  if (fill_) ops.push(setFillingRgbColor(...fill_));
  const extra: Record<string, unknown> = {};
  let subtype: string;
  if (o.kind === 'cloud') {
    subtype = 'Square';
    const s = cloudScallops(o.width, o.height, Math.max(10, o.strokeWidth * 6));
    if (s.length) {
      ops.push(moveTo(...P(s[0].x0, s[0].y0)));
      for (const c of s) ops.push(appendBezierCurve(...P(c.c1x, c.c1y), ...P(c.c2x, c.c2y), ...P(c.x, c.y)));
      ops.push(closePath(), fill_ ? fillAndStroke() : stroke());
    }
    extra.BE = { S: 'C', I: 1 };
    const inner = transformRectBounds(local, { x: 0, y: 0, width: o.width, height: o.height });
    extra.RD = [inner.x - r.x, inner.y - r.y, r.x + r.width - (inner.x + inner.width), r.y + r.height - (inner.y + inner.height)];
  } else {
    subtype = o.kind === 'polygon' ? 'Polygon' : 'PolyLine';
    const vertices: number[] = [];
    for (let i = 0; i + 1 < o.points.length; i += 2) vertices.push(...P(o.points[i], o.points[i + 1]));
    extra.Vertices = vertices;
    if (vertices.length >= 4) {
      ops.push(moveTo(vertices[0], vertices[1]));
      for (let i = 2; i < vertices.length; i += 2) ops.push(lineTo(vertices[i], vertices[i + 1]));
      if (o.kind === 'polygon') ops.push(closePath(), fill_ ? fillAndStroke() : stroke());
      else ops.push(stroke());
    }
  }
  ops.push(popGraphicsState());
  const bbox: [number, number, number, number] = [r.x, r.y, r.x + r.width, r.y + r.height];
  const ap = appearance(doc, ops, bbox, [1, 0, 0, 1, 0, 0], doc.context.obj({ ExtGState: { GS0: transparency(doc, o.opacity) } }));
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: bbox,
      C: stroke_,
      ...(fill_ ? { IC: fill_ } : {}),
      CA: o.opacity,
      BS: { W: o.strokeWidth, S: 'S' },
      ...extra,
      ...commentDict(o, o.text),
      F: 4,
      P: page.ref,
      AP: { N: ap },
    }),
  );
  addToPage(doc, page, ref);
}

// ------------------------------------------------------------------ file attachment

/** A paperclip in a 16 × 20 box (y up). */
function paperclipOps(color: [number, number, number]): PDFOperator[] {
  return [
    pushGraphicsState(),
    setStrokingRgbColor(...color),
    setLineWidth(1.6),
    moveTo(10.5, 5),
    lineTo(10.5, 14),
    appendBezierCurve(10.5, 18.5, 4.5, 18.5, 4.5, 14),
    lineTo(4.5, 4.5),
    appendBezierCurve(4.5, 1.2, 8.5, 1.2, 8.5, 4.5),
    lineTo(8.5, 13),
    appendBezierCurve(8.5, 14.8, 6.5, 14.8, 6.5, 13),
    lineTo(6.5, 6),
    stroke(),
    popGraphicsState(),
  ];
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function writeAttachment(doc: PDFDocument, page: PDFPage, pm: Matrix, o: AttachmentObject): void {
  const { local, flipped } = frames(pm, o, o.height);
  const r = transformRectBounds(local, { x: 0, y: 0, width: o.width, height: o.height });
  const color = hexToRgbTuple(o.color);
  const bytes = base64Bytes(o.data);
  const now = pdfDate(o.modifiedAt);
  const file = doc.context.register(
    doc.context.flateStream(bytes, {
      Type: 'EmbeddedFile',
      ...(o.mime ? { Subtype: o.mime } : {}),
      Params: { Size: bytes.length, ModDate: PDFString.of(now) },
    }),
  );
  const spec = doc.context.register(
    doc.context.obj({ Type: 'Filespec', F: text(o.fileName), UF: text(o.fileName), Desc: text(o.text), EF: { F: file, UF: file } }),
  );
  const scale: Matrix = [o.width / 16, 0, 0, o.height / 20, 0, 0];
  const ap = appearance(doc, paperclipOps(color), [0, 0, 16, 20], linear(multiply(flipped, scale)));
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      FS: spec,
      Name: 'Paperclip',
      C: color,
      ...commentDict(o, o.text || o.fileName),
      F: 28, // Print | NoZoom | NoRotate
      P: page.ref,
      AP: { N: ap },
    }),
  );
  addToPage(doc, page, ref);
}

// ------------------------------------------------------------------ link

/** Invisible link area; `target` is the destination page for page links (null if that page was removed). */
export function writeLink(doc: PDFDocument, page: PDFPage, pm: Matrix, o: LinkObject, target: PDFPage | null): void {
  const { local } = frames(pm, o, o.height);
  const r = transformRectBounds(local, { x: 0, y: 0, width: o.width, height: o.height });
  let action: Record<string, unknown> | null = null;
  if (o.target.kind === 'url') {
    const url = o.target.url.trim();
    if (!url) return;
    action = { A: { Type: 'Action', S: 'URI', URI: PDFString.of(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`) } };
  } else {
    if (!target) return;
    action = { Dest: [target.ref, PDFName.of('Fit')] };
  }
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      Border: [0, 0, 0],
      H: 'I',
      NM: PDFString.of(o.id),
      F: 4,
      P: page.ref,
      ...action,
    }),
  );
  addToPage(doc, page, ref);
}

// ------------------------------------------------------------------ measurement

const MEASURE_INTENT = { distance: 'LineDimension', perimeter: 'PolyLineDimension', area: 'PolygonDimension' } as const;

/** Where the value label goes (display-local): middle of a distance, end of a perimeter, centre of an area. */
export function measureLabelAnchor(kind: MeasureObject['kind'], pts: number[]): { x: number; y: number } {
  const n = Math.floor(pts.length / 2);
  if (kind === 'distance') return { x: (pts[0] + pts[2]) / 2, y: (pts[1] + pts[3]) / 2 };
  if (kind === 'perimeter') return { x: pts[(n - 1) * 2], y: pts[(n - 1) * 2 + 1] };
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += pts[i * 2];
    y += pts[i * 2 + 1];
  }
  return { x: x / n, y: y / n };
}

export const MEASURE_LABEL_SIZE = 9;

/** Label position relative to its anchor (display-local, top-left of the text box). */
export function measureLabelOffset(kind: MeasureObject['kind'], labelWidth: number): { x: number; y: number } {
  if (kind === 'perimeter') return { x: 6, y: -MEASURE_LABEL_SIZE - 4 };
  if (kind === 'distance') return { x: -labelWidth / 2, y: -MEASURE_LABEL_SIZE - 6 };
  return { x: -labelWidth / 2, y: -MEASURE_LABEL_SIZE / 2 };
}

export function writeMeasure(doc: PDFDocument, page: PDFPage, pm: Matrix, o: MeasureObject, font: PDFFont): void {
  const { local } = frames(pm, o, o.height);
  const P = (x: number, y: number) => applyMatrix(local, x, y);
  const n = Math.floor(o.points.length / 2);
  if (n < 2) return;
  const vertices: number[] = [];
  for (let i = 0; i < n; i++) vertices.push(...P(o.points[i * 2], o.points[i * 2 + 1]));
  const { label } = measureValue(o.kind, o.points, o.scale);
  const color = hexToRgbTuple(o.stroke);
  const size = MEASURE_LABEL_SIZE;
  const labelW = font.widthOfTextAtSize(label, size);
  const ops: PDFOperator[] = [pushGraphicsState(), setLineWidth(o.strokeWidth), setLineJoin(LineJoinStyle.Round), setStrokingRgbColor(...color)];
  ops.push(moveTo(vertices[0], vertices[1]));
  for (let i = 1; i < n; i++) ops.push(lineTo(vertices[i * 2], vertices[i * 2 + 1]));
  if (o.kind === 'area') ops.push(closePath());
  ops.push(stroke());
  if (o.kind === 'distance') {
    // Tick marks across both ends.
    const [x1, y1, x2, y2] = vertices;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = (-(y2 - y1) / len) * 5;
    const ny = ((x2 - x1) / len) * 5;
    ops.push(moveTo(x1 - nx, y1 - ny), lineTo(x1 + nx, y1 + ny), moveTo(x2 - nx, y2 - ny), lineTo(x2 + nx, y2 + ny), stroke());
  }
  // The value, upright as the page is seen: white box + text, drawn in the display frame (y flipped per glyph line).
  const at = measureLabelAnchor(o.kind, o.points);
  const off = measureLabelOffset(o.kind, labelW);
  const boxTopLeft = { x: at.x + off.x, y: at.y + off.y };
  const lm = multiply(local, multiply(translate(boxTopLeft.x, boxTopLeft.y + size), [1, 0, 0, -1, 0, 0]));
  ops.push(
    pushGraphicsState(),
    concatTransformationMatrix(...lm),
    setFillingRgbColor(1, 1, 1),
    rectangle(-2, -2.5, labelW + 4, size + 3),
    fill(),
    setFillingRgbColor(...color),
    beginText(),
    setFontAndSize(PDFName.of('F1'), size),
    moveText(0, 0),
    showText(font.encodeText(label)),
    endText(),
    popGraphicsState(),
  );
  ops.push(popGraphicsState());
  const lb = transformRectBounds(local, { x: boxTopLeft.x - 3, y: boxTopLeft.y - 3, width: labelW + 6, height: size + 6 });
  const xs = [...vertices.filter((_, i) => i % 2 === 0), lb.x, lb.x + lb.width];
  const ys = [...vertices.filter((_, i) => i % 2 === 1), lb.y, lb.y + lb.height];
  const pad = 6;
  const bbox: [number, number, number, number] = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  const ap = appearance(doc, ops, bbox, [1, 0, 0, 1, 0, 0], doc.context.obj({ Font: { F1: font.ref } }));
  // /Measure (PDF 32000 12.9): X converts user-space units to real units; D and A format distances and areas.
  const k = realPerPoint(o.scale);
  const fmt = (unit: string, c: number) => ({ Type: 'NumberFormat', U: text(unit), C: c, D: 100, SS: text(' ') });
  const measure = { Type: 'Measure', Subtype: 'RL', R: text(scaleText(o.scale)), X: [fmt(o.scale.realUnit, k)], D: [fmt(o.scale.realUnit, 1)], A: [fmt(`${o.scale.realUnit}²`, 1)] };
  const geometry = o.kind === 'distance' ? { L: vertices, LE: ['Butt', 'Butt'], Cap: true } : { Vertices: vertices };
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: o.kind === 'distance' ? 'Line' : o.kind === 'perimeter' ? 'PolyLine' : 'Polygon',
      Rect: bbox,
      IT: MEASURE_INTENT[o.kind],
      ...geometry,
      Measure: measure,
      C: color,
      BS: { W: o.strokeWidth, S: 'S' },
      Subj: text(o.kind === 'distance' ? 'Distance' : o.kind === 'perimeter' ? 'Perimeter' : 'Area'),
      ...commentDict(o, o.text ? `${label}\n${o.text}` : label),
      F: 4,
      P: page.ref,
      AP: { N: ap },
    }),
  );
  addToPage(doc, page, ref);
}
