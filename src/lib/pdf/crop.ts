/**
 * Crop pages (Acrobat "Crop Pages"): shrink the visible box (/CropBox) by
 * margins given as the user sees the page, i.e. after its /Rotate.
 */
import { PDFDocument } from 'pdf-lib';

export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** PDF-space insets (from x0, y0, x1, y1 of the unrotated box) for on-screen margins of a page with `rotation`. */
export function marginsToInsets(m: CropMargins, rotation: number): { x0: number; y0: number; x1: number; y1: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90: // displayed clockwise: PDF left edge on top, PDF top edge on the right
      return { x0: m.top, y1: m.right, x1: m.bottom, y0: m.left };
    case 180:
      return { y0: m.top, x0: m.right, y1: m.bottom, x1: m.left };
    case 270:
      return { x1: m.top, y0: m.right, x0: m.bottom, y1: m.left };
    default:
      return { y1: m.top, x1: m.right, y0: m.bottom, x0: m.left };
  }
}

/**
 * Crops `pageNumbers` (1-based; all when undefined). A page too small for
 * the margins is left unchanged. Returns the new bytes and how many pages
 * were cropped.
 */
export async function cropPages(bytes: Uint8Array, margins: CropMargins, pageNumbers?: number[]): Promise<{ bytes: Uint8Array; cropped: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const wanted = pageNumbers ? new Set(pageNumbers) : null;
  let cropped = 0;
  pages.forEach((page, i) => {
    if (wanted && !wanted.has(i + 1)) return;
    const box = page.getCropBox();
    const ins = marginsToInsets(margins, page.getRotation().angle);
    const x0 = box.x + Math.max(0, ins.x0);
    const y0 = box.y + Math.max(0, ins.y0);
    const x1 = box.x + box.width - Math.max(0, ins.x1);
    const y1 = box.y + box.height - Math.max(0, ins.y1);
    if (x1 - x0 < 10 || y1 - y0 < 10) return;
    page.setCropBox(x0, y0, x1 - x0, y1 - y0);
    cropped++;
  });
  return { bytes: await doc.save({ useObjectStreams: true }), cropped };
}
