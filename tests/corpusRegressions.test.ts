// Small synthetic reproductions of failures found by the corpus run (tests/corpus).
import { afterAll, describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { editableCopy, loadEditable, pdfLibProblem } from '@/lib/pdf/editable';
import { buildIncrementalPdf, buildPdf, incrementalBlocker } from '@/lib/pdf/exportPdf';
import { analyzePageText } from '@/lib/pdf/textRemoval';
import { checkPdfUa } from '@/lib/pdf/pdfua';
import { scanHiddenInfo } from '@/lib/pdf/hiddenInfo';
import { compressPdf } from '@/lib/pdf/compress';
import { findTextMatches, queryFinder } from '@/lib/pdf/textSearch';
import type { PageRef, SourceDoc } from '@/types';
import { loadFont, measure, rasterize } from './helpers/redaction';
import { rawPdf, stream } from './helpers/rawPdf';
import { encryptFixture } from './helpers/pdfEncryptor';
import { scanFile } from '@/lib/pdf/repair';
import { decryptPdf, UnsupportedEncryptionError } from '@/lib/crypto/decrypt';

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

  it('the checks and Compress read it through the repaired copy', async () => {
    await expect(checkPdfUa(untyped)).resolves.toBeTruthy();
    await expect(scanHiddenInfo(untyped)).resolves.toBeTruthy();
    const res = await compressPdf(untyped, { imageQuality: 0.6, maxImageDpi: 150, stripMetadata: false });
    expect(await pdfjsPages(res.bytes)).toEqual(['Untyped tree']);
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

  it('objects in an object stream: the update carries a complete cross-reference stream', async () => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>'];
    let head = '';
    let body = '';
    objs.forEach((b, i) => {
      head += `${i + 1} ${body.length} `;
      body += `${b}\n`;
    });
    const data = head + body;
    const content = 'BT /F1 12 Tf 20 100 Td (Packed text) Tj ET';
    let s = `%PDF-1.5\n`;
    const at: number[] = [];
    at[4] = s.length;
    s += `4 0 obj\n<< /Type /ObjStm /N 3 /First ${head.length} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
    at[5] = s.length;
    s += `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
    at[6] = s.length;
    s += `6 0 obj\n${FONT}\nendobj\n`;
    at[7] = s.length;
    // A cross-reference stream (W 1 2 1), but startxref points past the end of the file.
    const row = (t: number, a: number, b: number) => String.fromCharCode(t, (a >> 8) & 255, a & 255, b);
    const rows = row(0, 0, 255) + [1, 2, 3].map((i) => row(2, 4, i - 1)).join('') + [4, 5, 6, 7].map((n) => row(1, at[n], 0)).join('');
    s += `7 0 obj\n<< /Type /XRef /Size 8 /W [1 2 1] /Root 1 0 R /Length ${rows.length} >>\nstream\n${rows}\nendstream\nendobj\nstartxref\n999999\n%%EOF\n`;
    const bytes = new Uint8Array(Buffer.from(s, 'latin1'));
    expect(await pdfjsPages(bytes)).toEqual(['Packed text']);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1, original: true };
    const note = { id: 'n', type: 'note' as const, pageId: 'p0', x: 10, y: 10, width: 20, height: 20, rotation: 0, opacity: 1, text: 'added note', color: '#ffd400', author: 'a', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z' };
    const out = await buildIncrementalPdf({ sources: { s: src }, pages: refs(src, 1), objects: [note], fieldValues: {} }, { loadFont, measure });
    expect(Buffer.from(out.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true);
    expect(Buffer.from(out).toString('latin1')).toContain('/Type /XRef');
    const task = pdfjs.getDocument({ data: out.slice(), verbosity: 0 });
    tasks.push(task);
    const annots = await (await (await task.promise).getPage(1)).getAnnotations();
    expect(annots.some((a) => a.contentsObj?.str === 'added note')).toBe(true);
    expect(await pdfjsPages(out)).toEqual(['Packed text']);
  });
});

describe('incremental save of an XFA form', () => {
  const bytes = rawPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA 4 0 R >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'),
  ]);
  const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1, original: true };

  it('filled-in values are blocked up front (a full save), not refused while saving', () => {
    expect(incrementalBlocker({ sources: { s: src }, pages: refs(src, 1), objects: [], fieldValues: { 's::name': 'x' } })).toMatch(/XFA/);
  });

  it('comments are appended and the XFA stays', async () => {
    const note = { id: 'n', type: 'note' as const, pageId: 'p0', x: 10, y: 10, width: 20, height: 20, rotation: 0, opacity: 1, text: 'on xfa', color: '#ffd400', author: 'a', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z' };
    const input = { sources: { s: src }, pages: refs(src, 1), objects: [note], fieldValues: {} };
    expect(incrementalBlocker(input)).toBeNull();
    const out = await buildIncrementalPdf(input, { loadFont, measure });
    expect(Buffer.from(out.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true);
    const doc = await PDFDocument.load(out);
    expect(doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).get(PDFName.of('XFA'))).toBeDefined();
  });
});

describe('a page pdf.js shows but pdf-lib cannot parse', () => {
  // /Contents is a direct stream (not allowed): pdf-lib drops the page object, pdf.js still draws it.
  const s = 'BT /F1 24 Tf 20 100 Td (Direct) Tj ET';
  const bytes = rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Contents << /Length ${s.length} >>\nstream\n${s}\nendstream\n/Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`,
  ]);

  it('is saved from its rendering instead of failing', async () => {
    expect(await pdfjsPages(bytes)).toEqual(['Direct']);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    let asked = 0;
    const out = await buildPdf(
      { sources: { s: src }, pages: refs(src, 1), objects: [{ id: 'rd', type: 'redact', pageId: 'p0', x: 10, y: 10, width: 50, height: 20, rotation: 0, opacity: 1, fill: '#000000' }], fieldValues: {} },
      { loadFont, measure, fallbackFonts: null, rasterizeRedactedPage: async (_p, rects) => (asked++, expect(rects).toHaveLength(1), rasterize()) },
    );
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 200, height: 200 });
    // Repaired (the text stays real) or, failing that, rebuilt from the rendering with the box burned in.
    expect(asked === 1 || (await pdfjsPages(out))[0] === 'Direct').toBe(true);
  });
});

describe('repair reads what pdf.js reads', () => {
  const body = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  /** Objects 1-3 in an object stream (object 4), stored with `dict` and `data`. */
  const inStream = (dict: string, pack: (s: string) => Buffer) => {
    let head = '';
    let objs = '';
    body.forEach((b, i) => {
      head += `${i + 1} ${objs.length} `;
      objs += `${b}\n`;
    });
    const data = pack(head + objs);
    const pre = `%PDF-1.5\n4 0 obj\n<< ${dict} /N 3 /First ${head.length} /Length ${data.length} >>\nstream\n`;
    return new Uint8Array(Buffer.concat([Buffer.from(pre, 'latin1'), data, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')]));
  };

  it('an object stream with a wrong /Type', async () => {
    const fixed = await editableCopy(inStream('/Type /Potato', (s) => Buffer.from(s, 'latin1')), 1);
    expect(fixed).not.toBeNull();
  });

  it('an object stream with an abbreviated filter name (/Fl)', async () => {
    const fixed = await editableCopy(inStream('/Type /ObjStm /Filter /Fl', (s) => deflateSync(Buffer.from(s, 'latin1'))), 1);
    expect(fixed).not.toBeNull();
  });

  it('pages written directly into /Kids', async () => {
    const bytes = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [<< /Type /Page /MediaBox [0 0 200 200] >> << /Type /Page /MediaBox [0 0 300 300] >>] /Count 2 >>']);
    const fixed = await editableCopy(bytes, 2);
    expect(fixed).not.toBeNull();
    expect((await PDFDocument.load(fixed!)).getPages().map((p) => p.getWidth())).toEqual([200, 300]);
  });
});

describe('objects written right after endobj (no line break)', () => {
  it('are found by the scan (repair, decryption)', () => {
    const s = '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
    expect(scanFile(new Uint8Array(Buffer.from(s, 'latin1'))).headers.map((h) => h.num)).toEqual([1, 2, 3]);
  });
});

describe('decryption that does not produce readable object streams', () => {
  it('is refused (the file stays read-only) instead of saving garbage', async () => {
    const d = await PDFDocument.create();
    d.addPage([200, 200]);
    const f = await encryptFixture(await d.save({ useObjectStreams: false }), { handler: 'rc4-128', userPassword: '', ownerPassword: 'o', p: -4, objectStreams: true });
    expect((await decryptPdf(f.bytes, '')).bytes.length).toBeGreaterThan(0);
    // The same object stream claiming Flate data: after decryption it does not inflate.
    const bad = new Uint8Array(Buffer.from(Buffer.from(f.bytes).toString('latin1').replace('<< /Type /ObjStm', '<< /Filter /FlateDecode /Type /ObjStm'), 'latin1'));
    await expect(decryptPdf(bad, '')).rejects.toBeInstanceOf(UnsupportedEncryptionError);
  });
});

describe('saving files with odd structures', () => {
  const save = async (bytes: Uint8Array) => {
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    return buildPdf({ sources: { s: src }, pages: refs(src, 1), objects: [], fieldValues: {} }, { loadFont, measure, rasterizeRedactedPage: rasterize, fallbackFonts: null });
  };
  const textPage = (extraCatalog = '', extraPage = '', more: string[] = []) =>
    rawPdf([
      `<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> ${extraPage} >>`,
      stream('BT /F1 12 Tf 20 100 Td (Body text) Tj ET'),
      FONT,
      ...more,
    ]);

  it('no %PDF- header', async () => {
    const s = Buffer.from(textPage()).toString('latin1');
    // A binary comment where the header should be (pdfjs bug1606566), offsets unchanged.
    const bytes = new Uint8Array(Buffer.from('%\xe2\xe3\xcf\xd3\xe2\xe3\xcf' + s.slice(8), 'latin1'));
    expect(await pdfjsPages(bytes)).toEqual(['Body text']);
    expect(await pdfjsPages(await save(bytes))).toEqual(['Body text']);
  });

  it('a rich text field without an appearance', async () => {
    const bytes = textPage('/AcroForm << /Fields [6 0 R] /DA (/Helv 0 Tf 0 g) >>', '/Annots [6 0 R]', [
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Rich) /Ff 33554432 /V (plain) /RV (<body>plain</body>) /Rect [20 20 120 40] /P 3 0 R /DA (/Helv 10 Tf 0 g) >>',
    ]);
    expect(await pdfjsPages(await save(bytes))).toEqual(['Body text']);
  });

  it('a /Contents that is not a stream, with a drawing added', async () => {
    const bytes = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>']);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    const rect = { id: 'r', type: 'rect' as const, pageId: 'p0', x: 10, y: 10, width: 50, height: 20, rotation: 0, opacity: 1, stroke: '#ff0000', strokeWidth: 1, fill: null };
    const out = await buildPdf({ sources: { s: src }, pages: refs(src, 1), objects: [rect], fieldValues: {} }, { loadFont, measure, rasterizeRedactedPage: rasterize, fallbackFonts: null });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });

  it('an /AcroForm that is not a dictionary', async () => {
    expect(await pdfjsPages(await save(textPage('/AcroForm []')))).toEqual(['Body text']);
  });
});

describe('more pages in pdf.js than pdf-lib finds', () => {
  it('the missing page comes from its rendering, the others stay real', async () => {
    const d = await PDFDocument.create();
    d.addPage([200, 200]);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes: await d.save(), pageCount: 2 };
    const asked: number[] = [];
    const out = await buildPdf({ sources: { s: src }, pages: refs(src, 2), objects: [], fieldValues: {} }, { loadFont, measure, fallbackFonts: null, rasterizeRedactedPage: async (p) => (asked.push(p.sourceIndex), rasterize()) });
    expect(asked).toEqual([1]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });
});

describe('redaction on a page whose CropBox reaches past the MediaBox', () => {
  for (const [name, boxes] of [
    ['CropBox larger than the MediaBox', '/MediaBox [0 0 200 200] /CropBox [0 0 1000 1000]'],
    ['empty CropBox', '/MediaBox [0 0 200 200] /CropBox [0 0 0 0]'],
    ['no MediaBox (US Letter)', ''],
  ] as const) {
    it(`${name}: the box lands where pdf.js shows the text`, async () => {
      const bytes = rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R ${boxes} /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
        stream('BT /F1 12 Tf 20 100 Td (SECRET) Tj 0 50 Td (Public) Tj ET'),
        FONT,
      ]);
      const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
      tasks.push(task);
      const page = await (await task.promise).getPage(1);
      const [x0, y0, x1, y1] = page.view;
      const vp = page.getViewport({ scale: 1 });
      // Display box of "SECRET" (baseline 100, 12 pt) as the viewer computes it.
      const [ax, ay] = vp.convertToViewportPoint(18, 97);
      const [bx, by] = vp.convertToViewportPoint(70, 112);
      const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
      const ref = { ...refs(src, 1)[0], width: x1 - x0, height: y1 - y0 };
      const redact = { id: 'rd', type: 'redact' as const, pageId: 'p0', x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay), rotation: 0, opacity: 1, fill: '#000000' };
      const out = await buildPdf({ sources: { s: src }, pages: [ref], objects: [redact], fieldValues: {} }, { loadFont, measure, rasterizeRedactedPage: rasterize, fallbackFonts: null });
      expect(await pdfjsPages(out)).toEqual(['Public']);
    });
  }
});

describe('a font set by a graphics state (gs /Font)', () => {
  it('is measured with that font and size, so redaction removes the text', async () => {
    const bytes = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ExtGState << /GS1 6 0 R >> >> >>`,
      stream('/F1 4 Tf /GS1 gs BT 20 100 Td (SECRET) Tj 0 100 Td (Public) Tj ET'),
      FONT,
      '<< /Type /ExtGState /Font [7 0 R 30] >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    ]);
    const doc = await PDFDocument.load(bytes);
    const t = analyzePageText(doc, doc.getPage(0));
    expect(t.glyphs[0].size).toBeCloseTo(30);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    // "SECRET" in 30 pt Courier: x 20..128, baseline 100 -> display y 172..206.
    const redact = { id: 'rd', type: 'redact' as const, pageId: 'p0', x: 15, y: 170, width: 120, height: 40, rotation: 0, opacity: 1, fill: '#000000' };
    const out = await buildPdf({ sources: { s: src }, pages: [{ ...refs(src, 1)[0], width: 300, height: 300 }], objects: [redact], fieldValues: {} }, { loadFont, measure, rasterizeRedactedPage: rasterize, fallbackFonts: null });
    expect(await pdfjsPages(out)).toEqual(['Public']);
  });
});

describe('a Type3 font whose FontMatrix mirrors y', () => {
  it('a box over the letters as drawn removes them', async () => {
    const bytes = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /T3 5 0 R >> >> >>`,
      stream('BT /T3 20 Tf 20 100 Td (aa) Tj ET'),
      '<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0 0 -0.001 0 0] /FontBBox [0 0 1000 1000] /FirstChar 97 /LastChar 97 /Widths [1000] /Encoding << /Differences [97 /a] >> /CharProcs << /a 6 0 R >> >>',
      // Drawn at negative y, which the mirrored matrix puts above the baseline.
      stream('1000 0 0 -900 900 0 d1 0 -900 900 900 re f'),
    ]);
    expect(await pdfjsPages(bytes)).toEqual(['aa']);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    // Above the baseline: PDF y 100..118 -> display y 182..200, both letters (x 20..60).
    const redact = { id: 'rd', type: 'redact' as const, pageId: 'p0', x: 18, y: 182, width: 44, height: 18, rotation: 0, opacity: 1, fill: '#000000' };
    const out = await buildPdf({ sources: { s: src }, pages: [{ ...refs(src, 1)[0], width: 300, height: 300 }], objects: [redact], fieldValues: {} }, { loadFont, measure, rasterizeRedactedPage: rasterize, fallbackFonts: null });
    expect(await pdfjsPages(out)).toEqual(['']);
  });
});

describe('search on a font the text engine cannot read', () => {
  it('takes the matches from pdf.js when the engine reads other letters', async () => {
    // Glyph names without Unicode meaning: pdf.js recovers such text from the font program, the engine cannot.
    const bytes = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      stream('BT /F1 12 Tf 20 100 Td (ABCDEF) Tj ET'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /g1 /g2 /g3 /g4 /g5 /g6] >> >>',
    ]);
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    const run = { str: 'Secret', origin: [20, 200] as [number, number], dir: [1, 0] as [number, number], size: 12, width: 40, fontName: 'f', fontFamily: null, bold: false, italic: false };
    const hits = await findTextMatches(refs(src, 1), { s: src }, queryFinder('Secret'), async () => [run]);
    expect(hits).toHaveLength(1);
    expect(hits[0].exact).toBe(false);
    // Where both read the same letters, the engine's exact positions stay.
    const plain = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      stream('BT /F1 12 Tf 20 100 Td (Secret) Tj ET'),
      FONT,
    ]);
    const src2: SourceDoc = { id: 's', name: 'a.pdf', bytes: plain, pageCount: 1 };
    const exact = await findTextMatches(refs(src2, 1), { s: src2 }, queryFinder('Secret'), async () => [run]);
    expect(exact.map((h) => h.exact)).toEqual([true]);
  });
});

describe('text drawn with a negative font size (upside down)', () => {
  const bytes = rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    stream('BT /F1 -12 Tf 250 150 Td (Negative size) Tj ET'),
    FONT,
  ]);

  it('reads as one line of words and is found by search', async () => {
    const doc = await PDFDocument.load(bytes);
    expect(analyzePageText(doc, doc.getPage(0)).text).toBe('Negative size');
    const src: SourceDoc = { id: 's', name: 'a.pdf', bytes, pageCount: 1 };
    const hits = await findTextMatches(refs(src, 1), { s: src }, queryFinder('Negative'));
    expect(hits).toHaveLength(1);
  });
});
