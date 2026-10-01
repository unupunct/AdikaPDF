// Automation and search: watched folders, folder search, split by bookmarks / size, command line — included by suite.mjs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { PDFDocument as PD, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';

async function textPdf(pages) {
  const d = await PD.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of pages) d.addPage([400, 300]).drawText(t, { x: 30, y: 250, size: 14, font: f });
  return d.save();
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export function registerAutomationTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, EXE } = ctx;
  const slash = (p) => p.split('\\').join('/');

  test('watched folder: a PDF copied in is processed with the saved sequence, the original moves to Processed', async () => {
    const watched = join(dir, 'watched');
    mkdirSync(watched);
    await S(() =>
      localStorage.setItem('adika.actionSequences', JSON.stringify([{ id: 'seq-w', name: 'Numerotare', steps: [{ kind: 'pageNumbers', format: 'Pagina {page} din {pages}' }] }])),
    );
    await S(() => window.__adika.store.getState().openModal('batch'));
    await page.waitForSelector('[data-testid="batch-modal"]');
    await page.click('[data-testid="batch-modal"] [role="tab"]:has-text("Watched folders")');
    await page.waitForSelector('[data-testid="watch-panel"]');
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), watched);
    await page.click('[data-testid="watch-add"]');
    await page.waitForSelector('[data-testid="watch-item"]');
    writeFileSync(join(watched, 'raport.pdf'), await textPdf(['Raport lunar', 'Anexa']));
    const out = join(watched, 'Output', 'raport-numerotare.pdf');
    assert(await waitFor(() => existsSync(out), 40000), 'result in Output');
    assert(existsSync(join(watched, 'Processed', 'raport.pdf')) && !existsSync(join(watched, 'raport.pdf')), 'original moved to Processed');
    const t = await pdfText(out);
    assert(t[1].includes('Pagina 2 din 2'), `sequence applied (${t[1]})`);
    await page.waitForSelector('[data-testid="watch-events"]', { timeout: 10000 });
    // Stop watching.
    await page.click('[data-testid="watch-item"] button[aria-label="Stop watching this folder"]');
    await page.keyboard.press('Escape');
  });

  test('search folders: every PDF indexed, diacritics ignored, a hit opens the file at its page', async () => {
    const acte = join(dir, 'acte');
    mkdirSync(join(acte, '2026'), { recursive: true });
    writeFileSync(join(acte, 'contract.pdf'), await textPdf(['Contract nr. 12', 'Chiria lunara: 2.500 lei (inchiriere apartament)', 'Semnaturi']));
    writeFileSync(join(acte, '2026', 'factura.pdf'), await textPdf(['Factura fiscala 2026-114, total 2.500 lei']));
    writeFileSync(join(acte, 'altceva.pdf'), await textPdf(['Nimic relevant aici']));
    await S(() => window.__adika.store.getState().openModal('foldersearch'));
    await page.waitForSelector('[data-testid="foldersearch-modal"]');
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), acte);
    await page.click('[data-testid="foldersearch-add"]');
    await page.waitForFunction(() => /3 PDFs indexed/.test(document.querySelector('[data-testid="foldersearch-status"]')?.textContent ?? ''), null, { timeout: 60000 });
    await page.fill('[data-testid="foldersearch-query"]', 'ÎNCHIRIERE');
    await page.waitForSelector('[data-testid="foldersearch-result"]');
    let names = await page.$$eval('[data-testid="foldersearch-result"]', (els) => els.map((e) => e.textContent));
    assert(names.length === 1 && /contract\.pdf/.test(names[0]), `one result (${names})`);
    await page.fill('[data-testid="foldersearch-query"]', '"2.500 lei"');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="foldersearch-result"]').length === 2, null, { timeout: 5000 });
    await page.fill('[data-testid="foldersearch-query"]', 'chiria');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="foldersearch-result"]').length === 1, null, { timeout: 5000 });
    await page.click('[data-testid="foldersearch-hit"]');
    await page.waitForFunction(() => window.__adika.store.getState().fileName === 'contract.pdf', null, { timeout: 15000 });
    await page.waitForTimeout(600);
    const cur = await S(() => {
      const s = window.__adika.store.getState();
      return s.pages.findIndex((p) => p.id === s.currentPageId) + 1;
    });
    assert(cur === 2, `opened at page 2 (${cur})`);
  });

  test('split by bookmarks (named parts) and by size', async () => {
    const path = join(dir, 'manual.pdf');
    writeFileSync(path, await textPdf(['Coperta', 'Capitolul 1', 'Capitolul 1, continuare', 'Capitolul 2']));
    await open(path);
    await S(() => {
      const s = window.__adika.store.getState();
      const bm = (title, i) => ({ id: `bm${i}`, title, pageId: s.pages[i].id, top: null, url: null, bold: false, italic: false, open: false, children: [] });
      window.__adika.store.setState({ outline: [bm('Capitolul 1', 1), bm('Capitolul 2', 3)] });
    });
    await S(() => window.__adika.store.getState().openModal('split'));
    await page.click('[data-testid="split-modal"] [role="tab"]:has-text("Bookmarks")');
    await page.click('[data-testid="split-run"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /manual-split\.zip$/.test(f)), null, { timeout: 60000 });
    let zip = await JSZip.loadAsync(readFileSync(await savedFile(/manual-split\.zip$/)));
    let names = Object.keys(zip.files).sort();
    assert(names.join('|') === 'Capitolul 1.pdf|Capitolul 2.pdf|manual-part1.pdf', `bookmark parts (${names})`);
    const ch1 = await PD.load(await zip.files['Capitolul 1.pdf'].async('uint8array'));
    assert(ch1.getPageCount() === 2, 'chapter 1 has 2 pages');

    // By size: three pages with ~0.5 MB pictures, at most 0.8 MB per part.
    const d = await PD.create();
    for (let i = 0; i < 3; i++) {
      const c = createCanvas(700, 700);
      const g = c.getContext('2d');
      const img = g.createImageData(700, 700);
      let seed = 1 + i;
      for (let k = 0; k < img.data.length; k++) img.data[k] = (seed = (seed * 16807) % 2147483647) & 255;
      g.putImageData(img, 0, 0);
      const png = await d.embedPng(c.toBuffer('image/png'));
      d.addPage([400, 400]).drawImage(png, { x: 0, y: 0, width: 400, height: 400 });
    }
    const big = join(dir, 'heavy-pages.pdf');
    writeFileSync(big, await d.save());
    await open(big);
    await S(() => window.__adika.store.getState().openModal('split'));
    await page.click('[data-testid="split-modal"] [role="tab"]:has-text("Size")');
    await page.fill('[data-testid="split-max-mb"]', '2');
    await page.click('[data-testid="split-run"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /heavy-pages-split\.zip$/.test(f)), null, { timeout: 60000 });
    zip = await JSZip.loadAsync(readFileSync(await savedFile(/heavy-pages-split\.zip$/)));
    names = Object.keys(zip.files);
    assert(names.length >= 2, `size parts (${names.length})`);
    for (const n of names) assert((await zip.files[n].async('uint8array')).length < 2 * 1024 * 1024, `${n} under the limit`);
  });

  test('command line: --batch runs steps on wildcard files without a window and exits with a status code', async () => {
    const cli = join(dir, 'cli');
    mkdirSync(join(cli, 'out'), { recursive: true });
    writeFileSync(join(cli, 'cli-a.pdf'), await textPdf(['Unu', 'Doi']));
    writeFileSync(join(cli, 'cli-b.pdf'), await textPdf(['Trei']));
    copyFileSync(join(cli, 'cli-b.pdf'), join(cli, 'other.pdf'));
    const run = (args) =>
      new Promise((resolve) => {
        const p = spawn(EXE, args, { cwd: cli, env: { ...process.env, ADIKA_E2E: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (b) => (out += b));
        p.stderr.on('data', (b) => (out += b));
        const t = setTimeout(() => p.kill(), 120000);
        p.on('exit', (code) => {
          clearTimeout(t);
          resolve({ code, out });
        });
      });
    const ok = await run(['--batch', '--page-numbers', 'Pagina {page}', '--out', 'out', 'cli-*.pdf']);
    assert(ok.code === 0, `exit code 0 (${ok.code}; ${ok.out.slice(0, 300)})`);
    const made = readdirSync(join(cli, 'out')).sort();
    assert(made.join('|') === 'cli-a-numbered.pdf|cli-b-numbered.pdf', `outputs (${made})`);
    const t = await pdfText(join(cli, 'out', 'cli-a-numbered.pdf'));
    assert(t[1].includes('Pagina 2'), `page numbers (${t[1]})`);
    const bad = await run(['--batch', '--bogus', 'cli-a.pdf']);
    assert(bad.code === 2, `wrong arguments exit 2 (${bad.code})`);
    console.log(`   command line output: ${ok.out.trim().split('\n').slice(-1)[0] ?? '(none captured)'}`);
  });
}
