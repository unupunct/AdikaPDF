// Windows integration and UX: send by e-mail, Quick Access and shortcuts, pen pressure, tab in its own window — included by suite.mjs.
import { readFileSync } from 'node:fs';
import { PDFDocument as PD, StandardFonts } from 'pdf-lib';

export function registerUx4Tests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, pageBox } = ctx;
  const doc = async (name, pages = 1) => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= pages; i++) d.addPage([400, 400]).drawText(`${name} ${i}`, { x: 40, y: 340, size: 18, font: f });
    const path = join(dir, `${name}.pdf`);
    writeFileSync(path, await d.save());
    return path;
  };

  test('Send by e-mail attaches the document as it is now', async () => {
    await open(await doc('mesaj'));
    await page.click('[data-testid="tab-home"]');
    await page.click('[data-testid="btn-email"]');
    await page.waitForFunction(() => window.__adika.platform.e2eMails().length > 0, null, { timeout: 30000 });
    const [mail] = await S(() => window.__adika.platform.e2eMails());
    assert(mail.fileName === 'mesaj.pdf' && mail.subject === 'mesaj', `message (${JSON.stringify(mail)})`);
    const bytes = readFileSync(mail.path);
    assert(String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-', 'a PDF attachment');
  });

  test('Quick Access toolbar and a keyboard shortcut of your own', async () => {
    await open(await doc('rotire'));
    await page.click('[data-testid="customize-open"]');
    await page.waitForSelector('[data-testid="customize-modal"]');
    await page.fill('[data-testid="customize-search"]', 'Rotate right');
    await page.waitForSelector('[data-testid="customize-command"]');
    await page.click('[data-testid="customize-add"] >> nth=0');
    await page.click('[data-testid="customize-modal"] button:has-text("Keyboard shortcuts")');
    await page.fill('[data-testid="customize-search"]', 'Rotate right');
    await page.click('[data-testid="customize-set-key"] >> nth=0');
    await page.waitForSelector('[data-testid="customize-capturing"]');
    await page.keyboard.press('Control+Alt+R');
    await page.waitForFunction(() => document.querySelector('[data-testid="customize-keys"]')?.textContent.includes('Ctrl+Alt+R'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="customize-modal"]', { state: 'detached' });
    const rot = () => S(() => window.__adika.store.getState().pages[0].userRotation);
    await page.click('[data-testid="page-1"]', { position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('Control+Alt+R');
    await page.waitForFunction(() => window.__adika.store.getState().pages[0].userRotation === 90, null, { timeout: 10000 });
    await page.click('[data-testid="quick-access-item"]');
    await page.waitForFunction(() => window.__adika.store.getState().pages[0].userRotation === 180, null, { timeout: 10000 });
    assert((await rot()) === 180, 'rotated by shortcut and Quick Access');
    // Kept for the next start; cleared for the other tests.
    const kept = await S(() => JSON.parse(localStorage.getItem('adika.customize') ?? '{}'));
    assert(kept.quick?.length === 1 && kept.shortcuts?.[0]?.combo === 'Ctrl+Alt+R', `stored (${JSON.stringify(kept)})`);
    await S(() => {
      const c = window.__adika.customize.getState();
      c.setQuick([]);
      c.setShortcuts([]);
    });
  });

  test('ink drawn with a pen follows its pressure', async () => {
    await open(await doc('cerneala'));
    await S(() => window.__adika.store.getState().setTool('pen'));
    const b = await pageBox(1);
    const z = await S(() => window.__adika.store.getState().zoom);
    const at = (x, y) => [b.x + x * z, b.y + y * z];
    // Synthetic Windows Ink events: a pointer of type "pen" with pressure.
    await page.evaluate(
      ([pts]) => {
        const target = document.querySelector('[data-testid="page-1"] .konvajs-content canvas:last-child') ?? document.elementFromPoint(pts[0][0], pts[0][1]);
        const ev = (type, [x, y, p], on) => on.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'pen', pressure: p, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, isPrimary: true }));
        ev('pointerdown', pts[0], target);
        for (const p of pts.slice(1)) ev('pointermove', p, window);
        ev('pointerup', pts[pts.length - 1], window);
      },
      [[[...at(60, 200), 0.1], [...at(120, 200), 0.4], [...at(180, 200), 0.7], [...at(240, 200), 1.0]]],
    );
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'pen'), null, { timeout: 10000 });
    const pen = await S(() => window.__adika.store.getState().objects.find((o) => o.type === 'pen'));
    assert(pen.pressures?.length === 4 && pen.pressures[0] < pen.pressures[3], `pressures (${JSON.stringify(pen.pressures)})`);
    await S(() => window.__adika.store.getState().setTool('select'));
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/cerneala\.pdf$/)));
    const { decodePDFRawStream, PDFArray, PDFName, PDFRawStream } = await import('pdf-lib');
    const contents = out.getPage(0).node.lookup(PDFName.of('Contents'));
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => out.context.lookup(r)) : [contents];
    const text = streams.map((s) => new TextDecoder().decode(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents())).join('\n');
    const widths = new Set([...text.matchAll(/([\d.]+) w\b/g)].map((m) => m[1]));
    assert(widths.size >= 3, `several line widths in the page (${[...widths]})`);
  });

  test('a document tab moves into a window of its own', async () => {
    await open(await doc('fereastra', 2));
    await S(() => window.__adika.store.getState().rotatePages([window.__adika.store.getState().pages[1].id], 90));
    const ctxPages = () => page.context().pages().filter((p) => p !== page && !p.url().startsWith('devtools'));
    const before = ctxPages().length;
    await page.evaluate(() => document.querySelector('[data-testid="palette-open"]').click());
    await page.fill('[data-testid="palette-input"]', 'Move to a new window');
    await page.keyboard.press('Enter');
    let win = null;
    for (let i = 0; i < 100 && !win; i++) {
      win = ctxPages().find((p) => /adopt=/.test(p.url())) ?? null;
      if (!win) await new Promise((r) => setTimeout(r, 200));
    }
    assert(win && ctxPages().length > before, 'a new window');
    await win.waitForFunction(() => window.__adika?.store.getState().pages.length === 2, null, { timeout: 30000 });
    const there = await win.evaluate(() => {
      const s = window.__adika.store.getState();
      return { name: s.fileName, rot: s.pages[1].userRotation, dirty: s.dirty };
    });
    assert(there.name === 'fereastra.pdf' && there.rot === 90 && there.dirty, `document in the new window (${JSON.stringify(there)})`);
    const here = await S(() => window.__adika.store.getState().pages.length);
    assert(here === 0, 'gone from the first window');
    await win.evaluate(() => window.__adika.closeWindow()).catch(() => undefined);
  });
}
