// Tool search and split view — included by suite.mjs.
export function registerViewToolTests(test, ctx) {
  const { S, page, open, assert, F } = ctx;

  test('tool search: Ctrl+K finds commands in English and Romanian and runs them', async () => {
    await open(F.sample);
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-testid="palette-input"]');
    await page.fill('[data-testid="palette-input"]', 'compress');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="palette-item"]').length > 0, null, { timeout: 5000 });
    const first = await page.textContent('[data-testid="palette-item"]');
    assert(/^Compress/.test(first), `first result (${first})`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__adika.store.getState().modal === 'compress', null, { timeout: 5000 });
    await page.keyboard.press('Escape');
    // In Romanian: by the Romanian name and by the English one.
    await S(() => window.__adika.i18n.useLang.getState().setLang('ro'));
    for (const q of ['filigran', 'watermark']) {
      await page.click('[data-testid="palette-open"]');
      await page.waitForSelector('[data-testid="palette-input"]');
      await page.fill('[data-testid="palette-input"]', q);
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="palette-item"]').length > 0, null, { timeout: 5000 });
      const items = await page.$$eval('[data-testid="palette-item"]', (els) => els.map((e) => e.textContent));
      assert(items.some((t) => /^Filigran/.test(t)), `"${q}" finds Filigran (${items.slice(0, 3).join(' | ')})`);
      await page.keyboard.press('Escape');
    }
    await S(() => window.__adika.i18n.useLang.getState().setLang('en'));
  });

  test('split view: a second pane with its own scrolling, following the main view or another tab', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-view"]');
    await page.click('[data-testid="btn-split-view"]');
    await page.waitForSelector('[data-testid="split-view"]');
    const n = await page.$$eval('[data-testid^="split-page-"]', (e) => e.length);
    assert(n === 3, `3 pages in the split pane (${n})`);
    // Its pages are rendered.
    await page.waitForFunction(() => {
      const c = document.querySelector('[data-testid="split-page-1"] canvas');
      return c && c.width > 0;
    }, null, { timeout: 10000 });
    // Follow: the pane scrolls to the main view's page.
    await page.click('[data-testid="split-view"] label');
    await S(() => {
      const s = window.__adika.store.getState();
      s.setCurrentPage(s.pages[2].id);
    });
    await page.waitForFunction(() => {
      const pane = document.querySelector('[data-testid="split-scroll"]');
      const p3 = document.querySelector('[data-testid="split-page-3"]');
      // The last page can only scroll as far as the end of the pane.
      return pane && p3 && Math.abs(pane.scrollTop - Math.min(p3.offsetTop - 12, pane.scrollHeight - pane.clientHeight)) < 30 && pane.scrollTop > 100;
    }, null, { timeout: 5000 });
    // Another open document (a second tab) in the pane.
    const firstName = await S(() => window.__adika.store.getState().fileName);
    await S((p) => window.__adika.document.openPdfPath(p), F.second);
    await page.waitForFunction(() => window.__adika.tabs.useTabs.getState().tabs.length === 2, null, { timeout: 15000 });
    await page.waitForSelector('[data-testid="split-view"]');
    await page.selectOption('select[aria-label="Document in the split pane"]', { index: 1 });
    const other = await page.$$eval('[data-testid^="split-page-"]', (e) => e.length);
    const label = await page.$eval('select[aria-label="Document in the split pane"]', (el) => el.options[el.selectedIndex].text);
    assert(label === firstName, `pane shows the other tab (${label})`);
    assert(other === 3, `the other tab's pages (${other})`);
    await page.click('[data-testid="split-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="split-view"]'));
  });
}
