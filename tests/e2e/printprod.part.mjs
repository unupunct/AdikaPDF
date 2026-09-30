// Print production: preflight, PDF/X-4, grey conversion, ink preview, bleed and marks — included by suite.mjs.
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument as PD, PDFName, StandardFonts, rgb } from 'pdf-lib';

export function registerPrintProdTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, FONT_DATA } = ctx;

  const waitSaved = (re) => page.waitForFunction((src) => window.__adika.platform.e2eSavedFiles().some((f) => new RegExp(src).test(f)), re.source, { timeout: 60000 });

  test('print production: PDF/X-4 preflight and conversion, grey conversion, ink preview, bleed and printer marks', async () => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([420, 297]);
    p.drawRectangle({ x: 0, y: 0, width: 420, height: 90, color: rgb(0.9, 0.1, 0.1) }); // runs to the edge
    p.drawRectangle({ x: 40, y: 150, width: 120, height: 80, color: rgb(0.1, 0.4, 0.9) });
    p.drawText('Afis concert - tipar', { x: 180, y: 200, size: 18, font, color: rgb(0.1, 0.5, 0.2) });
    const path = join(dir, 'poster.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-convert"]');
    await page.click('[data-testid="btn-printprod"]');
    await page.waitForSelector('[data-testid="printprod-modal"]');
    // Preflight for PDF/X-4.
    await page.click('[data-testid="preflight-run"]');
    await page.waitForSelector('[data-testid="preflight-issues"]', { timeout: 20000 });
    const before = await page.$$eval('[data-testid="preflight-issue"]', (els) => els.map((e) => e.textContent));
    assert(before.some((t) => /Trim box/.test(t)) && before.some((t) => /Output intent/.test(t)), `issues before (${before.length})`);
    await page.click('[data-testid="preflight-convert"]');
    await waitSaved(/poster-pdfx4\.pdf$/);
    await idle();
    const x4 = await savedFile(/poster-pdfx4\.pdf$/);
    const xd = await PD.load(readFileSync(x4));
    assert(String(xd.catalog.lookup(PDFName.of('OutputIntents'))).includes('GTS_PDFX'), 'output intent');
    assert(xd.getPage(0).node.has(PDFName.of('TrimBox')), 'trim box');
    // Re-checked on the converted copy: only the (standard, unembeddable) fonts remain.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="preflight-issue"]').length <= 1, null, { timeout: 20000 });

    // Grey.
    await open(path);
    await page.click('[data-testid="btn-printprod"]');
    await page.waitForSelector('[data-testid="printprod-modal"]');
    await page.click('[data-testid="printprod-modal"] [role="tab"]:has-text("Colours")');
    await page.click('[data-testid="colors-gray"]');
    await waitSaved(/poster-grayscale\.pdf$/);
    await idle();
    const gray = await savedFile(/poster-grayscale\.pdf$/);
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(gray)), standardFontDataUrl: FONT_DATA, verbosity: 0 }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp, canvas: null }).promise;
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let colourful = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 6) colourful++;
    await doc.loadingTask.destroy();
    assert(colourful === 0, `no colour left (${colourful} coloured pixels)`);

    // Ink preview and marks on the original.
    await open(path);
    await page.click('[data-testid="btn-printprod"]');
    await page.waitForSelector('[data-testid="printprod-modal"]');
    await page.click('[data-testid="printprod-modal"] [role="tab"]:has-text("Output preview")');
    await page.waitForSelector('[data-testid="ink-stats"]', { timeout: 20000 });
    const stats = await page.textContent('[data-testid="ink-stats"]');
    assert(/Highest total ink\s*\d+%/.test(stats), `ink stats (${stats})`);
    const drawn = await page.$eval('[data-testid="ink-canvas"]', (cv) => cv.width > 100);
    assert(drawn, 'separation picture drawn');
    await page.click('[data-testid="printprod-modal"] [role="tab"]:has-text("Marks and bleed")');
    await page.click('[data-testid="marks-add"]');
    await waitSaved(/poster-print\.pdf$/);
    await idle();
    const marked = await PD.load(readFileSync(await savedFile(/poster-print\.pdf$/)));
    const mp = marked.getPage(0);
    const trim = mp.getTrimBox();
    const media = mp.getMediaBox();
    assert(Math.round(trim.width) === 420 && media.width > trim.width + 50 && mp.getBleedBox().width > trim.width, `boxes (trim ${trim.width}, media ${media.width})`);
    await page.keyboard.press('Escape');
  });
}
