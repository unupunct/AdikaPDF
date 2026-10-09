import { beforeAll, describe, expect, it, vi } from 'vitest';

// The store reads window/localStorage when it is created; pdf.js runs as the Node (legacy) build.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
});
vi.mock('@/lib/pdf/pdfService', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    openPdf: (bytes: Uint8Array) => pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, disableFontFace: true }).promise,
    registerSource: () => undefined,
    releaseSource: async () => undefined,
  };
});

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { usePDFStore, sameDoc } from '@/store/usePDFStore';
import {
  anchoredScrollTop,
  containsToken,
  firstPagesToRead,
  FIRST_PAGES,
  LAZY_MIN_PAGES,
  loadPageSizes,
  readingOrder,
  rowAt,
  visibleRows,
  type Band,
  type PageSize,
} from '@/lib/pdf/pageSizes';
import { beginEstimated, correctPage, correctPages, forgetSource, hasEstimated, isEstimated, onSizesCorrected, pageCorrector, pageSizesReady, reportSizes } from '@/lib/pdf/pageSizeRegistry';
import type { EditorObject, PageRef } from '@/types';
import { setPageOrder } from '@/lib/pdf/exportPdf';

const S = () => usePDFStore.getState();
const enc = (s: string) => new TextEncoder().encode(s);
const page = (i: number, sourceId = 'src1', w = 595, h = 842): PageRef => ({ id: `p${i}`, kind: 'source', sourceId, sourceIndex: i, baseRotation: 0, userRotation: 0, width: w, height: h });
const bands = (heights: number[], gap = 20, top = 24): Band[] => {
  let y = top;
  return heights.map((h) => {
    const b = { top: y, height: h };
    y += h + gap;
    return b;
  });
};

/** 5,000 pages: every 50th landscape, every 7th /Rotate 90 (as the benchmark). */
async function bigPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage(i % 50 === 0 ? [842, 595] : [595, 842]);
    if (i % 7 === 0) p.setRotation({ type: 'degrees', angle: 90 } as never);
    p.drawText(`Page ${i}`, { x: 60, y: 500, size: 18, font });
  }
  return doc.save({ objectsPerTick: 5000 });
}

describe('page size helpers', () => {
  it('reads all pages of a small document first, a few of a large one', () => {
    expect(firstPagesToRead(LAZY_MIN_PAGES)).toHaveLength(LAZY_MIN_PAGES);
    expect(firstPagesToRead(5000)).toEqual(Array.from({ length: FIRST_PAGES }, (_, i) => i));
    expect(firstPagesToRead(0)).toEqual([]);
  });

  it('loads sizes in batches, with /Rotate and the view box', async () => {
    const doc = { numPages: 10, getPage: async (n: number) => ({ view: [0, 0, 100 + n, 200], rotate: n === 3 ? 450 : 0 }) };
    const batches: PageSize[][] = [];
    await loadPageSizes(doc, [0, 1, 2, 3, 4], (b) => batches.push(b), { batch: 2 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batches[1][0]).toEqual({ index: 2, width: 103, height: 200, rotation: 90 });
  });

  it('reads the rest from the current page outwards', () => {
    expect(readingOrder(8, (i) => i < 2, 5)).toEqual([5, 6, 4, 7, 3, 2]);
    expect(readingOrder(4, () => false, 0)).toEqual([0, 1, 2, 3]);
  });

  it('finds rows by position and the window to mount', () => {
    const rows = bands(Array(1000).fill(1000));
    expect(rowAt(rows, 0)).toBe(0);
    expect(rowAt(rows, 24 + 1020 * 500 + 10)).toBe(500);
    // Viewport of 800 px at row 500, one viewport above and below.
    const [first, last] = visibleRows(rows, 24 + 1020 * 500, 800, 1);
    expect(first).toBe(499);
    expect(last).toBe(501);
    expect(visibleRows([], 0, 800)).toEqual([0, -1]);
    const end = visibleRows(rows, 1e9, 800, 1);
    expect(end).toEqual([999, 999]);
  });

  it('keeps the view on the same page when heights above it change', () => {
    const before = bands([842, 842, 842, 842]);
    // Page 2 turns out landscape (shorter): the view on page 3 moves up with it.
    const after = bands([842, 595, 842, 842]);
    const onPage3 = before[2].top + 100;
    expect(anchoredScrollTop(before, after, onPage3)).toBe(after[2].top + 100);
    // Half way down a page whose own height changes: still half way.
    const grown = bands([842, 1684, 842, 842]);
    expect(anchoredScrollTop(before, grown, before[1].top + 421)).toBe(grown[1].top + 842);
    // In the gap below a page, and above the first one.
    expect(anchoredScrollTop(before, after, before[1].top + 842 + 10)).toBe(after[1].top + 595 + 10);
    expect(anchoredScrollTop(before, after, 0)).toBe(0);
    // Different rows: unchanged.
    expect(anchoredScrollTop(before, after.slice(1), 500)).toBe(500);
  });

  it('finds a token in the bytes', () => {
    expect(containsToken(enc('1 0 obj << /Type /Sig /ByteRange [0 1 2 3] >>'), '/ByteRange')).toBe(true);
    expect(containsToken(enc('/Byte /ByteRang'), '/ByteRange')).toBe(false);
    expect(containsToken(new Uint8Array(0), '/ByteRange')).toBe(false);
  });
});

describe('estimated page sizes', () => {
  it('records only sizes that differ from the estimate, and corrects pages keeping their identity', async () => {
    const estimate = { width: 595, height: 842, rotation: 0 as const };
    beginEstimated('srcA', [1, 2, 3], estimate);
    let calls = 0;
    const off = onSizesCorrected(() => calls++);
    expect(isEstimated('srcA', 2)).toBe(true);
    const ready = pageSizesReady(['srcA']);
    reportSizes('srcA', [{ index: 1, ...estimate }]);
    expect(calls).toBe(0);
    reportSizes('srcA', [{ index: 2, width: 842, height: 595, rotation: 90 }]);
    expect(calls).toBe(1);
    expect(hasEstimated('srcA')).toBe(true);
    reportSizes('srcA', [{ index: 3, ...estimate }]);
    await ready;
    expect(hasEstimated('srcA')).toBe(false);
    off();

    const pages = [0, 1, 2, 3].map((i) => page(i, 'srcA'));
    pages[2] = { ...pages[2], userRotation: 180 };
    const fixed = correctPages(pages);
    expect(fixed).not.toBe(pages);
    expect(fixed[1]).toBe(pages[1]);
    expect(fixed[2]).toMatchObject({ width: 842, height: 595, baseRotation: 90, userRotation: 180 });
    expect(correctPage(fixed[2])).toBe(fixed[2]);
    expect(correctPages(fixed)).toBe(fixed);
    // Shared arrays stay shared.
    const fix = pageCorrector();
    expect(fix(pages)).toBe(fix(pages));
    forgetSource('srcA');
    expect(correctPages(pages)).toBe(pages);
  });
});

describe('saving', () => {
  it('sets the page order in one pass (pages, cache and count stay consistent)', async () => {
    const doc = await PDFDocument.create();
    const sizes: Array<[number, number]> = [[100, 200], [300, 400], [500, 600]];
    for (const s of sizes) doc.addPage(s);
    const [a, b, c] = doc.getPages();
    const blank = doc.addPage([10, 20]);
    setPageOrder(doc, [c, a, blank]);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPages()).toEqual([c, a, blank]);
    const again = await PDFDocument.load(await doc.save());
    expect(again.getPages().map((p) => p.getSize().width)).toEqual([500, 100, 10]);
    void b;
  });
});

describe('a 5,000-page document', () => {
  let bytes: Uint8Array;
  beforeAll(async () => {
    bytes = await bigPdf(5000);
  }, 120_000);

  it('opens after its first pages, then gets the real sizes everywhere (history too)', async () => {
    const t0 = performance.now();
    await S().loadDocument(bytes, 'big.pdf', null);
    const opened = performance.now() - t0;
    // Generous: the first pages only (the old way read all 5,000 first).
    expect(opened).toBeLessThan(8000);
    console.log(`5,000 pages: shown after ${opened.toFixed(0)} ms`);
    expect(S().pages).toHaveLength(5000);
    const src = S().pages[0].sourceId!;
    expect(hasEstimated(src)).toBe(true);
    // Page 50 is landscape, page 7 turned: estimated as page 1 for now.
    expect(S().pages[49]).toMatchObject({ width: 595, height: 842 });

    // An edit while sizes are being read: undo history and the saved state share the page arrays.
    S().addObject({ id: 'n1', type: 'note', pageId: S().pages[0].id, x: 1, y: 1, rotation: 0, opacity: 1, text: '', color: '#ff0', author: '', createdAt: '' } as unknown as EditorObject);
    const t1 = performance.now();
    await pageSizesReady([src]);
    await new Promise((r) => setTimeout(r, 400));
    console.log(`5,000 pages: all sizes after ${(performance.now() - t0).toFixed(0)} ms (${(performance.now() - t1).toFixed(0)} ms in the background)`);
    const s = S();
    expect(s.pages[49]).toMatchObject({ width: 842, height: 595, baseRotation: 0 });
    expect(s.pages[6]).toMatchObject({ width: 595, height: 842, baseRotation: 90 });
    expect(s.pages[5]).toMatchObject({ baseRotation: 0 });
    expect(s.past[0].pages).toBe(s.pages);
    expect(s.savedDoc?.pages).toBe(s.pages);
    S().undo();
    expect(sameDoc(S(), S().savedDoc)).toBe(true);
    expect(S().dirty).toBe(false);
  }, 120_000);

  it('a small document is read completely before it shows', async () => {
    const small = await bigPdf(LAZY_MIN_PAGES);
    await S().loadDocument(small, 'small.pdf', null);
    const src = S().pages[0].sourceId!;
    expect(hasEstimated(src)).toBe(false);
    expect(S().pages[49]).toMatchObject({ width: 842, height: 595 });
  }, 60_000);
});
