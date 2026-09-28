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
import { useShortcuts } from '@/hooks/useShortcuts';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useAutoReload } from '@/hooks/useAutoReload';
import { TabBar } from '@/components/shell/TabBar';
import { PresentationView } from '@/components/viewer/PresentationView';
import { SelectionToolbar } from '@/components/viewer/SelectionToolbar';
import { dirtyTabCount } from '@/store/tabs';
import { ensureFontsLoaded } from '@/lib/fonts';
import { ensurePrintWatcher, initialFiles, onForwardedFiles } from '@/lib/platform';
import { openPdfPath } from '@/actions/document';
import { maybeAutoCheck } from '@/lib/updates';

export default function App() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const sidebarOpen = usePDFStore((s) => s.sidebarOpen);
  const inspectorOpen = usePDFStore((s) => s.inspectorOpen);
  const theme = usePDFStore((s) => s.theme);
  const [fontsReady, setFontsReady] = useState(false);
  const dragging = useFileDrop();
  const presentation = usePDFStore((s) => s.presentation);
  const fullscreen = usePDFStore((s) => s.fullscreen);
  useShortcuts();
  useAutoReload();

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
    void initialFiles().then(async (paths) => {
      for (const p of paths) await openPdfPath(p);
    });
    const off = onForwardedFiles(async (paths) => {
      for (const p of paths) await openPdfPath(p);
    });
    void ensurePrintWatcher();
    maybeAutoCheck();
    return () => {
      void off.then((f) => f());
    };
  }, [fontsReady]);

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
          {hasDoc && inspectorOpen ? <PropertiesPanel /> : null}
        </div>
        {fullscreen ? null : <StatusBar />}
        {presentation && hasDoc ? <PresentationView /> : null}
        {hasDoc ? <SelectionToolbar /> : null}
        <Modals />
        <Toasts />
        <BusyOverlay />
        {dragging ? <DropOverlay /> : null}
      </div>
    </TooltipProvider>
  );
}
