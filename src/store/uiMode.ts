/**
 * Simple or full ribbon, and the first-run welcome. New installations start
 * with the simple ribbon and the welcome; people who used Adika before (any
 * other setting of ours in this profile) keep the full ribbon. Imported
 * first by main.tsx, so the decision is taken before anything else stores
 * a setting.
 */
import { create } from 'zustand';
import type { RibbonTab } from '@/types';

export type RibbonMode = 'simple' | 'full';

export const MODE_KEY = 'adika.ribbonMode';
export const WELCOME_KEY = 'adika.welcome';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Any other Adika setting in this profile: recent files, theme, language, signatures, Quick Access… */
export function usedBefore(st: Storage | null): boolean {
  if (!st) return false;
  for (let k = 0; k < st.length; k++) {
    const key = st.key(k);
    if (key && key.startsWith('adika.') && key !== MODE_KEY && key !== WELCOME_KEY) return true;
  }
  return false;
}

export function storedMode(st: Storage | null): RibbonMode | null {
  const v = st?.getItem(MODE_KEY);
  return v === 'simple' || v === 'full' ? v : null;
}

/** The stored choice; else simple for a new installation, full for someone who used Adika before. */
export function initialMode(st: Storage | null): RibbonMode {
  return storedMode(st) ?? (usedBefore(st) ? 'full' : 'simple');
}

/** Show the welcome at start: asked to ("show"), or a new installation that never closed it. */
export function welcomeDue(st: Storage | null): boolean {
  const v = st?.getItem(WELCOME_KEY);
  if (v === 'hide') return false;
  if (v === 'show') return true;
  return !usedBefore(st);
}

function write(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* storage unavailable: kept for this session */
  }
}

interface UiMode {
  mode: RibbonMode;
  /** A full-ribbon tab shown for a while in simple mode (a command found by the tool search or Quick Access). */
  peek: RibbonTab | null;
  welcome: boolean;
  /** Groups that do not fit collapse into a button (off in end-to-end tests: they click buttons by position). */
  collapse: boolean;
  setMode: (mode: RibbonMode) => void;
  setPeek: (tab: RibbonTab | null) => void;
  openWelcome: () => void;
  /** Closes the welcome; `again` shows it at the next start too. */
  closeWelcome: (again: boolean) => void;
  /** End-to-end tests: the full ribbon (tests click its buttons), no collapsed groups and no welcome. */
  e2eDefaults: () => void;
}

function decide(): Pick<UiMode, 'mode' | 'welcome'> {
  const st = storage();
  const mode = initialMode(st);
  const welcome = welcomeDue(st) && !(typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('adopt'));
  // Remember the decision: opening a file later must not turn a new user into an "existing" one.
  if (!storedMode(st)) write(MODE_KEY, mode);
  return { mode, welcome };
}

export const useUiMode = create<UiMode>()((set) => ({
  ...decide(),
  peek: null,
  collapse: true,
  setMode: (mode) => {
    write(MODE_KEY, mode);
    set({ mode, peek: null });
  },
  setPeek: (peek) => set({ peek }),
  openWelcome: () => set({ welcome: true }),
  closeWelcome: (again) => {
    write(WELCOME_KEY, again ? 'show' : 'hide');
    set({ welcome: false });
  },
  e2eDefaults: () => set({ mode: 'full', peek: null, welcome: false, collapse: false }),
}));

/** Ribbon buttons that run commands (not the buttons of collapsed groups). */
const BUTTONS = '[data-testid="ribbon"] button[aria-label]:not([data-ribbon-collapse])';

export function ribbonButton(match: (b: HTMLButtonElement) => boolean): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>(BUTTONS)].find(match);
}

/**
 * Runs a ribbon command found by the tool search or Quick Access: the button
 * of the simple ribbon when it has one, otherwise the command's full tab is
 * shown (in simple mode for a while, with a way back) and its button clicked.
 */
export async function runRibbonCommand(tab: RibbonTab, match: (b: HTMLButtonElement) => boolean): Promise<void> {
  const { usePDFStore } = await import('./usePDFStore');
  const ui = useUiMode.getState();
  if (ui.mode === 'simple' && !ui.peek) {
    const b = ribbonButton(match);
    if (b) {
      if (!b.disabled) b.click();
      return;
    }
    ui.setPeek(tab);
  }
  usePDFStore.getState().setRibbonTab(tab);
  window.setTimeout(() => {
    const b = ribbonButton(match);
    if (b && !b.disabled) b.click();
  }, 60);
}
