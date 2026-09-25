import { useEffect, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { TooltipProvider } from '@/components/ui/primitives';
import { TopBar } from '@/components/shell/TopBar';
import { Ribbon } from '@/components/ribbon/Ribbon';
import { ThumbnailSidebar } from '@/components/sidebar/ThumbnailSidebar';
import { PDFCanvas } from '@/components/viewer/PDFCanvas';
import { PropertiesPanel } from '@/components/inspector/PropertiesPanel';
import { StatusBar } from '@/components/shell/StatusBar';
import { WelcomeScreen } from '@/components/shell/WelcomeScreen';
import { SearchBar } from '@/components/shell/SearchBar';
import { Toasts, BusyOverlay, DropOverlay } from '@/components/shell/Overlays';
import { Modals } from '@/components/modals/Modals';
import { useShortcuts } from '@/hooks/useShortcuts';
import { useFileDrop } from '@/hooks/useFileDrop';
import { ensureFontsLoaded } from '@/lib/fonts';
import { initialFiles } from '@/lib/platform';
import { openPdfPath } from '@/actions/document';

export default function App() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const sidebarOpen = usePDFStore((s) => s.sidebarOpen);
  const inspectorOpen = usePDFStore((s) => s.inspectorOpen);
  const theme = usePDFStore((s) => s.theme);
  const [fontsReady, setFontsReady] = useState(false);
  const dragging = useFileDrop();
  useShortcuts();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    ensureFontsLoaded()
      .catch((e) => console.error('Font loading failed', e))
      .finally(() => setFontsReady(true));
  }, []);

  // Files passed on the command line (Explorer "Open with Adika").
  useEffect(() => {
    if (!fontsReady) return;
    void initialFiles().then((paths) => {
      if (paths[0]) void openPdfPath(paths[0]);
    });
  }, [fontsReady]);

  // Warn before closing the window with unsaved work.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (usePDFStore.getState().dirty) {
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
        <TopBar />
        <Ribbon />
        <div className="relative flex min-h-0 flex-1">
          {hasDoc && sidebarOpen ? <ThumbnailSidebar /> : null}
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
        <StatusBar />
        <Modals />
        <Toasts />
        <BusyOverlay />
        {dragging ? <DropOverlay /> : null}
      </div>
    </TooltipProvider>
  );
}
