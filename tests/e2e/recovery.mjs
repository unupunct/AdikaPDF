// Crash recovery: edits are backed up automatically; after the app is killed,
// the next start offers them back. Saving removes the backup.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EXE, launchApp, tempDir } from './harness.mjs';

const exe = process.env.ADIKA_EXE ?? EXE;
const assert = (c, m) => {
  if (!c) throw new Error(`Assertion failed: ${m}`);
};
const dir = tempDir();
const recoveryDir = tempDir('adika-recovery-');
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i++) doc.addPage([400, 400]).drawText(`Contract page ${i}`, { x: 30, y: 350, size: 14, font });
const file = join(dir, 'contract.pdf');
writeFileSync(file, await doc.save());
const backups = () => (existsSync(recoveryDir) ? readdirSync(recoveryDir).filter((d) => existsSync(join(recoveryDir, d, 'state.json'))) : []);

// 1. Edit, wait for the backup, then "crash".
let app = await launchApp({ exe, args: [file], recoveryDir });
await app.page.waitForFunction(() => window.__adika.store.getState().fileName === 'contract.pdf', null, { timeout: 15000 });
await app.page.evaluate(() => {
  const s = window.__adika.store.getState();
  s.addObject({ id: 'rec-text', type: 'text', pageId: s.pages[1].id, x: 40, y: 80, width: 260, height: 24, rotation: 0, opacity: 1, text: 'Clauză nouă — recuperată', fontFamily: 'sans', bold: false, italic: false, fontSize: 14, color: '#000000', align: 'left', lineHeight: 1.25, background: null });
});
for (let i = 0; i < 40 && backups().length === 0; i++) await new Promise((r) => setTimeout(r, 250));
assert(backups().length === 1, `one backup written (${backups().join(',')})`);
console.log('✓ backup written a few seconds after the edit');
app.proc.kill();
await app.browser.close().catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// 2. Restart: the recovery dialog offers the document; recover it.
app = await launchApp({ exe, recoveryDir });
try {
  await app.page.waitForSelector('[data-testid="recover-modal"]', { timeout: 20000 });
  const listed = await app.page.textContent('[data-testid="recover-modal"]');
  assert(listed.includes('contract.pdf') && /1 edit/.test(listed), `dialog lists the document (${listed})`);
  await app.page.click('[data-testid="recover-open"]');
  await app.page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.id === 'rec-text'), null, { timeout: 20000 });
  const st = await app.page.evaluate(() => {
    const s = window.__adika.store.getState();
    return { pages: s.pages.length, dirty: s.dirty, name: s.fileName, path: s.filePath, onPage2: s.objects.find((o) => o.id === 'rec-text').pageId === s.pages[1].id };
  });
  assert(st.pages === 2 && st.dirty && st.name === 'contract.pdf' && st.onPage2, `document and edit restored (${JSON.stringify(st)})`);
  console.log('✓ recovered after restart: 2 pages, the edit on page 2, marked unsaved');
  // 3. Saving removes the backup.
  await app.page.evaluate((d) => window.__adika.platform.e2eSetSaveDir(d), dir);
  await app.page.keyboard.press('Control+Shift+s');
  await app.page.waitForFunction(() => !window.__adika.store.getState().dirty, null, { timeout: 20000 });
  for (let i = 0; i < 40 && backups().length > 0; i++) await new Promise((r) => setTimeout(r, 250));
  assert(backups().length === 0, `backup removed after saving (${backups().join(',')})`);
  console.log('✓ backup removed after saving');
} finally {
  await app.close();
}
