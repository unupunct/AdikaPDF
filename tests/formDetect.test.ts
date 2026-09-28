import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { cleanLabel, detectFields, fieldNames, type LabelRun } from '@/lib/formDetect';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const H = 842;

/** A typical Romanian form, plus things that must NOT become fields. */
async function formPdf(): Promise<{ bytes: Uint8Array; runs: LabelRun[] }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync(join(process.cwd(), 'node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf')));
  const p = doc.addPage([595, H]);
  const runs: LabelRun[] = [];
  const text = (s: string, x: number, y: number, size = 11) => {
    p.drawText(s, { x, y, size, font });
    runs.push({ str: s, rect: { x, y: H - y - size * 0.8, width: font.widthOfTextAtSize(s, size), height: size } });
  };
  const line = (x0: number, x1: number, y: number) => p.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.8, color: rgb(0, 0, 0) });

  text('Cerere de înscriere', 60, 780, 16);
  // Underlined heading: a line right under text, no free space -> not a field.
  line(60, 210, 776);
  text('Nume și prenume:', 60, 730);
  line(160, 420, 728);
  text('Data nașterii:', 60, 700);
  line(140, 260, 698);
  // Checkboxes with labels on the right.
  text('Cetățean român:', 60, 660);
  p.drawRectangle({ x: 160, y: 658, width: 10, height: 10, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  text('Da', 175, 660);
  p.drawRectangle({ x: 210, y: 658, width: 10, height: 10, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  text('Nu', 225, 660);
  // Decoys: a filled bullet and the letter O.
  p.drawRectangle({ x: 60, y: 630, width: 8, height: 8, color: rgb(0, 0, 0) });
  text('O listă cu puncte', 75, 630);
  // Table: labels left, empty cells right.
  const top = 600;
  for (let r = 0; r <= 2; r++) line(60, 420, top - r * 24);
  for (const x of [60, 180, 420]) p.drawLine({ start: { x, y: top }, end: { x, y: top - 48 }, thickness: 0.8, color: rgb(0, 0, 0) });
  text('Localitate', 66, top - 17);
  text('Telefon', 66, top - 41);
  return { bytes: await doc.save(), runs };
}

async function render(bytes: Uint8Array, scale: number) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const page = await (await task.promise).getPage(1);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never }).promise;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

describe('form field detection', () => {
  it('finds fill-in lines, empty table cells and checkboxes with their labels, and nothing else', async () => {
    const { bytes, runs } = await formPdf();
    const img = await render(bytes, 2);
    const found = detectFields(img, 2, runs);
    const summary = found.map((f) => `${f.kind}:${f.source}:${f.label}`);
    expect(summary).toEqual([
      'text:line:Nume și prenume',
      'text:line:Data nașterii',
      'checkbox:square:Da',
      'checkbox:square:Nu',
      'text:cell:Localitate',
      'text:cell:Telefon',
    ]);
    // The name field sits on its line, above it, as wide as the line.
    const name = found[0].rect;
    expect(name.x).toBeCloseTo(160, 0);
    expect(name.x + name.width).toBeCloseTo(420, 0);
    expect(name.y + name.height).toBeLessThanOrEqual(H - 728);
    expect(name.height).toBeGreaterThanOrEqual(9);
    // Checkbox: the drawn 10 pt square.
    expect(found[2].rect.width).toBeCloseTo(10.8, 0);
    // Table cell: inside the right column of the first row.
    const cell = found[4].rect;
    expect(cell.x).toBeGreaterThan(180);
    expect(cell.x + cell.width).toBeLessThan(420);
    expect(cell.y).toBeGreaterThan(H - 600);
    expect(cell.y + cell.height).toBeLessThan(H - 576);
  });

  it('does not detect fields that already exist', async () => {
    const { bytes, runs } = await formPdf();
    const img = await render(bytes, 2);
    const all = detectFields(img, 2, runs);
    const again = detectFields(img, 2, runs, all.map((f) => f.rect));
    expect(again).toEqual([]);
  });

  it('cleans labels and makes unique names', () => {
    expect(cleanLabel('Nume și prenume: ________')).toBe('Nume și prenume');
    expect(cleanLabel('Semnătura ......')).toBe('Semnătura');
    const names = fieldNames(
      [
        { kind: 'text', rect: { x: 0, y: 0, width: 1, height: 1 }, label: 'Nume', source: 'line' },
        { kind: 'text', rect: { x: 0, y: 0, width: 1, height: 1 }, label: 'Nume', source: 'line' },
        { kind: 'checkbox', rect: { x: 0, y: 0, width: 1, height: 1 }, label: '', source: 'square' },
        { kind: 'text', rect: { x: 0, y: 0, width: 1, height: 1 }, label: '', source: 'line' },
      ],
      ['Text1'],
    );
    expect(names).toEqual(['Nume', 'Nume 2', 'Check1', 'Text2']);
  });
});
