import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';
import { extractStructuredText, fontFamilyFromName, groupTextItems, type PageText, type RawTextItem, type TextLine } from '../src/lib/pdf/convert';
import { collectDocxGraphics, exportToDocx, markUnderlines, sampleInkColor } from '../src/lib/pdf/docx';
import { detectColumnGutter, layoutPage, type ParaBlock } from '../src/lib/pdf/wordLayout';

// ---------------------------------------------------------------- helpers

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

// The exporter draws on OffscreenCanvas / ImageData (browser); give node the @napi-rs/canvas equivalents.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (!g.OffscreenCanvas) {
    g.OffscreenCanvas = function OffscreenCanvas(w: number, h: number) {
      const c = createCanvas(w, h) as unknown as Record<string, unknown>;
      c.convertToBlob = async ({ type }: { type?: string } = {}) => {
        const png = type !== 'image/jpeg';
        const buf = await (c as unknown as { encode(f: string, q?: number): Promise<Buffer> }).encode(png ? 'png' : 'jpeg', 90);
        return new Blob([new Uint8Array(buf)], { type: png ? 'image/png' : 'image/jpeg' });
      };
      return c;
    };
  }
  if (!g.ImageData) g.ImageData = NapiImageData;
});

async function documentXml(blob: Blob): Promise<{ xml: string; zip: JSZip }> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return { xml: await zip.file('word/document.xml')!.async('string'), zip };
}

/** One text item per word, laid out like a PDF line (5.5pt per char at 11pt). */
function words(text: string, x: number, y: number, fs = 11, extra: Partial<RawTextItem> = {}): RawTextItem[] {
  const out: RawTextItem[] = [];
  let cx = x;
  for (const w of text.split(' ')) {
    const width = w.length * fs * 0.5;
    out.push({ str: w, x: cx, y, width, fontSize: fs, ...extra });
    cx += width + fs * 0.3;
  }
  return out;
}

function page(lines: TextLine[], width = 595, height = 842): PageText {
  return { pageNumber: 1, width, height, lines };
}

const noGraphics = { images: [], rules: [] };

// ---------------------------------------------------------------- units

describe('fontFamilyFromName', () => {
  it('maps PDF font names to Word families', () => {
    expect(fontFamilyFromName('ABCDEF+TimesNewRomanPS-BoldMT')).toBe('Times New Roman');
    expect(fontFamilyFromName('Helvetica-Bold')).toBe('Arial');
    expect(fontFamilyFromName('ArialMT')).toBe('Arial');
    expect(fontFamilyFromName('Times-Italic')).toBe('Times New Roman');
    expect(fontFamilyFromName('BCDEEE+Calibri-Bold')).toBe('Calibri');
    expect(fontFamilyFromName('OpenSans-Regular')).toBe('Open Sans');
    expect(fontFamilyFromName('SegoeUI')).toBe('Segoe UI');
    expect(fontFamilyFromName('CourierNewPSMT')).toBe('Courier New');
    expect(fontFamilyFromName('RobotoLight')).toBe('Roboto');
    expect(fontFamilyFromName('F1')).toBeUndefined();
    expect(fontFamilyFromName('g_d0_f3')).toBeUndefined();
    expect(fontFamilyFromName(undefined)).toBeUndefined();
  });
});

describe('groupTextItems spans', () => {
  it('keeps per-item style in spans matching the cell text', () => {
    const lines = groupTextItems([
      { str: 'Plain', x: 10, y: 20, width: 25, fontSize: 10 },
      { str: 'bold', x: 38, y: 20, width: 20, fontSize: 10, bold: true, family: 'Arial' },
      { str: 'it', x: 61, y: 20, width: 8, fontSize: 10, italic: true },
    ]);
    const cell = lines[0].cells[0];
    expect(cell.text).toBe('Plain bold it');
    expect(cell.spans!.map((s) => s.text).join('')).toBe(cell.text);
    expect(cell.spans!.map((s) => [s.bold, s.italic])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(cell.spans![1].family).toBe('Arial');
  });
});

describe('sampleInkColor', () => {
  it('finds the text colour on a background and ignores black', () => {
    const w = 20;
    const h = 10;
    const make = (ink: [number, number, number]) => {
      const d = new Uint8ClampedArray(w * h * 4).fill(255);
      for (let y = 3; y < 7; y++) for (let x = 2; x < 18; x++) d.set([...ink, 255], (y * w + x) * 4);
      return d;
    };
    expect(sampleInkColor(make([200, 0, 0]), w, 0, 0, w, h)).toBe('C80000');
    expect(sampleInkColor(make([10, 10, 10]), w, 0, 0, w, h)).toBeUndefined();
    // Bold text can cover most of its box: with the measured background it is still black, not white.
    expect(sampleInkColor(make([10, 10, 10]), w, 2, 3, 18, 7, [255, 255, 255])).toBeUndefined();
    expect(sampleInkColor(make([0, 90, 200]), w, 2, 3, 18, 7, [255, 255, 255])).toBe('005AC8');
  });
});

describe('pdf.js operator codes', () => {
  it('match the local copy used by the exporter', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/lib/pdf/docx.ts', import.meta.url), 'utf8'));
    const block = /const OPS = \{([\s\S]*?)\} as const;/.exec(src)![1];
    const OPS = pdfjs.OPS as unknown as Record<string, number>;
    for (const [, name, code] of block.matchAll(/(\w+): (\d+),/g)) expect(OPS[name], name).toBe(Number(code));
  });
});

// ---------------------------------------------------------------- layout

describe('layoutPage', () => {
  const body = 11;
  const wrapped = [
    'The quarterly figures show a steady rise in sales across all the regions we',
    'serve, with the strongest growth in the north where two new stores opened',
    'in the spring and a third is planned before the end of the year.',
  ];

  it('joins wrapped lines into one paragraph and keeps a first-line indent', () => {
    const lines = groupTextItems([...words(wrapped[0], 90, 100), ...words(wrapped[1], 72, 114), ...words(wrapped[2], 72, 128)]);
    const layout = layoutPage(page(lines), noGraphics, body);
    const blocks = layout.segments[0].streams[0];
    expect(blocks).toHaveLength(1);
    const p = blocks[0] as ParaBlock;
    expect(p.lines).toHaveLength(3);
    expect(p.firstLine).toBeCloseTo(18, 0);
    expect(p.align).toBe('left');
  });

  it('splits paragraphs on short lines and big gaps, centres titles, keeps space before', () => {
    const lines = groupTextItems([
      ...words('Annual Report', 234, 80, 20, { bold: true }), // centred on the page (297)
      ...words(wrapped[0], 72, 130),
      ...words('Short last line.', 72, 144),
      ...words(wrapped[1], 72, 180),
    ]);
    const layout = layoutPage(page(lines), noGraphics, body);
    const blocks = layout.segments[0].streams[0] as ParaBlock[];
    expect(blocks.map((b) => b.lines.length)).toEqual([1, 2, 1]);
    expect(blocks[0].align).toBe('center');
    expect(blocks[0].heading).toBe(1);
    expect(blocks[2].spaceBefore).toBeGreaterThan(15);
  });

  it('detects bullets with a hanging indent', () => {
    const lines = groupTextItems([
      { str: '•', x: 72, y: 100, width: 4, fontSize: 11 },
      ...words(wrapped[0], 96, 100),
      ...words('continues here.', 96, 114),
      { str: '•', x: 72, y: 128, width: 4, fontSize: 11 },
      ...words('Second point.', 96, 128),
    ]);
    const layout = layoutPage(page(lines), noGraphics, body);
    const blocks = layout.segments[0].streams[0] as ParaBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].bullet).toBe(true);
    expect(blocks[0].lines).toHaveLength(2);
    expect(blocks[0].firstLine).toBeCloseTo(-24, 0);
  });

  it('finds two text columns', () => {
    const items: RawTextItem[] = [];
    const col = 'Lorem ipsum dolor sit amet consectetur';
    for (let k = 0; k < 12; k++) {
      items.push(...words(col, 50, 100 + k * 14));
      items.push(...words(col, 320, 100 + k * 14));
    }
    const lines = groupTextItems(items);
    expect(detectColumnGutter(lines, 50, 530)).not.toBeNull();
    const layout = layoutPage(page(lines), noGraphics, body);
    expect(layout.segments.map((s) => s.columns)).toEqual([2]);
    expect(layout.segments[0].streams[0].length).toBeGreaterThan(0);
    expect(layout.segments[0].streams[1].length).toBeGreaterThan(0);
  });

  it('places images inline, beside text (float) or under text (behind)', () => {
    const lines = groupTextItems([...words('Caption text next to the picture', 250, 110), ...words('Label', 90, 330)]);
    const images = [
      { x0: 72, y0: 90, x1: 200, y1: 180 }, // text beside it
      { x0: 72, y0: 200, x1: 300, y1: 300 }, // nothing beside it
      { x0: 72, y0: 310, x1: 300, y1: 360 }, // "Label" sits on it
    ];
    const layout = layoutPage(page(lines), { images, rules: [] }, body);
    expect(layout.floats.map((f) => [f.index, f.behind])).toEqual([
      [0, false],
      [2, true],
    ]);
    const inline = layout.segments.flatMap((s) => s.streams.flat()).filter((b) => b.kind === 'image');
    expect(inline.map((b) => (b.kind === 'image' ? b.index : -1))).toEqual([1]);
  });

  it('marks underlines from thin rules under a span', () => {
    const lines = groupTextItems([...words('see the link here', 72, 100)]);
    const p = page(lines);
    // Under "link": x from 72 + (3+3)*5.5 + 2*3.3
    const spans = lines[0].cells[0].spans!;
    const link = spans.find((s) => s.text.startsWith('link'))!;
    markUnderlines(p, [{ x0: link.x, y0: 101.5, x1: link.x + link.width, y1: 102.2 }]);
    expect(spans.filter((s) => s.underline).map((s) => s.text.trim())).toEqual(['link']);
  });
});

describe('layout: tables, gaps, running lines', () => {
  const hRule = (x0: number, x1: number, y: number) => ({ x0, y0: y - 0.25, x1, y1: y + 0.25 });
  const vRule = (x: number, y0: number, y1: number) => ({ x0: x - 0.25, y0, x1: x + 0.25, y1 });

  it('reads ruled tables from their borders, with wrapped cell text joined', () => {
    const lines = groupTextItems([
      ...words('Area', 76, 112),
      ...words('What you can do', 176, 112),
      ...words('Read', 76, 132),
      ...words('Tabs for several documents, continuous and single', 176, 132),
      ...words('two-page layouts, night mode.', 176, 146),
    ]);
    const rules = [hRule(70, 470, 100), hRule(70, 470, 118), hRule(70, 470, 152), vRule(70, 100, 152), vRule(170, 100, 152), vRule(470, 100, 152)];
    const layout = layoutPage(page(lines), { images: [], rules }, 11);
    const tables = layout.segments.flatMap((s) => s.streams.flat()).filter((b) => b.kind === 'table');
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.kind === 'table' && t.grid?.cells.length).toBe(2);
    const cell = t.kind === 'table' ? t.grid!.cells[1][1] : [];
    expect(cell).toHaveLength(1);
    expect(cell[0].lines).toHaveLength(2);
  });

  it('splits lines at a narrow gap shared by many lines (tight column gutter)', () => {
    const items: RawTextItem[] = [];
    for (let k = 0; k < 5; k++) {
      // One item per column line, padded with a trailing space like Word does; the gap is only ~1.5 em.
      items.push({ str: 'Left column text runs across here ', x: 60, y: 100 + k * 14, width: 204, fontSize: 11 });
      items.push({ str: 'Right column text runs along too', x: 280, y: 100 + k * 14, width: 190, fontSize: 11 });
    }
    const lines = groupTextItems(items);
    expect(lines[0].cells).toHaveLength(1);
    const layout = layoutPage(page(lines), noGraphics, 11);
    expect(layout.segments.map((s) => s.columns)).toEqual([2]);
  });

  it('keeps wide list items left-aligned (not mistaken for centred text)', () => {
    const lines = groupTextItems([
      { str: '•', x: 45, y: 100, width: 4, fontSize: 10.5 },
      ...words('Hardware-token signing is tested end to end against a SoftHSM2 token and verified', 58, 100, 10.5),
      ...words('independently with pyHanko and the token test script in the repository', 58, 115, 10.5),
    ]);
    const p = layoutPage(page(lines, 612, 792), noGraphics, 10.5).segments[0].streams[0][0] as ParaBlock;
    expect(p.align).not.toBe('center');
    expect(p.bullet).toBe(true);
  });

  it('marks shaded paragraphs and pins text-less scans to the page', () => {
    const lines = groupTextItems([...words('npm install', 60, 100)]);
    const shaded = layoutPage(page(lines), { images: [], rules: [], shades: [{ box: { x0: 50, y0: 85, x1: 540, y1: 106 }, color: 'F3F3F3' }] }, 11);
    expect((shaded.segments[0].streams[0][0] as ParaBlock).shading).toBe('F3F3F3');
    const scan = layoutPage(page([]), { images: [{ x0: 0, y0: 0, x1: 595, y1: 842 }], rules: [] }, 11);
    expect(scan.floats).toHaveLength(1);
  });

  it('splits a long span so only the underlined words are underlined', () => {
    const lines = groupTextItems([{ str: 'The board is asked to approve the budget presented here', x: 72, y: 100, width: 300, fontSize: 11 }]);
    const sp = lines[0].cells[0].spans![0];
    const at = (i: number) => sp.x + (sp.width * i) / sp.text.length;
    const a = sp.text.indexOf('approve');
    const b = sp.text.indexOf(' presented');
    markUnderlines(page(lines), [{ x0: at(a), y0: 101.5, x1: at(b), y1: 102 }]);
    const under = lines[0].cells[0].spans!.filter((s) => s.underline).map((s) => s.text);
    expect(under).toEqual(['approve the budget']);
  });
});

// ---------------------------------------------------------------- docx output

describe('exportToDocx', () => {
  it('writes joined, de-hyphenated paragraphs with styles, tables and headings', async () => {
    const lines = groupTextItems([
      ...words('Annual Report', 240, 80, 20, { bold: true, family: 'Times New Roman' }),
      ...words('The results were strong in every one of the regions we serve and extra-', 72, 130, 11, { family: 'Times New Roman' }),
      ...words('ordinary this year and every region did well above the average we have', 72, 144, 11, { family: 'Times New Roman' }),
      ...words('expected.', 72, 158, 11, { italic: true, family: 'Times New Roman' }),
      ...words('Item', 72, 200),
      ...words('Amount', 300, 200),
      ...words('Coffee', 72, 214),
      ...words('12.50', 300, 214),
    ]);
    const { assignTableColumns } = await import('../src/lib/pdf/convert');
    assignTableColumns(lines);
    const { xml } = await documentXml(await exportToDocx([page(lines)], 'T'));
    expect(xml).toContain('extraordinary');
    expect(xml).not.toContain('extra-');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('w:w="11900"');
    const styles = await (await JSZip.loadAsync(await (await exportToDocx([page(lines)], 'T')).arrayBuffer())).file('word/styles.xml')!.async('string');
    expect(styles).toContain('Times New Roman');
    expect(styles).not.toMatch(/Heading1[\s\S]{0,400}2E74B5/);
  });

  it('moves repeated page numbers and titles into a Word header/footer with a live page field', async () => {
    const pages = [1, 2, 3].map((n) =>
      page(
        groupTextItems([
          ...words('Quarterly report', 72, 40, 9),
          ...words(`Body text on page ${n} of the report.`, 72, 120),
          ...words('More body text near the bottom of the page.', 72, 700),
          ...words(`Page ${n} of 3`, 270, 810, 9),
        ]),
      ),
    );
    const blob = await exportToDocx(pages, 'T');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const names = Object.keys(zip.files);
    const footer = names.find((f) => /word\/footer\d*\.xml/.test(f));
    const header = names.find((f) => /word\/header\d*\.xml/.test(f));
    expect(footer && header).toBeTruthy();
    const fxml = await zip.file(footer!)!.async('string');
    expect(fxml).toMatch(/PAGE/);
    expect(fxml).toMatch(/NUMPAGES/);
    expect(await zip.file(header!)!.async('string')).toContain('Quarterly report');
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).not.toContain('Quarterly report');
    expect(doc).toContain('Body text on page 2');
    // Full pages that end low continue on the same Word page flow (continuous sections).
    expect(doc).toContain('w:val="continuous"');
  });

  it('writes two-column sections, floating images and exact-layout frames', async () => {
    const items: RawTextItem[] = [];
    const col = 'Lorem ipsum dolor sit amet consectetur';
    for (let k = 0; k < 12; k++) {
      items.push(...words(col, 50, 100 + k * 14));
      items.push(...words(col, 320, 100 + k * 14));
    }
    const lines = groupTextItems(items);
    const png = new Uint8Array(await createCanvas(4, 4).encode('png'));
    const graphics = [{ images: [{ box: { x0: 50, y0: 400, x1: 150, y1: 460 }, data: png, type: 'png' as const }], rules: [] }];

    const flow = await documentXml(await exportToDocx([page(lines)], 'T', { graphics }));
    expect(flow.xml).toContain('w:num="2"');
    expect(flow.xml).toContain('<w:br w:type="column"/>');
    expect(Object.keys(flow.zip.files).some((f) => f.startsWith('word/media/'))).toBe(true);

    const exact = await documentXml(await exportToDocx([page(lines)], 'T', { graphics, layout: 'exact' }));
    expect(exact.xml).toContain('<w:framePr');
    expect(exact.xml).toContain('<wp:anchor');
  });
});

// ---------------------------------------------------------------- real PDF, end to end

describe('PDF -> Word end to end (pdf.js + node canvas)', () => {
  it('keeps fonts, italics, colour, underline and the embedded picture', async () => {
    const doc = await PDFDocument.create();
    const times = await doc.embedFont(StandardFonts.TimesRoman);
    const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pic = createCanvas(40, 20);
    const pctx = pic.getContext('2d');
    pctx.fillStyle = '#1060d0';
    pctx.fillRect(0, 0, 40, 20);
    const png = await doc.embedPng(new Uint8Array(await pic.encode('png')));
    const p = doc.addPage([595, 842]);
    p.drawText('Report Title', { x: 230, y: 780, size: 22, font: bold });
    p.drawText('Plain body text in Times.', { x: 72, y: 740, size: 12, font: times });
    p.drawText('An italic sentence.', { x: 72, y: 722, size: 12, font: italic });
    p.drawText('Red warning', { x: 72, y: 704, size: 12, font: times, color: rgb(0.8, 0, 0) });
    const w = times.widthOfTextAtSize('underlined', 12);
    p.drawText('underlined', { x: 72, y: 686, size: 12, font: times });
    p.drawLine({ start: { x: 72, y: 684.5 }, end: { x: 72 + w, y: 684.5 }, thickness: 0.8 });
    p.drawImage(png, { x: 72, y: 520, width: 200, height: 100 });

    const pdf = await openPdf(await doc.save());
    const pages = await extractStructuredText(pdf);
    const graphics = await collectDocxGraphics(pdf, pages);
    expect(graphics[0].images).toHaveLength(1);
    const img = graphics[0].images[0];
    expect(img.box.x0).toBeCloseTo(72, 0);
    expect(img.box.y0).toBeCloseTo(842 - 620, 0);

    const spans = pages[0].lines.flatMap((l) => l.cells.flatMap((c) => c.spans ?? []));
    const red = spans.find((s) => s.text.includes('Red'))!;
    expect(red.color).toBeDefined();
    const [r, g] = [parseInt(red.color!.slice(0, 2), 16), parseInt(red.color!.slice(2, 4), 16)];
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(spans.find((s) => s.text.includes('Plain'))!.color).toBeUndefined();
    expect(spans.find((s) => s.text.includes('underlined'))!.underline).toBe(true);
    expect(spans.find((s) => s.text.includes('italic'))!.italic).toBe(true);
    expect(spans.find((s) => s.text.includes('Plain'))!.family).toBe('Times New Roman');

    const { xml, zip } = await documentXml(await exportToDocx(pages, 'Report', { graphics }));
    expect(xml).toContain('Red warning');
    expect(xml).toMatch(/<w:color w:val="[0-9A-F]{6}"\/>/);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('<w:drawing>');
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !zip.files[f].dir)).toHaveLength(1);
  });
});
