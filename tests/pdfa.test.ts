import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolve } from 'node:path';
import { convertToPdfA, convertToPdfADetailed, pdfaWarnings, type PdfALevel } from '../src/lib/pdf/pdfa';

const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/';
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, standardFontDataUrl, verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

/** Sample with text, optional content, an embedded file and a transparent ExtGState. */
async function makeSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText('Archive body text', { x: 40, y: 200, size: 18, font });
  page.drawRectangle({ x: 40, y: 40, width: 100, height: 50, opacity: 0.5 });
  const ctx = doc.context;
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: 'Layer A' }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { ON: [ocg], Order: [ocg] } }));
  await doc.attach(new TextEncoder().encode('hello'), 'old.txt', { mimeType: 'text/plain' });
  return doc.save({ useObjectStreams: true });
}

function xmpOf(doc: PDFDocument): string {
  const meta = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata'))) as PDFRawStream;
  return new TextDecoder().decode(meta.contents);
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 65536) s += String.fromCharCode(...b.subarray(i, i + 65536));
  return s;
}

describe.each<[PdfALevel, string, number]>([
  ['1b', '%PDF-1.4', 1],
  ['2b', '%PDF-1.7', 2],
  ['3b', '%PDF-1.7', 3],
])('PDF/A-%s', (level, header, part) => {
  it('writes header, XMP part, output intent and opens in pdf.js', async () => {
    const src = await makeSource();
    const docx = new TextEncoder().encode('PK fake docx');
    const { bytes: out, notes } = await convertToPdfADetailed(src, {
      title: `Titlu ${level} ăîșț`,
      author: 'Ana Pop',
      level,
      attachments: [{ name: 'original.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx, relationship: 'Source' }],
    });
    expect(latin1(out.subarray(0, 8))).toBe(header);
    const raw = latin1(out);
    expect(raw).not.toMatch(/\/Type\s*\/ObjStm/);
    expect(raw).not.toMatch(/\/Type\s*\/XRef/);

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const xmp = xmpOf(doc);
    expect(xmp).toContain(`<pdfaid:part>${part}</pdfaid:part>`);
    expect(xmp).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    const intents = doc.catalog.lookup(PDFName.of('OutputIntents'), PDFArray);
    const intent = intents.lookup(0, PDFDict);
    expect(intent.get(PDFName.of('S'))).toBe(PDFName.of('GTS_PDFA1'));
    expect(doc.context.lookup(intent.get(PDFName.of('DestOutputProfile')))).toBeInstanceOf(PDFRawStream);

    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (level === '1b') {
      expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(false);
      expect(raw).not.toMatch(/\/OCProperties/);
    } else {
      expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(true);
    }
    if (level === '3b') {
      const af = doc.catalog.lookup(PDFName.of('AF'), PDFArray);
      expect(af.size()).toBe(2);
      const rels: string[] = [];
      for (let i = 0; i < af.size(); i++) {
        const ref = af.get(i);
        expect(ref).toBeInstanceOf(PDFRef);
        const fs = doc.context.lookup(ref, PDFDict);
        rels.push((fs.get(PDFName.of('AFRelationship')) as PDFName).decodeText());
        expect(fs.has(PDFName.of('UF'))).toBe(true);
        const ef = fs.lookup(PDFName.of('EF'), PDFDict);
        const stream = doc.context.lookup(ef.get(PDFName.of('F'))) as PDFRawStream;
        expect(stream.dict.get(PDFName.of('Subtype'))).toBeInstanceOf(PDFName);
        expect(stream.dict.lookup(PDFName.of('Params'), PDFDict).has(PDFName.of('ModDate'))).toBe(true);
      }
      expect(rels.sort()).toEqual(['Source', 'Unspecified']);
      expect(names?.has(PDFName.of('EmbeddedFiles'))).toBe(true);
      const w = await pdfaWarnings(out);
      expect(w.join('\n')).not.toMatch(/AFRelationship|MIME|ModDate|not listed/);
    } else {
      expect(names?.has(PDFName.of('EmbeddedFiles')) ?? false).toBe(false);
      expect(doc.catalog.has(PDFName.of('AF'))).toBe(false);
      expect(raw).not.toMatch(/\/Type\s*\/EmbeddedFile/);
      expect(notes.join('\n')).toMatch(/attachment\(s\) were not embedded/);
    }

    const pdf = await openPdf(out);
    const md = await pdf.getMetadata();
    expect((md.info as Record<string, unknown>).Title).toBe(`Titlu ${level} ăîșț`);
    expect(md.metadata?.get('dc:title')).toBe(`Titlu ${level} ăîșț`);
    const page = await pdf.getPage(1);
    const tc = await page.getTextContent();
    expect(tc.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain('Archive body text');
    if (level === '3b') {
      const att = await pdf.getAttachments();
      expect(att?.size).toBe(2);
    }

    const warnings = await pdfaWarnings(out, level);
    expect(warnings[warnings.length - 1]).toMatch(new RegExp(`PDF/A-${level}.*veraPDF`));
    // Level detection from XMP gives the same answer.
    expect(await pdfaWarnings(out)).toEqual(warnings);
    if (level === '1b') expect(warnings.join('\n')).toMatch(/PDF\/A-1 forbids transparency/);
    else expect(warnings.join('\n')).not.toMatch(/forbids transparency/);
  });
});

describe('convertToPdfA defaults', () => {
  it('defaults to 2b and keeps the old signature', async () => {
    const out = await convertToPdfA(await makeSource(), { title: 'T', author: 'A' });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(xmpOf(doc)).toContain('<pdfaid:part>2</pdfaid:part>');
  });

  it('flags JPX, 16-bit, LZW and embedded files for 1b', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const ctx = doc.context;
    ctx.register(ctx.stream(new Uint8Array([0]), { Type: 'XObject', Subtype: 'Image', Filter: 'JPXDecode', Width: 1, Height: 1 }));
    ctx.register(ctx.stream(new Uint8Array([0, 0]), { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 16, Width: 1, Height: 1, ColorSpace: 'DeviceGray' }));
    ctx.register(ctx.stream(new Uint8Array([0]), { Filter: 'LZWDecode' }));
    const w = (await pdfaWarnings(await doc.save({ useObjectStreams: false }), '1b')).join('\n');
    expect(w).toMatch(/JPEG 2000/);
    expect(w).toMatch(/16 bits/);
    expect(w).toMatch(/LZW/);
    expect(w).toMatch(/header/);
  });
});
