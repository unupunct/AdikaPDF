/**
 * The visible area of a page as pdf.js shows it (and as the app's page sizes
 * are measured): the CropBox clipped to the MediaBox; an empty or invalid box
 * falls back to the MediaBox, and that to US Letter. pdf-lib's getCropBox()
 * takes the CropBox as written, so display coordinates mapped through it miss
 * on pages whose CropBox reaches past the MediaBox.
 */
import { PDFArray, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Quad = [number, number, number, number];

function box(page: PDFPage, name: 'MediaBox' | 'CropBox'): Quad | null {
  let v: unknown;
  try {
    v = page.node.getInheritableAttribute(PDFName.of(name));
    v = v === undefined ? undefined : page.doc.context.lookup(v as never);
  } catch {
    return null;
  }
  if (!(v instanceof PDFArray) || v.size() !== 4) return null;
  const n: number[] = [];
  for (let i = 0; i < 4; i++) {
    const x = page.doc.context.lookup(v.get(i));
    if (!(x instanceof PDFNumber) || !Number.isFinite(x.asNumber())) return null;
    n.push(x.asNumber());
  }
  const q: Quad = [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  return q[2] - q[0] > 0 && q[3] - q[1] > 0 ? q : null;
}

export function viewBox(page: PDFPage): ViewBox {
  const media = box(page, 'MediaBox') ?? [0, 0, 612, 792];
  const crop = box(page, 'CropBox');
  let v: Quad = media;
  if (crop) {
    const i: Quad = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
    if (i[2] - i[0] > 0 && i[3] - i[1] > 0) v = i;
  }
  return { x: v[0], y: v[1], width: v[2] - v[0], height: v[3] - v[1] };
}
