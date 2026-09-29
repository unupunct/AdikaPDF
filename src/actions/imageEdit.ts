/**
 * Edit → Edit image: click a picture that is already in the PDF. It is taken
 * out of the page content (the document is rewritten, undoable) and becomes
 * an image object that can be moved, resized, rotated, replaced or deleted.
 * JPEGs keep their original bytes; other pictures become lossless PNGs.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { uid } from '@/lib/uid';
import { displayToPdfMatrix, totalRotation, type Matrix } from '@/lib/geometry';
import { bytesToBase64 } from '@/lib/platform';
import type { ImageObject, PageRef } from '@/types';

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

async function pngDataUrl(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const url = c.toDataURL('image/png');
  c.width = c.height = 0;
  return url;
}

/** Lifts the topmost picture under (x, y) (display space) on `page`. Returns false when there is none. */
export async function liftImage(page: PageRef, x: number, y: number): Promise<boolean> {
  const s0 = usePDFStore.getState();
  if (s0.readOnlyReason) {
    s0.toast(s0.readOnlyReason, 'info');
    return false;
  }
  if (page.kind !== 'source' || !page.sourceId || !s0.sources[page.sourceId]) return false;
  const src = s0.sources[page.sourceId];
  const [{ PDFDocument }, { imagePlacements, frameOf, frameHit, removePlacement }, { readImage }, { dropUnreachableObjects }] = await Promise.all([
    import('pdf-lib'),
    import('@/lib/pdf/imageEdit'),
    import('@/lib/pdf/imageExport'),
    import('@/lib/pdf/prune'),
  ]);
  const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
  const pdfPage = doc.getPage(page.sourceIndex);
  const box = pdfPage.getCropBox();
  const inv = invert(displayToPdfMatrix(totalRotation(page), { x: box.x, y: box.y, width: box.width, height: box.height }));
  const toDisplay = (px: number, py: number): [number, number] => [px * inv[0] + py * inv[2] + inv[4], px * inv[1] + py * inv[3] + inv[5]];
  const placements = imagePlacements(doc, pdfPage);
  const hit = [...placements].reverse().find((p) => {
    const f = frameOf(p.ctm, toDisplay);
    return f && frameHit(f, x, y);
  });
  if (!hit) {
    const skewed = [...placements].reverse().some((p) => !frameOf(p.ctm, toDisplay));
    s0.toast(skewed ? 'This picture is skewed or mirrored and cannot be edited as a box.' : 'No picture found there. Click directly on a picture in the page.', 'info');
    return false;
  }
  const frame = frameOf(hit.ctm, toDisplay)!;
  const img = readImage(doc, hit.stream, 'image', page.sourceIndex + 1);
  if (!img || img.kind === 'jp2') {
    s0.toast('This picture is stored in a format that cannot be edited here (it stays as it is).', 'info');
    return false;
  }
  const srcUrl = img.kind === 'jpg' ? `data:image/jpeg;base64,${bytesToBase64(img.bytes!)}` : await pngDataUrl(img.rgba!, img.width, img.height);
  removePlacement(doc, pdfPage, hit.index);
  dropUnreachableObjects(doc);
  const bytes = await doc.save({ useObjectStreams: true });
  const { source } = await usePDFStore.getState().addSource(bytes, src.name);
  const s = usePDFStore.getState();
  const obj: ImageObject = {
    id: uid('obj'),
    type: 'image',
    pageId: page.id,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    rotation: ((Math.round(frame.rotation * 100) / 100) % 360 + 360) % 360,
    opacity: 1,
    src: srcUrl,
    crop: null,
    naturalWidth: img.width,
    naturalHeight: img.height,
  };
  const oldId = page.sourceId;
  const prefix = `${oldId}::`;
  s.commit((st) => ({
    pages: st.pages.map((p) => (p.sourceId === oldId ? { ...p, sourceId: source.id } : p)),
    fieldValues: Object.fromEntries(Object.entries(st.fieldValues).map(([k, v]) => [k.startsWith(prefix) ? `${source.id}::${k.slice(prefix.length)}` : k, v])),
    objects: [...st.objects, obj],
  }));
  usePDFStore.setState({ selectedIds: [obj.id], tool: 'select' });
  s.toast('The picture can now be moved, resized or rotated; replace it in Properties, or press Delete to remove it.', 'success');
  return true;
}

/** Properties → Replace picture: keeps the box width and position, adapts the height to the new picture. */
export async function replacePicture(obj: ImageObject): Promise<void> {
  const { pickImagesAsDataUrls } = await import('./convert');
  const [img] = await pickImagesAsDataUrls();
  if (!img) return;
  usePDFStore.getState().updateObject(obj.id, { src: img.src, naturalWidth: img.width, naturalHeight: img.height, crop: null, height: (obj.width * img.height) / img.width } as Partial<ImageObject>);
}
