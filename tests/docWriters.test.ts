import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { groupTextItems, type PageText, type RawTextItem } from '../src/lib/pdf/convert';
import type { DocxPageGraphics } from '../src/lib/pdf/docx';
import { buildOdtParts, exportToCsv, exportToMarkdown, exportToRtf, layoutRows } from '../src/lib/pdf/exportFormats';
import { pdfToEpub } from '../src/lib/pdf/epub';

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

const hRule = (x0: number, x1: number, y: number) => ({ x0, y0: y - 0.25, x1, y1: y + 0.25 });
const vRule = (x: number, y0: number, y1: number) => ({ x0: x - 0.25, y0, x1: x + 0.25, y1 });

/** Three A4 pages: a title, a ruled table with a wrapped cell, a bullet list, two columns, a picture and a page-number footer. */
function sample(): { pages: PageText[]; graphics: DocxPageGraphics[] } {
  const col = 'Lorem ipsum dolor sit amet consectetur';
  const pages: PageText[] = [1, 2, 3].map((n) => {
    const items: RawTextItem[] = [...words(`Page ${n} of 3`, 270, 810, 9)];
    if (n === 1) {
      items.push(
        ...words('Annual Report', 234, 80, 20, { bold: true, family: 'Arial' }),
        ...words('Area', 76, 132),
        ...words('What you can do', 176, 132),
        ...words('Read', 76, 152),
        ...words('Tabs for several documents, continuous and single', 176, 152, 11, { italic: true }),
        ...words('two-page layouts, night mode.', 176, 166, 11, { italic: true }),
        { str: '•', x: 72, y: 220, width: 4, fontSize: 11 },
        ...words('First point of the list.', 90, 220),
        { str: '•', x: 72, y: 236, width: 4, fontSize: 11 },
        ...words('Second point.', 90, 236),
      );
      for (let k = 0; k < 12; k++) items.push(...words(col, 50, 300 + k * 14), ...words(col, 320, 300 + k * 14));
    } else {
      for (let k = 0; k < 40; k++) items.push(...words(`Body line ${k} on page ${n} with enough words to be a line.`, 72, 90 + k * 17));
    }
    return { pageNumber: n, width: 595, height: 842, lines: groupTextItems(items) };
  });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const graphics: DocxPageGraphics[] = [
    {
      images: [{ box: { x0: 72, y0: 520, x1: 272, y1: 620 }, data: png, type: 'png' }],
      rules: [hRule(70, 470, 120), hRule(70, 470, 138), hRule(70, 470, 172), vRule(70, 120, 172), vRule(170, 120, 172), vRule(470, 120, 172)],
    },
    { images: [], rules: [] },
    { images: [], rules: [] },
  ];
  return { pages, graphics };
}

describe('RTF from the page layout', () => {
  it('writes styled runs, a ruled table, two columns, a picture and a footer with PAGE/NUMPAGES', () => {
    const { pages, graphics } = sample();
    const rtf = exportToRtf(pages, 'Report', graphics);
    expect(/[^\x00-\x7f]/.test(rtf)).toBe(false);
    expect(rtf).toMatch(/\\s1\\outlinelevel0\\qc/); // centred heading
    expect(rtf).toContain('\\i Tabs for several documents, continuous and single two-page layouts, night mode.}');
    expect(rtf.match(/\\row\b/g)?.length).toBe(2);
    expect(rtf).toContain('\\cols2');
    expect(rtf).toContain('\\column');
    expect(rtf).toContain('\\pngblip');
    expect(rtf).toMatch(/\{\\footer [^]*PAGE[^]*NUMPAGES/);
    expect(rtf).not.toContain('Page 2 of 3'); // running footer moved out of the body
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
});

describe('ODT from the page layout', () => {
  it('embeds pictures, uses a two-column section and page-number fields', () => {
    const { pages, graphics } = sample();
    const parts = buildOdtParts(pages, 'Report', graphics);
    const content = parts.get('content.xml') as string;
    const styles = parts.get('styles.xml') as string;
    const manifest = parts.get('META-INF/manifest.xml') as string;
    expect([...parts.keys()].some((k) => k.startsWith('Pictures/'))).toBe(true);
    expect(manifest).toContain('Pictures/image1.png');
    expect(content).toContain('<draw:frame');
    expect(content).toContain('<text:section');
    expect(content).toContain('fo:column-count="2"');
    expect(content).toContain('fo:break-before="column"');
    expect(content).toContain('fo:text-align="center"');
    expect(styles).toContain('<text:page-number');
    expect(styles).toContain('<text:page-count');
    expect(content).not.toContain('Page 2 of 3');
  });
});

describe('Markdown, rows and EPUB from the page layout', () => {
  it('Markdown has joined paragraphs, a list and the ruled table', () => {
    const { pages, graphics } = sample();
    const md = exportToMarkdown(pages, graphics);
    expect(md).toContain('# Annual Report');
    expect(md).toContain('- First point of the list.\n- Second point.');
    expect(md).toContain('| Read | *Tabs for several documents, continuous and single two-page layouts, night mode.* |');
    expect(md).not.toContain('Page 1 of 3');
  });

  it('keeps a wrapped table cell in one row (Excel / CSV)', () => {
    const { pages, graphics } = sample();
    const rows = layoutRows(pages, graphics).filter((r) => r.table);
    expect(rows.map((r) => r.cells)).toEqual([
      ['Area', 'What you can do'],
      ['Read', 'Tabs for several documents, continuous and single two-page layouts, night mode.'],
    ]);
    const list = layoutRows(pages, graphics).find((r) => r.cells[0].startsWith('•'));
    expect(list?.cells).toEqual(['• First point of the list.']);
    const csv = exportToCsv(pages, {}, graphics);
    expect(csv).toContain('Read,"Tabs for several documents, continuous and single two-page layouts, night mode."');
  });

  it('EPUB uses the layout: joined table cells, bullets, no running footer', async () => {
    const { pages, graphics } = sample();
    const zip = await JSZip.loadAsync(await (await pdfToEpub(pages, { title: 'Report', author: '' }, graphics)).arrayBuffer());
    const xhtml = (await Promise.all(Object.keys(zip.files).filter((n) => n.endsWith('.xhtml')).map((n) => zip.file(n)!.async('string')))).join('');
    expect(xhtml).toContain('<td>Tabs for several documents, continuous and single two-page layouts, night mode.</td>');
    expect(xhtml).toContain('• First point of the list.');
    expect(xhtml).not.toContain('Page 2 of 3');
  });
});
