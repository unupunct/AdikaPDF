import { afterEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { decodeStreamWithPredictors, unpredict } from '../src/lib/pdf/predictor';
import { compressPdf } from '../src/lib/pdf/compress';

function pixels(w: number, h: number, n: number): Uint8Array {
  const px = new Uint8Array(w * h * n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < n; c++) px[(y * w + x) * n + c] = (x * 3 + y * 7 + c * 50 + ((x * y) % 13)) & 0xff;
  return px;
}

/** PNG-predicts rows cycling through filter types 0..4. */
function pngPredict(px: Uint8Array, w: number, n: number): Uint8Array {
  const row = w * n;
  const h = px.length / row;
  const out = new Uint8Array(h * (row + 1));
  for (let y = 0; y < h; y++) {
    const type = y % 5;
    out[y * (row + 1)] = type;
    for (let i = 0; i < row; i++) {
      const v = px[y * row + i];
      const a = i >= n ? px[y * row + i - n] : 0;
      const b = y > 0 ? px[(y - 1) * row + i] : 0;
      const c = y > 0 && i >= n ? px[(y - 1) * row + i - n] : 0;
      let p = 0;
      if (type === 1) p = a;
      else if (type === 2) p = b;
      else if (type === 3) p = (a + b) >> 1;
      else if (type === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * (row + 1) + 1 + i] = (v - p) & 0xff;
    }
  }
  return out;
}

function tiffPredict(px: Uint8Array, w: number, n: number): Uint8Array {
  const out = new Uint8Array(px.length);
  const row = w * n;
  for (let i = 0; i < px.length; i++) out[i] = i % row < n ? px[i] : (px[i] - px[i - n]) & 0xff;
  return out;
}

async function docWithImage(w: number, h: number, data: Uint8Array, predictor: number) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  const img = PDFRawStream.of(
    doc.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: predictor, Colors: 3, BitsPerComponent: 8, Columns: w },
    }),
    deflateSync(data),
  );
  const ref = doc.context.register(img);
  page.node.setXObject(PDFName.of('Im0'), ref);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`)));
  return { doc, img };
}

describe('predictors', () => {
  it('undoes PNG and TIFF prediction', () => {
    const px = pixels(17, 9, 3);
    const p = { colors: 3, bitsPerComponent: 8, columns: 17 };
    expect(unpredict(pngPredict(px, 17, 3), { ...p, predictor: 15 })).toEqual(px);
    expect(unpredict(tiffPredict(px, 17, 3), { ...p, predictor: 2 })).toEqual(px);
  });

  it('TIFF prediction on 4-bit samples', () => {
    // one row, 4 gray samples 1,3,6,15 -> deltas 1,2,3,9
    const out = unpredict(new Uint8Array([0x12, 0x39]), { predictor: 2, colors: 1, bitsPerComponent: 4, columns: 4 });
    expect([...out]).toEqual([0x13, 0x6f]);
  });

  it('decodes a predicted Flate image stream', async () => {
    const px = pixels(20, 6, 3);
    const { img } = await docWithImage(20, 6, pngPredict(px, 20, 3), 12);
    expect(decodeStreamWithPredictors(img)).toEqual(px);
  });
});

describe('compress with predicted images', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { cib: g.createImageBitmap, oc: g.OffscreenCanvas, id: g.ImageData };
  afterEach(() => {
    g.createImageBitmap = saved.cib;
    g.OffscreenCanvas = saved.oc;
    g.ImageData = saved.id;
  });

  function mockCanvas() {
    const seen: { src: unknown; opts: unknown }[] = [];
    g.ImageData = class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    };
    g.createImageBitmap = async (src: { width?: number; height?: number }, opts?: unknown) => {
      seen.push({ src, opts });
      return { width: src.width ?? 600, height: src.height ?? 500, close() {} };
    };
    g.OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { fillRect() {}, drawImage() {}, fillStyle: '', imageSmoothingEnabled: true, imageSmoothingQuality: 'high' };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);
      }
    };
    return seen;
  }

  for (const predictor of [15, 2]) {
    it(`feeds un-predicted pixels to the encoder (predictor ${predictor})`, async () => {
      const seen = mockCanvas();
      const w = 600, h = 500;
      const px = pixels(w, h, 3);
      const { doc } = await docWithImage(w, h, predictor === 2 ? tiffPredict(px, w, 3) : pngPredict(px, w, 3), predictor);
      const res = await compressPdf(await doc.save(), { imageQuality: 0.7, maxImageDpi: 300, stripMetadata: false });
      expect(res.imagesRecompressed).toBe(1);
      const data = (seen[0].src as { data: Uint8ClampedArray }).data;
      for (const i of [0, 1, 2, 3 * 601, 3 * (w * 250 + 77) + 1, 3 * (w * h - 1) + 2]) {
        const p = Math.floor(i / 3);
        expect(data[p * 4 + (i % 3)]).toBe(px[i]);
      }
    });
  }

  it('ignores EXIF orientation when decoding JPEGs', async () => {
    const seen = mockCanvas();
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 500]);
    const jpeg = new Uint8Array(200_000).fill(7);
    const ref = doc.context.register(
      PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 600, Height: 500, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }), jpeg),
    );
    page.node.setXObject(PDFName.of('Im0'), ref);
    await compressPdf(await doc.save(), { imageQuality: 0.7, maxImageDpi: 150, stripMetadata: false });
    expect(seen[0].opts).toEqual({ imageOrientation: 'none' });
  });
});
