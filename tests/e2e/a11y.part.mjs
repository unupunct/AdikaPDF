// Accessibility (axe-core in the running app) — included by suite.mjs.
// Reports every violation by rule (with colour contrast, which needs real layout); fails on critical ones.
import { readFileSync, writeFileSync } from 'node:fs';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export function registerA11yTests(test, ctx) {
  const { S, page, open, assert, F } = ctx;

  async function check(where, selector = 'body') {
    await S((src) => {
      if (!window.axe) (0, eval)(src);
    }, AXE);
    return S(
      async ({ selector, tags }) => {
        const root = document.querySelector(selector);
        if (!root) throw new Error(`nothing matches ${selector}`);
        const res = await window.axe.run(root, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
        return res.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, sample: v.nodes[0]?.target.join(' ') ?? '', nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 300), summary: n.failureSummary })) }));
      },
      { selector, tags: TAGS },
    ).then((list) => ({ where, list }));
  }

  test('accessibility: axe on the start screen, every ribbon tab, dialogs and the dark theme', async () => {
    const results = [];
    // Start screen.
    await S(() => {
      const t = window.__adika.tabs;
      window.__adika.store.setState({ dirty: false, modal: null });
      for (const tab of [...t.useTabs.getState().tabs]) t.removeTab(tab.id);
    });
    await page.waitForSelector('[data-testid="welcome"]');
    results.push(await check('start screen'));
    // Main window with a document, every ribbon tab.
    await open(F.sample);
    for (const id of ['home', 'view', 'edit', 'comment', 'sign', 'organize', 'forms', 'security', 'convert']) {
      await page.click(`[data-testid="tab-${id}"]`);
      results.push(await check(`ribbon: ${id}`));
    }
    // Dialogs.
    for (const id of ['properties', 'ocr', 'signature', 'batch', 'batchsign', 'customize', 'about', 'export', 'einvoiceNew']) {
      await S((m) => window.__adika.store.getState().openModal(m), id);
      await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
      await page.waitForTimeout(200);
      results.push(await check(`dialog: ${id}`, '[role="dialog"]'));
      await S(() => window.__adika.store.getState().openModal(null));
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    }
    // Tool search.
    await page.keyboard.press('Control+K');
    await page.waitForSelector('[data-testid="palette-input"]');
    await page.fill('[data-testid="palette-input"]', 'sign');
    await page.waitForTimeout(150);
    results.push(await check('tool search'));
    await page.keyboard.press('Escape');
    // Dark theme.
    await page.click('[data-testid="theme-toggle"]');
    try {
      results.push(await check('dark theme: main window'));
      await S(() => window.__adika.store.getState().openModal('properties'));
      await page.waitForSelector('[role="dialog"]');
      results.push(await check('dark theme: properties', '[role="dialog"]'));
      await S(() => window.__adika.store.getState().openModal(null));
    } finally {
      await page.click('[data-testid="theme-toggle"]');
    }

    // Report by rule (ADIKA_A11Y_JSON=<file> writes every node).
    if (process.env.ADIKA_A11Y_JSON) writeFileSync(process.env.ADIKA_A11Y_JSON, JSON.stringify(results, null, 1));
    const byRule = new Map();
    for (const { where, list } of results)
      for (const v of list) {
        const r = byRule.get(v.id) ?? { impact: v.impact, count: 0, where: [], sample: v.sample };
        r.count += v.count;
        r.where.push(where);
        byRule.set(v.id, r);
      }
    for (const [id, r] of [...byRule].sort((a, b) => b[1].count - a[1].count))
      console.log(`      ${r.impact.padEnd(8)} ${id} ×${r.count} — ${[...new Set(r.where)].slice(0, 6).join(', ')}${r.where.length > 6 ? '…' : ''} (e.g. ${r.sample.slice(0, 80)})`);
    if (!byRule.size) console.log('      no violations');
    const critical = [...byRule].filter(([, r]) => r.impact === 'critical');
    assert(!critical.length, `no critical violations (${critical.map(([id, r]) => `${id} in ${r.where.join(', ')}`).join('; ')})`);
  });
}
