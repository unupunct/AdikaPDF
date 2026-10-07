import { useEffect, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { TooltipProvider } from '@/components/ui/primitives';
import { TopBar } from '@/components/shell/TopBar';
import { Ribbon } from '@/components/ribbon/Ribbon';
import { LeftSidebar } from '@/components/sidebar/LeftSidebar';
import { PDFCanvas } from '@/components/viewer/PDFCanvas';
import { PropertiesPanel } from '@/components/inspector/PropertiesPanel';
import { StatusBar } from '@/components/shell/StatusBar';
import { WelcomeScreen } from '@/components/shell/WelcomeScreen';
import { SearchBar } from '@/components/shell/SearchBar';
import { Toasts, BusyOverlay, DropOverlay } from '@/components/shell/Overlays';
import { Modals } from '@/components/modals/Modals';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { SplitView, useSplit } from '@/components/viewer/SplitView';
import { useShortcuts } from '@/hooks/useShortcuts';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useAutoReload } from '@/hooks/useAutoReload';
import { useViewPrefs } from '@/hooks/useViewPrefs';
import { TabBar } from '@/components/shell/TabBar';
import { PresentationView } from '@/components/viewer/PresentationView';
import { SelectionToolbar } from '@/components/viewer/SelectionToolbar';
import { dirtyTabCount } from '@/store/tabs';
import { ensureFontsLoaded } from '@/lib/fonts';
import { ensurePrintWatcher, launchRequest, onLaunch } from '@/lib/platform';
import { maybeAutoCheck } from '@/lib/updates';
import { isDesktop } from '@/lib/platform';
import { askConfirm } from '@/store/useDialogs';

export default function App() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const sidebarOpen = usePDFStore((s) => s.sidebarOpen);
  const inspectorOpen = usePDFStore((s) => s.inspectorOpen);
  const theme = usePDFStore((s) => s.theme);
  const [fontsReady, setFontsReady] = useState(false);
  const dragging = useFileDrop();
  const presentation = usePDFStore((s) => s.presentation);
  const fullscreen = usePDFStore((s) => s.fullscreen);
  const split = useSplit((s) => s.open);
  useShortcuts();
  useAutoReload();
  useViewPrefs();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    ensureFontsLoaded()
      .catch((e) => console.error('Font loading failed', e))
      .finally(() => setFontsReady(true));
  }, []);

  // Files passed on the command line (Explorer "Open with Adika"), files
  // forwarded by a second launch (virtual printer), and the print helper.
  useEffect(() => {
    if (!fontsReady) return;
    let off: Promise<() => void> | null = null;
    void import('@/actions/windows').then(async (w) => {
      // A window opened for a tab moved out of another window: that document, nothing else.
      const adopt = w.adoptRequest();
      if (adopt || (await w.windowLabel()) !== 'main') {
        const r = await import('@/lib/recovery');
        if (adopt) await r.adoptSnapshot(adopt).catch((e: unknown) => usePDFStore.getState().toast(String(e), 'error'));
        r.startAutoBackup();
        return;
      }
      void launchRequest().then((req) => import('@/actions/launch').then((m) => m.handleLaunch(req)));
      off = onLaunch((req) => void import('@/actions/launch').then((m) => m.handleLaunch(req)));
      void ensurePrintWatcher();
      maybeAutoCheck();
      void import('@/actions/automation').then((m) => m.restartWatching());
      // Crash recovery: offer what an earlier run left, then back up from now on.
      void import('@/lib/recovery').then(async (r) => {
        const items = await r.listBackups();
        r.startAutoBackup();
        if (items.length) {
          const { useRecoverList } = await import('@/components/modals/RecoverModal');
          useRecoverList.setState({ items });
          usePDFStore.getState().openModal('recover');
        }
      });
    });
    return () => {
      void off?.then((f) => f());
    };
  }, [fontsReady]);

  // Closing the window: ask about unsaved work (the WebView's beforeunload does not run
  // when the desktop window closes), then remove this session's backups.
  useEffect(() => {
    if (!isDesktop) return;
    let off: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win
        .onCloseRequested(async (e) => {
          e.preventDefault();
          const n = dirtyTabCount();
          if (n > 0) {
            const ok = await askConfirm({
              title: 'Close Adika PDF Editor?',
              message: n === 1 ? 'A document has unsaved changes. Close without saving?' : `${n} documents have unsaved changes. Close without saving?`,
              confirmLabel: 'Close without saving',
              danger: true,
            });
            if (!ok) return;
          }
          const { discardSessionBackups } = await import('@/lib/recovery');
          await discardSessionBackups().catch(() => undefined);
          await win.destroy();
        })
        .then((f) => (off = f));
    });
    return () => off?.();
  }, []);

  // Warn before closing the window with unsaved work.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyTabCount() > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (!fontsReady) {
    return (
      <div className="flex h-full items-center justify-center bg-app">
        <img src="./brand/adika-icon.svg" alt="" className="h-14 w-14 animate-pulse" />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-app" data-testid="app-root">
        {fullscreen ? null : (
          <>
            <TopBar />
            <Ribbon />
            <TabBar />
          </>
        )}
        <div className="relative flex min-h-0 flex-1">
          {hasDoc && sidebarOpen ? <LeftSidebar /> : null}
          <main className="relative min-w-0 flex-1">
            {hasDoc ? (
              <>
                <PDFCanvas />
                <SearchBar />
              </>
            ) : (
              <WelcomeScreen />
            )}
          </main>
          {hasDoc && split ? <SplitView /> : null}
          {hasDoc && inspectorOpen ? <PropertiesPanel /> : null}
        </div>
        {fullscreen ? null : <StatusBar />}
        {presentation && hasDoc ? <PresentationView /> : null}
        {hasDoc ? <SelectionToolbar /> : null}
        <Modals />
        <CommandPalette />
        <Toasts />
        <BusyOverlay />
        {dragging ? <DropOverlay /> : null}
      </div>
    </TooltipProvider>
  );
}
