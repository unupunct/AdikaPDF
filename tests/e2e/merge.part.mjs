// Mail merge and action sequences — included by suite.mjs.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { PDFDocument as PD, StandardFonts } from 'pdf-lib';

export function registerMergeTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync } = ctx;
  const slash = (p) => p.split('\\').join('/');

  test('mail merge: a form filled once per CSV row, one PDF per row in a folder, then one combined PDF', async () => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    p.drawText('Adeverinta de angajare', { x: 60, y: 780, size: 16, font });
    const form = d.getForm();
    form.createTextField('Nume').addToPage(p, { x: 60, y: 700, width: 260, height: 22 });
    form.createTextField('Functie').addToPage(p, { x: 60, y: 660, width: 260, height: 22 });
    form.createCheckBox('Norma_intreaga').addToPage(p, { x: 60, y: 620, width: 14, height: 14 });
    const tpl = join(dir, 'adeverinta.pdf');
    writeFileSync(tpl, await d.save());
    const csv = join(dir, 'angajati.csv');
    writeFileSync(csv, '\uFEFFNume;Funcție;Normă întreagă\r\nȘtefan Țurcanu;Inginer;da\r\nIoana Mureșan;Contabil;nu\r\nAna Pop;Jurist;da\r\n');
    const folder = join(dir, 'merge-out');
    mkdirSync(folder);

    await open(tpl);
    await page.click('[data-testid="tab-forms"]');
    await page.click('[data-testid="btn-mailmerge"]');
    await page.waitForSelector('[data-testid="mailmerge-modal"]');
    await S((c) => window.__adika.platform.e2eQueuePicks([c]), slash(csv));
    await page.click('[data-testid="mailmerge-pick"]');
    await page.waitForSelector('[data-testid="mailmerge-summary"]');
    const summary = await page.textContent('[data-testid="mailmerge-summary"]');
    assert(/3 rows · 3 of 3 fields matched/.test(summary), `columns matched to fields (${summary})`);
    await page.fill('[data-testid="mailmerge-pattern"]', 'Adeverinta {Nume}');
    const first = await page.textContent('[data-testid="mailmerge-first-name"]');
    assert(first === 'Adeverinta Ștefan Țurcanu.pdf', `first file name (${first})`);
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), folder);
    await page.click('[data-testid="mailmerge-run"]');
    await page.waitForSelector('[data-testid="mailmerge-modal"]', { state: 'detached', timeout: 60000 });
    for (const [name, role, full] of [
      ['Ștefan Țurcanu', 'Inginer', true],
      ['Ioana Mureșan', 'Contabil', false],
      ['Ana Pop', 'Jurist', true],
    ]) {
      const out = join(folder, `Adeverinta ${name}.pdf`);
      assert(existsSync(out), `${out} written`);
      const f = (await PD.load(readFileSync(out))).getForm();
      assert(f.getTextField('Nume').getText() === name && f.getTextField('Functie').getText() === role, `${name}: fields filled`);
      assert(f.getCheckBox('Norma_intreaga').isChecked() === full, `${name}: checkbox`);
    }

    // All rows in one (flattened) PDF.
    await page.click('[data-testid="btn-mailmerge"]');
    await page.waitForSelector('[data-testid="mailmerge-modal"]');
    await S((c) => window.__adika.platform.e2eQueuePicks([c]), slash(csv));
    await page.click('[data-testid="mailmerge-pick"]');
    await page.waitForSelector('[data-testid="mailmerge-summary"]');
    await page.selectOption('[data-testid="mailmerge-modal"] select[aria-label="Output"]', 'combined');
    await page.click('[data-testid="mailmerge-run"]');
    await page.waitForSelector('[data-testid="mailmerge-modal"]', { state: 'detached', timeout: 60000 });
    await idle();
    const merged = await savedFile(/adeverinta-merged\.pdf$/);
    const texts = await pdfText(merged);
    assert(texts.length === 3 && texts[0].includes('Ștefan Țurcanu') && texts[1].includes('Ioana Mureșan') && texts[2].includes('Jurist'), `combined PDF (${texts.map((t) => t.slice(0, 60)).join(' | ')})`);
  });

  test('action sequence: watermark then page numbers on several files, saved and reused', async () => {
    await S(() => localStorage.removeItem('adika.actionSequences'));
    const paths = [];
    for (const n of ['scan-1', 'scan-2']) {
      const d = await PD.create();
      const font = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 2; i++) d.addPage([595, 842]).drawText(`${n} page ${i}`, { x: 60, y: 760, size: 14, font });
      const path = join(dir, `${n}.pdf`);
      writeFileSync(path, await d.save());
      paths.push(path);
    }
    await S(() => window.__adika.store.getState().openModal('batch'));
    await page.waitForSelector('[data-testid="batch-modal"]');
    await S((p) => window.__adika.platform.e2eQueuePicks(p), paths.map(slash));
    await page.click('[data-testid="batch-add"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-files"] li').length === 2);
    await page.click('[data-testid="batch-modal"] [role="tab"]:has-text("Action sequence")');
    await page.waitForSelector('[data-testid="sequence-editor"]');
    // Default steps: OCR, compress. Make them watermark, page numbers.
    await page.selectOption('[data-testid="batch-modal"] select[aria-label="Step 1"]', 'watermark');
    await page.fill('[data-testid="seq-0-watermark"]', 'ARHIVAT');
    await page.selectOption('[data-testid="batch-modal"] select[aria-label="Step 2"]', 'pageNumbers');
    await page.fill('[data-testid="seq-1-pagenumbers"]', 'Pagina {page} din {pages}');
    // A protect step before the others is refused.
    await page.click('[data-testid="seq-add-step"]');
    await page.selectOption('[data-testid="batch-modal"] select[aria-label="Step 3"]', 'protect');
    await page.click('[data-testid="batch-modal"] [data-testid="seq-step"]:nth-child(3) button[aria-label="Move up"]');
    const problem = await page.textContent('[data-testid="seq-problem"]');
    assert(/must be the last step/.test(problem), `order checked (${problem})`);
    await page.click('[data-testid="batch-modal"] [data-testid="seq-step"]:nth-child(2) button[aria-label="Remove step"]');
    assert((await page.$$('[data-testid="seq-step"]')).length === 2, 'protect step removed');
    await page.fill('[data-testid="seq-name"]', 'Arhivă test');
    await page.click('[data-testid="seq-save"]');
    await page.waitForFunction(() => localStorage.getItem('adika.actionSequences'), null, { timeout: 5000 });
    const saved = await S(() => JSON.parse(localStorage.getItem('adika.actionSequences')));
    assert(saved.length === 1 && saved[0].name === 'Arhivă test' && saved[0].steps.map((s) => s.kind).join() === 'watermark,pageNumbers', `sequence saved (${JSON.stringify(saved)})`);
    await page.click('[data-testid="batch-run"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-result"]').length === 2, null, { timeout: 60000 });
    for (const n of ['scan-1', 'scan-2']) {
      const out = join(dir, `${n}-arhiva-test.pdf`);
      assert(existsSync(out), `${n}-arhiva-test.pdf written`);
      const t = await pdfText(out);
      assert(t[1].includes('ARHIVAT') && t[1].includes('Pagina 2 din 2') && t[1].includes(`${n} page 2`), `steps applied in ${n} (${t[1]})`);
    }
    await page.keyboard.press('Escape');
    // Reopened, the saved sequence can be picked again.
    await S(() => window.__adika.store.getState().openModal('batch'));
    await page.click('[data-testid="batch-modal"] [role="tab"]:has-text("Action sequence")');
    const options = await page.$$eval('[data-testid="batch-modal"] select[aria-label="Saved sequence"] option', (o) => o.map((x) => x.textContent));
    assert(options.includes('Arhivă test'), `saved sequence listed (${options})`);
    await page.keyboard.press('Escape');
  });
}
