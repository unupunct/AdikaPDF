import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { BATCH_OPS, BatchSkip, outputPath, runBatchOp, type BatchOp } from '@/lib/batch';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const ctx = { fileName: 'raport.pdf', loadFont };
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
async function textOf(bytes: Uint8Array, password?: string) {
  const task = pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0 });
  tasks.push(task);
  const c = await (await (await task.promise).getPage(1)).getTextContent();
  return c.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Raport lunar', { x: 60, y: 760, size: 18, font });
  const form = doc.getForm();
  const f = form.createTextField('Nume');
  f.setText('Ana Pop');
  f.addToPage(p, { x: 60, y: 700, width: 200, height: 20 });
  doc.setAuthor('Secret Author');
  doc.setTitle('Internal title');
  return doc.save();
}

describe('batch operations', () => {
  it('every operation has a distinct suffix', () => {
    expect(new Set(BATCH_OPS.map((o) => o.suffix)).size).toBe(BATCH_OPS.length);
  });

  it('watermark, protect, sanitize, flatten and PDF/A produce valid PDFs', async () => {
    const src = await sample();
    const wm = await runBatchOp(src, { kind: 'watermark', text: 'CONFIDENȚIAL' }, ctx);
    expect(await textOf(wm.bytes)).toContain('CONFIDENȚIAL');

    const prot = await runBatchOp(src, { kind: 'protect', userPassword: 'parola123' }, ctx);
    expect(isPdfEncrypted(prot.bytes)).toBe(true);
    expect(await textOf(prot.bytes, 'parola123')).toContain('Raport lunar');

    const san = await runBatchOp(src, { kind: 'sanitize' }, ctx);
    const sd = await PDFDocument.load(san.bytes);
    expect(sd.getAuthor() ?? '').toBe('');
    expect(Buffer.from(san.bytes).includes(Buffer.from('Secret Author'))).toBe(false);

    const flat = await runBatchOp(src, { kind: 'flatten' }, ctx);
    const fd = await PDFDocument.load(flat.bytes);
    expect(fd.getForm().getFields()).toHaveLength(0);
    expect(await textOf(flat.bytes)).toContain('Ana Pop');

    const a = await runBatchOp(src, { kind: 'pdfa' }, ctx);
    expect(Buffer.from(a.bytes).toString('latin1')).toContain('pdfaid:part');
    // What the conversion changed and could not fix reaches the batch results.
    expect(a.note).toMatch(/not embedded/);
    expect(a.note).not.toMatch(/veraPDF/);
  });

  it('skips password-protected files and files that cannot be made smaller', async () => {
    const src = await sample();
    const prot = (await runBatchOp(src, { kind: 'protect', userPassword: 'x' }, ctx)).bytes;
    await expect(runBatchOp(prot, { kind: 'sanitize' }, ctx)).rejects.toBeInstanceOf(BatchSkip);
    // Compress either makes the file smaller or skips it (never a bigger "compressed" copy).
    const c = await runBatchOp(src, { kind: 'compress', level: 'strong' } as BatchOp, ctx).catch((e: unknown) => e);
    if (c instanceof BatchSkip) expect(c.message).toMatch(/already well optimised/);
    else expect((c as { bytes: Uint8Array }).bytes.length).toBeLessThan(src.length);
  });

  it('names outputs next to the original without overwriting', async () => {
    const taken = new Set(['C:\\Docs\\raport-ocr.pdf', 'C:\\Docs\\raport-ocr (2).pdf']);
    expect(await outputPath('C:\\Docs\\raport.pdf', '-ocr', async (p) => taken.has(p))).toBe('C:\\Docs\\raport-ocr (3).pdf');
    expect(await outputPath('C:\\Docs\\Contract.PDF', '-protected', async () => false)).toBe('C:\\Docs\\Contract-protected.pdf');
  });
});
