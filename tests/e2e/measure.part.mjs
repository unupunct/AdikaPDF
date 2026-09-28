// Measure tools (distance, perimeter, area with a drawing scale) and
// auto-scroll — included by suite.mjs.
import { readFileSync } from 'node:fs';
import { PDFDocument as PD } from 'pdf-lib';

export function registerMeasureTests(test, ctx) {
  const { S, page, open, idle, savedFile, assert, F, pdfjs, FONT_DATA, at } = ctx;
  const MM = 72 / 25.4;

  const drag = async (x0, y0, x1, y1) => {
    const a = await at(1, x0, y0);
    const b = await at(1, x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };
  const click = async (x, y) => {
    const p = await at(1, x, y);
    await page.mouse.click(p.x, p.y);
  };
  const num = (label) => Number(String(label).replace(/[^\d.,-]/g, '').replace(/,/g, ''));
  const near = (v, want, tol = 0.02) => Math.abs(v - want) <= want * tol;

  test('measure: distance, perimeter and area use the drawing scale and are saved as PDF measurements', async () => {
    await open(F.sample);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    await page.click('[data-testid="tab-comment"]');
    // Scale 1 cm = 2 m (a 1:200 drawing), set in the ribbon popover.
    await page.click('[data-testid="btn-measure-scale"]');
    await page.fill('[data-testid="scale-page-value"]', '1');
    await page.press('[data-testid="scale-page-value"]', 'Enter');
    await page.selectOption('select[aria-label="Page unit"]', 'cm');
    await page.fill('[data-testid="scale-real-value"]', '2');
    await page.press('[data-testid="scale-real-value"]', 'Enter');
    await page.selectOption('select[aria-label="Real unit"]', 'm');
    const scale = await S(() => window.__adika.measure.useMeasureScale.getState().scale);
    assert(scale.pageUnit === 'cm' && scale.realValue === 2 && scale.realUnit === 'm', `scale set (${JSON.stringify(scale)})`);
    await page.keyboard.press('Escape');
    // Distance: 5 cm on the page = 10 m.
    await page.click('[data-testid="tool-measure-distance"]');
    await drag(100, 200, 100 + 50 * MM, 200);
    // Perimeter: three points, Enter.
    await page.click('[data-testid="tool-measure-perimeter"]');
    await click(100, 300);
    await click(100 + 30 * MM, 300);
    await click(100 + 30 * MM, 300 + 40 * MM);
    await page.keyboard.press('Enter');
    // Area: 5 cm × 3 cm rectangle, closed by clicking the first point = 10 m × 6 m = 60 m².
    await page.click('[data-testid="tool-measure-area"]');
    await click(300, 450);
    await click(300 + 50 * MM, 450);
    await click(300 + 50 * MM, 450 + 30 * MM);
    await click(300, 450 + 30 * MM);
    await click(300, 450);
    await page.waitForFunction(() => window.__adika.store.getState().objects.filter((o) => o.type === 'measure').length === 3, null, { timeout: 5000 });
    const labels = await S(() => {
      const { measureValue } = window.__adika.measure;
      return window.__adika.store.getState().objects.filter((o) => o.type === 'measure').map((o) => ({ kind: o.kind, label: measureValue(o.kind, o.points, o.scale).label }));
    });
    const by = (k) => labels.find((l) => l.kind === k).label;
    assert(near(num(by('distance')), 10) && /\bm$/.test(by('distance')), `distance ≈ 10 m (${by('distance')})`);
    assert(near(num(by('perimeter')), 14) && /\bm$/.test(by('perimeter')), `perimeter ≈ 6 m + 8 m (${by('perimeter')})`);
    assert(near(num(by('area')), 60, 0.03) && /m²$/.test(by('area')), `area ≈ 60 m² (${by('area')})`);
    // Listed in the Comments panel and shown in the properties.
    await page.click('[data-testid="btn-comments"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="comments-panel"]')?.textContent.includes('m²'), null, { timeout: 5000 });
    // Save: Line / PolyLine / Polygon with the measurement intent and the /Measure scale.
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const path = await savedFile(/sample\.pdf$/);
    const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
    const annots = (await (await d.getPage(1)).getAnnotations()).filter((a) => ['Line', 'PolyLine', 'Polygon'].includes(a.subtype));
    await d.loadingTask.destroy();
    assert(annots.length === 3 && annots.every((a) => a.hasAppearance), `three measurements with appearances (${annots.map((a) => a.subtype).join(',')})`);
    assert(annots.some((a) => a.subtype === 'Polygon' && /m²/.test(a.contentsObj?.str ?? '')), 'area value in the Polygon contents');
    const doc = await PD.load(readFileSync(path));
    const raw = doc.getPages()[0].node.Annots().asArray().map((r) => doc.context.lookup(r).toString()).join('\n');
    for (const it of ['LineDimension', 'PolyLineDimension', 'PolygonDimension']) assert(raw.includes(`/IT /${it}`), `${it} intent saved`);
    const r = /\/Measure <<[\s\S]*?\/R (?:\(([^)]*)\)|<([0-9A-Fa-f]+)>)/.exec(raw);
    const hex = r?.[2] ? Buffer.from(r[2], 'hex') : null;
    const scaleStr = r?.[1] ?? (hex ? (hex[0] === 0xfe ? hex.subarray(2).swap16().toString('utf16le') : hex.toString('latin1')) : '');
    assert(scaleStr === '1 cm = 2 m', `scale saved in /Measure (${scaleStr})`);
    // Reset for later tests.
    await S(() => {
      window.__adika.measure.useMeasureScale.getState().setScale(window.__adika.measure.DEFAULT_SCALE);
      window.__adika.store.getState().setTool('selectText');
    });
  });

  test('auto-scroll: scrolls by itself, changes speed and direction, stops with Esc and Ctrl+Shift+H', async () => {
    await open(F.sample);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    const top = () => S(() => document.querySelector('[data-testid="pdf-canvas"]').scrollTop);
    const st = () => S(() => {
      const s = window.__adika.autoScroll.useAutoScroll.getState();
      return { on: s.on, level: s.level, direction: s.direction };
    });
    await S(() => (document.querySelector('[data-testid="pdf-canvas"]').scrollTop = 0));
    await page.click('[data-testid="tab-view"]');
    await page.click('[data-testid="btn-autoscroll"]');
    await page.waitForSelector('[data-testid="status-autoscroll"]', { timeout: 3000 });
    const t0 = await top();
    await page.waitForTimeout(1000);
    const t1 = await top();
    assert(t1 - t0 > 15, `the document scrolls down by itself (${t0} → ${t1})`);
    const lvl = (await st()).level;
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert((await st()).level === lvl + 2, '↓ makes it faster');
    await page.keyboard.press('-');
    assert((await st()).direction === -1, '− reverses');
    const t2 = await top();
    await page.waitForTimeout(600);
    const t3 = await top();
    assert(t3 < t2, `now scrolls up (${t2} → ${t3})`);
    await page.keyboard.press('Escape');
    assert(!(await st()).on, 'Esc stops');
    await page.waitForFunction(() => !document.querySelector('[data-testid="status-autoscroll"]'), null, { timeout: 3000 });
    const t4 = await top();
    await page.waitForTimeout(400);
    assert((await top()) === t4, 'stopped means stopped');
    await page.click('[data-testid="pdf-canvas"]', { position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+Shift+h');
    assert((await st()).on && (await st()).direction === 1, 'Ctrl+Shift+H starts it again, downwards');
    await page.keyboard.press('Control+Shift+h');
    assert(!(await st()).on, 'Ctrl+Shift+H stops it');
  });
}
