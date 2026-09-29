import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { findUrls, headingTree, type TextLine } from '@/lib/docStructure';
import { extractImages } from '@/lib/pdf/imageExport';
import { createCanvas } from '@napi-rs/canvas';

const L = (pageId: string, text: string, size: number, top: number, bold = false): TextLine => ({ pageId, text, size, bold, top, destTop: 800 - top });

describe('bookmarks from headings', () => {
  it('nests headings by size, skips page numbers and running headers, joins wrapped titles', () => {
    const lines: TextLine[] = [];
    for (const p of ['p1', 'p2', 'p3', 'p4']) {
      lines.push(L(p, 'Raport anual 2025 — confidențial', 9, 20)); // running header on every page
      lines.push(L(p, `${p.slice(1)}`, 9, 820)); // page number
    }
    lines.push(L('p1', 'Raport anual', 24, 80));
    lines.push(L('p1', '1. Introducere', 16, 140));
    for (let i = 0; i < 12; i++) lines.push(L('p1', 'Text obișnuit al documentului, destul de lung pentru a fi corp de text.', 11, 170 + i * 14));
    lines.push(L('p2', '1.1 Obiective', 13, 60));
    lines.push(L('p2', 'Text obișnuit al documentului, destul de lung pentru a fi corp de text.', 11, 90));
    lines.push(L('p3', '2. Rezultate financiare pe', 16, 60));
    lines.push(L('p3', 'regiuni și trimestre', 16, 80));
    lines.push(L('p3', 'Text obișnuit al documentului, destul de lung pentru a fi corp de text.', 11, 110));
    const tree = headingTree(lines);
    const flat = (items: typeof tree, depth = 0): string[] => items.flatMap((i) => [`${'-'.repeat(depth)}${i.title}`, ...flat(i.children, depth + 1)]);
    expect(flat(tree)).toEqual(['Raport anual', '-1. Introducere', '--1.1 Obiective', '-2. Rezultate financiare pe regiuni și trimestre']);
    expect(tree[0].pageId).toBe('p1');
    expect(tree[0].top).toBe(720);
  });

  it('a document with no larger text gives no bookmarks', () => {
    expect(headingTree([L('p1', 'Doar text simplu, fără titluri.', 11, 100), L('p1', 'Încă un rând obișnuit.', 11, 120)])).toEqual([]);
  });
});

describe('links from web addresses', () => {
  it('finds URLs, www addresses and e-mails, without trailing punctuation', () => {
    const t = 'Detalii pe https://example.com/raport?an=2025, la www.anaf.ro. sau scrieți la ana.pop@firma.ro; (vezi http://x.ro/a_b).';
    expect(findUrls(t).map((m) => [t.slice(m.start, m.end), m.url])).toEqual([
      ['https://example.com/raport?an=2025', 'https://example.com/raport?an=2025'],
      ['www.anaf.ro', 'https://www.anaf.ro'],
      ['ana.pop@firma.ro', 'mailto:ana.pop@firma.ro'],
      ['http://x.ro/a_b', 'http://x.ro/a_b'],
    ]);
  });
});

describe('export images', () => {
  it('JPEGs as stored, other images as RGBA with transparency, each image once', async () => {
    const d = await PDFDocument.create();
    const jpg = await d.embedJpg(new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64')));
    // 2x1 PNG: red opaque, blue half transparent.
    const cv = createCanvas(2, 1);
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(255,0,0,1)';
    g.fillRect(0, 0, 1, 1);
    g.fillStyle = 'rgba(0,0,255,0.5)';
    g.fillRect(1, 0, 1, 1);
    const png = await d.embedPng(new Uint8Array(cv.toBuffer('image/png')));
    const font = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const p = d.addPage([300, 300]);
      p.drawImage(jpg, { x: 10, y: 10, width: 50, height: 50 });
      p.drawText('x', { x: 100, y: 100, size: 10, font });
    }
    d.getPage(1).drawImage(png, { x: 100, y: 10, width: 40, height: 20 });
    const src = await d.save();
    const { images, skipped } = await extractImages(src);
    expect(skipped).toBe(0);
    expect(images.map((i) => `${i.name} ${i.width}x${i.height}`)).toEqual(['page1-image1.jpg 1x1', 'page2-image2.png 2x1']);
    expect(Buffer.from(images[0].bytes!).subarray(0, 2).toString('hex')).toBe('ffd8');
    const px = Array.from(images[1].rgba!);
    expect(px.slice(0, 4)).toEqual([255, 0, 0, 255]);
    expect(px.slice(4, 7)).toEqual([0, 0, 255]);
    expect(px[7]).toBeLessThan(255);
  });
});
