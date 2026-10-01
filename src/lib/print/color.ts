/**
 * The colour model of the print tools: a simple, generic press model
 * (no dot gain, grey component replacement) between sRGB and CMYK, and an
 * ICC v2 output ("prtr") profile built from it for PDF/X output intents.
 * It is not a characterised printing condition (like FOGRA39): the output
 * intent says so, and printers apply their own conversion.
 */

export type RGB = [number, number, number];
export type CMYK = [number, number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** RGB 0..1 -> CMYK 0..1 with grey component replacement (neutral greys print with black only). */
export function rgbToCmyk([r, g, b]: RGB): CMYK {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-9) return [0, 0, 0, 1];
  const c = (1 - r - k) / (1 - k);
  const m = (1 - g - k) / (1 - k);
  const y = (1 - b - k) / (1 - k);
  return [clamp01(c), clamp01(m), clamp01(y), clamp01(k)];
}

export function cmykToRgb([c, m, y, k]: CMYK): RGB {
  return [clamp01((1 - c) * (1 - k)), clamp01((1 - m) * (1 - k)), clamp01((1 - y) * (1 - k))];
}

/** Luminance-weighted grey 0..1 (1 = white). */
export const rgbToGray = ([r, g, b]: RGB) => clamp01(0.299 * r + 0.587 * g + 0.114 * b);
export const cmykToGray = (c: CMYK) => rgbToGray(cmykToRgb(c));

// ---------------------------------------------------------------- Lab (D50)

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const WHITE_D50 = [0.9642, 1, 0.8249];

/** sRGB -> CIELab (D50, Bradford-adapted sRGB matrix). */
export function rgbToLab([r, g, b]: RGB): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  const Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X / WHITE_D50[0]);
  const fy = f(Y / WHITE_D50[1]);
  const fz = f(Z / WHITE_D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([L, a, bb]: [number, number, number]): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * WHITE_D50[0];
  const Y = inv(fy) * WHITE_D50[1];
  const Z = inv(fz) * WHITE_D50[2];
  const R = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const G = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const B = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  return [clamp01(linearToSrgb(clamp01(R))), clamp01(linearToSrgb(clamp01(G))), clamp01(linearToSrgb(clamp01(B)))];
}

// ---------------------------------------------------------------- ICC v2 output profile

class Buf {
  parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number) {
    this.u16(Math.floor(v / 65536));
    this.u16(v % 65536);
  }
  s15(v: number) {
    const n = Math.round(v * 65536);
    this.u32(n < 0 ? n + 0x100000000 : n);
  }
  ascii(s: string, len = s.length) {
    for (let i = 0; i < len; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
  }
  pad4() {
    while (this.parts.length % 4) this.u8(0);
  }
  bytes() {
    return Uint8Array.from(this.parts);
  }
}

function textDesc(s: string): Uint8Array {
  const b = new Buf();
  b.ascii('desc');
  b.u32(0);
  b.u32(s.length + 1);
  b.ascii(s, s.length + 1);
  b.u32(0); // Unicode language
  b.u32(0); // Unicode count
  b.u16(0); // ScriptCode code
  b.u8(0); // ScriptCode count
  for (let i = 0; i < 67; i++) b.u8(0);
  b.pad4();
  return b.bytes();
}

function textTag(s: string): Uint8Array {
  const b = new Buf();
  b.ascii('text');
  b.u32(0);
  b.ascii(s, s.length + 1);
  b.pad4();
  return b.bytes();
}

function xyzTag(x: number, y: number, z: number): Uint8Array {
  const b = new Buf();
  b.ascii('XYZ ');
  b.u32(0);
  b.s15(x);
  b.s15(y);
  b.s15(z);
  return b.bytes();
}

/** ICC v2 Lab encoding in 16 bits: L 0..100 -> 0..0xFF00, a/b -128..127.996 -> 0..0xFFFF (0 = 0x8000). */
const labEnc = (L: number, a: number, b: number): [number, number, number] => [
  Math.round(Math.max(0, Math.min(100, L)) * (0xff00 / 100)),
  Math.round((Math.max(-128, Math.min(127.996, a)) + 128) * 256),
  Math.round((Math.max(-128, Math.min(127.996, b)) + 128) * 256),
];
const labDec = (L: number, a: number, b: number): [number, number, number] => [(L / 0xff00) * 100, a / 256 - 128, b / 256 - 128];

/** lut16Type with identity matrix and linear curves; `clut(inputs 0..1) -> outputs 0..65535`. */
function lut16(inCh: number, outCh: number, grid: number, clut: (v: number[]) => number[]): Uint8Array {
  const b = new Buf();
  b.ascii('mft2');
  b.u32(0);
  b.u8(inCh);
  b.u8(outCh);
  b.u8(grid);
  b.u8(0);
  for (const v of [1, 0, 0, 0, 1, 0, 0, 0, 1]) b.s15(v);
  b.u16(2); // input table entries
  b.u16(2); // output table entries
  for (let c = 0; c < inCh; c++) (b.u16(0), b.u16(65535));
  const idx = new Array(inCh).fill(0);
  const total = grid ** inCh;
  for (let n = 0; n < total; n++) {
    let rem = n;
    for (let c = inCh - 1; c >= 0; c--) {
      idx[c] = rem % grid;
      rem = Math.floor(rem / grid);
    }
    for (const v of clut(idx.map((i) => i / (grid - 1)))) b.u16(Math.max(0, Math.min(65535, Math.round(v))));
  }
  for (let c = 0; c < outCh; c++) (b.u16(0), b.u16(65535));
  b.pad4();
  return b.bytes();
}

let cachedProfile: Uint8Array | null = null;

/** A valid ICC v2 CMYK output profile of the generic press model (about 60 KB). */
export function genericCmykProfile(): Uint8Array {
  if (cachedProfile) return cachedProfile;
  const a2b = lut16(4, 3, 9, ([c, m, y, k]) => labEnc(...rgbToLab(cmykToRgb([c, m, y, k]))));
  const b2a = lut16(3, 4, 17, ([L, a, bb]) => rgbToCmyk(labToRgb(labDec(L * 0xffff, a * 0xffff, bb * 0xffff))).map((v) => v * 65535));
  const gamut = lut16(3, 1, 9, () => [0]);
  const tags: Array<[string, Uint8Array]> = [
    ['desc', textDesc('Adika generic CMYK (uncharacterised)')],
    ['cprt', textTag('No copyright, use freely')],
    ['wtpt', xyzTag(0.9642, 1, 0.8249)],
    ['A2B0', a2b],
    ['A2B1', a2b],
    ['A2B2', a2b],
    ['B2A0', b2a],
    ['B2A1', b2a],
    ['B2A2', b2a],
    ['gamt', gamut],
  ];
  // Identical tag data is stored once (tags may share offsets).
  const unique: Uint8Array[] = [];
  const offsetOf = new Map<Uint8Array, number>();
  let offset = 128 + 4 + tags.length * 12;
  for (const [, data] of tags) {
    if (offsetOf.has(data)) continue;
    offsetOf.set(data, offset);
    unique.push(data);
    offset += data.length;
  }
  const size = offset;
  const h = new Buf();
  h.u32(size);
  h.ascii('ADKA');
  h.u8(2);
  h.u8(0x10);
  h.u16(0); // version 2.1
  h.ascii('prtr');
  h.ascii('CMYK');
  h.ascii('Lab ');
  for (const v of [2026, 1, 1, 0, 0, 0]) h.u16(v);
  h.ascii('acsp');
  h.ascii('MSFT');
  h.u32(0); // flags
  h.u32(0); // manufacturer
  h.u32(0); // model
  h.u32(0);
  h.u32(0); // attributes
  h.u32(0); // rendering intent: perceptual
  h.s15(0.9642);
  h.s15(1);
  h.s15(0.8249); // illuminant D50
  h.ascii('ADKA');
  while (h.parts.length < 128) h.u8(0);
  h.u32(tags.length);
  for (const [sig, data] of tags) {
    h.ascii(sig);
    h.u32(offsetOf.get(data)!);
    h.u32(data.length);
  }
  const out = new Uint8Array(size);
  out.set(h.bytes(), 0);
  let o = 128 + 4 + tags.length * 12;
  for (const d of unique) {
    out.set(d, o);
    o += d.length;
  }
  cachedProfile = out;
  return out;
}
