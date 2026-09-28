// Opening a PDF while Adika is already running adds a tab to the running window
// (single-instance forwarding), which is also how virtual-printer jobs arrive.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EXE, launchApp, tempDir } from './harness.mjs';

const exe = process.env.ADIKA_EXE ?? EXE;
async function makePdf(name, text) {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText(text, { x: 20, y: 150, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  const file = join(tempDir(), name);
  writeFileSync(file, await doc.save());
  return file;
}
const first = await makePdf('first.pdf', 'First');
const second = await makePdf('Printed 2026-09-28 120000.pdf', 'Second');

const app = await launchApp({ exe, args: [first] });
try {
  await app.page.waitForFunction(() => window.__adika.store.getState().fileName === 'first.pdf', null, { timeout: 15000 });
  const t0 = Date.now();
  const r = spawnSync(exe, [second], { timeout: 20000 });
  console.log(`second instance exited with ${r.status} after ${Date.now() - t0} ms`);
  await app.page.waitForFunction((n) => window.__adika.store.getState().fileName === n, 'Printed 2026-09-28 120000.pdf', { timeout: 15000 });
  const tabs = await app.page.evaluate(() => { const T = window.__adika.tabs; const st = T.useTabs.getState(); return st.tabs.map((t) => T.tabInfo(t, st.activeId).name); });
  if (tabs.length !== 2) throw new Error('expected 2 tabs, got ' + JSON.stringify(tabs));
  console.log('✓ forwarded to running window, tabs:', tabs.join(' | '));
} finally {
  await app.close();
}
