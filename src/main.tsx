import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import 'pdfjs-dist/web/pdf_viewer.css';
import './index.css';
import { installGlobalErrorLogging } from './lib/log';
import { applyLang, startDomTranslation, useLang } from './lib/i18n';

installGlobalErrorLogging();
void import('./lib/author').then((m) => m.initAuthor());

// Test hooks for the end-to-end suite: only in dev, or when the desktop app
// was started with ADIKA_E2E=1.
void (async () => {
  let enabled = import.meta.env.DEV;
  if (!enabled && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    enabled = await invoke<boolean>('e2e_mode').catch(() => false);
  }
  if (!enabled) return;
  const [store, dialogs, document, convert, security, sign, platform, signature, search, email, tabs, print, log, pageTools, modalArgs, readingAids, readAloud, measure, autoScroll, updates] = await Promise.all([
    import('./store/usePDFStore'),
    import('./store/useDialogs'),
    import('./actions/document'),
    import('./actions/convert'),
    import('./actions/security'),
    import('./actions/sign'),
    import('./lib/platform'),
    import('./lib/crypto/digitalSignature'),
    import('./lib/search'),
    import('./lib/pdf/email'),
    import('./store/tabs'),
    import('./actions/print'),
    import('./lib/log'),
    import('./actions/pageTools'),
    import('./store/useModalArgs'),
    import('./actions/readingAids'),
    import('./lib/readAloud'),
    import('./lib/measure'),
    import('./components/viewer/AutoScroll'),
    import('./lib/updates'),
  ]);
  (window as unknown as { __adika: unknown }).__adika = {
    store: store.usePDFStore,
    dialogs: dialogs.useDialogs,
    document,
    convert,
    security,
    sign,
    platform,
    signature,
    search,
    email,
    tabs,
    print,
    log,
    pageTools,
    modalArgs: modalArgs.useModalArgs,
    readingAids,
    readAloud,
    measure,
    autoScroll,
    updates,
    i18n: await import('./lib/i18n'),
  };
})();

// Command line batch (`--batch`): runs without the interface, then exits.
const commandLine: Promise<boolean> =
  '__TAURI_INTERNALS__' in window
    ? import('./actions/automation').then((m) => m.runCommandLine()).catch((e) => (console.error('Command line failed', e), false))
    : Promise.resolve(false);

// Interface language first (no flash of English), then watch the DOM and render.
void applyLang(useLang.getState().lang)
  .catch((e) => console.error('Language loading failed', e))
  .finally(async () => {
    if (await commandLine) return;
    startDomTranslation();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  });
