// Small synthetic reproductions of failures found by the corpus run (tests/corpus).
import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { editableCopy, loadEditable, pdfLibProblem } from '@/lib/pdf/editable';
import { buildIncrementalPdf, buildPdf, incrementalBlocker } from '@/lib/pdf/exportPdf';
import type { PageRef, SourceDoc } from '@/types';
import { loadFont, measure, rasterize } from './helpers/redaction';
import { rawPdf, stream } from './helpers/rawPdf';

const tasks: Array<{ destroy(): Promise<void> }> = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

async function pdfjsPages(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(''));
  return out;
}

function refs(src: SourceDoc, n: number): PageRef[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, kind: 'source' as const, sourceId: src.id, sourceIndex: i, baseRotation: 0 as const, userRotation: 0 as const, width: 200, height: 200 }));
}

describe('files pdf.js opens but pdf-lib cannot edit as they are', () => {
  // Catalog, page tree and page without /Type (pdfium bug_547706-like): pdf-lib finds no catalog class.
  const untyped = rawPdf([
    '<< /Pages 2 0 R >>',
    '<< /Kids [3 0 R] /Count 1 >>',
    `<< /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    stream('BT /F1 12 Tf 20 100 Td (Untyped tree) Tj ET'),
    FONT,
  ]);

  it('pdf.js shows the page; pdf-lib cannot walk it; the repaired copy can', async () => {
    expect(await pdfjsPages(untyped)).toEqual(['Untyped tree']);
    const raw = await PDFDocument.load(untyped, { updateMetadata: false }).catch(() => null);
    expect(raw === null || pdfLibProblem(raw, 1) !== null).toBe(true);
    const fixed = await editableCopy(untyped, 1);
    expect(fixed).not.toBeNull();
    expect(pdfLibProblem(await PDFDocument.load(fixed!), 1)).toBeNull();
  });

  it('saving keeps the page and its text', async () => {
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes: untyped, pageCount: 1 };
    const out = await buildPdf({ sources: { s: src }, pages: refs(src, 1), objects: [], fieldValues: {} }, { loadFont, measure, rasterizeRedactedPage: rasterize, fallbackFonts: null });
    expect(await pdfjsPages(out)).toEqual(['Untyped tree']);
  });

  it('a sound file is loaded as it is', async () => {
    const d = await PDFDocument.create();
    d.addPage([100, 100]);
    const bytes = await d.save();
    expect(await editableCopy(bytes, 1)).toBeNull();
    expect((await loadEditable(bytes, {}, 1)).getPageCount()).toBe(1);
  });
});

describe('incremental save of a file whose cross-reference table is gone', () => {
  const damaged = (tail: string) => {
    const good = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      stream('BT /F1 12 Tf 20 100 Td (Kept text) Tj ET'),
      FONT,
    ]);
    const s = Buffer.from(good).toString('latin1');
    // The table goes, the trailer stays (pdf.js finds the catalog through it).
    return new Uint8Array(Buffer.from(s.slice(0, s.indexOf('xref')) + s.slice(s.indexOf('trailer'), s.indexOf('startxref')) + tail, 'latin1'));
  };

  for (const [name, tail] of [
    ['no table and no startxref', '%%EOF\n'],
    ['startxref pointing nowhere', 'startxref\n999999\n%%EOF\n'],
  ] as const) {
    it(`${name}: the update carries a full table, the original bytes stay`, async () => {
      const bytes = damaged(tail);
      expect(await pdfjsPages(bytes)).toEqual(['Kept text']);
      const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1, original: true };
      const note = { id: 'n', type: 'note' as const, pageId: 'p0', x: 10, y: 10, width: 20, height: 20, rotation: 0, opacity: 1, text: 'added note', color: '#ffd400', author: 'a', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z' };
      const input = { sources: { s: src }, pages: refs(src, 1), objects: [note], fieldValues: {} };
      expect(incrementalBlocker(input)).toBeNull();
      const out = await buildIncrementalPdf(input, { loadFont, measure });
      expect(Buffer.from(out.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true);
      expect(Buffer.from(out).toString('latin1')).not.toContain('/Prev');
      const task = pdfjs.getDocument({ data: out.slice(), verbosity: 0 });
      tasks.push(task);
      const doc = await task.promise;
      const annots = await (await doc.getPage(1)).getAnnotations();
      expect(annots.some((a) => a.contentsObj?.str === 'added note')).toBe(true);
      expect(await pdfjsPages(out)).toEqual(['Kept text']);
    });
  }
});

describe('incremental save of an XFA form', () => {
  it('is blocked up front (a full save), not refused while saving', () => {
    const bytes = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA 4 0 R >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
      stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'),
    ]);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1, original: true };
    expect(incrementalBlocker({ sources: { s: src }, pages: refs(src, 1), objects: [], fieldValues: {} })).toMatch(/XFA/);
  });
});
