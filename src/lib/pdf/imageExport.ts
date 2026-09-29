/**
 * Export images: every picture stored in the PDF. JPEG and JPEG 2000 images
 * are written exactly as stored (no quality loss); other images are decoded
 * to RGBA pixels (the caller encodes them as PNG), with their transparency
 * mask. Images used on several pages are exported once.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';

export interface ExtractedImage {
  name: string;
  /** 1-based page where it first appears. */
  page: number;
  width: number;
  height: number;
  kind: 'jpg' | 'jp2' | 'pixels';
  bytes?: Uint8Array;
  /** RGBA, for kind 'pixels'. */
  rgba?: Uint8ClampedArray;
}

const num = (v: unknown, d = 0) => (v instanceof PDFNumber ? v.asNumber() : d);

function filters(d: PDFDict): string[] {
  const f = d.lookup(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : ''));
  return [];
}

interface Space {
  kind: 'gray' | 'rgb' | 'cmyk' | 'indexed';
  base?: 'gray' | 'rgb' | 'cmyk';
  lookup?: Uint8Array;
}

function colorSpace(doc: PDFDocument, v: unknown): Space | null {
  const cs = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    return n === 'DeviceGray' || n === 'CalGray' ? { kind: 'gray' } : n === 'DeviceRGB' || n === 'CalRGB' ? { kind: 'rgb' } : n === 'DeviceCMYK' ? { kind: 'cmyk' } : null;
  }
  if (cs instanceof PDFArray) {
    const head = cs.lookup(0);
    const name = head instanceof PDFName ? head.decodeText() : '';
    if (name === 'ICCBased') {
      const s = cs.lookup(1);
      const n = s instanceof PDFStream ? num(s.dict.lookup(PDFName.of('N')), 3) : 3;
      return n === 1 ? { kind: 'gray' } : n === 4 ? { kind: 'cmyk' } : { kind: 'rgb' };
    }
    if (name === 'CalRGB' || name === 'Lab') return { kind: 'rgb' };
    if (name === 'CalGray') return { kind: 'gray' };
    if (name === 'Indexed' || name === 'I') {
      const base = colorSpace(doc, cs.get(1));
      const table = cs.lookup(3);
      let lookup: Uint8Array | null = null;
      if (table instanceof PDFRawStream) lookup = decodePDFRawStream(table).decode();
      else if (table && typeof (table as unknown as { asBytes?: () => Uint8Array }).asBytes === 'function') lookup = (table as unknown as { asBytes: () => Uint8Array }).asBytes();
      if (!base || base.kind === 'indexed' || !lookup) return null;
      return { kind: 'indexed', base: base.kind, lookup };
    }
  }
  return null;
}

/** Samples (8 bits, or 1 bit for gray) -> RGBA. */
function toRgba(data: Uint8Array, w: number, h: number, bpc: number, sp: Space): Uint8ClampedArray | null {
  const out = new Uint8ClampedArray(w * h * 4);
  const comps = sp.kind === 'gray' || sp.kind === 'indexed' ? 1 : sp.kind === 'rgb' ? 3 : 4;
  if (bpc !== 8 && !(bpc === 1 && (sp.kind === 'gray' || sp.kind === 'indexed'))) return null;
  const rowBytes = bpc === 8 ? w * comps : Math.ceil(w / 8);
  if (data.length < rowBytes * h) return null;
  const baseComps = sp.base === 'gray' ? 1 : sp.base === 'cmyk' ? 4 : 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let c: number[];
      if (bpc === 1) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        c = sp.kind === 'indexed' ? Array.from(sp.lookup!.subarray(bit * baseComps, bit * baseComps + baseComps)) : [bit ? 255 : 0];
      } else {
        const i = y * rowBytes + x * comps;
        c = sp.kind === 'indexed' ? Array.from(sp.lookup!.subarray(data[i] * baseComps, data[i] * baseComps + baseComps)) : Array.from(data.subarray(i, i + comps));
      }
      const kind = sp.kind === 'indexed' ? sp.base! : sp.kind;
      if (kind === 'gray') out.set([c[0], c[0], c[0], 255], o);
      else if (kind === 'rgb') out.set([c[0], c[1], c[2], 255], o);
      else {
        const k = c[3] / 255;
        out.set([255 * (1 - c[0] / 255) * (1 - k), 255 * (1 - c[1] / 255) * (1 - k), 255 * (1 - c[2] / 255) * (1 - k), 255], o);
      }
    }
  }
  return out;
}

export async function extractImages(bytes: Uint8Array): Promise<{ images: ExtractedImage[]; skipped: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const seen = new Set<string>();
  const images: ExtractedImage[] = [];
  let skipped = 0;

  const visit = (res: unknown, pageNo: number, depth: number) => {
    const r = res instanceof PDFRef ? doc.context.lookup(res) : res;
    if (!(r instanceof PDFDict) || depth > 8) return;
    const xo = r.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) return;
    for (const [, ref] of xo.entries()) {
      const key = ref instanceof PDFRef ? ref.toString() : '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(s instanceof PDFRawStream)) continue;
      const d = s.dict;
      const sub = d.lookup(PDFName.of('Subtype'));
      if (sub === PDFName.of('Form')) {
        visit(d.get(PDFName.of('Resources')), pageNo, depth + 1);
        continue;
      }
      if (sub !== PDFName.of('Image')) continue;
      const w = num(d.lookup(PDFName.of('Width')));
      const h = num(d.lookup(PDFName.of('Height')));
      if (d.lookup(PDFName.of('ImageMask'))?.toString() === 'true' || w < 1 || h < 1) {
        skipped++;
        continue;
      }
      const f = filters(d);
      const name = `page${pageNo}-image${images.length + 1}`;
      if (f.length === 1 && (f[0] === 'DCTDecode' || f[0] === 'DCT')) {
        images.push({ name: `${name}.jpg`, page: pageNo, width: w, height: h, kind: 'jpg', bytes: s.contents });
        continue;
      }
      if (f.length === 1 && f[0] === 'JPXDecode') {
        images.push({ name: `${name}.jp2`, page: pageNo, width: w, height: h, kind: 'jp2', bytes: s.contents });
        continue;
      }
      try {
        const sp = colorSpace(doc, d.get(PDFName.of('ColorSpace')));
        const data = decodePDFRawStream(s).decode();
        const rgba = sp ? toRgba(data, w, h, num(d.lookup(PDFName.of('BitsPerComponent')), 8), sp) : null;
        if (!rgba) {
          skipped++;
          continue;
        }
        // Transparency: a soft mask of the same size.
        const sm = d.lookup(PDFName.of('SMask'));
        if (sm instanceof PDFRawStream && num(sm.dict.lookup(PDFName.of('Width'))) === w && num(sm.dict.lookup(PDFName.of('Height'))) === h) {
          const a = decodePDFRawStream(sm).decode();
          if (a.length >= w * h) for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = a[i];
        }
        images.push({ name: `${name}.png`, page: pageNo, width: w, height: h, kind: 'pixels', rgba });
      } catch {
        skipped++; // CCITT, JBIG2, unusual colour spaces
      }
    }
  };

  doc.getPages().forEach((p, i) => visit(p.node.get(PDFName.of('Resources')) ?? p.node.Resources(), i + 1, 0));
  return { images, skipped };
}
