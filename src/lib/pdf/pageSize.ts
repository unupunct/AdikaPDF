/**
 * Page size (Acrobat "Set Page Boxes" / PDF-XChange "Resize pages"): pages
 * get a paper size. "fit" scales the content to fit (centred, aspect kept),
 * "canvas" keeps the content at its size and grows or crops the page around
 * it. Sizes are as the user sees the page (after /Rotate). Comments and
 * form fields move with the content.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, concatTransformationMatrix, popGraphicsState, pushGraphicsState } from 'pdf-lib';

export const PAPER_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  B5: [498.9, 708.66],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

export interface PageSizeOptions {
  /** Width and height as displayed, points. */
  size: [number, number];
  /** Turn the paper to match each page's orientation (portrait / landscape). */
  matchOrientation: boolean;
  mode: 'fit' | 'canvas';
  /** Space kept around scaled content, points (fit only). */
  margin?: number;
  /** 1-based; all pages when undefined. */
  pages?: number[];
}

type M = [number, number, number, number, number, number];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Moves an annotation's geometry (Rect, QuadPoints, InkList, Vertices, L, CL) by `m` (scale + translate). */
function moveAnnot(a: PDFDict, m: M): void {
  const nums = (arr: PDFArray) => arr.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
  const setPairs = (key: string) => {
    const v = a.lookup(PDFName.of(key));
    if (!(v instanceof PDFArray)) return;
    const n = nums(v);
    const out: number[] = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push(...apply(m, n[i], n[i + 1]));
    a.set(PDFName.of(key), a.context.obj(out));
  };
  const r = a.lookup(PDFName.of('Rect'));
  if (r instanceof PDFArray && r.size() === 4) {
    const [x0, y0, x1, y1] = nums(r);
    const p = apply(m, x0, y0);
    const q = apply(m, x1, y1);
    a.set(PDFName.of('Rect'), a.context.obj([Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])]));
  }
  for (const k of ['QuadPoints', 'Vertices', 'L', 'CL']) setPairs(k);
  const ink = a.lookup(PDFName.of('InkList'));
  if (ink instanceof PDFArray)
    a.set(
      PDFName.of('InkList'),
      a.context.obj(
        ink.asArray().map((s) => {
          const n = s instanceof PDFArray ? nums(s) : [];
          const out: number[] = [];
          for (let i = 0; i + 1 < n.length; i += 2) out.push(...apply(m, n[i], n[i + 1]));
          return out;
        }),
      ),
    );
}

export function resizePage(doc: PDFDocument, page: PDFPage, o: PageSizeOptions): boolean {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const box = page.getCropBox();
  const sideways = rot === 90 || rot === 270;
  // Current size as seen; wanted size as seen (turned to the page's orientation if asked).
  const seenW = sideways ? box.height : box.width;
  const seenH = sideways ? box.width : box.height;
  let [tw, th] = o.size;
  if (o.matchOrientation && seenW > seenH !== tw > th) [tw, th] = [th, tw];
  // Back to the page's own (unrotated) axes.
  const [uw, uh] = sideways ? [th, tw] : [tw, th];
  if (Math.abs(uw - box.width) < 0.5 && Math.abs(uh - box.height) < 0.5) return false;
  let m: M;
  if (o.mode === 'fit') {
    const margin = Math.max(0, o.margin ?? 0);
    const s = Math.min((uw - 2 * margin) / box.width, (uh - 2 * margin) / box.height);
    if (!(s > 0)) return false;
    m = [s, 0, 0, s, (uw - box.width * s) / 2 - box.x * s, (uh - box.height * s) / 2 - box.y * s];
  } else {
    // Same scale: the content stays centred on the new page.
    m = [1, 0, 0, 1, (uw - box.width) / 2 - box.x, (uh - box.height) / 2 - box.y];
  }
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState(), concatTransformationMatrix(...m)]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i);
    if (a instanceof PDFDict) moveAnnot(a, m);
  }
  page.setMediaBox(0, 0, uw, uh);
  page.setCropBox(0, 0, uw, uh);
  for (const k of ['BleedBox', 'TrimBox', 'ArtBox']) page.node.delete(PDFName.of(k));
  return true;
}

export async function resizePages(bytes: Uint8Array, o: PageSizeOptions): Promise<{ bytes: Uint8Array; resized: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const wanted = o.pages ? new Set(o.pages) : null;
  let resized = 0;
  doc.getPages().forEach((p, i) => {
    if (wanted && !wanted.has(i + 1)) return;
    if (resizePage(doc, p, o)) resized++;
  });
  return { bytes: await doc.save({ useObjectStreams: true }), resized };
}
