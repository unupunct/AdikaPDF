import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  assignTableColumns,
  buildHtmlDocument,
  buildPptxParts,
  buildSheetXml,
  columnLetter,
  detectTableColumns,
  encodeTiff,
  exportPlainText,
  exportToXlsx,
  extractStructuredText,
  groupTextItems,
  pageToRows,
  pptxSlideSize,
  type PageText,
  type RawTextItem,
  type TextLine,
} from '../src/lib/pdf/convert';
import { exportToDocx } from '../src/lib/pdf/docx';
import { exportToMarkdown } from '../src/lib/pdf/exportFormats';
import { buildSrgbIccProfile, convertToPdfA, pdfaWarnings } from '../src/lib/pdf/pdfa';
import { compressPdf, scanContentOps, targetImageSize } from '../src/lib/pdf/compress';
import { blocksToWords, makeSearchable, sanitizeForFont, type OcrPageResult } from '../src/lib/pdf/ocr';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function pageText(bytes: Uint8Array, n = 1): Promise<string> {
  const pdf = await openPdf(bytes);
  const page = await pdf.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

const item = (str: string, x: number, y: number, width: number, fontSize = 10, bold = false): RawTextItem => ({
  str,
  x,
  y,
  width,
  fontSize,
  bold,
});

function xmlWellFormedish(xml: string): void {
  // Tag balance check (no DOMParser in node).
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;
  const body = xml.replace(/<\?[^?]*\?>/g, '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[3] === '/') continue;
    if (m[1] === '/') expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2]);
  }
  expect(stack).toEqual([]);
}

describe('groupTextItems', () => {
  it('groups by baseline, inserts spaces and splits cells', () => {
    const lines = groupTextItems([
      item('World', 60, 100.5, 25),
      item('Hello', 30, 100, 25),
      item('Price', 200, 100.2, 25),
      item('Second', 30, 120, 30, 10, true),
      item('line', 63, 120, 18, 10, true),
      item('Big', 30, 60, 40, 24),
    ]);
    expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual([['Big'], ['Hello World', 'Price'], ['Second line']]);
    expect(lines[0].fontSize).toBe(24);
    expect(lines[1].text).toBe('Hello World\tPrice');
    expect(lines[1].x).toBe(30);
    expect(lines[2].bold).toBe(true);
    expect(lines[1].bold).toBe(false);
  });

  it('does not insert spaces between touching glyph runs', () => {
    const [l] = groupTextItems([item('Hel', 10, 50, 15), item('lo', 25.5, 50, 10)]);
    expect(l.text).toBe('Hello');
  });
});

describe('table columns', () => {
  const line = (y: number, cells: [number, string][]): TextLine => ({
    y,
    x: cells[0][0],
    text: cells.map((c) => c[1]).join('\t'),
    fontSize: 10,
    bold: false,
    cells: cells.map(([x, text]) => ({ x, text })),
  });

  it('clusters x-starts across lines', () => {
    const lines = [
      line(10, [[50, 'Name'], [200, 'Qty'], [300, 'Price']]),
      line(22, [[51, 'Apple'], [202, '3'], [301, '1.50']]),
      line(34, [[50, 'Pear'], [299, '2.00']]),
    ];
    expect(detectTableColumns(lines)).toEqual([50, 200, 299]);
    assignTableColumns(lines);
    expect(lines[2].cells.map((c) => c.col)).toEqual([0, 2]);
    const rows = pageToRows({ pageNumber: 1, width: 600, height: 800, lines });
    expect(rows[2]).toEqual(['Pear', '', '2.00']);
  });

  it('returns [] for non-tabular text', () => {
    expect(detectTableColumns([line(10, [[50, 'just text']]), line(22, [[50, 'more']])])).toEqual([]);
  });
});

describe('buildSheetXml', () => {
  it('escapes, strips invalid chars and detects numbers', () => {
    const xml = buildSheetXml([
      ['A & B <c>', '42', '007'],
      ['', '-3.5e2', 'bad\u0001char "q"'],
    ]);
    expect(xml).toContain('<sheetData>');
    expect(xml).toContain('<row r="1">');
    expect(xml).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">A &amp; B &lt;c&gt;</t></is></c>');
    expect(xml).toContain('<c r="B1"><v>42</v></c>');
    expect(xml).toContain('<c r="C1" t="inlineStr"><is><t xml:space="preserve">007</t></is></c>');
    expect(xml).toContain('<c r="B2"><v>-350</v></c>');
    expect(xml).toContain('badchar &quot;q&quot;');
    expect(xml).not.toContain('\u0001');
    expect(xml).not.toContain('r="A2"');
    xmlWellFormedish(xml);
  });

  it('column letters', () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
  });
});

const samplePages: PageText[] = [
  {
    pageNumber: 1,
    width: 595,
    height: 842,
    lines: groupTextItems([
      item('Report Title', 50, 60, 150, 24, true),
      item('Body text here', 50, 100, 80, 11),
      item('Name', 50, 130, 30, 11),
      item('Value', 250, 130, 30, 11),
      item('Alpha', 50, 145, 30, 11),
      item('1.5', 250, 145, 15, 11),
      item('Important', 50, 170, 50, 11, true),
    ]),
  },
];

describe('text exports', () => {
  it('plain text and markdown', () => {
    expect(exportPlainText(samplePages)).toContain('Name\tValue');
    const md = exportToMarkdown(samplePages);
    expect(md).toContain('# Report Title');
    expect(md).toContain('| Name | Value |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Alpha | 1.5 |');
    expect(md).toContain('**Important**');
  });

  it('docx and xlsx packages', async () => {
    const docx = await exportToDocx(samplePages, 'T');
    const dz = await JSZip.loadAsync(await docx.arrayBuffer());
    const docXml = await dz.file('word/document.xml')!.async('string');
    expect(docXml).toContain('Report Title');
    expect(docXml).toContain('w:w="11900"');

    const xlsx = await exportToXlsx(samplePages);
    const xz = await JSZip.loadAsync(await xlsx.arrayBuffer());
    for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      expect(xz.file(f), f).not.toBeNull();
      xmlWellFormedish(await xz.file(f)!.async('string'));
    }
    expect(await xz.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<v>1.5</v>');
  });

  it('pptx parts are balanced and reference each other', () => {
    const parts = buildPptxParts(
      [
        { image: 'image1.jpg', imageBytes: new Uint8Array([1]), widthPt: 595, heightPt: 842, notes: 'Hello & <notes>' },
        { image: 'image2.jpg', imageBytes: new Uint8Array([1]), widthPt: 842, heightPt: 595, notes: '' },
      ],
      'Deck',
    );
    for (const [name, data] of parts) if (typeof data === 'string' && (name.endsWith('.xml') || name.endsWith('.rels'))) xmlWellFormedish(data);
    expect(parts.get('ppt/notesSlides/notesSlide1.xml')).toContain('Hello &amp; &lt;notes&gt;');
    expect(parts.get('[Content_Types].xml')).toContain('/ppt/slides/slide2.xml');
    const s = pptxSlideSize(595, 842);
    expect(s.cx / s.cy).toBeCloseTo(595 / 842, 3);
    expect(pptxSlideSize(5000, 5000).cx).toBeLessThanOrEqual(51206400);
  });

  it('html document', () => {
    const html = buildHtmlDocument('Doc <x>', [{ page: samplePages[0], imageUri: 'data:image/png;base64,AA==' }]);
    expect(html).toContain('<title>Doc &lt;x&gt;</title>');
    expect(html).toContain('aspect-ratio:595.00 / 842.00');
    expect(html).toContain('>Report Title</span>');
    expect(html).toMatch(/font-size:[\d.]+cqw/);
  });
});

describe('encodeTiff', () => {
  it('writes a two-page baseline RGB TIFF', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const t = encodeTiff([
      { width: 2, height: 1, data: rgba, channels: 4, dpi: 150 },
      { width: 1, height: 1, data: new Uint8Array([1, 2, 3]), channels: 3 },
    ]);
    const dv = new DataView(t.buffer);
    expect(String.fromCharCode(t[0], t[1])).toBe('II');
    expect(dv.getUint16(2, true)).toBe(42);
    const ifd1 = dv.getUint32(4, true);
    const n = dv.getUint16(ifd1, true);
    const tags: Record<number, number> = {};
    for (let i = 0; i < n; i++) tags[dv.getUint16(ifd1 + 2 + i * 12, true)] = dv.getUint32(ifd1 + 2 + i * 12 + 8, true);
    expect(tags[256]).toBe(2);
    expect(tags[279]).toBe(6);
    expect(Array.from(t.subarray(tags[273], tags[273] + 6))).toEqual([255, 0, 0, 0, 255, 0]);
    const ifd2 = dv.getUint32(ifd1 + 2 + n * 12, true);
    expect(ifd2).toBeGreaterThan(0);
    expect(dv.getUint32(ifd2 + 2 + n * 12, true)).toBe(0);
  });
});

describe('buildSrgbIccProfile', () => {
  it('has a consistent header and tag table', () => {
    const p = buildSrgbIccProfile();
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint32(0)).toBe(p.length);
    expect(p.length % 4).toBe(0);
    expect(String.fromCharCode(...p.subarray(36, 40))).toBe('acsp');
    expect(String.fromCharCode(...p.subarray(12, 16))).toBe('mntr');
    expect(String.fromCharCode(...p.subarray(16, 20))).toBe('RGB ');
    expect(dv.getUint32(8)).toBe(0x02100000);
    const count = dv.getUint32(128);
    const sigs: string[] = [];
    for (let i = 0; i < count; i++) {
      const base = 132 + i * 12;
      const sig = String.fromCharCode(...p.subarray(base, base + 4));
      const off = dv.getUint32(base + 4);
      const size = dv.getUint32(base + 8);
      sigs.push(sig);
      expect(off % 4, sig).toBe(0);
      expect(off).toBeGreaterThanOrEqual(132 + count * 12);
      expect(off + size).toBeLessThanOrEqual(p.length);
    }
    expect(sigs.sort()).toEqual(['bTRC', 'bXYZ', 'cprt', 'desc', 'gTRC', 'gXYZ', 'rTRC', 'rXYZ', 'wtpt'].sort());
    // rXYZ X value ~ 0.4361
    const rIdx = [...Array(count).keys()].find((i) => String.fromCharCode(...p.subarray(132 + i * 12, 136 + i * 12)) === 'rXYZ')!;
    const rOff = dv.getUint32(132 + rIdx * 12 + 4);
    expect(String.fromCharCode(...p.subarray(rOff, rOff + 4))).toBe('XYZ ');
    expect(dv.getInt32(rOff + 8) / 65536).toBeCloseTo(0.4361, 3);
  });
});

async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText('PDF/A sample text', { x: 40, y: 200, size: 18, font });
  doc.setTitle('Old title');
  doc.setKeywords(['alpha', 'beta']);
  // JavaScript open action + names tree
  const js = doc.context.obj({ S: 'JavaScript', JS: doc.context.obj('app.alert(1)') });
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(js));
  const names = doc.context.obj({ JavaScript: doc.context.obj({ Names: [] }) });
  doc.catalog.set(PDFName.of('Names'), names);
  return doc.save({ useObjectStreams: false });
}

describe('convertToPdfA', () => {
  it('adds OutputIntents, XMP, ID and strips JavaScript', async () => {
    const src = await makeSamplePdf();
    const out = await convertToPdfA(src, { title: 'Archive Title', author: 'Ana Pop' });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const cat = doc.catalog;
    const intents = cat.lookup(PDFName.of('OutputIntents'), PDFArray);
    const intent = intents.lookup(0, PDFDict);
    expect(intent.get(PDFName.of('S'))).toBe(PDFName.of('GTS_PDFA1'));
    const icc = doc.context.lookup(intent.get(PDFName.of('DestOutputProfile')));
    expect(icc).toBeInstanceOf(PDFRawStream);
    const meta = doc.context.lookup(cat.get(PDFName.of('Metadata'))) as PDFRawStream;
    expect(meta.dict.has(PDFName.of('Filter'))).toBe(false);
    const xmp = new TextDecoder().decode(meta.contents);
    expect(xmp).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(xmp).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(xmp).toContain('Archive Title');
    expect(xmp).toContain('<pdf:Keywords>alpha beta</pdf:Keywords>');
    expect(cat.has(PDFName.of('OpenAction'))).toBe(false);
    expect(cat.lookup(PDFName.of('Names'), PDFDict).has(PDFName.of('JavaScript'))).toBe(false);
    const tail = new TextDecoder('latin1').decode(out.subarray(out.length - 400));
    expect(tail).toMatch(/\/ID \[ <[0-9A-F]{32}> <[0-9A-F]{32}> \]/);

    const pdf = await openPdf(out);
    const md = await pdf.getMetadata();
    expect((md.info as Record<string, unknown>).Title).toBe('Archive Title');
    expect((md.info as Record<string, unknown>).Author).toBe('Ana Pop');
    expect(md.metadata?.get('dc:title')).toBe('Archive Title');

    const warnings = await pdfaWarnings(out);
    expect(warnings.join('\n')).toMatch(/Helvetica/);
    expect(warnings.join('\n')).toMatch(/veraPDF/);
  });

  it('rejects encrypted input', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard' });
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(convertToPdfA(bytes, { title: 't', author: 'a' })).rejects.toThrow(/encrypted/i);
  });
});

describe('compress (node: structural only)', () => {
  it('never grows the file and strips metadata', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Secret title');
    doc.setAuthor('Someone');
    const page = doc.addPage([300, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 40; i++) page.drawText('Line of repeated text ' + i, { x: 10, y: 280 - i * 7, size: 6, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const res = await compressPdf(bytes, { imageQuality: 0.7, maxImageDpi: 150, stripMetadata: true });
    expect(res.before).toBe(bytes.length);
    expect(res.after).toBeLessThanOrEqual(res.before);
    const pdf = await openPdf(res.bytes);
    const md = await pdf.getMetadata();
    if (res.bytes !== bytes) expect((md.info as Record<string, unknown>).Title).toBeUndefined();
    expect(await pageText(res.bytes)).toContain('Line of repeated text 39');
  });

  it('content scanner tracks cm/Do and skips strings/inline images', () => {
    const src = new TextEncoder().encode('q 200 0 0 100 10 10 cm /Im1 Do Q (a) Tj [(x) 3 (y)] TJ BI /W 1 ID xx EI 1 0 0 1 0 0 cm');
    const ops = [...scanContentOps(src)];
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Do', 'Q', 'Tj', 'TJ', 'cm']);
    expect(ops[1].nums).toEqual([200, 0, 0, 100, 10, 10]);
    expect(ops[2].name).toBe('Im1');
    expect(targetImageSize(4000, 2000, { w: 200, h: 100 }, 150)).toEqual({ w: 417, h: 208 });
    expect(targetImageSize(400, 200, { w: 200, h: 100 }, 150)).toEqual({ w: 400, h: 200 });
  });
});

describe('OCR text layer', () => {
  it('blocksToWords converts pixels to points', () => {
    const words = blocksToWords(
      [{ paragraphs: [{ lines: [{ words: [{ text: 'Hi', confidence: 90, bbox: { x0: 100, y0: 50, x1: 200, y1: 90 } }] }] }] }],
      2,
    );
    expect(words).toEqual([{ text: 'Hi', x: 50, y: 25, width: 50, height: 20, confidence: 90 }]);
    expect(sanitizeForFont('a中bé', new Set([97, 98, 0xe9]))).toBe('a?bé');
  });

  it('makeSearchable adds invisible, extractable words', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    const p2 = doc.addPage([400, 300]);
    p2.setCropBox(50, 50, 300, 200);
    const bytes = await doc.save();
    const results: OcrPageResult[] = [
      {
        pageNumber: 1,
        widthPt: 400,
        heightPt: 300,
        words: [
          { text: 'Scanned', x: 40, y: 40, width: 80, height: 14, confidence: 95 },
          { text: 'invoice', x: 130, y: 40, width: 60, height: 14, confidence: 93 },
          { text: 'Ţară', x: 40, y: 80, width: 40, height: 14, confidence: 80 },
        ],
      },
      { pageNumber: 2, widthPt: 300, heightPt: 200, words: [{ text: 'Cropped', x: 10, y: 10, width: 60, height: 12, confidence: 90 }] },
    ];
    // Node has no fetch for Vite asset URLs: hand the bundled TTF over directly.
    const notoSans = new URL('../node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', import.meta.url);
    const out = await makeSearchable(bytes, results, { loadFont: async () => new Uint8Array(readFileSync(notoSans)) });
    const pdf = await openPdf(out);
    const page = await pdf.getPage(1);
    const tc = await page.getTextContent();
    const text = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(text).toContain('Scanned');
    expect(text).toContain('invoice');
    expect(text).toContain('Ţară');
    // Position: first word's left edge ~ x=40, baseline ~ 300-40-14*0.8.
    const first = tc.items.find((i) => 'str' in i && i.str.startsWith('Scanned')) as { transform: number[]; width: number };
    expect(first.transform[4]).toBeCloseTo(40, 0);
    expect(first.transform[5]).toBeCloseTo(300 - 40 - 14 * 0.8, 0);

    const p2t = await (await pdf.getPage(2)).getTextContent();
    const cropped = p2t.items.find((i) => 'str' in i && i.str.startsWith('Cropped')) as { transform: number[] };
    expect(cropped.transform[4]).toBeCloseTo(60, 0);
    expect(cropped.transform[5]).toBeCloseTo(50 + 200 - 10 - 12 * 0.8, 0);
  });
});

describe('extractStructuredText (pdfjs in node)', () => {
  it('extracts lines and table cells from a real PDF', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([400, 300]);
    page.drawText('Quarterly Report', { x: 40, y: 260, size: 20, font: bold });
    page.drawText('Item', { x: 40, y: 220, size: 10, font });
    page.drawText('Amount', { x: 200, y: 220, size: 10, font });
    page.drawText('Coffee', { x: 40, y: 205, size: 10, font });
    page.drawText('12.50', { x: 200, y: 205, size: 10, font });
    const pdf = await openPdf(await doc.save());
    const pages = await extractStructuredText(pdf);
    expect(pages).toHaveLength(1);
    const lines = pages[0].lines;
    expect(lines[0].text).toBe('Quarterly Report');
    expect(lines[0].bold).toBe(true);
    expect(lines[1].cells.map((c) => c.text)).toEqual(['Item', 'Amount']);
    expect(lines[2].cells.map((c) => c.col)).toEqual([0, 1]);
    expect(pages[0].width).toBe(400);
  });
});
