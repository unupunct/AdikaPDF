/** The help viewer: open or not, the page shown, back / forward history and the search text. */
import { create } from 'zustand';
import { parseTopic } from '@/lib/help/guide';

export interface HelpLocation {
  page: string;
  anchor: string | null;
}

interface HelpState extends HelpLocation {
  open: boolean;
  back: HelpLocation[];
  forward: HelpLocation[];
  query: string;
  /** Changes on every navigation (the viewer scrolls again even to the same heading). */
  nonce: number;
  /** Opens the help at a topic ("page" or "page#heading"); the start page when none is given. */
  openHelp: (topic?: string | null) => void;
  close: () => void;
  /** Shows another page (or heading); the current one goes on the back list. */
  go: (page: string, anchor?: string | null) => void;
  goBack: () => void;
  goForward: () => void;
  setQuery: (q: string) => void;
}

const same = (a: HelpLocation, b: HelpLocation) => a.page === b.page && a.anchor === b.anchor;

export const useHelp = create<HelpState>()((set, get) => ({
  open: false,
  page: 'index',
  anchor: null,
  back: [],
  forward: [],
  query: '',
  nonce: 0,
  openHelp: (topic) => {
    const to = parseTopic(topic);
    const s = get();
    if (s.open && same(s, to)) return;
    if (s.open) get().go(to.page, to.anchor);
    else set({ open: true, page: to.page, anchor: to.anchor, back: [], forward: [], query: '', nonce: s.nonce + 1 });
  },
  close: () => set({ open: false }),
  go: (page, anchor = null) => {
    const s = get();
    const to = { page, anchor };
    if (same(s, to)) {
      set({ nonce: s.nonce + 1 });
      return;
    }
    set({ page, anchor, back: [...s.back, { page: s.page, anchor: s.anchor }].slice(-50), forward: [], nonce: s.nonce + 1 });
  },
  goBack: () => {
    const s = get();
    const prev = s.back[s.back.length - 1];
    if (!prev) return;
    set({ ...prev, back: s.back.slice(0, -1), forward: [{ page: s.page, anchor: s.anchor }, ...s.forward], nonce: s.nonce + 1 });
  },
  goForward: () => {
    const s = get();
    const next = s.forward[0];
    if (!next) return;
    set({ ...next, forward: s.forward.slice(1), back: [...s.back, { page: s.page, anchor: s.anchor }], nonce: s.nonce + 1 });
  },
  setQuery: (query) => set({ query }),
}));

/** Opens the help (F1, the Help button, a dialog's "?"). */
export function openHelp(topic?: string | null): void {
  useHelp.getState().openHelp(topic);
}
