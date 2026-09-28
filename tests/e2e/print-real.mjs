// Real virtual-printer test (needs the printer from printer.ps1 and a running spooler):
// prints text through Windows to "Adika PDF Editor" and expects it to open as a tab.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { EXE, launchApp } from './harness.mjs';

const exe = resolve(process.env.ADIKA_EXE ?? EXE);
const app = await launchApp({ exe });
try {
  await app.page.waitForFunction(() => window.__adika?.store, null, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2000)); // watcher start-up
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "'Hello from the Windows print system' | Out-Printer -Name 'Adika PDF Editor'"]);
  await app.page.waitForFunction(() => /^Printed .*\.pdf$/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 60000 });
  const s = await app.page.evaluate(async () => {
    const st = window.__adika.store.getState();
    return { name: st.fileName, pages: st.pages.length };
  });
  console.log('✓ printed page opened in Adika:', s.name, `(${s.pages} page)`);
} finally {
  await app.close();
}
