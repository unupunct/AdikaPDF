// Detect form fields and Batch processing — included by suite.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { PDFDocument as PD, StandardFonts, rgb } from 'pdf-lib';

export function registerBatchFormTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync } = ctx;

  test('detect fields: a flat form becomes fillable, fields named after their labels', async () => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    const line = (x0, x1, y) => p.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.8, color: rgb(0, 0, 0) });
    p.drawText('Registration', { x: 60, y: 780, size: 16, font });
    p.drawText('Full name:', { x: 60, y: 730, size: 11, font });
    line(125, 420, 728);
    p.drawText('Date of birth:', { x: 60, y: 700, size: 11, font });
    line(140, 260, 698);
    p.drawRectangle({ x: 60, y: 658, width: 10, height: 10, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    p.drawText('I agree to the terms', { x: 76, y: 660, size: 11, font });
    for (let r = 0; r <= 2; r++) line(60, 420, 600 - r * 24);
    for (const x of [60, 180, 420]) p.drawLine({ start: { x, y: 600 }, end: { x, y: 552 }, thickness: 0.8, color: rgb(0, 0, 0) });
    p.drawText('City', { x: 66, y: 583, size: 11, font });
    p.drawText('Phone', { x: 66, y: 559, size: 11, font });
    const path = join(dir, 'flat-form.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-forms"]');
    await page.click('[data-testid="btn-detect-fields"]');
    await page.waitForFunction(() => window.__adika.store.getState().objects.filter((o) => o.type === 'field').length >= 5, null, { timeout: 30000 });
    const fields = await S(() => window.__adika.store.getState().objects.filter((o) => o.type === 'field').map((o) => `${o.fieldKind}:${o.name}`));
    for (const want of ['text:Full name', 'text:Date of birth', 'checkbox:I agree to the terms', 'text:City', 'text:Phone']) assert(fields.includes(want), `${want} detected (${fields.join(', ')})`);
    assert(fields.length === 5, `nothing else detected (${fields.length})`);
    // Saved as a real AcroForm.
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const saved = await PD.load(readFileSync(await savedFile(/flat-form\.pdf$/)));
    const names = saved.getForm().getFields().map((f) => f.getName());
    assert(['Full name', 'Date of birth', 'I agree to the terms', 'City', 'Phone'].every((n) => names.includes(n)), `form fields saved (${names.join(', ')})`);
    // Running it again adds nothing (fields already there).
    await page.click('[data-testid="btn-detect-fields"]');
    await page.waitForFunction(() => window.__adika.store.getState().toasts.some((t) => /No form fields found/.test(t.message)), null, { timeout: 30000 });
  });

  test('batch: watermark several files at once, results next to the originals, bad files reported', async () => {
    const paths = [];
    for (const n of ['raport-a', 'raport-b']) {
      const d = await PD.create();
      const font = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([595, 842]).drawText(`Document ${n}`, { x: 60, y: 760, size: 14, font });
      const path = join(dir, `${n}.pdf`);
      writeFileSync(path, await d.save());
      paths.push(path);
    }
    const broken = join(dir, 'not-a-pdf.pdf');
    writeFileSync(broken, 'this is not a PDF');
    paths.push(broken);
    await S(() => window.__adika.store.getState().openModal('batch'));
    await page.waitForSelector('[data-testid="batch-modal"]');
    await S((p) => window.__adika.platform.e2eQueuePicks(p), paths.map((p) => p.split('\\').join('/')));
    await page.click('[data-testid="batch-add"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-files"] li').length === 3);
    await page.click('[data-testid="batch-op-watermark"]');
    await page.fill('[data-testid="batch-watermark"]', 'CIORNĂ');
    await page.click('[data-testid="batch-run"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-result"]').length === 3, null, { timeout: 60000 });
    const rows = await page.$$eval('[data-testid="batch-result"]', (r) => r.map((x) => x.textContent));
    assert(rows.filter((r) => r.includes('-watermarked.pdf')).length === 2, `two files done (${rows.join(' | ')})`);
    for (const n of ['raport-a', 'raport-b']) {
      const out = join(dir, `${n}-watermarked.pdf`);
      assert(existsSync(out), `${n}-watermarked.pdf written next to the original`);
      const [t] = await pdfText(out);
      assert(t.includes('CIORNĂ') && t.includes(`Document ${n}`), `watermark and content in ${n} (${t})`);
    }
    assert(!rows[2].includes('.pdf') || /fail|parse|invalid|No PDF|header/i.test(rows[2]), `broken file reported (${rows[2]})`);
    // A second run never overwrites: "(2)".
    await page.click('[data-testid="batch-run"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="batch-result"]')].some((x) => x.textContent.includes('(2)')), null, { timeout: 60000 });
    assert(existsSync(join(dir, 'raport-a-watermarked (2).pdf')), 'second run saved as (2)');
    await page.keyboard.press('Escape');
  });
}
