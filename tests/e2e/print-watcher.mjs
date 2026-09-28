// Virtual printer pipeline without the Windows spooler: a PDF dropped where the
// "Adika PDF Editor" printer port writes is moved to Printed\ and opens as a tab.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EXE, launchApp } from './harness.mjs';

const exe = resolve(process.env.ADIKA_EXE ?? EXE);
const dir = resolve('.tools/scratch/print-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'print'), { recursive: true });
process.env.ADIKA_PRINT_DIR = dir; // inherited by the app and the watcher it starts

function killWatcher() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='adika-pdf-editor.exe'" | Where-Object { $_.CommandLine -like '*--print-watcher*' -and $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
}

const doc = await PDFDocument.create();
doc.addPage([595, 842]).drawText('Printed from a web page', { x: 50, y: 780, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
const job = await doc.save();

const app = await launchApp({ exe });
try {
  await app.page.waitForFunction(() => window.__adika?.store, null, { timeout: 15000 });
  // App start-up launches the watcher; give it a moment to take its lock.
  for (let i = 0; i < 40 && !existsSync(join(dir, 'print-watcher.lock')); i++) await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(join(dir, 'print-watcher.lock'))) throw new Error('print watcher did not start');
  writeFileSync(join(dir, 'print', 'adika-print.pdf'), job);
  await app.page.waitForFunction(() => /^Printed \d{4}-\d\d-\d\d \d{6}\.pdf$/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 20000 });
  const pages = await app.page.evaluate(() => window.__adika.store.getState().pages.length);
  const printed = readdirSync(join(dir, 'Printed'));
  if (existsSync(join(dir, 'print', 'adika-print.pdf'))) throw new Error('spool file was not moved');
  if (printed.length !== 1 || pages !== 1) throw new Error(`unexpected result: ${printed} / ${pages} pages`);
  console.log('✓ print job opened as', printed[0]);
} finally {
  await app.close();
  killWatcher();
  rmSync(dir, { recursive: true, force: true });
}
