/**
 * Tool search (Ctrl+K): finds any ribbon command by name or description, in
 * the interface language or in English. The index is the ribbon itself:
 * every tab is rendered off-screen and its buttons are read, so the search
 * always matches what the ribbon offers; running a result clicks that button
 * and shows its tab.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Search } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { RIBBON_TABS, TabContent } from '@/components/ribbon/Ribbon';
import { normalizeForSearch } from '@/lib/search';
import { originalAttr, translate } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useTabs } from '@/store/tabs';
import type { RibbonTab } from '@/types';

export const usePalette = create<{ open: boolean }>()(() => ({ open: false }));

interface Item {
  key: string;
  tab: RibbonTab | null;
  label: string;
  tip: string;
  hay: string;
  disabled: boolean;
  run: () => void;
}

const fold = (s: string) => normalizeForSearch(s, false);

/** Clicks the button with this label in the visible ribbon. */
function clickRibbon(label: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="ribbon"] button[aria-label]')].find((b) => b.getAttribute('aria-label') === label);
  btn?.click();
}

function extras(): Item[] {
  const s = usePDFStore.getState();
  const mk = (key: string, label: string, tip: string, run: () => void): Item => ({ key, tab: null, label: translate(label), tip: translate(tip), hay: fold(`${label} ${tip} ${translate(label)} ${translate(tip)}`), disabled: false, run });
  return [
    mk('replace', 'Find & replace', 'Replace text everywhere (Ctrl+H)', () => s.setSearch({ open: true, replace: true })),
    mk('theme', 'Dark mode', 'Switch between light and dark', () => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')),
    mk('lang', 'Language', 'Interface language: the next one (English, Română, Deutsch, Français, Magyar, Italiano, Español)', () =>
      void import('@/lib/i18n').then((m) => {
        const i = m.LANGS.findIndex((l) => l.id === m.useLang.getState().lang);
        return m.useLang.getState().setLang(m.LANGS[(i + 1) % m.LANGS.length].id);
      }),
    ),
    mk('about', 'About', 'Version, updates, shortcuts and logs', () => s.openModal('about')),
    mk('newwindow', 'Move to a new window', 'Open this document in a window of its own', () => void import('@/actions/windows').then((m) => m.moveTabToWindow(useTabs.getState().activeId))),
    mk('customize', 'Customize', 'Quick Access toolbar and keyboard shortcuts', () => s.openModal('customize')),
  ];
}

export function CommandPalette() {
  const open = usePalette((p) => p.open);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const hidden = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => usePalette.setState({ open: false });

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  // Read the off-screen ribbon once it (and its translation) is in the DOM.
  useLayoutEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const root = hidden.current;
      if (!root) return;
      const found: Item[] = [];
      const seen = new Set<string>();
      root.querySelectorAll<HTMLElement>('[data-tab]').forEach((tabEl) => {
        const tab = tabEl.dataset.tab as RibbonTab;
        tabEl.querySelectorAll<HTMLButtonElement>('button[aria-label]:not([aria-haspopup])').forEach((b, i) => {
          const label = b.getAttribute('aria-label') ?? '';
          const tip = b.dataset.tip ?? '';
          if (!label || seen.has(`${tab}:${label}`)) return;
          seen.add(`${tab}:${label}`);
          const en = `${originalAttr(b, 'aria-label') ?? ''} ${originalAttr(b, 'data-tip') ?? ''}`;
          found.push({ key: `${tab}-${i}`, tab, label, tip: tip === label ? '' : tip, hay: fold(`${label} ${tip} ${en}`), disabled: b.disabled, run: () => clickRibbon(label) });
        });
      });
      setItems([...found, ...extras()]);
    }, 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const results = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored = items
      .filter((it) => words.every((w) => it.hay.includes(w)))
      .map((it) => {
        const l = fold(it.label);
        const score = (l.startsWith(words[0]) ? 0 : l.split(/[\s/&(-]+/).some((p) => p.startsWith(words[0])) ? 1 : l.includes(words[0]) ? 2 : 3) + (it.disabled ? 5 : 0);
        return { it, score };
      })
      .sort((a, b) => a.score - b.score || a.it.label.length - b.it.label.length);
    return scored.slice(0, 12).map((x) => x.it);
  }, [items, query]);

  const tabName = (id: RibbonTab | null) => (id ? translate(RIBBON_TABS.find((t) => t.id === id)?.label ?? '') : '');

  // Close first (focus back in the app), show the tab, then run: a dialog the
  // command opens would otherwise close again when this box goes away.
  const run = (it: Item | undefined) => {
    if (!it || it.disabled) return;
    close();
    if (it.tab) usePDFStore.getState().setRibbonTab(it.tab);
    window.setTimeout(it.run, 60);
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]" onMouseDown={close} data-testid="palette">
      <div className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-app bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-app px-3">
          <Search size={16} className="text-muted" />
          <input
            ref={input}
            value={query}
            data-testid="palette-input"
            placeholder="Search tools and commands…"
            className="h-11 flex-1 bg-transparent text-[14px] outline-none"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') run(results[active]);
            }}
          />
          <kbd className="rounded border border-app px-1.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-auto py-1" data-testid="palette-results">
          {results.map((it, i) => (
            <li key={it.key}>
              <button
                type="button"
                disabled={it.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(it)}
                data-testid="palette-item"
                className={cn('flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] disabled:opacity-40', i === active && 'bg-brand-50 dark:bg-brand-900/40')}
              >
                <span className="font-medium">{it.label}</span>
                {it.tip ? <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{it.tip}</span> : <span className="flex-1" />}
                <span className="text-[11px] text-muted">{tabName(it.tab)}</span>
              </button>
            </li>
          ))}
          {query.trim() && !results.length ? <li className="px-3 py-3 text-[12.5px] text-muted">Nothing found.</li> : null}
          {!query.trim() ? <li className="px-3 py-3 text-[12.5px] text-muted">Type what you want to do, e.g. compress, watermark, signature, OCR.</li> : null}
        </ul>
      </div>
      {/* The ribbon of every tab, off-screen: the search index. */}
      <div ref={hidden} aria-hidden="true" style={{ position: 'fixed', left: -20000, top: 0, width: 6000, pointerEvents: 'none' }}>
        {RIBBON_TABS.map((t) => (
          <div key={t.id} data-tab={t.id} className="flex">
            <TabContent tab={t.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
