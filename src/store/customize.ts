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

export interface BuiltInShortcut {
  combo: string;
  /** What it does (English, translated when shown). */
  label: string;
  /** The same keys as `comboOf` may name them (e.g. Ctrl+Shift+- arrives as Ctrl+Shift+_). */
  aliases?: string[];
}

/** Shortcuts the app already uses (a custom one takes their place). Keep in step with useShortcuts. */
export const BUILT_IN_SHORTCUTS: BuiltInShortcut[] = [
  { combo: 'Ctrl+O', label: 'Open' },
  { combo: 'Ctrl+S', label: 'Save' },
  { combo: 'Ctrl+Shift+S', label: 'Save as' },
  { combo: 'Ctrl+P', label: 'Print' },
  { combo: 'Ctrl+W', label: 'Close document' },
  { combo: 'Ctrl+Tab', label: 'Next document' },
  { combo: 'Ctrl+Shift+Tab', label: 'Previous document' },
  { combo: 'Ctrl+F', label: 'Find' },
  { combo: 'Ctrl+H', label: 'Find and replace' },
  { combo: 'Ctrl+K', label: 'Tool search' },
  { combo: 'Ctrl+G', label: 'Go to page' },
  { combo: 'Ctrl+D', label: 'Document properties' },
  { combo: 'Ctrl+Z', label: 'Undo' },
  { combo: 'Ctrl+Y', label: 'Redo', aliases: ['Ctrl+Shift+Z'] },
  { combo: 'Ctrl+A', label: 'Select all' },
  { combo: 'Ctrl+C', label: 'Copy' },
  { combo: 'Ctrl+X', label: 'Cut' },
  { combo: 'Ctrl+V', label: 'Paste' },
  { combo: 'Ctrl+Shift+D', label: 'Duplicate' },
  { combo: 'Ctrl+=', label: 'Zoom in', aliases: ['Ctrl++'] },
  { combo: 'Ctrl+-', label: 'Zoom out' },
  { combo: 'Ctrl+0', label: 'Fit width' },
  { combo: 'Ctrl+Shift+-', label: 'Rotate view left', aliases: ['Ctrl+Shift+_'] },
  { combo: 'Ctrl+Shift++', label: 'Rotate view right', aliases: ['Ctrl+Shift+='] },
  { combo: 'Ctrl+\\', label: 'Split view' },
  { combo: 'Ctrl+Shift+H', label: 'Auto-scroll' },
  { combo: 'Ctrl+Shift+V', label: 'Read this page aloud' },
  { combo: 'Ctrl+Shift+B', label: 'Read to the end' },
  { combo: 'Ctrl+Shift+C', label: 'Pause or resume reading' },
  { combo: 'Ctrl+Shift+E', label: 'Stop reading' },
  { combo: 'Alt+ArrowLeft', label: 'Previous view' },
  { combo: 'Alt+ArrowRight', label: 'Next view' },
  { combo: 'F5', label: 'Presentation' },
  { combo: 'F7', label: 'Spelling' },
  { combo: 'F11', label: 'Full screen' },
  { combo: 'Delete', label: 'Delete' },
  { combo: 'Escape', label: 'Cancel' },
];

export const BUILT_IN = BUILT_IN_SHORTCUTS.flatMap((b) => [b.combo, ...(b.aliases ?? [])]);

/** The built-in shortcut on these keys, if any. */
export function builtInFor(combo: string): BuiltInShortcut | undefined {
  return BUILT_IN_SHORTCUTS.find((b) => b.combo === combo || b.aliases?.includes(combo));
}

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
