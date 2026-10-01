// Scan to PDF (with pictures instead of a scanner), cleanup, separator sheets, split — included by suite.mjs.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument as PD } from 'pdf-lib';
import JSZip from 'jszip';

const LINES = [
  'The quick brown fox jumps over the lazy dog while the',
  'little black kitten sleeps behind the old wooden table;',
  'both of them will stay there until the light fades and',
  'the whole house finally becomes quiet for the night.',
  'Details like these make a simple story feel much better.',
];

/** A "scanned" page picture (A4 at 150 DPI). */
function pagePng({ angle = 0, lines = LINES, dust = 0, flip = false } = {}) {
  const w = 1240;
  const h = 1754;
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#f7f5ef';
  g.fillRect(0, 0, w, h);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(((angle + (flip ? 180 : 0)) * Math.PI) / 180);
  g.translate(-w / 2, -h / 2);
  g.fillStyle = '#151515';
  g.font = '34px serif';
  lines.forEach((l, i) => g.fillText(l, 110, 260 + i * 58));
  lines.forEach((l, i) => g.fillText(l, 110, 800 + i * 58));
  g.restore();
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#000';
  for (let i = 0; i < dust; i++) g.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), 2, 2);
  return c.toBuffer('image/png');
}

async function renderPng(pdfPath, pageNo, FONT_DATA) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdfPath)), standardFontDataUrl: FONT_DATA, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 150 / 72 });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp, canvas: null }).promise;
  await doc.loadingTask.destroy();
  return c.toBuffer('image/png');
}

export function registerScanTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, FONT_DATA } = ctx;
  const slash = (p) => p.split('\\').join('/');
  const pics = {};

  test('scan to PDF: pictures cleaned up (straightened, turned upright), blank page and named separator sheet split the batch, black-and-white Group 4', async () => {
    await S(() => localStorage.removeItem('adika.scanPrefs'));
    await S(() => window.__adika.store.getState().openModal('scan'));
    await page.waitForSelector('[data-testid="scan-modal"]');
    // No scanner on this computer: the dialog says so.
    await page.waitForFunction(() => /No scanner found/.test(document.querySelector('[data-testid="scan-modal"]')?.textContent ?? ''), null, { timeout: 60000 });
    await page.selectOption('[data-testid="scan-modal"] select[aria-label="Colour mode"]', 'bw');
    // Print a separator sheet from the dialog, and "scan" it.
    await page.click('[data-testid="scan-modal"] summary');
    await page.fill('[data-testid="scan-sep-names"]', 'Anexa Ștefan');
    await page.click('[data-testid="scan-sep-save"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /separator sheets\.pdf$/.test(f)), null, { timeout: 15000 });
    const sheet = await savedFile(/separator sheets\.pdf$/);
    pics.sep = join(dir, 'scan-sep.png');
    writeFileSync(pics.sep, await renderPng(sheet, 1, FONT_DATA));
    pics.p1 = join(dir, 'scan-p1.png');
    writeFileSync(pics.p1, pagePng({ angle: 3 }));
    pics.p2 = join(dir, 'scan-blank.png');
    writeFileSync(pics.p2, pagePng({ lines: [], dust: 250 }));
    pics.p4 = join(dir, 'scan-p4.png');
    writeFileSync(pics.p4, pagePng({ flip: true }));

    await S((p) => window.__adika.platform.e2eQueuePicks(p), [pics.p1, pics.p2, pics.sep, pics.p4].map(slash));
    await page.click('[data-testid="scan-add-pictures"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scan-page"]').length === 4, null, { timeout: 120000 });
    const roles = await page.$$eval('[data-testid="scan-page"]', (els) => els.map((e) => e.getAttribute('data-role')));
    assert(roles.join() === 'content,blank,separator,content', `pages recognised (${roles})`);
    const sep = await page.textContent('[data-testid="scan-separator"]');
    assert(/Anexa Stefan/.test(sep), `separator name (${sep})`);
    const summary = await page.textContent('[data-testid="scan-summary"]');
    assert(/4 pages · 2 documents/.test(summary), `summary (${summary})`);
    const turned = await page.$$eval('[data-testid="scan-page"]', (els) => els.map((e) => e.textContent));
    assert(/180°/.test(turned[3]) && /-?3\.\d°|3°/.test(turned[0]), `straightened and turned (${turned.join(' | ')})`);

    const folder = join(dir, 'scans');
    mkdirSync(folder);
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), folder);
    await page.click('[data-testid="scan-create"]');
    for (let t = 0; t < 240 && readdirSync(folder).length < 2; t++) await new Promise((r) => setTimeout(r, 500));
    await idle(120000);
    const files = readdirSync(folder).sort();
    assert(files.join('|') === 'Anexa Stefan.pdf|Scan 1.pdf', `documents (${files})`);
    for (const f of files) {
      const bytes = readFileSync(join(folder, f));
      const doc = await PD.load(bytes);
      assert(doc.getPageCount() === 1, `${f}: one page`);
      assert(bytes.includes(Buffer.from('/CCITTFaxDecode')), `${f}: Group 4 image`);
      assert(bytes.length < 120000, `${f}: small (${bytes.length} bytes)`);
    }
  });

  test('split an existing PDF at separator sheets (named parts)', async () => {
    const d = await PD.create();
    for (const p of [pics.p1, pics.sep, pics.p4]) {
      const img = await d.embedPng(readFileSync(p));
      d.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }
    const path = join(dir, 'batch-with-separator.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await S(() => window.__adika.store.getState().openModal('split'));
    await page.waitForSelector('[data-testid="split-modal"]');
    await page.click('[data-testid="split-modal"] [role="tab"]:has-text("At separators")');
    await page.click('[data-testid="split-run"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /batch-with-separator-split\.zip$/.test(f)), null, { timeout: 60000 });
    const zipPath = await savedFile(/batch-with-separator-split\.zip$/);
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    const names = Object.keys(zip.files).sort();
    assert(names.join('|') === 'Anexa Stefan.pdf|batch-with-separator-part1.pdf', `parts (${names})`);
    assert(existsSync(zipPath), 'zip saved');
  });
}
