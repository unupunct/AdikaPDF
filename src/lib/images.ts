/** TIFF decoding (multi-page) via UTIF, producing PNG data URLs. */
import UTIF from 'utif';

export function decodeTiff(bytes: Uint8Array): Array<{ src: string; width: number; height: number }> {
  const buf = bytes.slice().buffer;
  const ifds = UTIF.decode(buf);
  const out: Array<{ src: string; width: number; height: number }> = [];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const width = ifd.width;
    const height = ifd.height;
    if (!width || !height) continue;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const data = ctx.createImageData(width, height);
    data.data.set(rgba.subarray(0, data.data.length));
    ctx.putImageData(data, 0, 0);
    out.push({ src: canvas.toDataURL('image/png'), width, height });
  }
  return out;
}
