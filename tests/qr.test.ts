import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeQr, type QrEcc } from '@/lib/barcode/qr';

/** The symbol as a picture: `scale` px per module, 4-module quiet zone. */
function picture(modules: boolean[][], scale = 4) {
  const n = modules.length + 8;
  const w = n * scale;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + 4) * scale + dy) * w + (x + 4) * scale + dx) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
    }),
  );
  return { data, w };
}

const decode = (text: string, ecc: QrEcc) => {
  const q = encodeQr(text, ecc);
  const { data, w } = picture(q.modules, q.version > 20 ? 3 : 4);
  return { q, read: jsQR(data, w, w)?.data ?? null };
};

describe('QR code', () => {
  it('is read back by an independent decoder at every error correction level', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const { q, read } = decode('https://github.com/unupunct/AdikaPDF', ecc);
      expect(read).toBe('https://github.com/unupunct/AdikaPDF');
      expect(q.size).toBe(q.version * 4 + 17);
    }
  });

  it('works across versions 1–40 (alignment patterns, version information, many blocks)', () => {
    const lengths = [1, 10, 30, 60, 100, 150, 200, 300, 450, 600, 800, 1000, 1300, 1600, 2000, 2300];
    const versions = new Set<number>();
    for (const len of lengths) {
      const text = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('');
      const { q, read } = decode(text, 'M');
      versions.add(q.version);
      expect(read).toBe(text);
    }
    expect(Math.max(...versions)).toBeGreaterThanOrEqual(35);
    expect(versions.size).toBeGreaterThanOrEqual(12);
  });

  it('carries UTF-8 (Romanian diacritics) and refuses what cannot fit', () => {
    const t = 'Factură nr. 114 · Șoseaua Iași 5 · total 2.500,00 lei';
    expect(decode(t, 'Q').read).toBe(t);
    expect(() => encodeQr('x'.repeat(4000), 'H')).toThrow(/too long/);
  });
});
