// Drag and drop and "Report a problem" — included by suite.mjs.
// Drops from Explorer cannot be started from a test: `window.__adika.dnd.e2eDropPaths(paths, { x, y })`
// runs the same handling at a point in the window. Drags inside the page use synthetic
// DragEvents with a real DataTransfer (Chromium lets the page build one).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function registerDndTests(test, ctx) {
  const { S, page, assert, F, idle, dir } = ctx;
  // Earlier tests may leave another side panel (Comments, Tags…) showing: these drops need the thumbnails.
  const open = async (path) => {
    await ctx.open(path);
    await S(() => window.__adika.store.setState({ sidebarOpen: true, sidebarTab: 'pages' }));
    await page.waitForSelector('[data-testid="thumb-1"]');
  };
  const pages = () => S(() => window.__adika.store.getState().pages.length);
  const tabs = () => S(() => window.__adika.tabs.useTabs.getState().tabs.length);
  const center = (sel) => S((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  const choose = async (label) => {
    await page.waitForSelector(`[role="dialog"] button:has-text("${label}")`, { timeout: 10000 });
    await page.click(`[role="dialog"] button:has-text("${label}")`);
  };

  test('dnd: a PDF dropped on the thumbnails is inserted there (after asking)', async () => {
    await open(F.sample);
    const before = await pages();
    const at = await center('[data-testid="thumb-1"]');
    const drop = S(({ p, at }) => window.__adika.dnd.e2eDropPaths([p], at), { p: F.second, at: { x: at.x, y: at.y + 40 } });
    await choose('Insert pages here');
    await drop;
    await idle();
    assert((await pages()) > before, `pages inserted (${before} → ${await pages()})`);
    assert((await tabs()) === 1, 'no new tab');
  });

  test('dnd: "Open in new tab" and drops elsewhere open each PDF in a tab', async () => {
    await open(F.sample);
    const at = await center('[data-testid="thumb-1"]');
    const drop = S(({ p, at }) => window.__adika.dnd.e2eDropPaths([p], at), { p: F.second, at });
    await choose('Open in new tab');
    await drop;
    await idle();
    assert((await tabs()) === 2, `second tab (${await tabs()})`);
    // Onto the ribbon: no question, a tab per PDF.
    await S((p) => window.__adika.dnd.e2eDropPaths([p], { kind: 'app' }), F.form);
    await idle();
    assert((await tabs()) === 3, `third tab (${await tabs()})`);
  });

  test('dnd: a picture dropped on a page is placed at the drop point', async () => {
    await open(F.sample);
    const png = join(dir, 'dnd-logo.png');
    const b64 = await S(() => {
      const c = document.createElement('canvas');
      c.width = 60;
      c.height = 40;
      c.getContext('2d').fillRect(0, 0, 60, 40);
      return c.toDataURL('image/png').split(',')[1];
    });
    writeFileSync(png, Buffer.from(b64, 'base64'));
    const box = await S(() => document.querySelector('[data-testid="page-1"]').getBoundingClientRect().toJSON());
    await S(({ p, at }) => window.__adika.dnd.e2eDropPaths([p], at), { p: png, at: { x: box.left + 150, y: box.top + 120 } });
    await idle();
    const img = await S(() => window.__adika.store.getState().objects.find((o) => o.type === 'image'));
    const zoom = await S(() => window.__adika.store.getState().zoom);
    assert(img, 'image object added');
    assert(Math.abs(img.x + img.width / 2 - 150 / zoom) < 2 && Math.abs(img.y + img.height / 2 - 120 / zoom) < 2, `centred on the drop point (${img.x},${img.y})`);
  });

  test('dnd: unsupported files and a protected document', async () => {
    await open(F.sample);
    const exe = join(dir, 'tool.exe');
    writeFileSync(exe, 'MZ');
    await S((p) => window.__adika.dnd.e2eDropPaths([p], { kind: 'app' }), exe);
    const toasts = await S(() => window.__adika.store.getState().toasts.map((t) => t.message));
    assert(toasts.some((t) => /unsupported file type.*tool\.exe/.test(t)), `toast (${toasts})`);
    // Pages restricted: a drop on the thumbnails opens a tab instead of inserting.
    await S(() => window.__adika.store.setState({ protection: { full: false, permissions: { modify: false, assemble: false, annotate: true, fillForms: true, print: true, copy: true } } }));
    const [firstTab] = await S(() => window.__adika.tabs.useTabs.getState().tabs.map((t) => t.id));
    const before = await pages();
    await S((p) => window.__adika.dnd.e2eDropPaths([p], { kind: 'thumbs', index: 0 }), F.second);
    await idle();
    assert((await tabs()) === 2, 'opened in a tab');
    // The new tab is in front now: count the protected document's pages in its own (parked) tab.
    const after = await S((id) => window.__adika.tabs.tabSlice(id).pages.length, firstTab);
    assert(after === before, `nothing inserted (${before} → ${after})`);
  });

  test('dnd: a thumbnail dragged onto another tab and into its pages is copied', async () => {
    await open(F.sample);
    await S((p) => window.__adika.document.openPdfPath(p), F.second);
    await idle();
    const [firstTab] = await S(() => window.__adika.tabs.useTabs.getState().tabs.map((t) => t.id));
    const targetBefore = await S((id) => window.__adika.tabs.tabSlice(id).pages.length, firstTab);
    // Start dragging page 1 of the second document.
    await S(() => {
      const dt = new DataTransfer();
      window.__e2eDt = dt;
      document.querySelector('[data-testid="thumb-1"]').parentElement.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    });
    const tab = await center(`[data-tab-id="${firstTab}"]`);
    await S((at) => document.elementFromPoint(at.x, at.y).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, dataTransfer: window.__e2eDt })), tab);
    await page.waitForFunction((id) => window.__adika.tabs.useTabs.getState().activeId === id, firstTab, { timeout: 3000 });
    const label = await page.textContent('[data-testid="drop-label"]').catch(() => '');
    const thumb = await center('[data-testid="thumb-1"]');
    await S((at) => {
      const el = document.elementFromPoint(at.x, at.y);
      for (const type of ['dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y + 30, dataTransfer: window.__e2eDt }));
    }, thumb);
    await idle();
    assert((await pages()) === targetBefore + 1, `page copied (${targetBefore} → ${await pages()}; label "${label}")`);
  });

  test('dnd: dropping a folder offers its PDFs; Batch takes dropped files', async () => {
    await open(F.sample);
    const drop = S((d) => window.__adika.dnd.e2eDropPaths([d], { kind: 'app' }), dir);
    await page.waitForSelector('[role="dialog"]:has-text("Open the PDFs in this folder?")', { timeout: 10000 });
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await drop;
    await S(() => window.__adika.store.getState().openModal('batch'));
    // The dialog keeps its last view (the watched-folder test leaves "Watched folders" showing).
    await page.click('[data-testid="batch-modal"] [role="tab"]:has-text("One operation")');
    await page.waitForSelector('[data-drop-list="batch"]');
    await page.waitForTimeout(300);
    await S(({ a, b }) => window.__adika.dnd.e2eDropPaths([a, b], { kind: 'list', list: 'batch' }), { a: F.sample, b: F.second });
    await page.waitForSelector('[data-testid="batch-files"] li');
    const n = await page.$$eval('[data-testid="batch-files"] li', (l) => l.length);
    assert(n === 2, `two files listed (${n})`);
    await S(() => window.__adika.store.getState().openModal(null));
  });

  test('report: About → Report a problem shows the text; nothing opens until asked', async () => {
    await S(() => window.__adika.store.getState().openModal('about'));
    await page.click('[data-testid="report-problem"]');
    await page.waitForSelector('[data-testid="report-modal"]');
    const text = await page.textContent('[data-testid="report-preview"]');
    assert(/### Adika version\s+\d+\.\d+\.\d+/.test(text), 'version filled');
    assert(/### Windows version\s+Windows/.test(text), `Windows version (${text.slice(0, 200)})`);
    assert(!/[A-Z]:\\/.test(text), 'no paths');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="report-modal"]', { state: 'detached' });
  });
}
