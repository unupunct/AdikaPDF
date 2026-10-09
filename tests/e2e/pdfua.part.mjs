// PDF/UA check, safe fixes, report and Reading order — included by suite.mjs.
// NOTE: written in round 14 without running it (no build in that worker); run it with the suite.
import { PDFDocument as PD, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';

export function registerPdfUaTests(test, ctx) {
  const { page, dir, open, idle, savedFile, assert, join, writeFileSync } = ctx;

  test('PDF/UA: the panel groups failures by checkpoint, "Fix all safe issues" fixes them, the report saves', async () => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    p.drawText('Heading', { x: 60, y: 760, size: 24, font });
    p.drawText('Body text of the page.', { x: 60, y: 720, size: 11, font });
    p.drawText('1', { x: 290, y: 30, size: 9, font });
    const path = join(dir, 'pdfua.pdf');
    writeFileSync(path, await d.save());

    await open(path);
    await page.click('[data-testid="tab-security"]');
    await page.click('[data-testid="btn-pdfua"]');
    await page.waitForSelector('[data-testid="pdfua-summary"]', { timeout: 30000 });
    const groups = await page.$$eval('[data-testid="pdfua-group"]', (els) => els.map((e) => e.getAttribute('data-checkpoint')));
    for (const cp of ['01', '06', '07', '11']) assert(groups.includes(cp), `checkpoint ${cp} fails before (${groups})`);
    // An issue on a page highlights it.
    await page.click('[data-testid="pdfua-group"][data-checkpoint="01"] button');
    await page.click('[data-testid="pdfua-fix-safe"]');
    await idle();
    await page.waitForFunction(() => {
      const g = [...document.querySelectorAll('[data-testid="pdfua-group"]')].map((e) => e.getAttribute('data-checkpoint'));
      return !g.includes('06') && !g.includes('07') && !g.includes('01');
    }, null, { timeout: 30000 });
    // Only the unembedded standard font remains (needs a person / PDF/A conversion).
    const left = await page.$$eval('[data-testid="pdfua-group"]', (els) => els.map((e) => e.getAttribute('data-checkpoint')));
    assert(left.join(',') === '31', `left after fixing: ${left}`);

    await page.click('[data-testid="pdfua-save-pdf"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /pdfua-pdfua\.pdf$/.test(f)), null, { timeout: 30000 });
    const report = await savedFile(/pdfua-pdfua\.pdf$/);
    const rep = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(report)), verbosity: 0 }).promise;
    const text = (await (await rep.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
    assert(/PDF\/UA/.test(text) && /31-009/.test(text), 'report lists the remaining failure');
    await rep.loadingTask.destroy();
  });

  test('Reading order: numbered boxes, retag the selection, Tags panel follows, undo', async () => {
    await page.click('[data-testid="btn-reading-order"]');
    await page.waitForSelector('[data-testid="ro-item"]', { timeout: 20000 });
    const before = await page.$$eval('[data-testid="ro-item"]', (els) => els.map((e) => `${e.getAttribute('data-order')}:${e.getAttribute('data-type')}`));
    assert(before.length >= 2 && before[0].startsWith('1:'), `boxes (${before})`);
    const box = await page.$('[data-testid="ro-item"][data-order="1"]');
    await box.click();
    await page.click('[data-testid="ro-type-H1"]');
    await idle();
    await page.waitForSelector('[data-testid="ro-item"][data-order="1"][data-type="H1"]', { timeout: 20000 });
    await page.click('[data-testid="sidebar-tags"]');
    await page.waitForSelector('[data-testid="tag-row"][data-tag="H1"]', { timeout: 20000 });
    await page.keyboard.press('Control+z');
    await idle();
    await page.click('[data-testid="ro-close"]');
    assert(!(await page.$('[data-testid="reading-order-layer"]')), 'layer closed');
  });
}
