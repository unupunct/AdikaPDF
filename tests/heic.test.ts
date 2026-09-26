import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeHeicToRgba, isHeic } from '../src/lib/images/heic';

// autumn_1440x960.heic from github.com/nokiatech/heif (gh-pages/content/images).
const FIXTURE = fileURLToPath(new URL('./fixtures/sample.heic', import.meta.url));

function ftyp(major: string, compat: string[]): Uint8Array {
  const size = 16 + compat.length * 4;
  const b = new Uint8Array(size + 8);
  new DataView(b.buffer).setUint32(0, size);
  const put = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  put(4, 'ftyp');
  put(8, major);
  compat.forEach((c, i) => put(16 + i * 4, c));
  return b;
}

describe('isHeic', () => {
  it('accepts HEIF brands', () => {
    for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']) expect(isHeic(ftyp(brand, []))).toBe(true);
    expect(isHeic(ftyp('mif1', ['mif1', 'heic']))).toBe(true);
  });
  it('rejects AVIF, MP4 and junk', () => {
    expect(isHeic(ftyp('avif', ['mif1', 'avif']))).toBe(false);
    expect(isHeic(ftyp('mif1', ['avif', 'miaf']))).toBe(false);
    expect(isHeic(ftyp('isom', ['mp41', 'avc1']))).toBe(false);
    expect(isHeic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isHeic(new Uint8Array(4))).toBe(false);
  });
  it('recognises the fixture', () => {
    expect(isHeic(new Uint8Array(readFileSync(FIXTURE)))).toBe(true);
  });
});

describe.skipIf(!existsSync(FIXTURE))('decodeHeicToRgba', () => {
  it('decodes the primary image to RGBA pixels', async () => {
    const images = await decodeHeicToRgba(new Uint8Array(readFileSync(FIXTURE)));
    expect(images).toHaveLength(1);
    const [img] = images;
    expect(img.width).toBe(1440);
    expect(img.height).toBe(960);
    expect(img.data).toBeInstanceOf(Uint8ClampedArray);
    expect(img.data.length).toBe(1440 * 960 * 4);
    // Opaque photo with real content (not a blank buffer).
    let alphaOk = true;
    let sum = 0;
    const seen = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4 * 97) {
      if (img.data[i + 3] !== 255) alphaOk = false;
      sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
      seen.add((img.data[i] >> 4) * 256 + (img.data[i + 1] >> 4) * 16 + (img.data[i + 2] >> 4));
    }
    expect(alphaOk).toBe(true);
    expect(sum).toBeGreaterThan(0);
    expect(seen.size).toBeGreaterThan(50);
  });

  it('rejects non-HEIF data', async () => {
    await expect(decodeHeicToRgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
  });
});
