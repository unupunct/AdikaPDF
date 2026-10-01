/**
 * Your own Quick Access toolbar and keyboard shortcuts. Commands are ribbon
 * buttons, remembered by their tab and English label (so they survive a
 * change of interface language); kept in this computer's app storage.
 */
import { create } from 'zustand';
import type { RibbonTab } from '@/types';

export interface CommandRef {
  tab: RibbonTab;
  /** The button's English label. */
  en: string;
}

export interface QuickItem extends CommandRef {
  /** The button's icon (SVG markup taken from the ribbon). */
  svg: string;
}

export interface CustomShortcut extends CommandRef {
  /** e.g. "Ctrl+Shift+E", "Alt+1", "F9". */
  combo: string;
}

interface Customize {
  quick: QuickItem[];
  shortcuts: CustomShortcut[];
  setQuick: (q: QuickItem[]) => void;
  setShortcuts: (s: CustomShortcut[]) => void;
}

const KEY = 'adika.customize';

function load(): Pick<Customize, 'quick' | 'shortcuts'> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Customize>;
    return { quick: Array.isArray(v.quick) ? v.quick : [], shortcuts: Array.isArray(v.shortcuts) ? v.shortcuts : [] };
  } catch {
    return { quick: [], shortcuts: [] };
  }
}

function save(c: Pick<Customize, 'quick' | 'shortcuts'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable: kept for this session */
  }
}

export const useCustomize = create<Customize>()((set, get) => ({
  ...load(),
  setQuick: (quick) => {
    set({ quick });
    save({ quick, shortcuts: get().shortcuts });
  },
  setShortcuts: (shortcuts) => {
    set({ shortcuts });
    save({ quick: get().quick, shortcuts });
  },
}));

/** The key combination of a keyboard event ("Ctrl+Shift+E"), or null for a lone modifier. */
export function comboOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return null;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key === ' ' ? 'Space' : e.key;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

/** Shortcuts the app already uses (a custom one takes their place). */
export const BUILT_IN = ['Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+P', 'Ctrl+F', 'Ctrl+H', 'Ctrl+K', 'Ctrl+W', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+D', 'Ctrl+G', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Tab', 'F5', 'F7', 'F11', 'Delete', 'Escape'];

/** Single letters, digits and plain keys are for tools and typing: a shortcut needs Ctrl or Alt, or a function key. */
export function usableCombo(combo: string): boolean {
  return /^(Ctrl|Alt)\+/.test(combo) || /^(Shift\+)?F([1-9]|1[0-2])$/.test(combo);
}

/** Shows the command's tab and clicks its button. */
export async function runCommand(c: CommandRef): Promise<void> {
  const { usePDFStore } = await import('./usePDFStore');
  const { originalAttr } = await import('@/lib/i18n');
  usePDFStore.getState().setRibbonTab(c.tab);
  window.setTimeout(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="ribbon"] button[aria-label]')].find((b) => (originalAttr(b, 'aria-label') ?? b.getAttribute('aria-label')) === c.en);
    if (btn && !btn.disabled) btn.click();
  }, 60);
}
