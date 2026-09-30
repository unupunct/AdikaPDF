import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PATTERNS, decodeSymbols, encodeModules, encodeSymbols, readCode128 } from '@/lib/barcode/code128';
import { binarize, rotateQuarter, toGray } from '@/lib/scan/cleanup';

describe('Code 128', () => {
  it('has 106 distinct 11-module symbols and a 13-module stop', () => {
    expect(new Set(PATTERNS).size).toBe(107);
    PATTERNS.slice(0, 106).forEach((p) => expect([...p].reduce((s, c) => s + Number(c), 0)).toBe(11));
    expect([...PATTERNS[106]].reduce((s, c) => s + Number(c), 0)).toBe(13);
  });

  it('encodes with code B / C and a checksum, and decodes back', () => {
    // "PJJ123C": Start B, P J J 1 2 3 C, check (104 + Σ i·v) mod 103 = 55, stop.
    expect(encodeSymbols("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    for (const t of ['ADIKA:SPLIT', 'ADIKA:SPLIT:Factura 2026-114', '1234567890', 'x', '']) expect(decodeSymbols(encodeSymbols(t))).toBe(t);
    const digits = encodeSymbols('12345678');
    expect(digits[0]).toBe(105); // code C: two digits per symbol
    expect(digits.length).toBe(1 + 4 + 2);
    const bad = encodeSymbols('ADIKA');
    bad[2] = (bad[2] + 1) % 96;
    expect(decodeSymbols(bad)).toBeNull();
  });

  it('reads a printed barcode from a scanned page, also upside down', () => {
    const w = 1500;
    const h = 500;
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.font = '40px sans-serif';
    g.fillText('SEPARATOR — Adika PDF Editor', 80, 80);
    const mods = encodeModules('ADIKA:SPLIT:Contract 7');
    const mw = 4;
    mods.forEach((bar, i) => {
      if (bar) g.fillRect(120 + i * mw, 150, mw, 180);
    });
    // As a scanner sees it: resampled to 3.7 px per module, smoothed edges.
    const s2 = createCanvas(w, h);
    const g2 = s2.getContext('2d');
    g2.fillStyle = '#fff';
    g2.fillRect(0, 0, w, h);
    g2.imageSmoothingEnabled = true;
    g2.drawImage(c, 0, 0, w * 0.925, h * 0.925);
    const d = g2.getImageData(0, 0, w, h);
    const img = { data: new Uint8ClampedArray(d.data), width: w, height: h };
    expect(readCode128(binarize(toGray(img)), w, h)).toEqual(['ADIKA:SPLIT:Contract 7']);
    const flipped = rotateQuarter(img, 2);
    expect(readCode128(binarize(toGray(flipped)), w, h)).toEqual(['ADIKA:SPLIT:Contract 7']);
    // A page with only text has no barcode.
    const t = createCanvas(w, h).getContext('2d');
    t.fillStyle = '#fff';
    t.fillRect(0, 0, w, h);
    t.fillStyle = '#000';
    t.font = '40px sans-serif';
    for (let i = 0; i < 8; i++) t.fillText('Lorem ipsum dolor sit amet, ||| lll 111 consectetur', 30, 50 + i * 55);
    const td = t.getImageData(0, 0, w, h);
    expect(readCode128(binarize(toGray({ data: new Uint8ClampedArray(td.data), width: w, height: h })), w, h)).toEqual([]);
  });
});
