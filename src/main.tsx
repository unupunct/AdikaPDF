import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import 'pdfjs-dist/web/pdf_viewer.css';
import './index.css';
import { installGlobalErrorLogging } from './lib/log';

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
  const [store, dialogs, document, convert, security, sign, platform, signature, search, email, tabs, print, log, pageTools, modalArgs] = await Promise.all([
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
  };
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
