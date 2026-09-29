// Editable scans, visual compare and the reading view — included by suite.mjs.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { PDFArray, PDFDocument as PD, PDFName, StandardFonts, rgb } from 'pdf-lib';

/** The page's content streams, decoded, as text. */
function pageContentText(doc, index) {
  const c = doc.getPage(index).node.Contents();
  const refs = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
  return refs
    .map((s) => (String(s.dict.get(PDFName.of('Filter'))) === '/FlateDecode' ? zlib.inflateSync(Buffer.from(s.contents)) : Buffer.from(s.contents)).toString('latin1'))
    .join('\n');
}

export function registerVisualTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, F } = ctx;

  test('editable scan: OCR text becomes real, visible text in the ink colour over the painted-out scan', async () => {
    const png = await S(() => {
      const c = document.createElement('canvas');
      c.width = 2480;
      c.height = 1200;
      const x = c.getContext('2d');
      x.fillStyle = 'rgb(248,242,228)'; // off-white paper
      x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = 'rgb(25,45,130)'; // blue ink
      x.font = '96px Georgia';
      x.fillText('Contract number 58213', 120, 400);
      x.fillText('Signed in Cluj on the first of May', 120, 600);
      x.fillStyle = 'rgb(200,30,30)';
      x.beginPath();
      x.arc(2000, 900, 150, 0, Math.PI * 2);
      x.fill(); // a stamp, which stays a picture
      return c.toDataURL('image/png');
    });
    const bytes = await S((src) => window.__adika.convert.imagesToPdf([{ src, width: 2480, height: 1200 }], { pageSize: 'fit', orientation: 'auto', marginMm: 0 }).then((b) => Array.from(b)), png);
    const scan = join(dir, 'letter-scan.pdf');
    writeFileSync(scan, Uint8Array.from(bytes));
    await open(scan);
    await page.click('[data-testid="tab-convert"]');
    await page.click('[data-testid="btn-ocr"]');
    await page.waitForSelector('[data-testid="ocr-modal"]');
    await page.selectOption('[data-testid="ocr-modal"] select[aria-label="OCR result"]', 'serif');
    await page.selectOption('[data-testid="ocr-modal"] select[aria-label="OCR resolution"]', '200');
    await page.click('[data-testid="ocr-run"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => f.endsWith('letter-scan-editable.pdf')), null, { timeout: 300000 });
    await idle(300000);
    const path = await savedFile(/letter-scan-editable\.pdf$/);
    const t = (await pdfText(path))[0];
    assert(/Contract/.test(t) && /58213/.test(t) && /Cluj/.test(t), `editable text (${t.slice(0, 100)})`);
    // Visible text (not render mode 3), coloured like the ink, squeezed to the scanned width.
    const doc = await PD.load(readFileSync(path));
    const content = pageContentText(doc, 0);
    assert(!/\b3 Tr\b/.test(content) && / Tz\b/.test(content), 'visible text with horizontal scaling');
    const colors = [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].map((m) => m.slice(1, 4).map(Number));
    assert(colors.some(([r, g, b]) => b > r + 0.2 && b > 0.3), `blue ink colour (${JSON.stringify(colors.slice(0, 4))})`);
    assert(colors.some(([r, g, b]) => r > 0.9 && g > 0.9 && b > 0.83), 'paper colour');
    // Opened in the app: the text is editable text of the page.
    await page.waitForFunction(() => /editable/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 15000 });
  });

  test('visual compare: an overlay report of the pixel differences', async () => {
    const make = async (amount, color) => {
      const d = await PD.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      const p = d.addPage([595, 842]);
      p.drawText('Invoice 2026-114', { x: 60, y: 760, size: 20, font: f });
      p.drawText(`Amount due: ${amount}`, { x: 60, y: 720, size: 14, font: f });
      p.drawRectangle({ x: 60, y: 500, width: 200, height: 120, color });
      return d.save();
    };
    const oldPath = join(dir, 'invoice-v1.pdf');
    const newPath = join(dir, 'invoice-v2.pdf');
    writeFileSync(oldPath, await make('1 200 lei', rgb(0.2, 0.5, 0.2)));
    writeFileSync(newPath, await make('1 900 lei', rgb(0.8, 0.2, 0.2)));
    await open(newPath);
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), oldPath.split('\\').join('/'));
    await S(() => window.__adika.pageTools.compareVisually());
    await idle();
    await page.waitForFunction(() => /visual comparison/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 30000 });
    const pages = await S(() => window.__adika.store.getState().pages.length);
    assert(pages === 2, `summary + one page (${pages})`);
    const bytes = await S(async () => Array.from(await window.__adika.document.exportCurrentPdf()));
    const tmp = join(dir, 'visual-report.pdf');
    writeFileSync(tmp, Uint8Array.from(bytes));
    const t = await pdfText(tmp);
    assert(/changed area/.test(t[0]) && /on page 1/.test(t[0]), `summary (${t[0].slice(0, 160)})`);
    assert(/Page 1: \d+ changed area/.test(t[1]), `page label (${t[1]})`);
    await S(() => window.__adika.store.setState({ dirty: false }));
  });

  test('reading view: the text reflowed with size, theme and page markers that jump back', async () => {
    await open(F.reader);
    await page.click('[data-testid="tab-view"]');
    await page.click('[data-testid="btn-reading-view"]');
    await page.waitForSelector('[data-testid="reading-article"] p', { timeout: 20000 });
    const text = await page.textContent('[data-testid="reading-article"]');
    assert(text.length > 120, `reflowed text (${text.length} chars)`);
    const markers = await page.$$('[data-testid="reading-page-marker"]');
    assert(markers.length >= 2, `page markers (${markers.length})`);
    const size = async () => page.$eval('[data-testid="reading-article"]', (a) => getComputedStyle(a).fontSize);
    const before = await size();
    await page.click('[data-testid="reading-larger"]');
    await page.click('[data-testid="reading-larger"]');
    const after = await size();
    assert(parseFloat(after) === parseFloat(before) + 2, `text larger (${before} → ${after})`);
    await page.click('[data-testid="reading-theme-dark"]');
    const bg = await page.$eval('[data-testid="reading-view"]', (e) => getComputedStyle(e).backgroundColor);
    assert(bg === 'rgb(21, 23, 26)', `dark theme (${bg})`);
    // Remembered.
    const prefs = await S(() => JSON.parse(localStorage.getItem('adika.readingView')));
    assert(prefs.theme === 'dark', 'preferences remembered');
    await S(() => localStorage.removeItem('adika.readingView'));
    // A page marker goes back to that page.
    await markers[1].click();
    await page.waitForSelector('[data-testid="reading-view"]', { state: 'detached' });
    const cur = await S(() => {
      const s = window.__adika.store.getState();
      return s.pages.findIndex((p) => p.id === s.currentPageId) + 1;
    });
    assert(cur >= 2, `jumped to page ${cur}`);
  });
}
