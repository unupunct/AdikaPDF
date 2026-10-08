// Stream decoding with /DecodeParms predictors. pdf-lib decodes Flate and LZW
// but ignores /Predictor, so images stored with PNG (10-15) or TIFF (2)
// prediction come out as filtered rows instead of pixels.

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export interface PredictorParams {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
}

export function predictorParams(parms: PDFDict | undefined): PredictorParams | undefined {
  if (!parms) return undefined;
  const n = (k: string, def: number) => {
    const v = parms.lookup(PDFName.of(k));
    return v instanceof PDFNumber ? v.asNumber() : def;
  };
  const predictor = n('Predictor', 1);
  if (predictor <= 1) return undefined;
  return { predictor, colors: n('Colors', 1), bitsPerComponent: n('BitsPerComponent', 8), columns: n('Columns', 1) };
}

/** Undoes PNG (10-15, per-row filter byte) or TIFF 2 prediction. Pure. */
export function unpredict(data: Uint8Array, p: PredictorParams): Uint8Array {
  const { colors, bitsPerComponent: bpc, columns } = p;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (p.predictor === 2) {
    const rows = Math.floor(data.length / rowBytes);
    const out = new Uint8Array(rows * rowBytes);
    out.set(data.subarray(0, out.length));
    for (let r = 0; r < rows; r++) {
      const o = r * rowBytes;
      if (bpc === 8) {
        for (let i = colors; i < rowBytes; i++) out[o + i] = (out[o + i] + out[o + i - colors]) & 0xff;
      } else if (bpc === 16) {
        for (let i = colors * 2; i + 1 < rowBytes; i += 2) {
          const v = ((out[o + i] << 8) | out[o + i + 1]) + ((out[o + i - colors * 2] << 8) | out[o + i - colors * 2 + 1]);
          out[o + i] = (v >> 8) & 0xff;
          out[o + i + 1] = v & 0xff;
        }
      } else {
        // 1, 2 or 4 bits: work on unpacked samples.
        const mask = (1 << bpc) - 1;
        const get = (i: number) => (out[o + ((i * bpc) >> 3)] >> (8 - bpc - ((i * bpc) & 7))) & mask;
        const set = (i: number, v: number) => {
          const byte = o + ((i * bpc) >> 3);
          const shift = 8 - bpc - ((i * bpc) & 7);
          out[byte] = (out[byte] & ~(mask << shift)) | ((v & mask) << shift);
        };
        for (let i = colors; i < columns * colors; i++) set(i, get(i) + get(i - colors));
      }
    }
    return out;
  }
  // PNG: every row starts with its own filter type byte.
  const stride = rowBytes + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * stride];
    const src = data.subarray(r * stride + 1, r * stride + 1 + rowBytes);
    const cur = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

/**
 * Decodes a stream through its whole filter chain, applying each filter's
 * predictor. Throws on filters pdf-lib cannot decode (DCT, JPX, CCITT...).
 */
export function decodeStreamWithPredictors(stream: PDFRawStream): Uint8Array {
  const d = stream.dict;
  const filter = d.lookup(PDFName.of('Filter'));
  const parmsObj = d.lookup(PDFName.of('DecodeParms'));
  const filters = filter instanceof PDFName ? [filter] : filter instanceof PDFArray ? filter.asArray() : [];
  const parmsAt = (i: number): PDFDict | undefined => {
    if (parmsObj instanceof PDFDict) return i === 0 ? parmsObj : undefined;
    if (parmsObj instanceof PDFArray) {
      const v = parmsObj.lookup(i);
      return v instanceof PDFDict ? v : undefined;
    }
    return undefined;
  };
  if (!filters.some((_, i) => predictorParams(parmsAt(i)))) return decodePDFRawStream(stream).decode();
  let data = stream.contents;
  for (let i = 0; i < filters.length; i++) {
    const one = PDFDict.withContext(d.context);
    one.set(PDFName.of('Filter'), filters[i]);
    const parms = parmsAt(i);
    if (parms) one.set(PDFName.of('DecodeParms'), parms);
    data = decodePDFRawStream(PDFRawStream.of(one, data)).decode();
    const p = predictorParams(parms);
    if (p) data = unpredict(data, p);
  }
  return data;
}
