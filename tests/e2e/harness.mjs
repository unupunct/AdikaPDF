// Launches the real Adika desktop app (Tauri + WebView2) with a remote
// debugging port and connects Playwright to its WebView over CDP.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

export const EXE = process.env.ADIKA_EXE ?? join(process.cwd(), 'src-tauri', 'target', 'release', 'adika-pdf-editor.exe');

/** `recoveryDir` / `dataDir`: crash-recovery backups and cache files go there (fresh temp folders by default, never the user's). */
export async function launchApp({ args = [], port = 9333, exe = EXE, recoveryDir = tempDir('adika-recovery-'), dataDir = tempDir('adika-data-') } = {}) {
  const env = {
    ...process.env,
    ADIKA_E2E: '1',
    ADIKA_RECOVERY_DIR: recoveryDir,
    ADIKA_DATA_DIR: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}${process.env.ADIKA_EXTRA_WV2_ARGS ? ` ${process.env.ADIKA_EXTRA_WV2_ARGS}` : ''}`,
  };
  const proc = spawn(exe, args, { env, stdio: process.env.ADIKA_STDERR ? ['ignore', 'ignore', 'inherit'] : 'ignore' });
  let exited = false;
  proc.on('exit', () => (exited = true));
  const deadline = Date.now() + 30000;
  let browser;
  while (!browser) {
    if (exited) throw new Error('Adika exited before the WebView came up');
    if (Date.now() > deadline) throw new Error('Timed out waiting for the WebView debug port');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  let page;
  while (!page) {
    page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools'));
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  await page.waitForFunction(() => window.__adika && document.querySelector('[data-testid="app-root"]'), null, { timeout: 30000 });
  const close = async () => {
    await browser.close().catch(() => {});
    proc.kill();
  };
  return { page, browser, proc, close };
}

export function tempDir(prefix = 'adika-e2e-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
