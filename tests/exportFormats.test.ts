import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFNull, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { assignTableColumns, groupTextItems, type PageText, type RawTextItem } from '../src/lib/pdf/convert';
import { buildOdtParts, exportToCsv, exportToJson, exportToOdt, exportToRtf, odfText, rtfEscape } from '../src/lib/pdf/exportFormats';
import { scratchPath, wordReadText } from './helpers/office';

const item = (str: string, x: number, y: number, width: number, fontSize = 11, bold = false): RawTextItem => ({ str, x, y, width, fontSize, bold });

function samplePages(): PageText[] {
  const p1 = assignTableColumns(
    groupTextItems([
      item('Raport anual ăîșț', 50, 60, 250, 24, true),
      item('Țară și oraș: București <&> "citat"', 50, 100, 300),
      item('Textul principal al documentului, cu diacritice: mâine, până, înțelegere.', 50, 116, 400),
      item('Paragraf aldin', 50, 132, 100, 11, true),
      item('Produs', 50, 170, 50),
      item('Cantitate', 200, 170, 60),
      item('Preț', 350, 170, 30),
      item('Mere; roșii', 50, 186, 60),
      item('10', 200, 186, 12),
      item('2,50', 350, 186, 22),
      item('Pere "Williams"', 50, 202, 80),
      item('7', 200, 202, 6),
      item('3,10', 350, 202, 22),
    ]),
  );
  const p2 = groupTextItems([item('Pagina a doua (peisaj) 😀 final', 50, 60, 200), item('Subtitlu secundar', 50, 90, 150, 16)]);
  return [
    { pageNumber: 1, width: 595.28, height: 841.89, lines: p1 },
    { pageNumber: 2, width: 841.89, height: 595.28, lines: p2 },
  ];
}

function wellFormedish(xml: string): void {
  expect(xml.startsWith('<?xml')).toBe(true);
  // No raw ampersands that are not entities, no stray '<' inside text.
  expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(xml)).toBe(false);
  const tags = xml.replace(/<\?xml[^>]*\?>/, '').match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
  const stack: string[] = [];
  for (const t of tags) {
    if (t.endsWith('/>')) continue;
    const name = /^<\/?([^\s>/]+)/.exec(t)![1];
    if (t.startsWith('</')) expect(stack.pop()).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);
}

describe('ODT export', () => {
  it('produces a valid package with mimetype stored first', async () => {
    const blob = await exportToOdt(samplePages(), 'Raport & test');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Local file header of the first entry: name "mimetype", method 0 (stored).
    expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe('mimetype');
    expect(bytes[8] | (bytes[9] << 8)).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(38, 38 + 39))).toBe('application/vnd.oasis.opendocument.text');
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['mimetype', 'META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml']),
    );
    const content = await zip.file('content.xml')!.async('string');
    wellFormedish(content);
    wellFormedish(await zip.file('styles.xml')!.async('string'));
    wellFormedish(await zip.file('meta.xml')!.async('string'));
    wellFormedish(await zip.file('META-INF/manifest.xml')!.async('string'));
    expect(content).toContain('<text:h text:style-name="Heading1_MP1" text:outline-level="1">Raport anual ăîșț</text:h>');
    expect(content).toContain('&lt;&amp;&gt; &quot;citat&quot;');
    expect(content).toContain('<table:table table:name="Table1"');
    expect(content).toContain('table:number-columns-repeated="3"');
    expect(content).toContain('Mere; roșii');
    expect(content).toContain('text:style-name="T_b">Paragraf aldin');
    // Second page is landscape: its own master page.
    const styles = await zip.file('styles.xml')!.async('string');
    expect(styles).toContain('style:name="MP2"');
    expect(styles).toContain('style:print-orientation="landscape"');
    expect(content).toContain('style:master-page-name="MP2"');
    expect(await zip.file('meta.xml')!.async('string')).toContain('<dc:title>Raport &amp; test</dc:title>');
  });

  it('escapes ODF whitespace', () => {
    expect(odfText('a  b\tc\nd')).toBe('a <text:s text:c="1"/>b<text:tab/>c<text:line-break/>d');
    expect(buildOdtParts([], 'x').get('content.xml')).toContain('office:text');
  });
});

describe('RTF export', () => {
  it('escapes non-ASCII as signed 16-bit \\uN? including surrogate pairs', () => {
    expect(rtfEscape('ăîșț')).toBe('\\u259?\\u238?\\u537?\\u539?');
    expect(rtfEscape('😀')).toBe('\\u-10179?\\u-8704?');
    expect(rtfEscape('a{b}\\c\td')).toBe('a\\{b\\}\\\\c\\tab d');
    expect(rtfEscape('�')).toBe('\\u-3?');
  });

  it('builds headings, tables and page breaks', () => {
    const rtf = exportToRtf(samplePages(), 'Raport');
    expect(rtf.startsWith('{\\rtf1\\ansi\\ansicpg1252')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
    expect(/[^\x00-\x7f]/.test(rtf)).toBe(false);
    expect(rtf).toContain('\\outlinelevel0\\b\\f0\\fs40 Raport anual \\u259?\\u238?\\u537?\\u539?\\par');
    expect(rtf.match(/\\trowd/g)?.length).toBe(3);
    expect(rtf.match(/\\cell\b/g)?.length).toBe(9);
    expect(rtf).toContain('\\row');
    // Landscape second page -> new section with its own size.
    expect(rtf).toContain('\\sect\\sectd\\sbkpage\\pgwsxn16838\\pghsxn11906');
    let depth = 0;
    for (let i = 0; i < rtf.length; i++) {
      if (rtf[i] === '\\') {
        i++;
        continue;
      }
      if (rtf[i] === '{') depth++;
      if (rtf[i] === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('uses \\page between same-size pages', () => {
    const pages = samplePages();
    pages[1] = { ...pages[1], width: pages[0].width, height: pages[0].height };
    const rtf = exportToRtf(pages, 'x');
    expect(rtf).toContain('\n\\page\n');
    expect(rtf).not.toContain('\\sbkpage');
  });
});

describe('CSV export', () => {
  it('exports table rows with RFC 4180 quoting, BOM and CRLF', () => {
    const csv = exportToCsv(samplePages());
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toEqual(['Produs,Cantitate,Preț', 'Mere; roșii,10,"2,50"', '"Pere ""Williams""",7,"3,10"', '']);
  });

  it('supports ; and tab delimiters and a page column', () => {
    const semi = exportToCsv(samplePages(), { delimiter: ';', includePageColumn: true });
    expect(semi.slice(1).split('\r\n')).toEqual([
      'Page;Column 1;Column 2;Column 3',
      '1;Produs;Cantitate;Preț',
      '1;"Mere; roșii";10;2,50',
      '1;"Pere ""Williams""";7;3,10',
      '',
    ]);
    const tab = exportToCsv(samplePages(), { delimiter: '\t' });
    expect(tab).toContain('Mere; roșii\t10\t2,50\r\n');
  });

  it('falls back to all lines when there is no table', () => {
    const pages = samplePages().slice(1);
    const csv = exportToCsv(pages);
    expect(csv).toBe('﻿Pagina a doua (peisaj) 😀 final\r\nSubtitlu secundar\r\n');
  });
});

describe('JSON export', () => {
  const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
  afterAll(async () => {
    for (const t of tasks) await t.destroy();
  });

  async function makePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle('Titlu șțăî');
    doc.setAuthor('Adika');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    p1.drawText('Hello page one', { x: 50, y: 780, size: 12, font });
    const p2 = doc.addPage([842, 595]);
    p2.drawText('Second page', { x: 50, y: 540, size: 12, font });
    // Outline: "Intro" -> page 1, with child "Detalii" -> page 2.
    const ctx = doc.context;
    const outlinesRef = ctx.nextRef();
    const introRef = ctx.nextRef();
    const childRef = ctx.nextRef();
    const dest = (ref: typeof p1.ref) => ctx.obj([ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]);
    ctx.assign(childRef, ctx.obj({ Title: PDFString.of('Detalii'), Parent: introRef, Dest: dest(p2.ref) }));
    ctx.assign(
      introRef,
      ctx.obj({ Title: PDFString.of('Intro'), Parent: outlinesRef, First: childRef, Last: childRef, Count: PDFNumber.of(1), Dest: dest(p1.ref) }),
    );
    ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: introRef, Last: introRef, Count: PDFNumber.of(2) }));
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    return doc.save();
  }

  it('includes metadata, flattened outline with page numbers, pages and form fields', async () => {
    const task = pdfjs.getDocument({ data: await makePdf(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    tasks.push(task);
    const pdf = (await task.promise) as unknown as PDFDocumentProxy;
    const json = await exportToJson(pdf, samplePages(), { formFields: [{ name: 'nume', kind: 'text', value: 'Ștefan' }] });
    const parsed = JSON.parse(json);
    expect(parsed.generator).toBe('Adika PDF Editor');
    expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
    expect(parsed.metadata.Title).toBe('Titlu șțăî');
    expect(parsed.metadata.Author).toBe('Adika');
    expect(parsed.outline).toEqual([
      { title: 'Intro', level: 0, page: 1 },
      { title: 'Detalii', level: 1, page: 2 },
    ]);
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.pages[0].number).toBe(1);
    expect(parsed.pages[0].text).toContain('Raport anual ăîșț');
    expect(parsed.pages[0].lines[4].cells.map((c: { col: number }) => c.col)).toEqual([0, 1, 2]);
    expect(parsed.formFields).toEqual([{ name: 'nume', kind: 'text', value: 'Ștefan' }]);
    expect(json).toContain('\n  "pages": [');
  });
});

describe('Word round-trip (COM)', () => {
  const pages = samplePages();
  const check = (text: string) => {
    expect(text).toContain('Raport anual ăîșț');
    expect(text).toContain('Țară și oraș: București <&> "citat"');
    expect(text).toContain('mâine, până, înțelegere');
    expect(text).toContain('Mere; roșii');
    expect(text).toContain('Pere "Williams"');
    expect(text).toContain('Preț');
    expect(text).toContain('😀');
  };

  it('Word opens the ODT with the Romanian and table text', async (ctx) => {
    const path = scratchPath('export-test.odt');
    writeFileSync(path, new Uint8Array(await (await exportToOdt(pages, 'Raport')).arrayBuffer()));
    const r = wordReadText(path);
    if (!r.ok && r.skip) ctx.skip(`Word COM unavailable: ${r.reason}`);
    if (!r.ok) throw new Error(r.reason);
    check(r.text);
    expect(r.tables).toBe(1);
    expect(r.pages).toBe(2);
  });

  it('Word opens the RTF with the Romanian and table text', async (ctx) => {
    const path = scratchPath('export-test.rtf');
    writeFileSync(path, exportToRtf(pages, 'Raport'), 'latin1');
    const r = wordReadText(path);
    if (!r.ok && r.skip) ctx.skip(`Word COM unavailable: ${r.reason}`);
    if (!r.ok) throw new Error(r.reason);
    check(r.text);
    expect(r.tables).toBe(1);
    expect(r.pages).toBe(2);
  });
});
