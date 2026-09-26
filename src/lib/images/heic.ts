// HEIC / HEIF decoding via libheif-js (LGPL-3.0, WebAssembly build).
//
// The ~2 MB wasm bundle is loaded with a dynamic import so it becomes its
// own lazy chunk and is only fetched when a HEIC file is actually opened.
// libheif applies the container transformations (irot rotation, imir
// mirroring, clap crop) by default, so the pixels come out upright.

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface DecodedImage {
  src: string;
  width: number;
  height: number;
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/**
 * Sniffs the ISO-BMFF `ftyp` box for a HEIF brand (major or compatible).
 * AVIF-only files (brand `avif`/`avis` without a HEIF brand) are rejected.
 */
export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  if (String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) !== 'ftyp') return false;
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, size >= 16 ? size : 16);
  const brands: string[] = [String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]));
  const hasHeif = brands.some((b) => HEIF_BRANDS.has(b));
  if (!hasHeif) return false;
  // mif1 is also used by AVIF files; without any HEVC brand, treat as AVIF.
  const hevc = brands.some((b) => b !== 'mif1' && b !== 'msf1' && HEIF_BRANDS.has(b));
  const avif = brands.some((b) => b === 'avif' || b === 'avis');
  return hevc || !avif;
}

// Minimal typing of the libheif-js JS wrapper API.
interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(target: RgbaImage, cb: (result: RgbaImage | null) => void): void;
  free(): void;
}
interface HeifDecoderCtor {
  new (): { decode(buffer: Uint8Array): HeifImage[] };
}
interface LibHeif {
  HeifDecoder: HeifDecoderCtor;
}

let libPromise: Promise<LibHeif> | null = null;

function loadLibheif(): Promise<LibHeif> {
  if (!libPromise) {
    libPromise = (async () => {
      // @ts-expect-error libheif-js ships no declaration for wasm-bundle.js; typed via LibHeif below.
      const mod: unknown = await import('libheif-js/wasm-bundle.js');
      // CJS interop: the module object is either the library or { default }.
      let lib = (mod as { default?: unknown }).default ?? mod;
      if (typeof lib === 'function') lib = await (lib as () => unknown)();
      if (!lib || typeof (lib as Partial<LibHeif>).HeifDecoder !== 'function') throw new Error('libheif failed to load');
      return lib as LibHeif;
    })();
    libPromise.catch(() => {
      libPromise = null;
    });
  }
  return libPromise;
}

/** Decodes every top-level image to RGBA (primary image first). */
export async function decodeHeicToRgba(bytes: Uint8Array): Promise<RgbaImage[]> {
  const lib = await loadLibheif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images.length) throw new Error('No images found in the HEIF file');
  const ordered = [...images].sort((a, b) => Number(b.is_primary()) - Number(a.is_primary()));
  const out: RgbaImage[] = [];
  try {
    for (const img of ordered) {
      const width = img.get_width();
      const height = img.get_height();
      const target: RgbaImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      const res = await new Promise<RgbaImage>((resolve, reject) =>
        img.display(target, (r) => (r ? resolve(r) : reject(new Error('HEIF decoding failed')))),
      );
      out.push({ width: res.width, height: res.height, data: res.data });
    }
  } finally {
    for (const img of images) {
      try {
        img.free();
      } catch {
        /* already freed */
      }
    }
  }
  return out;
}

async function rgbaToDataUrl(img: RgbaImage, type: 'image/jpeg' | 'image/png', quality: number): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed array (ImageData rejects shared/wasm views).
  const pixels = new Uint8ClampedArray(img.data);
  const imageData = new ImageData(pixels, img.width, img.height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(imageData, 0, 0);
    const blob = await c.convertToBlob({ type, quality });
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error ?? new Error('read failed'));
      fr.readAsDataURL(blob);
    });
  }
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.putImageData(imageData, 0, 0);
  return c.toDataURL(type, quality);
}

function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

/**
 * Decodes a HEIC/HEIF file to data URLs, one per top-level image (primary
 * first). Opaque images become JPEG (quality 0.92), images with alpha PNG.
 * Browser only (needs a canvas).
 */
export async function decodeHeic(bytes: Uint8Array): Promise<Array<{ src: string; width: number; height: number }>> {
  const images = await decodeHeicToRgba(bytes);
  const out: DecodedImage[] = [];
  for (const img of images) {
    const type = hasTransparency(img.data) ? 'image/png' : 'image/jpeg';
    out.push({ src: await rgbaToDataUrl(img, type, 0.92), width: img.width, height: img.height });
  }
  return out;
}
