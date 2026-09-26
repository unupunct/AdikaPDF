/** Default-valued constructors for editor objects. */
import type {
  FieldKind,
  FieldObject,
  ImageObject,
  LineObject,
  PenObject,
  RedactObject,
  SavedSignature,
  ShapeObject,
  SignatureObject,
  TextObject,
  ToolStyle,
} from '@/types';
import { uid } from './uid';
import { SIGNATURE_CAPTION_HEIGHT } from './pdf/exportPdf';

export function makeText(pageId: string, x: number, y: number, style: ToolStyle, patch: Partial<TextObject> = {}): TextObject {
  return {
    id: uid('obj'),
    type: 'text',
    pageId,
    x,
    y,
    rotation: 0,
    opacity: 1,
    width: 220,
    height: style.fontSize * 1.25 + 4,
    text: '',
    fontFamily: style.fontFamily,
    bold: style.bold,
    italic: style.italic,
    fontSize: style.fontSize,
    color: style.color,
    align: 'left',
    lineHeight: 1.25,
    background: null,
    ...patch,
  };
}

export function makeShape(
  type: ShapeObject['type'],
  pageId: string,
  rect: { x: number; y: number; width: number; height: number },
  style: ToolStyle,
): ShapeObject {
  const highlight = type === 'highlight';
  return {
    id: uid('obj'),
    type,
    pageId,
    ...rect,
    rotation: 0,
    opacity: highlight ? 0.45 : style.opacity,
    stroke: highlight ? null : style.stroke,
    strokeWidth: highlight ? 0 : style.strokeWidth,
    fill: highlight ? style.highlightColor : style.fill,
  };
}

export function makeLine(type: LineObject['type'], pageId: string, x1: number, y1: number, x2: number, y2: number, style: ToolStyle): LineObject {
  return {
    id: uid('obj'),
    type,
    pageId,
    x: x1,
    y: y1,
    rotation: 0,
    opacity: style.opacity,
    points: [0, 0, x2 - x1, y2 - y1],
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}

export function makePen(pageId: string, points: number[], style: ToolStyle): PenObject {
  const x = points[0];
  const y = points[1];
  return {
    id: uid('obj'),
    type: 'pen',
    pageId,
    x,
    y,
    rotation: 0,
    opacity: style.opacity,
    points: points.map((v, i) => (i % 2 === 0 ? v - x : v - y)),
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}

export function makeRedaction(pageId: string, rect: { x: number; y: number; width: number; height: number }): RedactObject {
  return { id: uid('obj'), type: 'redact', pageId, ...rect, rotation: 0, opacity: 1, fill: '#000000' };
}

export function makeImage(pageId: string, x: number, y: number, img: { src: string; width: number; height: number }, maxSize = 240): ImageObject {
  const k = Math.min(1, maxSize / Math.max(img.width, img.height));
  const width = Math.max(8, img.width * k);
  const height = Math.max(8, img.height * k);
  return {
    id: uid('obj'),
    type: 'image',
    pageId,
    x: x - width / 2,
    y: y - height / 2,
    rotation: 0,
    opacity: 1,
    width,
    height,
    src: img.src,
    crop: null,
    naturalWidth: img.width,
    naturalHeight: img.height,
  };
}

export function makeSignature(pageId: string, x: number, y: number, sig: SavedSignature, showCaption = true): SignatureObject {
  const max = sig.kind === 'initials' ? 70 : 170;
  const k = Math.min(max / sig.width, (sig.kind === 'initials' ? 40 : 60) / sig.height);
  const width = Math.max(30, sig.width * k);
  const inkH = Math.max(14, sig.height * k);
  const height = inkH + (showCaption ? SIGNATURE_CAPTION_HEIGHT : 0);
  return {
    id: uid('obj'),
    type: 'signature',
    pageId,
    x: x - width / 2,
    y: y - height / 2,
    rotation: 0,
    opacity: 1,
    width,
    height,
    src: sig.src,
    naturalWidth: sig.width,
    naturalHeight: sig.height,
    signerName: sig.signerName,
    signedAt: new Date().toISOString(),
    showCaption,
    kind: sig.kind,
  };
}

const FIELD_SIZES: Record<FieldKind, { width: number; height: number }> = {
  text: { width: 160, height: 22 },
  checkbox: { width: 14, height: 14 },
  radio: { width: 14, height: 14 },
  dropdown: { width: 140, height: 22 },
  signature: { width: 180, height: 50 },
};

export function defaultFieldSize(kind: FieldKind): { width: number; height: number } {
  return FIELD_SIZES[kind];
}

export function makeField(
  kind: FieldKind,
  pageId: string,
  rect: { x: number; y: number; width: number; height: number },
  existingNames: string[],
  radioGroup?: string,
): FieldObject {
  const prefix = { text: 'Text', checkbox: 'Check', radio: 'Group', dropdown: 'Dropdown', signature: 'Signature' }[kind];
  let name = radioGroup ?? '';
  if (!name) {
    let i = 1;
    while (existingNames.includes(`${prefix}${i}`)) i++;
    name = `${prefix}${i}`;
  }
  const radioCount = existingNames.filter((n) => n === name).length;
  return {
    id: uid('obj'),
    type: 'field',
    pageId,
    ...rect,
    rotation: 0,
    opacity: 1,
    fieldKind: kind,
    name,
    value: kind === 'radio' ? `Option${radioCount + 1}` : '',
    options: kind === 'dropdown' ? ['Option 1', 'Option 2', 'Option 3'] : [],
    required: false,
    fontSize: 0,
    multiline: false,
  };
}

/** Reads an image file into a PNG/JPEG data URL (other formats are converted to PNG). */
export async function imageFileToDataUrl(bytes: Uint8Array, name: string): Promise<{ src: string; width: number; height: number }> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) {
    const { decodeHeic } = await import('./images/heic');
    const images = await decodeHeic(bytes);
    if (images.length === 0) throw new Error('No image found in the HEIC file.');
    return images[0];
  }
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
    const { decodeTiff } = await import('./images');
    const pages = decodeTiff(bytes);
    if (pages.length === 0) throw new Error('No image found in the TIFF file.');
    return pages[0];
  }
  const mime = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
      ? 'image/jpeg'
      : lower.endsWith('.webp')
        ? 'image/webp'
        : lower.endsWith('.gif')
          ? 'image/gif'
          : lower.endsWith('.bmp')
            ? 'image/bmp'
            : lower.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream';
  const blob = new Blob([bytes.slice().buffer], { type: mime });
  const bitmapUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImage(bitmapUrl);
    const width = img.naturalWidth || 300;
    const height = img.naturalHeight || 150;
    if (mime === 'image/png' || mime === 'image/jpeg') {
      return { src: await blobToDataUrl(blob), width, height };
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
    return { src: canvas.toDataURL('image/png'), width, height };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image format is not supported.'));
    img.src = src;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Read failed'));
    r.readAsDataURL(blob);
  });
}
