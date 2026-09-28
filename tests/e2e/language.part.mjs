// Romanian interface — included by suite.mjs.
export function registerLanguageTests(test, ctx) {
  const { S, page, open, assert, F } = ctx;
  const text = (sel) => page.textContent(sel);

  test('language: the whole interface switches to Romanian and back; document content is left alone', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-home"]');
    await page.click('[data-testid="lang-toggle"]');
    await page.waitForFunction(() => document.documentElement.lang === 'ro');
    // Ribbon tabs, buttons and tooltips.
    const tabs = await page.$$eval('[data-testid^="tab-"]', (els) => els.map((e) => e.textContent.trim()));
    assert(tabs.includes('Pornire') && tabs.includes('Comentariu') && tabs.includes('Securitate'), `ribbon tabs in Romanian (${tabs.join(', ')})`);
    await page.click('[data-testid="tab-security"]');
    const sec = await text('[data-testid="btn-find-redact"]');
    assert(/anonimizare/i.test(sec) || /Căutare/i.test(sec), `Find & redact button (${sec})`);
    const status = await text('[data-testid="status-page"]');
    assert(/Pagina 1 din 3/.test(status), `status bar (${status})`);
    // The document's own text and the file name are not translated.
    const tab = await text('[data-testid="doc-tab"]');
    assert(tab.includes('sample.pdf'), `file name untouched (${tab})`);
    const pageText = await page.$$eval('[data-testid="page-1"] .textLayer span', (s) => s.map((x) => x.textContent).join(' '));
    assert(pageText.includes('The quick brown fox'), 'PDF text layer untouched');
    // Dialogs and messages rendered later are translated too.
    await S(() => window.__adika.store.getState().openModal('batch'));
    await page.waitForSelector('[data-testid="batch-modal"]');
    const dlg = await text('[data-testid="batch-modal"]');
    assert(/Procesare în lot/.test(dlg) && /Adăugare filigran text/.test(dlg), `batch dialog in Romanian (${dlg.slice(0, 120)})`);
    await page.keyboard.press('Escape');
    // How much English is left on screen (ribbon of every tab)?
    const leftovers = new Set();
    for (const id of ['home', 'view', 'edit', 'comment', 'sign', 'organize', 'forms', 'security', 'convert']) {
      await page.click(`[data-testid="tab-${id}"]`);
      const words = await page.$$eval('header, [role="tablist"], [data-testid="ribbon"], footer', (roots) =>
        roots.flatMap((r) => r.innerText.split(/\n/)).map((s) => s.trim()).filter(Boolean),
      );
      for (const w of words) if (/\b(the|and|with|File|Save|Open|Page|Add|Remove|Edit|Text|Tools|Print|Document|Sign|Form)\b/.test(w) && !/sample\.pdf|PDF\b|Adika/.test(w)) leftovers.add(w);
    }
    console.log(`      English left in ribbon/status: ${leftovers.size ? [...leftovers].slice(0, 15).join(' | ') : 'none'}`);
    assert(leftovers.size <= 3, `ribbon fully translated (${[...leftovers].join(' | ')})`);
    // Back to English.
    await page.click('[data-testid="lang-toggle"]');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    const tabsEn = await page.$$eval('[data-testid^="tab-"]', (els) => els.map((e) => e.textContent.trim()));
    assert(tabsEn.includes('Home') && tabsEn.includes('Security'), `back to English (${tabsEn.join(', ')})`);
    const statusEn = await text('[data-testid="status-page"]');
    assert(/Page 1 of 3/.test(statusEn), `status bar back in English (${statusEn})`);
  });
}
