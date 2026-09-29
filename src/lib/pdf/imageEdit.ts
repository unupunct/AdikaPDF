/**
 * Pictures already on a page: where each image XObject is drawn (its
 * transformation), and removing one drawing from the page content so the
 * picture can become an editable object.
 */
import { PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream, PDFRef } from 'pdf-lib';
import { pageContent, parseContent, resourcesOf } from './textRemoval';

type M = [number, number, number, number, number, number];
const mul = (A: M, B: M): M => [
  A[0] * B[0] + A[1] * B[2],
  A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2],
  A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4],
  A[4] * B[1] + A[5] * B[3] + B[5],
];

export interface Placement {
  /** Instruction index of the `Do` in the page content. */
  index: number;
  name: string;
  stream: PDFRawStream;
  /** Image space (unit square) -> PDF user space. */
  ctm: M;
}

/** Image XObjects drawn directly on the page, in drawing order (last = on top). */
export function imagePlacements(doc: PDFDocument, page: PDFPage): Placement[] {
  const instrs = parseContent(pageContent(doc, page));
  const xo = resourcesOf(page)?.lookup(PDFName.of('XObject'));
  const out: Placement[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  instrs.forEach((ins, index) => {
    if (ins.op === 'q') stack.push(ctm);
    else if (ins.op === 'Q') ctm = stack.pop() ?? ctm;
    else if (ins.op === 'cm') {
      const v = ins.args.map((a) => (a.k === 'n' ? a.v : 0));
      if (v.length === 6) ctm = mul(v as M, ctm);
    } else if (ins.op === 'Do' && ins.args[0]?.k === 'name' && xo instanceof PDFDict) {
      const name = ins.args[0].v;
      const ref = xo.get(PDFName.of(name));
      const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (s instanceof PDFRawStream && s.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) out.push({ index, name, stream: s, ctm });
    }
  });
  return out;
}

/** Removes one `Do` (by instruction index) from the page content. */
export function removePlacement(doc: PDFDocument, page: PDFPage, index: number): void {
  const src = pageContent(doc, page);
  const ins = parseContent(src)[index];
  if (!ins || ins.op !== 'Do') throw new Error('That picture is no longer on the page.');
  const out = new Uint8Array(src.length - (ins.end - ins.start));
  out.set(src.subarray(0, ins.start), 0);
  out.set(src.subarray(ins.end), ins.start);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
}

export interface ImageFrame {
  /** Top-left corner in display space, width / height along the picture's own axes, clockwise rotation. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/**
 * The picture's frame in display space (`toDisplay` maps PDF -> display).
 * Null when it is skewed or mirrored (it cannot become a plain image box).
 */
export function frameOf(ctm: M, toDisplay: (x: number, y: number) => [number, number]): ImageFrame | null {
  const ap = (u: number, v: number) => toDisplay(u * ctm[0] + v * ctm[2] + ctm[4], u * ctm[1] + v * ctm[3] + ctm[5]);
  // Image space: row 0 is at the top (unit y = 1).
  const tl = ap(0, 1);
  const tr = ap(1, 1);
  const bl = ap(0, 0);
  const xv = [tr[0] - tl[0], tr[1] - tl[1]];
  const yv = [bl[0] - tl[0], bl[1] - tl[1]];
  const width = Math.hypot(xv[0], xv[1]);
  const height = Math.hypot(yv[0], yv[1]);
  if (width < 0.5 || height < 0.5) return null;
  const skew = Math.abs(xv[0] * yv[0] + xv[1] * yv[1]) / (width * height);
  const cross = xv[0] * yv[1] - xv[1] * yv[0];
  if (skew > 0.02 || cross <= 0) return null;
  return { x: tl[0], y: tl[1], width, height, rotation: (Math.atan2(xv[1], xv[0]) * 180) / Math.PI };
}

/** Is a display point inside the frame? */
export function frameHit(f: ImageFrame, px: number, py: number): boolean {
  const a = (-f.rotation * Math.PI) / 180;
  const dx = px - f.x;
  const dy = py - f.y;
  const u = dx * Math.cos(a) - dy * Math.sin(a);
  const v = dx * Math.sin(a) + dy * Math.cos(a);
  return u >= 0 && u <= f.width && v >= 0 && v <= f.height;
}
