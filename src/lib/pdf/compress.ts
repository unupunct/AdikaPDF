// PDF size reduction: JPEG re-encoding / downsampling of raster images,
// optional metadata stripping, Flate-compressing uncompressed streams and
// saving with object streams.
//
// Image work needs a browser (createImageBitmap + canvas). Where those are
// missing (e.g. node tests) images are left untouched and the structural
// optimisations still apply. Odd images are always skipped, never fatal.

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from 'pdf-lib';
import { dropUnreachableObjects } from './prune';

export interface CompressOptions {
  /** JPEG quality 0..1 */
  imageQuality: number;
  /** Target maximum effective image resolution in dots per inch. */
  maxImageDpi: number;
  stripMetadata: boolean;
}

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  imagesRecompressed: number;
}

// ---------------------------------------------------------------------------
// Content-stream scan: largest drawn size (in points) of every image XObject.
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

function mul(m: Matrix, n: Matrix): Matrix {
  // m then n (PDF row-vector convention: [x y 1] * m * n)
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

export interface ContentOp {
  op: string;
  nums: number[];
  name?: string;
}

/**
 * Minimal content-stream tokenizer that yields operators with their numeric
 * operands and the last name operand. Strings, arrays, dicts and inline images
 * are skipped. Pure; exported for tests.
 */
export function* scanContentOps(bytes: Uint8Array): Generator<ContentOp> {
  const n = bytes.length;
  let i = 0;
  let nums: number[] = [];
  let name: string | undefined;
  while (i < n) {
    const c = bytes[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      // literal string
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const d = bytes[i];
        if (d === 0x5c) i += 2;
        else {
          if (d === 0x28) depth++;
          else if (d === 0x29) depth--;
          i++;
        }
      }
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c || bytes[i + 1] === 0x3e) {
        i += 2; // dict open (or empty hex string)
        continue;
      }
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      continue;
    }
    if (c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) {
      i++;
      if (c === 0x5b) nums = []; // array operand (e.g. TJ / d) – drop numbers inside
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !isWs(bytes[j]) && !isDelim(bytes[j])) j++;
      name = String.fromCharCode(...bytes.subarray(i + 1, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !isWs(bytes[j]) && !isDelim(bytes[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    const tok = String.fromCharCode(...bytes.subarray(i, j));
    i = j;
    const num = Number(tok);
    if (tok.length && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) && Number.isFinite(num)) {
      nums.push(num);
      continue;
    }
    if (tok === 'true' || tok === 'false' || tok === 'null') continue;
    if (tok === 'BI') {
      // Skip inline image up to whitespace-delimited EI.
      let k = i;
      while (k < n - 2) {
        if (bytes[k] === 0x45 && bytes[k + 1] === 0x49 && isWs(bytes[k - 1]) && (k + 2 >= n || isWs(bytes[k + 2]))) break;
        k++;
      }
      i = k + 2;
      nums = [];
      name = undefined;
      continue;
    }
    yield { op: tok, nums, name };
    nums = [];
    name = undefined;
  }
}

function refKey(r: PDFRef): string {
  return `${r.objectNumber} ${r.generationNumber}`;
}

function lookupDict(doc: PDFDocument, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  return undefined;
}

function streamBytes(s: PDFObject | undefined, doc: PDFDocument): Uint8Array[] {
  const v = s instanceof PDFRef ? doc.context.lookup(s) : s;
  if (v instanceof PDFRawStream) {
    try {
      return [decodePDFRawStream(v).decode()];
    } catch {
      return [];
    }
  }
  if (v instanceof PDFArray) {
    const out: Uint8Array[] = [];
    for (let i = 0; i < v.size(); i++) out.push(...streamBytes(v.get(i), doc));
    return out;
  }
  return [];
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

function collectDrawnSizes(doc: PDFDocument): Map<string, { w: number; h: number }> {
  const sizes = new Map<string, { w: number; h: number }>();
  const visitedForms = new Set<string>();

  const walk = (content: Uint8Array, resources: PDFDict | undefined, base: Matrix, depth: number) => {
    const xobjs = lookupDict(doc, resources?.get(PDFName.of('XObject')));
    const stack: Matrix[] = [];
    let ctm: Matrix = base;
    for (const { op, nums, name } of scanContentOps(content)) {
      if (op === 'q') stack.push(ctm);
      else if (op === 'Q') ctm = stack.pop() ?? base;
      else if (op === 'cm' && nums.length >= 6) {
        const m = nums.slice(-6) as Matrix;
        ctm = mul(m, ctm);
      } else if (op === 'Do' && name && xobjs) {
        const ref = xobjs.get(PDFName.of(name));
        if (!(ref instanceof PDFRef)) continue;
        const x = doc.context.lookup(ref);
        if (!(x instanceof PDFStream)) continue;
        const sub = x.dict.get(PDFName.of('Subtype'));
        if (sub === PDFName.of('Image')) {
          const w = Math.hypot(ctm[0], ctm[1]);
          const h = Math.hypot(ctm[2], ctm[3]);
          const k = refKey(ref);
          const prev = sizes.get(k);
          sizes.set(k, { w: Math.max(prev?.w ?? 0, w), h: Math.max(prev?.h ?? 0, h) });
        } else if (sub === PDFName.of('Form') && depth < 6 && x instanceof PDFRawStream) {
          const k = refKey(ref) + '@' + ctm.map((v) => v.toFixed(2)).join(',');
          if (visitedForms.has(k) || visitedForms.size > 2000) continue;
          visitedForms.add(k);
          const mArr = x.dict.lookup(PDFName.of('Matrix'));
          let fm: Matrix = [1, 0, 0, 1, 0, 0];
          if (mArr instanceof PDFArray && mArr.size() === 6) {
            fm = mArr.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) as Matrix;
          }
          const res = lookupDict(doc, x.dict.get(PDFName.of('Resources'))) ?? resources;
          const body = streamBytes(x, doc);
          if (body.length) walk(body[0], res, mul(fm, ctm), depth + 1);
        }
      }
    }
  };

  for (const page of doc.getPages()) {
    try {
      const node = page.node;
      const content = concatBytes(streamBytes(node.get(PDFName.of('Contents')), doc));
      walk(content, node.Resources(), [1, 0, 0, 1, 0, 0], 0);
    } catch {
      // ignore pages we cannot parse
    }
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function filterNames(d: PDFDict): string[] {
  const f = d.lookup(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : '?'));
  return [];
}

/** Returns components (1 or 3) if the colour space is safe to re-encode, else 0. */
function safeComponents(doc: PDFDocument, d: PDFDict): { n: number; keep: boolean } {
  const cs = d.lookup(PDFName.of('ColorSpace'));
  if (cs instanceof PDFName) {
    const s = cs.decodeText();
    if (s === 'DeviceRGB') return { n: 3, keep: true };
    if (s === 'DeviceGray') return { n: 1, keep: false };
    return { n: 0, keep: false };
  }
  if (cs instanceof PDFArray && cs.size() === 2) {
    const kind = cs.lookup(0);
    if (kind instanceof PDFName && kind.decodeText() === 'ICCBased') {
      const prof = doc.context.lookup(cs.get(1));
      if (prof instanceof PDFStream) {
        const n = prof.dict.lookup(PDFName.of('N'));
        const nv = n instanceof PDFNumber ? n.asNumber() : 0;
        if (nv === 3) return { n: 3, keep: true };
        if (nv === 1) return { n: 1, keep: false };
      }
    }
  }
  return { n: 0, keep: false };
}

function num(d: PDFDict, key: string): number {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : NaN;
}

function hasCanvas(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined')
  );
}

async function encodeJpeg(src: ImageBitmap, w: number, h: number, quality: number): Promise<Uint8Array> {
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality));
    c.width = c.height = 0;
  }
  if (!blob) throw new Error('JPEG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Target pixel size for an image given its drawn size and the DPI cap. Pure. */
export function targetImageSize(
  pxW: number,
  pxH: number,
  drawn: { w: number; h: number } | undefined,
  maxDpi: number,
): { w: number; h: number } {
  let scale = 1;
  if (drawn && drawn.w > 0.5 && drawn.h > 0.5) {
    const maxW = (drawn.w / 72) * maxDpi;
    const maxH = (drawn.h / 72) * maxDpi;
    scale = Math.min(1, maxW / pxW, maxH / pxH);
  } else {
    const cap = Math.max(256, Math.round((2000 * maxDpi) / 150));
    scale = Math.min(1, cap / Math.max(pxW, pxH));
  }
  return { w: Math.max(1, Math.round(pxW * scale)), h: Math.max(1, Math.round(pxH * scale)) };
}

function rawToImageData(raw: Uint8Array, w: number, h: number, n: number): ImageData {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, s = 0, o = 0; p < w * h; p++, s += n, o += 4) {
    if (n === 1) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = raw[s];
    } else {
      rgba[o] = raw[s];
      rgba[o + 1] = raw[s + 1];
      rgba[o + 2] = raw[s + 2];
    }
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, w, h);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function compressPdf(
  bytes: Uint8Array,
  opts: CompressOptions,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<CompressResult> {
  const before = bytes.length;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const quality = Math.min(1, Math.max(0.05, opts.imageQuality));
  const maxDpi = Math.max(36, opts.maxImageDpi || 150);

  // Images referenced as masks must stay untouched (gray, lossless).
  const maskRefs = new Set<string>();
  const images: { ref: PDFRef; stream: PDFRawStream }[] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const d = obj.dict;
    for (const k of ['SMask', 'Mask']) {
      const m = d.get(PDFName.of(k));
      if (m instanceof PDFRef) maskRefs.add(refKey(m));
    }
    if (obj instanceof PDFRawStream && d.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      images.push({ ref, stream: obj });
    }
  }

  let imagesRecompressed = 0;
  const canImage = hasCanvas();
  let drawn = new Map<string, { w: number; h: number }>();
  if (canImage && images.length) {
    try {
      drawn = collectDrawnSizes(doc);
    } catch {
      drawn = new Map();
    }
  }

  const total = images.length;
  let done = 0;
  onProgress?.(0, total);
  for (const { ref, stream } of images) {
    signal?.throwIfAborted();
    try {
      if (canImage && !maskRefs.has(refKey(ref))) {
        const replaced = await recompressImage(doc, ref, stream, drawn.get(refKey(ref)), quality, maxDpi);
        if (replaced) imagesRecompressed++;
      }
    } catch {
      // skip odd image
    }
    done++;
    onProgress?.(done, total);
    // Yield to keep the UI responsive.
    if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  if (opts.stripMetadata) stripMetadata(doc);

  // Flate-compress streams that are stored without any filter.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.has(PDFName.of('Filter'))) continue;
    if (d.get(PDFName.of('Type')) === PDFName.of('Metadata')) continue;
    if (d.has(PDFName.of('DL')) || obj.contents.length < 512) continue;
    try {
      const entries: Record<string, PDFObject> = {};
      for (const [k, v] of d.entries()) {
        if (k === PDFName.of('Length')) continue;
        entries[k.decodeText()] = v;
      }
      const packed = ctx.flateStream(obj.contents, entries);
      if (packed.contents.length < obj.contents.length) ctx.assign(ref, packed);
    } catch {
      // keep as is
    }
  }

  // Unused objects (stripped metadata, orphaned pages) cost space and can hold old data.
  dropUnreachableObjects(doc);
  const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  if (out.length >= before) {
    return { bytes, before, after: before, imagesRecompressed: 0 };
  }
  return { bytes: out, before, after: out.length, imagesRecompressed };
}

async function recompressImage(
  doc: PDFDocument,
  ref: PDFRef,
  stream: PDFRawStream,
  drawn: { w: number; h: number } | undefined,
  quality: number,
  maxDpi: number,
): Promise<boolean> {
  const d = stream.dict;
  const imageMask = d.lookup(PDFName.of('ImageMask'));
  if (imageMask instanceof PDFBool && imageMask.asBoolean()) return false;
  if (d.has(PDFName.of('SMask')) || d.has(PDFName.of('Mask')) || d.has(PDFName.of('Decode'))) return false;
  if (d.has(PDFName.of('SMaskInData'))) return false;
  const w = num(d, 'Width');
  const h = num(d, 'Height');
  if (!(w > 0 && h > 0) || w * h > 60_000_000) return false;
  const filters = filterNames(d);
  const cs = safeComponents(doc, d);
  if (!cs.n) return false;
  const orig = stream.contents.length;

  let bitmap: ImageBitmap;
  if (filters.length === 1 && filters[0] === 'DCTDecode') {
    const bpc = num(d, 'BitsPerComponent');
    if (!Number.isNaN(bpc) && bpc !== 8) return false;
    bitmap = await createImageBitmap(new Blob([stream.contents as BlobPart], { type: 'image/jpeg' }));
  } else if (filters.length === 1 && filters[0] === 'FlateDecode') {
    if (num(d, 'BitsPerComponent') !== 8) return false;
    if (w * h < 250_000 && orig < 100_000) return false; // only large images
    const raw = decodePDFRawStream(stream).decode();
    if (raw.length < w * h * cs.n) return false;
    bitmap = await createImageBitmap(rawToImageData(raw, w, h, cs.n));
  } else {
    return false;
  }

  try {
    if (bitmap.width !== w || bitmap.height !== h) {
      // Decoded size disagrees with the dictionary: leave it alone.
      return false;
    }
    const t = targetImageSize(w, h, drawn, maxDpi);
    const jpeg = await encodeJpeg(bitmap, t.w, t.h, quality);
    const isFlate = filters[0] === 'FlateDecode';
    const threshold = isFlate ? orig * 0.5 : orig * 0.95;
    if (jpeg.length >= threshold) return false;

    const entries: Record<string, PDFObject> = {};
    for (const [k, v] of d.entries()) {
      const key = k.decodeText();
      if (['Length', 'Filter', 'DecodeParms', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace', 'DL'].includes(key)) {
        continue;
      }
      entries[key] = v;
    }
    const dict = doc.context.obj({
      ...entries,
      Type: 'XObject',
      Subtype: 'Image',
      Width: t.w,
      Height: t.h,
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
    });
    dict.set(PDFName.of('ColorSpace'), cs.keep ? d.get(PDFName.of('ColorSpace'))! : PDFName.of('DeviceRGB'));
    doc.context.assign(ref, PDFRawStream.of(dict, jpeg));
    return true;
  } finally {
    bitmap.close();
  }
}

function stripMetadata(doc: PDFDocument): void {
  const ctx = doc.context;
  doc.catalog.delete(PDFName.of('Metadata'));
  doc.catalog.delete(PDFName.of('PieceInfo'));
  const infoObj = ctx.trailerInfo.Info;
  const info = infoObj instanceof PDFRef ? ctx.lookup(infoObj) : infoObj;
  if (info instanceof PDFDict) {
    for (const k of info.keys()) {
      if (k.decodeText() !== 'Producer') info.delete(k);
    }
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    if (!d) continue;
    d.delete(PDFName.of('PieceInfo'));
    if (d.get(PDFName.of('Type')) === PDFName.of('Page')) d.delete(PDFName.of('Metadata'));
  }
}
