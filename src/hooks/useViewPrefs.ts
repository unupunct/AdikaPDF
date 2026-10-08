/**
 * Remembers the panels (sidebar, inspector), page layout and fit mode between
 * sessions, in this computer's browser storage.
 */
import { useEffect } from 'react';
import { usePDFStore } from '@/store/usePDFStore';

const KEY = 'adika.viewPrefs';

export interface ViewPrefs {
  sidebarOpen?: boolean;
  inspectorOpen?: boolean;
  viewScroll?: 'continuous' | 'single';
  viewSpread?: 'none' | 'odd' | 'even';
  fit?: 'width' | 'page';
}

export function loadViewPrefs(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as ViewPrefs;
    const out: ViewPrefs = {};
    if (typeof v.sidebarOpen === 'boolean') out.sidebarOpen = v.sidebarOpen;
    if (typeof v.inspectorOpen === 'boolean') out.inspectorOpen = v.inspectorOpen;
    if (v.viewScroll === 'continuous' || v.viewScroll === 'single') out.viewScroll = v.viewScroll;
    if (v.viewSpread === 'none' || v.viewSpread === 'odd' || v.viewSpread === 'even') out.viewSpread = v.viewSpread;
    if (v.fit === 'width' || v.fit === 'page') out.fit = v.fit;
    return out;
  } catch {
    return {};
  }
}

function saveViewPrefs(p: ViewPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: kept for this session */
  }
}

/** The first page's id: changes when another document is opened or another tab shown. */
const docKey = (s: ReturnType<typeof usePDFStore.getState>) => s.pages[0]?.id ?? null;

export function useViewPrefs(): void {
  useEffect(() => {
    const prefs = loadViewPrefs();
    const { fit, ...panels } = prefs;
    usePDFStore.setState(panels);
    let doc = docKey(usePDFStore.getState());
    const seen = new Set<string>();
    return usePDFStore.subscribe((s, prev) => {
      const key = docKey(s);
      if (key !== doc) {
        doc = key;
        // A newly opened document starts at the remembered fit (opening resets it to width).
        // (Only the first time it is shown: a tab switched back to keeps its own fit.)
        if (key && !seen.has(key) && prefs.fit === 'page' && s.fitMode === 'width') s.setZoom(s.zoom, 'page');
        if (key) seen.add(key);
        return;
      }
      const changed =
        s.sidebarOpen !== prev.sidebarOpen || s.inspectorOpen !== prev.inspectorOpen || s.viewScroll !== prev.viewScroll || s.viewSpread !== prev.viewSpread || (s.fitMode !== prev.fitMode && s.fitMode !== null);
      if (!changed) return;
      prefs.sidebarOpen = s.sidebarOpen;
      prefs.inspectorOpen = s.inspectorOpen;
      prefs.viewScroll = s.viewScroll;
      prefs.viewSpread = s.viewSpread;
      if (s.fitMode) prefs.fit = s.fitMode;
      saveViewPrefs(prefs);
    });
  }, []);
}
