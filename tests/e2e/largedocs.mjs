/**
 * Very large documents in the desktop app (NOT RUN YET: written in round 14
 * without a release build). A generated 5,000-page PDF: time until page 1 is
 * visible, virtualised viewer, jump to page 4,000, scrolling, real page
 * sizes arriving, search and save. Prints the timings.
 *   node tests/e2e/largedocs.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { launchApp, tempDir } from './harness.mjs';

const PAGES = Number(process.env.LARGE_PAGES ?? 5000);
const dir = tempDir('adika-large-');
const out = join(dir, 'out');
mkdirSync(out);
const results = [];
const note = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Every 50th page landscape, every 7th /Rotate 90: sizes the app only learns after opening. */
async function bigPdf(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage(i % 50 === 0 ? [842, 595] : [595, 842]);
    if (i % 7 === 0) p.setRotation({ type: 'degrees', angle: 90 });
    p.drawText(`Page ${i} of the large document`, { x: 60, y: 520, size: 18, font });
    for (let l = 0; l < 20; l++) p.drawText(`Line ${l + 1}: lorem ipsum dolor sit amet ${i * 100 + l}`, { x: 60, y: 500 - l * 16, size: 10, font });
  }
  return doc.save({ objectsPerTick: 2000 });
}

const file = join(dir, `large-${PAGES}.pdf`);
const t0gen = Date.now();
writeFileSync(file, await bigPdf(PAGES));
console.log(`generated ${PAGES} pages (${(readFileSync(file).length / 1048576).toFixed(1)} MB) in ${Date.now() - t0gen} ms`);

const app = await launchApp({ exe: process.env.ADIKA_EXE });
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const S = (fn, arg) => page.evaluate(fn, arg);
await S((d) => window.__adika.platform.e2eSetSaveDir(d), out);
const rendered = (n) => {
  const el = document.querySelector(`[data-testid="page-${n}"]`);
  return !!el && !el.textContent.includes('Loading');
};

// 1. Open: page 1 visible
{
  const t0 = Date.now();
  const opening = S((p) => window.__adika.document.openPdfPath(p), file);
  await page.waitForFunction(rendered, 1, { timeout: 60000 }).then(
    () => note('page 1 visible', true, `${Date.now() - t0} ms after Open (goal: about 2 s)`),
    () => note('page 1 visible', false, 'not within 60 s'),
  );
  const ok = await opening;
  const s = await S(() => ({ pages: window.__adika.store.getState().pages.length, mounted: document.querySelectorAll('[data-page-id]').length, thumbs: document.querySelectorAll('[data-testid^="thumb-label-"]').length }));
  note('opens all pages', ok && s.pages === PAGES, `${s.pages} pages`);
  note('viewer mounts only pages near the view', s.mounted > 0 && s.mounted < 40, `${s.mounted} page elements, ${s.thumbs} thumbnails`);
}

// 2. Jump to page 4,000
{
  const n = Math.min(4000, PAGES);
  const t0 = Date.now();
  await S((i) => { const st = window.__adika.store.getState(); st.scrollToPage(st.pages[i - 1].id); }, n);
  await page.waitForFunction(rendered, n, { timeout: 30000 }).then(
    () => note(`page ${n} shown after a jump`, true, `${Date.now() - t0} ms`),
    () => note(`page ${n} shown after a jump`, false, 'not within 30 s'),
  );
  const cur = await S(() => { const st = window.__adika.store.getState(); return st.pages.findIndex((p) => p.id === st.currentPageId) + 1; });
  note('current page follows', Math.abs(cur - n) <= 1, `current page ${cur}`);
}

// 3. Scrolling: frame times while scrolling 60 steps of 400 px
{
  const r = await S(async () => {
    const el = document.querySelector('[data-testid="pdf-canvas"]');
    const frames = [];
    let last = performance.now();
    for (let i = 0; i < 60; i++) {
      el.scrollTop += 400;
      await new Promise((res) => requestAnimationFrame(res));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    frames.sort((a, b) => a - b);
    return { median: frames[30], p95: frames[57], max: frames[59], mounted: document.querySelectorAll('[data-page-id]').length };
  });
  note('scrolls smoothly', r.p95 < 50, `frame median ${r.median.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms, ${r.mounted} pages mounted`);
}

// 4. Real page sizes replace the estimates
{
  const t0 = Date.now();
  await page.waitForFunction(() => { const p = window.__adika.store.getState().pages; return p[49]?.width === 842 && p[6]?.baseRotation === 90; }, null, { timeout: 120000 }).then(
    () => note('real page sizes arrive', true, `${Date.now() - t0} ms after the checks above`),
    () => note('real page sizes arrive', false, 'landscape page 50 / rotated page 7 still estimated after 120 s'),
  );
}

// 5. Search
{
  const t0 = Date.now();
  const hits = await S(() => { const st = window.__adika.store.getState(); return window.__adika.search.searchDocument(st.pages, 'Page 4321 of', { cancelled: false }).then((h) => h.length); });
  note(`searches all ${PAGES} pages`, hits === (PAGES >= 4321 ? 1 : 0), `${hits} hit in ${Date.now() - t0} ms`);
}

// 6. Memory
{
  const mem = await S(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1));
  note('memory stays bounded', mem < 900, `JS heap ${mem} MB`);
}

// 7. Save (an edit on page 4,000)
{
  await S(() => {
    const s = window.__adika.store.getState();
    s.addObject({ id: 'big1', type: 'rect', pageId: s.pages[Math.min(3999, s.pages.length - 1)].id, x: 50, y: 50, width: 100, height: 60, rotation: 0, opacity: 1, stroke: '#ff0000', strokeWidth: 2, fill: null });
  });
  const t0 = Date.now();
  await S(() => window.__adika.document.saveDocument(true));
  await page.waitForFunction(() => !window.__adika.store.getState().busy, null, { timeout: 300000 });
  const ms = Date.now() - t0;
  const saved = (await S(() => window.__adika.platform.e2eSavedFiles())).pop();
  let pages = -1;
  let size = '';
  let rot = null;
  if (saved) {
    const bytes = new Uint8Array(readFileSync(saved));
    size = `${(bytes.length / 1048576).toFixed(1)} MB`;
    const d = await pdfjs.getDocument({ data: bytes, disableFontFace: true }).promise;
    pages = d.numPages;
    rot = (await d.getPage(7)).rotate;
    await d.loadingTask.destroy();
  }
  note('saves the large document', pages === PAGES && rot === 90, `${ms} ms, ${size}, ${pages} pages, page 7 /Rotate ${rot}`);
}

note('no uncaught errors', errors.length === 0, errors.join(' | ').slice(0, 300));
writeFileSync(join(dir, 'largedocs.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.ok).length} ok, ${results.filter((r) => !r.ok).length} failed · ${dir}`);
await app.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
