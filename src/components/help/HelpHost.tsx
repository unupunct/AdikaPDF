/**
 * Always mounted: F1 opens the help at the page for the dialog in front
 * (its "?" topic), or the start page; the viewer and the bundled guide are
 * loaded on first use.
 */
import { lazy, Suspense, useEffect } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { useHelp, openHelp } from '@/store/help';
import { helpTopicFor } from '@/lib/help/context';
import { useCustomize } from '@/store/customize';

const HelpViewer = lazy(() => import('./HelpViewer').then((m) => ({ default: m.HelpViewer })));

/** The topic of the dialog in front: the last open dialog that names one, else the store's modal. */
export function currentHelpTopic(): string {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-help-topic]')].filter((d) => d.dataset.testid !== 'help-viewer');
  const top = dialogs[dialogs.length - 1];
  return top?.dataset.helpTopic || helpTopicFor(usePDFStore.getState().modal);
}

export function HelpHost() {
  const open = useHelp((s) => s.open);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const s = usePDFStore.getState();
      if (s.busy || s.presentation) return;
      // The user's own shortcut on F1 wins outside dialogs.
      if (!s.modal && !useHelp.getState().open && useCustomize.getState().shortcuts.some((x) => x.combo === 'F1')) return;
      e.preventDefault();
      e.stopPropagation();
      if (useHelp.getState().open) return;
      openHelp(currentHelpTopic());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return open ? (
    <Suspense fallback={null}>
      <HelpViewer />
    </Suspense>
  ) : null;
}
