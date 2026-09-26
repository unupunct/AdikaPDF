// Renders what Adika *saves*: adds text boxes, exports, reopens the export, screenshots it.
import { launchApp } from './harness.mjs';
const [file, png] = process.argv.slice(2);
const app = await launchApp({ exe: process.env.ADIKA_EXE });
const { page } = app;
await page.evaluate((p) => window.__adika.document.openPdfPath(p), file);
await page.evaluate(async () => {
  const s = window.__adika.store.getState();
  const pageId = s.pages[0].id;
  const base = { type: 'text', pageId, rotation: 0, opacity: 1, width: 460, height: 30, bold: false, italic: false, color: '#b91c1c', align: 'left', lineHeight: 1.25, background: null };
  s.addObject({ ...base, id: 't1', x: 40, y: 40, text: 'Sans: Semnat în Cluj-Napoca ăâîșț ĂÂÎȘȚ 0123', fontFamily: 'sans', fontSize: 18 });
  s.addObject({ ...base, id: 't2', x: 40, y: 80, text: 'Serif bold: Contract nr. 58213 — țară', fontFamily: 'serif', bold: true, fontSize: 18 });
  s.addObject({ ...base, id: 't3', x: 40, y: 120, text: 'Mono italic: const x = "șț";', fontFamily: 'mono', italic: true, fontSize: 16 });
  const bytes = await window.__adika.document.exportCurrentPdf();
  s.markSaved(null);
  await window.__adika.document.openPdfBytes(bytes, 'exported.pdf', null, true);
});
await page.waitForFunction(() => window.__adika.store.getState().fileName === 'exported.pdf');
await page.waitForFunction(() => !document.querySelector('[data-testid="page-1"]')?.textContent?.includes('Loading'), null, { timeout: 20000 });
await page.evaluate(() => window.__adika.store.getState().setZoom(1.3, null));
await page.waitForTimeout(1500);
await page.screenshot({ path: png, clip: { x: 180, y: 160, width: 980, height: 320 } });
await app.close();
