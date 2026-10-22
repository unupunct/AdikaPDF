// First: decides simple / full ribbon and the welcome before anything stores a setting.
import { useUiMode } from './store/uiMode';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import 'pdfjs-dist/web/pdf_viewer.css';
import './index.css';
import { installGlobalErrorLogging } from './lib/log';
import { applyLang, setDefaultLang, startDomTranslation, useLang } from './lib/i18n';
import { loadDeployment, usePolicy } from './lib/policy';

installGlobalErrorLogging();
// Policies and the portable mode first: they decide the default language and what may go online.
const deployment = loadDeployment();
void import('./lib/author').then((m) => m.initAuthor());

// Test hooks for the end-to-end suite: only in dev, or when the desktop app
// was started with ADIKA_E2E=1.
const e2eMode: Promise<boolean> = (async () => {
  if (!('__TAURI_INTERNALS__' in window)) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('e2e_mode').catch(() => false);
})();
void (async () => {
  const enabled = import.meta.env.DEV || (await e2eMode);
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
    anaf: await import('./actions/anaf'),
    customize: (await import('./store/customize')).useCustomize,
    uiMode: useUiMode,
    // Closes this window without asking (a test closing a window it opened).
    closeWindow: async () => {
      store.usePDFStore.setState({ dirty: false });
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    },
  };
})();

// Command line batch (`--batch`): runs without the interface, then exits.
const commandLine: Promise<boolean> =
  '__TAURI_INTERNALS__' in window
    ? deployment.then(() => import('./actions/automation')).then((m) => m.runCommandLine()).catch((e) => (console.error('Command line failed', e), false))
    : Promise.resolve(false);

// Interface language first (no flash of English), then watch the DOM and render.
void deployment
  .then(() => setDefaultLang(usePolicy.getState().policies.defaultLanguage))
  .then(() => applyLang(useLang.getState().lang))
  .catch((e) => console.error('Language loading failed', e))
  .finally(async () => {
    if (await commandLine) return;
    // End-to-end tests drive the full ribbon and must not meet the welcome.
    if (await e2eMode) useUiMode.getState().e2eDefaults();
    startDomTranslation();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  });
