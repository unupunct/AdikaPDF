import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { looksLikePdf, repairPdf } from '../src/lib/pdf/repair';
import { encryptPdf } from '../src/lib/crypto/encrypt';

const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/';
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const PAGES = 20;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 65536) s += String.fromCharCode(...b.subarray(i, i + 65536));
  return s;
}
function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** Deterministic pseudo-random bytes (xorshift32). */
function noise(n: number, seed = 0x2545f491): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function makePdf(useObjectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= PAGES; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Page ${i}`, { x: 40, y: 200, size: 24, font });
  }
  doc.setTitle('Repair sample');
  return doc.save({ useObjectStreams });
}

interface PdfjsOutcome {
  error?: string;
  pages: number;
  texts: string[];
}

/** Opens with pdf.js and counts the pages it can actually fetch. */
async function probe(bytes: Uint8Array): Promise<PdfjsOutcome> {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, standardFontDataUrl, verbosity: 0 });
  tasks.push(task);
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    return { error: (e as Error).message, pages: 0, texts: [] };
  }
  const texts: string[] = [];
  let pages = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      texts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(''));
      pages++;
    } catch {
      texts.push('');
    }
  }
  return { pages, texts };
}

interface Range {
  start: number;
  end: number;
}

/**
 * Where each object physically lives in the undamaged file: its own
 * `N 0 obj … endobj` range, or — inside an object stream — that stream's range.
 */
function objectLocations(bytes: Uint8Array): Map<number, Range> {
  const text = latin1(bytes);
  const top = new Map<number, Range>();
  const re = /(\d+) 0 obj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = text.indexOf('endobj', m.index) + 6;
    top.set(Number(m[1]), { start: m.index, end });
    re.lastIndex = end;
  }
  const loc = new Map(top);
  for (const [, range] of top) {
    const body = text.slice(range.start, range.end);
    if (!body.includes('/ObjStm')) continue;
    const first = Number(/\/First (\d+)/.exec(body)?.[1]);
    const count = Number(/\/N (\d+)/.exec(body)?.[1]);
    const s = body.indexOf('stream') + 'stream'.length;
    const dataStart = body[s] === '\r' ? s + 2 : s + 1;
    const data = inflateSync(fromLatin1(body.slice(dataStart, body.lastIndexOf('endstream'))));
    const nums = latin1(data.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) loc.set(nums[i * 2], range);
  }
  return loc;
}

interface PageNeeds {
  page: number;
  contents: number[];
  font: number;
}

async function pageNeeds(bytes: Uint8Array): Promise<PageNeeds[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const contents = p.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    const fonts = p.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    const fontRef = fonts?.values()[0];
    return {
      page: p.ref.objectNumber,
      contents: refs.filter((r): r is PDFRef => r instanceof PDFRef).map((r) => r.objectNumber),
      font: fontRef instanceof PDFRef ? fontRef.objectNumber : -1,
    };
  });
}

interface Damage {
  name: string;
  bytes: Uint8Array;
  /** Is the object whose original range is `r` still intact in the damaged file? */
  intact: (r: Range) => boolean;
}

function damages(src: Uint8Array, objStm: boolean): Damage[] {
  const text = latin1(src);
  const out: Damage[] = [];
  for (const pct of [30, 55, 80, 96]) {
    const cut = Math.floor((src.length * pct) / 100);
    out.push({ name: `truncated at ${pct}%`, bytes: src.slice(0, cut), intact: (r) => r.end <= cut });
  }

  // The cross-reference section and trailer are gone.
  let xrefAt: number;
  if (objStm) {
    const m = [...text.matchAll(/(\d+) 0 obj\s*<<[^>]*\/Type \/XRef/g)].pop();
    xrefAt = m!.index!;
  } else {
    xrefAt = text.lastIndexOf('\nxref') + 1;
  }
  out.push({ name: 'xref + trailer deleted', bytes: src.slice(0, xrefAt), intact: () => true });

  const sx = text.lastIndexOf('startxref');
  const corrupted = text.slice(0, sx) + text.slice(sx).replace(/startxref\s+\d+/, 'startxref\n123');
  out.push({ name: 'startxref corrupted', bytes: fromLatin1(corrupted), intact: () => true });

  const mid = Math.floor(src.length / 2);
  out.push({
    name: 'garbage inserted mid-file',
    bytes: concat(src.subarray(0, mid), noise(4096), src.subarray(mid)),
    intact: (r) => !(r.start < mid && mid < r.end),
  });

  const rootNum = Number(/\/Root (\d+) 0 R/.exec(text.slice(text.lastIndexOf('/Root') - 1))![1]);
  if (objStm) {
    // The catalog lives inside an object stream: make it unreachable instead
    // (the trailer points at an object that does not exist).
    const bogus = String(rootNum).replace(/./g, '9');
    const pos = text.lastIndexOf(`/Root ${rootNum} 0 R`);
    const patched = text.slice(0, pos) + `/Root ${bogus} 0 R` + text.slice(pos + `/Root ${rootNum} 0 R`.length);
    out.push({ name: 'catalog unreachable', bytes: fromLatin1(patched), intact: () => true });
  } else {
    const start = text.search(new RegExp(`(^|\\n)${rootNum} 0 obj`)) + 1;
    const end = text.indexOf('endobj', start) + 'endobj'.length + 1;
    out.push({
      name: 'catalog removed',
      bytes: concat(src.subarray(0, start), src.subarray(end)),
      intact: (r) => r.start !== start,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const report: string[] = [];
afterAll(() => {
  // Documents which damage pdf.js survives on its own (repair only needed where it does not).
  console.log(['', 'damage case                               | pdf.js alone      | after repair', ...report].join('\n'));
});

for (const objStm of [false, true]) {
  describe(`repairPdf — ${objStm ? 'with' : 'without'} object streams`, () => {
    let src: Uint8Array;
    let locs: Map<number, Range>;
    let needs: PageNeeds[];
    const cases: Damage[] = [];

    beforeAll(async () => {
      src = await makePdf(objStm);
      locs = objectLocations(src);
      needs = await pageNeeds(src);
      cases.push(...damages(src, objStm));
    });

    it('the undamaged sample opens in pdf.js with 20 pages', async () => {
      const r = await probe(src);
      expect(r.error).toBeUndefined();
      expect(r.pages).toBe(PAGES);
      expect(r.texts[0]).toContain('Page 1');
    });

    for (const name of [
      'truncated at 30%',
      'truncated at 55%',
      'truncated at 80%',
      'truncated at 96%',
      'xref + trailer deleted',
      'startxref corrupted',
      'garbage inserted mid-file',
      objStm ? 'catalog unreachable' : 'catalog removed',
    ]) {
      it(`recovers: ${name}`, async () => {
        const dmg = cases.find((c) => c.name === name)!;
        const has = (num: number): boolean => {
          const r = locs.get(num);
          return r !== undefined && dmg.intact(r);
        };
        const present = needs.filter((n) => has(n.page));
        const fullyPresent = needs.filter((n) => has(n.page) && n.contents.every(has) && has(n.font));

        const before = await probe(dmg.bytes);
        const pdfjsOk = !before.error && before.pages === PAGES;

        let pagesRecovered = 0;
        let notes: string[] = [];
        let after: PdfjsOutcome = { pages: 0, texts: [] };
        if (present.length === 0) {
          await expect(repairPdf(dmg.bytes)).rejects.toThrow(/No recoverable pages/);
        } else {
          const res = await repairPdf(dmg.bytes);
          pagesRecovered = res.pagesRecovered;
          notes = res.notes;
          after = await probe(res.bytes);
          expect(after.error).toBeUndefined();
          expect(pagesRecovered).toBeGreaterThanOrEqual(present.length);
          expect(after.pages).toBe(pagesRecovered);
          expect(notes[0]).toMatch(/^Recovered /);

          // Every page whose objects all survived renders its own text, in the original order.
          const nums = after.texts
            .map((t) => /Page (\d+)/.exec(t)?.[1])
            .filter((s): s is string => s !== undefined)
            .map(Number);
          expect(nums.length).toBeGreaterThanOrEqual(fullyPresent.length);
          for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThan(nums[i - 1]);
          if (fullyPresent.some((n) => n.page === needs[0].page)) expect(after.texts[0]).toContain('Page 1');
        }

        // Where pdf.js alone already manages, repair must not make things worse.
        if (pdfjsOk) expect(pagesRecovered).toBe(PAGES);
        report.push(
          `${(objStm ? '[objstm] ' : '[plain]  ') + name.padEnd(32)} | ` +
            `${(before.error ? 'FAILS' : `${before.pages}/${PAGES} pages`).padEnd(17)} | ` +
            `${pagesRecovered}/${PAGES} pages (intact: ${present.length}) ${notes.join(' ')}`,
        );
      });
    }
  });
}

describe('repairPdf — edge cases', () => {
  it('looksLikePdf spots the signature only near the start', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
    expect(looksLikePdf(concat(new Uint8Array(500), new TextEncoder().encode('%PDF-1.4')))).toBe(true);
    expect(looksLikePdf(concat(new Uint8Array(2000), new TextEncoder().encode('%PDF-1.4')))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });

  it('rejects empty input', async () => {
    await expect(repairPdf(new Uint8Array(0))).rejects.toThrow(/empty/);
  });

  it('rejects non-PDF input quickly', async () => {
    const t = performance.now();
    await expect(repairPdf(new TextEncoder().encode('hello, I am a text file'))).rejects.toThrow(/not a PDF/);
    await expect(repairPdf(noise(1 << 20))).rejects.toThrow(/not a PDF/);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('a PDF header with no objects has no recoverable pages', async () => {
    await expect(repairPdf(new TextEncoder().encode('%PDF-1.7\n%%EOF\n'))).rejects.toThrow(/No recoverable pages/);
  });

  it('50 MB of random bytes behind a PDF header finishes in under 5 s', async () => {
    const big = noise(50 * 1024 * 1024, 12345);
    big.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
    const t = performance.now();
    await expect(repairPdf(big)).rejects.toThrow(/No recoverable pages/);
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('refuses damaged encrypted files with a clear message', async () => {
    const plain = await makePdf(false);
    const enc = await encryptPdf(plain, {
      userPassword: 'u',
      ownerPassword: 'o',
      permissions: {
        print: true,
        printHighQuality: true,
        modify: true,
        copy: true,
        annotate: true,
        fillForms: true,
        extractForAccessibility: true,
        assemble: true,
      },
    });
    // Intact trailer but truncated body…
    const text = latin1(enc);
    const damaged = concat(enc.subarray(0, Math.floor(enc.length * 0.6)), enc.subarray(text.lastIndexOf('trailer')));
    await expect(repairPdf(damaged)).rejects.toThrow(/encrypted/);
    // …and trailer gone, encryption dictionary still there.
    const noTrailer = enc.subarray(0, text.lastIndexOf('xref'));
    await expect(repairPdf(noTrailer)).rejects.toThrow(/encrypted/);
  });

  it('keeps the document info dict, even when the trailer that named it is gone', async () => {
    const src = await makePdf(false);
    const noTrailer = src.slice(0, latin1(src).lastIndexOf('\nxref') + 1);
    const res = await repairPdf(noTrailer);
    const out = await PDFDocument.load(res.bytes, { updateMetadata: false });
    expect(out.getTitle()).toBe('Repair sample');
    expect(out.getPageCount()).toBe(PAGES);
  });

  it('tolerates CR line endings, missing endobj and no xref at all', async () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Type /Page /MediaBox [0 0 300 200] /Contents 2 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
      '2 0 obj << /Length 36 >> stream',
      'BT /F1 18 Tf 20 100 Td (Page 1) Tj ET',
      'endstream',
      'junk ~~~ 17 garbage',
      '3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      '4 0 obj << /Type /Page /Contents 9 0 R >>',
      '5 0 obj << /Length 999 >> stream',
      'BT /F1 18 Tf 20 100 Td (cut',
    ].join('\r');
    const res = await repairPdf(new TextEncoder().encode(pdf));
    expect(res.pagesRecovered).toBe(2);
    expect(res.notes.join(' ')).toMatch(/1 page content was cut off/);
    expect(res.notes.join(' ')).toMatch(/A4 was assumed/);
    const r = await probe(res.bytes);
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(2);
    expect(r.texts[0]).toContain('Page 1');
  });
});
