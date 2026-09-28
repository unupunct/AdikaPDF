/**
 * Real-world robustness checks for the desktop app:
 * huge documents, damaged/fake files, and whether saving preserves
 * bookmarks, links and annotations made by other programs.
 *   node tests/e2e/robustness.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString, StandardFonts, PDFArray, PDFHexString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { launchApp, tempDir } from './harness.mjs';

const dir = tempDir('adika-robust-');
const out = join(dir, 'out');
mkdirSync(out);
const FONT_DATA = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts').split('\\').join('/') + '/';
const results = [];
const note = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- fixtures
async function bigPdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Page ${i} of the large document`, { x: 60, y: 780, size: 18, font });
    for (let l = 0; l < 40; l++) p.drawText(`Line ${l + 1}: lorem ipsum dolor sit amet ${i * 100 + l}`, { x: 60, y: 740 - l * 16, size: 10, font });
  }
  return doc.save();
}

/** A PDF with an outline (bookmarks), a URI link and a text-markup annotation from "another program". */
async function richPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [1, 2, 3].map((i) => {
    const p = doc.addPage([595, 842]);
    p.drawText(`Chapter ${i}`, { x: 60, y: 760, size: 24, font });
    return p;
  });
  const ctx = doc.context;
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [60, 700, 300, 720], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/') } }));
  const hl = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [58, 755, 200, 790], QuadPoints: [58, 790, 200, 790, 58, 755, 200, 755], C: [1, 1, 0], Contents: PDFHexString.fromText('Reviewer note'), T: PDFHexString.fromText('Foxit user') }),
  );
  pages[0].node.set(PDFName.of('Annots'), ctx.obj([link, hl]));
  // Outline: Chapter 1..3
  const outlineRef = ctx.nextRef();
  const itemRefs = pages.map(() => ctx.nextRef());
  pages.forEach((p, i) => {
    const d = { Title: PDFHexString.fromText(`Chapter ${i + 1}`), Parent: outlineRef, Dest: [p.ref, PDFName.of('Fit')] };
    if (i > 0) d.Prev = itemRefs[i - 1];
    if (i < pages.length - 1) d.Next = itemRefs[i + 1];
    ctx.assign(itemRefs[i], ctx.obj(d));
  });
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: itemRefs[0], Last: itemRefs[2], Count: 3 }));
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, ctx.obj({ S: 'r' }), 1, ctx.obj({ S: 'D' })] }));
  return doc.save();
}

async function inspect(path) {
  const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
  const outline = (await d.getOutline()) ?? [];
  const annots = await (await d.getPage(1)).getAnnotations();
  const labels = await d.getPageLabels();
  const r = { outline: outline.map((o) => o.title), annots: annots.map((a) => a.subtype), labels };
  await d.loadingTask.destroy();
  return r;
}

const F = {
  big: join(dir, 'big-1000.pdf'),
  rich: join(dir, 'rich.pdf'),
  truncated: join(dir, 'truncated.pdf'),
  empty: join(dir, 'empty.pdf'),
  fake: join(dir, 'fake.pdf'),
};
const big = await bigPdf(1000);
writeFileSync(F.big, big);
writeFileSync(F.rich, await richPdf());
writeFileSync(F.truncated, big.subarray(0, Math.floor(big.length * 0.55)));
writeFileSync(F.empty, new Uint8Array(0));
writeFileSync(F.fake, new TextEncoder().encode('This is not a PDF, just text renamed to .pdf'));

// ---------------------------------------------------------------- app
const app = await launchApp({ exe: process.env.ADIKA_EXE });
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const S = (fn, arg) => page.evaluate(fn, arg);
await S((d) => window.__adika.platform.e2eSetSaveDir(d), out);
const state = () => S(() => { const s = window.__adika.store.getState(); return { pages: s.pages.length, name: s.fileName, toasts: s.toasts.map((t) => `${t.kind}:${t.message}`), busy: !!s.busy }; });
const openPath = async (p) => {
  await S(() => window.__adika.store.setState({ dirty: false, toasts: [] }));
  const t0 = Date.now();
  const ok = await S((x) => window.__adika.document.openPdfPath(x), p);
  return { ok, ms: Date.now() - t0 };
};

// 1. Huge document
{
  const r = await openPath(F.big);
  const s = await state();
  note('opens a 1000-page PDF', r.ok && s.pages === 1000, `${(big.length / 1024 / 1024).toFixed(1)} MB in ${r.ms} ms`);
  const t0 = Date.now();
  await S(() => { const st = window.__adika.store.getState(); st.scrollToPage(st.pages[899].id); });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="page-900"]');
    return el && !el.textContent.includes('Loading');
  }, null, { timeout: 30000 }).then(
    () => note('jumps to page 900 and renders it', true, `${Date.now() - t0} ms`),
    () => note('jumps to page 900 and renders it', false, 'did not render within 30 s'),
  );
  const t1 = Date.now();
  const hits = await S(() => { const st = window.__adika.store.getState(); return window.__adika.search.searchDocument(st.pages, 'Page 777 of', { cancelled: false }).then((h) => h.length); });
  note('searches all 1000 pages', hits === 1, `${hits} hit in ${Date.now() - t1} ms`);
  const mem = await S(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1));
  note('memory stays reasonable', mem < 800, `JS heap ${mem} MB`);
}

// 2. Damaged and fake files
for (const [label, file] of [['truncated (55%) PDF', F.truncated], ['empty .pdf file', F.empty], ['text file renamed .pdf', F.fake]]) {
  const r = await openPath(file);
  const s = await state();
  const msg = s.toasts.find((t) => t.startsWith('error:')) ?? '';
  const recovered = r.ok && s.pages > 0;
  note(`${label}: handled without crashing`, recovered || msg.length > 0, recovered ? `recovered ${s.pages} pages` : msg.slice(0, 120));
}
{
  const alive = await S(() => !!document.querySelector('[data-testid="app-root"]'));
  note('app still responsive after bad files', alive && errors.length === 0, errors.length ? errors.join(' | ').slice(0, 200) : 'no uncaught errors');
}

// 3. Editing keeps other programs' bookmarks, links, annotations and page labels
{
  const before = await inspect(F.rich);
  await openPath(F.rich);
  await S(() => {
    const s = window.__adika.store.getState();
    s.addObject({ id: 'r1', type: 'rect', pageId: s.pages[1].id, x: 50, y: 50, width: 100, height: 60, rotation: 0, opacity: 1, stroke: '#ff0000', strokeWidth: 2, fill: null });
  });
  await S(() => window.__adika.document.saveDocument(true));
  await page.waitForFunction(() => !window.__adika.store.getState().busy);
  const saved = (await S(() => window.__adika.platform.e2eSavedFiles())).pop();
  const after = await inspect(saved);
  note('keeps bookmarks after saving', JSON.stringify(after.outline) === JSON.stringify(before.outline), after.outline.join(', '));
  note('keeps links and review annotations', after.annots.includes('Link') && after.annots.includes('Highlight'), after.annots.join(', '));
  note('keeps page labels', JSON.stringify(after.labels) === JSON.stringify(before.labels), JSON.stringify(after.labels?.slice(0, 3)));
  // Reordering pages must keep bookmarks pointing at the right chapter.
  await openPath(F.rich);
  await S(() => { const s = window.__adika.store.getState(); s.reorderPages([s.pages[2].id, s.pages[0].id, s.pages[1].id]); });
  await S(() => window.__adika.document.saveDocument(true));
  await page.waitForFunction(() => !window.__adika.store.getState().busy);
  const reordered = (await S(() => window.__adika.platform.e2eSavedFiles())).pop();
  const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(reordered)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
  const ol = (await d.getOutline()) ?? [];
  const destPage = ol.length ? await d.getPageIndex((Array.isArray(ol[0].dest) ? ol[0].dest : await d.getDestination(ol[0].dest))[0]) : -1;
  note('bookmark “Chapter 1” follows its page after reorder', destPage === 1, `points to page ${destPage + 1} (expected 2)`);
  await d.loadingTask.destroy();
}

// 4. Reader basics the UI offers today
{
  await openPath(F.rich);
  const ui = await S(() => ({
    textLayer: !!document.querySelector('.textLayer, [data-testid="text-layer"]'),
    links: !!document.querySelector('.annotationLayer a, [data-testid="link-layer"] a'),
    outlinePanel: !!document.querySelector('[data-testid="outline-panel"]'),
    print: [...document.querySelectorAll('button')].some((b) => /print/i.test(b.getAttribute('aria-label') ?? b.textContent ?? '')),
  }));
  note('text can be selected and copied', ui.textLayer, ui.textLayer ? '' : 'no selectable text layer');
  note('links are clickable', ui.links, ui.links ? '' : 'links are drawn but not clickable');
  note('bookmarks panel', ui.outlinePanel, ui.outlinePanel ? '' : 'no outline panel');
  note('printing', ui.print, ui.print ? '' : 'no Print command');
}

writeFileSync(join(dir, 'robustness.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.ok).length} ok, ${results.filter((r) => !r.ok).length} gaps · ${dir}`);
await app.close();
