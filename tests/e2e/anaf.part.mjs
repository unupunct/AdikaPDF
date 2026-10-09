// ANAF e-Factura dialog with a fake ANAF (no network, no browser, secrets in memory) — included by suite.mjs.
// Not yet run against a release build.
import { readFileSync } from 'node:fs';

export function registerAnafTests(test, ctx) {
  const { S, page, idle, assert, join } = ctx;

  test('ANAF: connect, check, send with status, list messages (fake ANAF)', async () => {
    const xml = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'anaf', 'ron-two-rates.xml'), 'utf8');
    await S(() => {
      let polls = 0;
      const json = (v, status = 200) => ({ status, body: JSON.stringify(v) });
      window.__adika.anaf.e2eAnaf({
        authorize: async (url) => ({ code: 'c1', state: new URL(url).searchParams.get('state') }),
        transport: async (r) => {
          if (r.url.includes('/anaf-oauth2/v1/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 7776000 });
          if (r.url.includes('/validare/')) return json({ stare: 'ok', trace_id: 'e2e' });
          if (r.url.includes('/upload?')) return { status: 200, body: '<header ExecutionStatus="0" index_incarcare="777"/>' };
          if (r.url.includes('/stareMesaj?')) return { status: 200, body: ++polls < 2 ? '<header stare="in prelucrare"/>' : '<header stare="ok" id_descarcare="888"/>' };
          if (r.url.includes('/listaMesajeFactura?')) return json({ mesaje: [{ data_creare: '202610091200', cif: '11111110', id_solicitare: '777', detalii: 'Factura trimisa', tip: 'FACTURA TRIMISA', id: '888' }] });
          return { status: 404, body: '' };
        },
      });
      window.__adika.anaf.useAnafSettings.getState().update({ clientId: 'e2e-client', redirectUri: 'http://localhost:8765/callback', test: true });
    });
    await S(() => window.__adika.anaf.saveClientSecret('e2e-secret'));
    await S((x) => window.__adika.anaf.openAnafDialog({ xml: x, number: 'TEST-2026-0001' }), xml);
    await page.waitForSelector('[data-testid="anaf-modal"]');
    await page.click('[data-testid="anaf-connect"]');
    await page.waitForSelector('[data-testid="anaf-disconnect"]', { timeout: 10000 });
    await page.click('[data-testid="anaf-validate"]');
    await page.waitForSelector('[data-testid="anaf-validation"]', { timeout: 10000 });
    const cif = await page.inputValue('[data-testid="anaf-cif"]');
    assert(cif === '11111110', `CUI from the invoice (${cif})`);
    await page.click('[data-testid="anaf-upload"]');
    await page.waitForSelector('[data-testid="anaf-current"]', { timeout: 10000 });
    // The status poll runs every 30 s; ask now instead.
    await page.click('[data-testid="anaf-current"] button:has-text("Check status")');
    await page.waitForFunction(() => document.querySelector('[data-testid="anaf-current"]')?.textContent?.includes('Accepted'), null, { timeout: 10000 });
    const log = await S(() => window.__adika.anaf.readUploads());
    assert(log.some((u) => u.index === '777' && u.test && u.state === 'ok'), `upload log (${JSON.stringify(log)})`);
    await page.click('[role="tab"]:has-text("Messages")');
    await page.click('[data-testid="anaf-list"]');
    await page.waitForSelector('[data-testid="anaf-messages"]', { timeout: 10000 });
    await page.keyboard.press('Escape');
    await idle();
    await S(() => window.__adika.anaf.e2eAnaf(null));
  });
}
