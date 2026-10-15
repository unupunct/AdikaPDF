// Help viewer: F1, search, links between pages, context help from a signing dialog — included by suite.mjs.
// Round 15: not run yet (needs an exe built with the help viewer).

export function registerHelpTests(test, ctx) {
  const { S, page, open, assert, F } = ctx;
  const shown = () => page.getAttribute('[data-testid="help-article"]', 'data-page');

  test('help: F1 opens the guide, search finds SPV, links navigate, Back returns', async () => {
    await S(() => window.__adika.store.getState().openModal(null));
    await page.keyboard.press('F1');
    await page.waitForSelector('[data-testid="help-viewer"] [data-testid="help-article"]', { timeout: 10000 });
    assert((await shown()) === 'index', `start page (${await shown()})`);
    // The pictures are bundled: they load without a network.
    const pictures = await S(async () => {
      document.querySelector('[data-testid="help-page-efactura-read"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const imgs = [...document.querySelectorAll('[data-testid="help-article"] img')];
      await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => i.addEventListener('load', r, { once: true })))));
      return imgs.map((i) => i.naturalWidth);
    });
    assert(pictures.length > 0 && pictures.every((w) => w > 100), `pictures loaded (${pictures})`);
    await page.fill('[data-testid="help-search"]', 'SPV');
    await page.waitForSelector('[data-testid="help-result"]', { timeout: 5000 });
    const hits = await page.$$eval('[data-testid="help-result"]', (els) => els.map((e) => e.textContent));
    assert(hits.some((h) => /ANAF/.test(h)), `search results (${hits.slice(0, 3).join(' | ')})`);
    await page.click('[data-testid="help-result"]:has-text("Send invoices to ANAF")');
    await page.waitForFunction(() => document.querySelector('[data-testid="help-article"]')?.dataset.page === 'efactura-anaf-send');
    await page.fill('[data-testid="help-search"]', '');
    await page.click('[data-testid="help-article"] a[href="efactura-anaf-check.md"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="help-article"]')?.dataset.page === 'efactura-anaf-check');
    await page.click('[data-testid="help-back"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="help-article"]')?.dataset.page === 'efactura-anaf-send');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="help-viewer"]', { state: 'detached' });
  });

  test("help: the signing dialog's ? opens the signing page; closing returns to the dialog", async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-cert-sign"]');
    await page.waitForSelector('[data-testid="certificate-modal"]');
    await page.click('[data-testid="certificate-modal"] [data-testid="dialog-help"]');
    await page.waitForSelector('[data-testid="help-viewer"] [data-testid="help-article"]');
    assert((await shown()) === 'signing-sign', `signing page (${await shown()})`);
    const heading = await S(() => {
      const a = document.querySelector('[data-testid="help-article"]');
      const target = a.querySelector('#sign-with-a-certificate-file-pfx-or-p12');
      const box = target.getBoundingClientRect();
      const scroller = a.parentElement.getBoundingClientRect();
      return box.top >= scroller.top - 2 && box.top < scroller.bottom;
    });
    assert(heading, 'scrolled to the certificate-file heading');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="help-viewer"]', { state: 'detached' });
    assert(await page.isVisible('[data-testid="certificate-modal"]'), 'the signing dialog stays open');
    // F1 inside the dialog does the same.
    await page.keyboard.press('F1');
    await page.waitForSelector('[data-testid="help-viewer"] [data-testid="help-article"]');
    assert((await shown()) === 'signing-sign', `F1 in the dialog (${await shown()})`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  test('help: Romanian interface shows the Romanian guide', async () => {
    await S(() => window.__adika.i18n.useLang.getState().setLang('ro'));
    await page.click('[data-testid="help-open"]');
    await page.waitForSelector('[data-testid="help-article"]');
    const title = await page.textContent('[data-testid="help-article"] h1');
    assert(/Ghidul utilizatorului/.test(title ?? ''), `Romanian title (${title})`);
    await page.fill('[data-testid="help-search"]', 'semnatura calificata');
    await page.waitForSelector('[data-testid="help-result"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await S(() => window.__adika.i18n.useLang.getState().setLang('en'));
  });
}
