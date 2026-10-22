// Simple ribbon, collapsing groups and the first-run welcome — included by suite.mjs.
// Round 16: not run yet (needs an exe built with the simple ribbon). The suite
// itself runs in the full ribbon (E2E mode sets it, without collapsing); these
// tests switch to the simple ribbon and back.

export function registerSimpleRibbonTests(test, ctx) {
  const { S, page, open, assert, F } = ctx;
  const ui = (fn) => S(fn);

  test('simple ribbon: common commands, a full-only command from the tool search, back to full', async () => {
    await open(F.sample);
    await ui(() => window.__adika.uiMode.getState().setMode('simple'));
    await page.waitForSelector('[data-ribbon-mode="simple"] [data-testid="ribbon"]');
    assert((await page.$$('[role="tab"][data-testid^="tab-"]')).length === 0, 'no ribbon tabs in simple mode');
    // A simple command: Organize opens the page organizer.
    await page.click('[data-testid="simple-organize"]');
    await page.waitForSelector('[data-testid="organizer-modal"]');
    await page.keyboard.press('Escape');
    // A command of the full ribbon only (Watermark): its tab is shown with a way back.
    await page.keyboard.press('Control+K');
    await page.fill('[data-testid="palette-input"]', 'watermark');
    await page.waitForSelector('[data-testid="palette-item"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="ribbon-back-simple"]', { timeout: 5000 });
    const modal = await ui(() => window.__adika.store.getState().modal);
    assert(modal === 'pageMarks', `watermark dialog opened (${modal})`);
    await page.keyboard.press('Escape');
    await page.click('[data-testid="ribbon-back-simple"]');
    await page.waitForSelector('[data-ribbon-mode="simple"]');
    // More tools: the full ribbon, remembered.
    await page.click('[data-testid="simple-more-tools"]');
    await page.waitForSelector('[data-testid="tab-home"]');
    const stored = await ui(() => localStorage.getItem('adika.ribbonMode'));
    assert(stored === 'full', `mode stored (${stored})`);
  });

  test('ribbon: every tab fits a 1280 px window', async () => {
    const widths = await ui(async () => {
      const out = {};
      for (const t of ['home', 'view', 'edit', 'comment', 'sign', 'organize', 'forms', 'security', 'convert']) {
        window.__adika.store.getState().setRibbonTab(t);
        await new Promise((r) => setTimeout(r, 200));
        const r = document.querySelector('[data-testid="ribbon"]');
        out[t] = [...r.querySelectorAll(':scope > [data-ribbon-group]')].reduce((a, g) => a + g.getBoundingClientRect().width, 0);
      }
      return out;
    });
    const wide = Object.entries(widths).filter(([, w]) => w > 1268);
    assert(wide.length === 0, `tabs wider than a 1280 px window: ${JSON.stringify(wide)}`);
  });

  test('welcome: Help → Welcome screen opens it; a card starts its task', async () => {
    await S(() => window.__adika.store.getState().openModal(null));
    await page.click('[data-testid="help-open"]');
    await page.waitForSelector('[data-testid="help-welcome"]');
    await page.click('[data-testid="help-welcome"]');
    await page.waitForSelector('[data-testid="first-run"]');
    await page.click('[data-testid="first-run-convert"]');
    await page.waitForSelector('[data-testid="first-run"]', { state: 'detached' });
    const modal = await ui(() => window.__adika.store.getState().modal);
    assert(modal === 'tools', `Tools window (${modal})`);
    await page.keyboard.press('Escape');
    const stored = await ui(() => localStorage.getItem('adika.welcome'));
    assert(stored === 'hide', `welcome closed for good (${stored})`);
  });
}
