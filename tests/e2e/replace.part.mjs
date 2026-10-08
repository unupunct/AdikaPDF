// Find & replace, Find & redact, and the update notice — included by suite.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { PDFDocument as PD, PDFName, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export function registerReplaceTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, F } = ctx;
  const flat = (s) => s.replace(/\s+/g, ' ');

  test('find & replace: every occurrence is rewritten in the page text, the line closes up, undo restores', async () => {
    await open(F.sample);
    const before = await S(() => window.__adika.store.getState().pages.map((p) => p.sourceId));
    await page.keyboard.press('Control+h');
    await page.waitForSelector('[data-testid="replace-input"]');
    await page.fill('[data-testid="search-input"]', 'quick brown');
    await page.fill('[data-testid="replace-input"]', 'slow red');
    await page.click('[data-testid="replace-all"]');
    await page.waitForFunction(() => window.__adika.store.getState().toasts.some((t) => /Replaced 3 occurrences/.test(t.message)), null, { timeout: 30000 });
    await idle();
    const after = await S(() => window.__adika.store.getState().pages.map((p) => p.sourceId));
    assert(after.every((id, i) => id !== before[i]), 'pages now show the rewritten document');
    // The new text is real page text right away (search finds it).
    const hits = await S(async () => {
      const s = window.__adika.store.getState();
      return (await window.__adika.search.searchDocument(s.pages, 'slow red', { cancelled: false })).length;
    });
    assert(hits === 3, `search finds the new text on all 3 pages (${hits})`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const text = await pdfText(await savedFile(/sample\.pdf$/));
    for (let i = 0; i < 3; i++) {
      assert(!/quick|brown/.test(text[i]), `page ${i + 1}: old words gone`);
      assert(/The\s*slow red\s*fox jumps over the lazy dog\./.test(flat(text[i])), `page ${i + 1}: "${flat(text[i]).slice(0, 90)}"`);
    }
    await page.keyboard.press('Control+z');
    const undone = await S(() => window.__adika.store.getState().pages.map((p) => p.sourceId));
    assert(undone.every((id, i) => id === before[i]), 'undo switches back to the original');
  });

  test('find & redact: e-mail, IBAN, phone and a chosen name are removed, amounts and the rest stay text', async () => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    p.drawText('Contract 17/2026 total 1111.50 EUR', { x: 60, y: 760, size: 12, font });
    p.drawText('Client: Ion Popescu, e-mail ion.popescu@firma.ro', { x: 60, y: 730, size: 12, font });
    p.drawText('IBAN RO49 AAAA 1B31 0075 9384 0000, tel. +40 722 123 456', { x: 60, y: 700, size: 12, font });
    const path = join(dir, 'sensitive.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-security"]');
    await page.click('[data-testid="btn-find-redact"]');
    await page.waitForSelector('[data-testid="find-redact-modal"]');
    await page.fill('[data-testid="find-redact-terms"]', 'Popescu');
    await page.click('[data-testid="find-redact-search"]');
    await page.waitForSelector('[data-testid="find-redact-results"]', { timeout: 15000 });
    const rows = await page.$$eval('[data-testid="find-redact-results"] tr', (r) => r.map((x) => x.textContent));
    const all = rows.join(' | ');
    for (const want of ['ion.popescu@firma.ro', 'RO49 AAAA 1B31 0075 9384 0000', '+40 722 123 456', 'Popescu']) assert(all.includes(want), `found ${want} (${all})`);
    assert(!all.includes('1111.50') && !all.includes('17/2026'), 'amount and contract number not marked');
    await page.click('[data-testid="find-redact-mark"]');
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'redact'), null, { timeout: 5000 });
    const marks = await S(() => window.__adika.store.getState().objects.filter((o) => o.type === 'redact').length);
    assert(marks >= 4, `redaction boxes marked (${marks})`);
    await page.click('[data-testid="btn-apply-redactions"]');
    await idle();
    const [text] = await pdfText(await savedFile(/sensitive\.pdf$/));
    for (const gone of ['Popescu', 'firma', 'RO49', '9384', '722']) assert(!text.includes(gone), `"${gone}" removed (${text})`);
    assert(/Contract 17\/2026 total 1111\.50 EUR/.test(flat(text)), 'the rest of the page is still real text (not a picture)');
    assert(text.includes('Client:') && text.includes('IBAN'), 'labels kept');
  });

  // Round 13, not yet run against a release build.
  test('find & replace: a letter missing from the subset font is drawn in the installed typeface, the rest stays in the document font', async () => {
    const arialPath = 'C:\\Windows\\Fonts\\arial.ttf';
    if (!existsSync(arialPath)) return;
    const d = await PD.create();
    d.registerFontkit(fontkit);
    // A subset of Arial with only the letters drawn: no Ș.
    const font = await d.embedFont(readFileSync(arialPath), { subset: true });
    d.addPage([595, 842]).drawText('Semnat de Stefan Ionescu, Bucuresti', { x: 60, y: 760, size: 12, font });
    const path = join(dir, 'subset-font.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.keyboard.press('Control+h');
    await page.waitForSelector('[data-testid="replace-input"]');
    await page.fill('[data-testid="search-input"]', 'Stefan');
    await page.fill('[data-testid="replace-input"]', 'Ștefan');
    await page.click('[data-testid="replace-all"]');
    await page.waitForFunction(() => window.__adika.store.getState().toasts.some((t) => /“Ș” was drawn in Arial \(installed in Windows\)/.test(t.message)), null, { timeout: 30000 });
    await idle();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const saved = await savedFile(/subset-font\.pdf$/);
    // Read as pdf.js copies text: its pieces joined as they are (pdf.js adds spaces itself where there is a gap).
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), verbosity: 0 }).promise;
    const items = (await (await pdf.getPage(1)).getTextContent()).items;
    const text = items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('');
    await pdf.loadingTask.destroy();
    assert(/Semnat de Ștefan Ionescu, Bucuresti/.test(flat(text)), `new text reads back exactly (${flat(text)})`);
    const out = await PD.load(readFileSync(saved));
    const fonts = out.getPage(0).node.Resources().lookup(PDFName.of('Font'));
    assert(fonts.keys().length === 2, 'the document font plus one fallback font for Ș');
  });

  test('updates: About shows the real version; a newer release shows a notice that can be dismissed', async () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    await S(() => window.__adika.store.getState().openModal('about'));
    await page.waitForSelector('[data-testid="update-info"]');
    const about = await page.textContent('[role="dialog"]');
    assert(about.includes(`Version ${pkg.version}`), `About shows ${pkg.version}`);
    await page.keyboard.press('Escape');
    // No signed feed (an older release): the GitHub release check is the fallback. Nothing goes to the network here.
    await S(() => window.__adika.updates.checkForUpdates(async () => ({ tag_name: 'v99.0.0', html_url: 'https://github.com/unupunct/AdikaPDF/releases/tag/v99.0.0' }), async () => undefined));
    await page.waitForSelector('[data-testid="status-update"]', { timeout: 3000 });
    const chip = await page.textContent('[data-testid="status-update"]');
    assert(chip.includes('Update 99.0.0 available'), `status bar notice (${chip})`);
    await page.click('[data-testid="status-update"] button[aria-label="Dismiss"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="status-update"]'), null, { timeout: 3000 });
    // The signed feed offers a newer version: installable from the update dialog.
    const installable = await S(async () => {
      const u = window.__adika.updates;
      u.useUpdates.setState({ status: 'idle', latest: null });
      const feed = { version: '99.0.1', notes: 'Notes', date: '2030-01-01', downloadAndInstall: async () => {} };
      const rel = await u.checkForUpdates(async () => { throw new Error('GitHub should not be asked'); }, async () => feed);
      return { version: rel?.version, installable: u.useUpdates.getState().installable };
    });
    assert(installable.version === '99.0.1' && installable.installable, `signed feed update (${JSON.stringify(installable)})`);
  });
}
