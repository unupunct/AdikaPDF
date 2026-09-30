/** Barcode fields: the text from a template, and the bars / modules as rectangles to draw. */
import { encodeModules } from './code128';
import { encodeQr } from './qr';

export type Symbology = 'qr' | 'code128';

/** "{Name};{Total}" with the values of those fields. */
export function fillTemplate(template: string, value: (field: string) => string | null): string {
  return template.replace(/\{([^{}]+)\}/g, (_, name: string) => value(name.trim()) ?? '');
}

/** Code 128 carries ASCII only: diacritics are folded, other characters become "?". */
export function code128Text(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Dark rectangles (0..1 units of the box, top-left origin) for the barcode
 * in a box of the given aspect (width / height). QR keeps square modules and a
 * quiet zone; Code 128 fills the width with bars and a quiet zone at the sides.
 */
export function barcodeRects(symbology: Symbology, text: string, aspect: number): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (symbology === 'qr') {
    const q = encodeQr(text || ' ', 'M');
    const n = q.size + 8; // 4-module quiet zone
    // Square: fit the smaller side, centred.
    const sx = aspect >= 1 ? 1 / aspect : 1;
    const sy = aspect >= 1 ? 1 : aspect;
    const m = 1 / n;
    const ox = (1 - sx) / 2;
    const oy = (1 - sy) / 2;
    q.modules.forEach((row, y) => {
      // Horizontal runs of dark modules as one rectangle each.
      for (let x = 0; x < row.length; ) {
        if (!row[x]) {
          x++;
          continue;
        }
        let e = x;
        while (e < row.length && row[e]) e++;
        out.push({ x: ox + (x + 4) * m * sx, y: oy + (y + 4) * m * sy, w: (e - x) * m * sx, h: m * sy });
        x = e;
      }
    });
    return out;
  }
  const mods = encodeModules(code128Text(text));
  const m = 1 / mods.length;
  for (let x = 0; x < mods.length; ) {
    if (!mods[x]) {
      x++;
      continue;
    }
    let e = x;
    while (e < mods.length && mods[e]) e++;
    out.push({ x: x * m, y: 0.08, w: (e - x) * m, h: 0.84 });
    x = e;
  }
  return out;
}
