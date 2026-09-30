import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { groupLines, lineColors, makeEditable, sizeFor } from '@/lib/pdf/editableScan';
import type { OcrWord } from '@/lib/pdf/ocr';
import { pageContent } from '@/lib/pdf/textRemoval';

const font = () => Promise.resolve(new Uint8Array(readFileSync(join(process.cwd(), 'node_modules', '@expo-google-fonts', 'noto-serif', '400Regular', 'NotoSerif_400Regular.ttf'))));
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
const w = (text: string, x: number, y: number, width: number, height: number, confidence = 90): OcrWord => ({ text, x, y, width, height, confidence });

describe('editable scans', () => {
  it('groups words into lines, splits columns, drops unsure words', () => {
    const lines = groupLines([
      w('Contract', 60, 100, 60, 12),
      w('nr.', 124, 101, 18, 11),
      w('12', 146, 100, 14, 12),
      w('Pagina', 400, 100, 40, 12), // another column on the same line
      w('Data:', 60, 130, 32, 12),
      w('~#~', 100, 130, 20, 12, 10), // noise
    ]);
    expect(lines.map((l) => l.words.map((x) => x.text).join(' '))).toEqual(['Contract nr. 12', 'Pagina', 'Data:']);
    expect(lines[0]).toMatchObject({ x: 60, y: 100, width: 100 });
  });

  it('sizes the font from the glyph height of the line', () => {
    expect(sizeFor('Contract', 7.2).size).toBeCloseTo(10, 1); // capitals, no descenders
    const s = sizeFor('Typography', 9.6);
    expect(s.size).toBeCloseTo(10, 1);
    expect(s.descent).toBeCloseTo(2.4, 1);
  });

  it('reads paper and ink colours from the scan, paints over the line and writes real text', async () => {
    // A "scan": dark blue text on beige paper, 2 px per point.
    const scale = 2;
    const cv = createCanvas(595 * scale, 200 * scale);
    const g = cv.getContext('2d');
    g.fillStyle = 'rgb(245,235,215)';
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = 'rgb(20,40,120)';
    g.font = `${24 * scale}px serif`;
    g.fillText('Contract', 60 * scale, 100 * scale);
    const m = g.measureText('Contract');
    const box = { x: 60, y: 100 - m.actualBoundingBoxAscent / scale, width: m.width / scale, height: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / scale };
    const img = g.getImageData(0, 0, cv.width, cv.height);
    const { bg, fg } = lineColors({ data: img.data, width: img.width, height: img.height, scale }, box);
    expect(bg).toEqual([245, 235, 215]);
    expect(Math.abs(fg[0] - 20) + Math.abs(fg[1] - 40) + Math.abs(fg[2] - 120)).toBeLessThan(60);

    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 200]);
    const png = await doc.embedPng(cv.toBuffer('image/png'));
    page.drawImage(png, { x: 0, y: 0, width: 595, height: 200 });
    const scan = await doc.save();
    const out = await makeEditable(scan, [{ pageNumber: 1, widthPt: 595, heightPt: 200, lines: [{ text: 'Contract', ...box, bg, fg }] }], { loadFont: font });
    expect(out.lines).toBe(1);

    const task = pdfjs.getDocument({ data: out.bytes.slice(), verbosity: 0 });
    tasks.push(task);
    const tc = await (await (await task.promise).getPage(1)).getTextContent();
    const item = tc.items.find((i) => 'str' in i && i.str === 'Contract') as { transform: number[]; width: number } | undefined;
    expect(item).toBeTruthy();
    // Same place and width as the scanned word (Tz squeezes it to fit).
    expect(item!.transform[4]).toBeCloseTo(60, 0);
    expect(item!.width).toBeCloseTo(box.width, 0);
    const content = new TextDecoder().decode(pageContent(await PDFDocument.load(out.bytes), (await PDFDocument.load(out.bytes)).getPage(0)));
    expect(content).toContain(`${(245 / 255).toFixed(2).replace(/0+$/, '')}`.slice(0, 4)); // the paper colour fill
    expect(content).toMatch(/ Tz/);
  });
});
