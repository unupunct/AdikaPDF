/**
 * Customize: your own Quick Access toolbar (any ribbon command, shown next
 * to the logo) and keyboard shortcuts for any command. The commands are read
 * from the ribbon itself, rendered off-screen, like the tool search.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Keyboard, Plus, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { BUILT_IN_SHORTCUTS, builtInFor, comboOf, usableCombo, useCustomize, type CommandRef } from '@/store/customize';
import { RIBBON_TABS, TabContent } from '@/components/ribbon/Ribbon';
import { originalAttr, translate } from '@/lib/i18n';
import { normalizeForSearch } from '@/lib/search';
import { Button, Callout, Dialog, Input, Tabs } from '@/components/ui/primitives';
import type { RibbonTab } from '@/types';

interface Cmd extends CommandRef {
  label: string;
  svg: string;
  hay: string;
}

const same = (a: CommandRef, b: CommandRef) => a.tab === b.tab && a.en === b.en;

export function CustomizeModal() {
  const open = usePDFStore((s) => s.modal === 'customize');
  const close = () => usePDFStore.getState().openModal(null);
  const { quick, shortcuts, setQuick, setShortcuts } = useCustomize();
  const [tab, setTab] = useState<'quick' | 'keys'>('quick');
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [query, setQuery] = useState('');
  const [capture, setCapture] = useState<Cmd | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const hidden = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const root = hidden.current;
      if (!root) return;
      const out: Cmd[] = [];
      const seen = new Set<string>();
      root.querySelectorAll<HTMLElement>('[data-tab]').forEach((tabEl) => {
        const tb = tabEl.dataset.tab as RibbonTab;
        tabEl.querySelectorAll<HTMLButtonElement>('button[aria-label]:not([aria-haspopup])').forEach((b) => {
          const en = originalAttr(b, 'aria-label') ?? '';
          if (!en || seen.has(`${tb}:${en}`)) return;
          seen.add(`${tb}:${en}`);
          const label = b.getAttribute('aria-label') ?? en;
          out.push({ tab: tb, en, label, svg: b.querySelector('svg')?.outerHTML ?? '', hay: normalizeForSearch(`${label} ${en}`, false) });
        });
      });
      setCmds(out);
    }, 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapture(null);
        return;
      }
      const combo = comboOf(e);
      if (!combo) return;
      if (!usableCombo(combo)) {
        setWarning(translate('Use Ctrl or Alt with a key, or a function key (F1–F12).'));
        return;
      }
      // Keys already taken: by another command of yours, or by a built-in shortcut.
      const taken = shortcuts.find((s) => s.combo === combo && !same(s, capture));
      const builtIn = builtInFor(combo);
      setWarning(
        taken
          ? translate('{0} ran “{1}”: it now runs this command.').replace('{0}', combo).replace('{1}', labelOf(taken))
          : builtIn
            ? translate('{0} was a built-in shortcut: it now runs this command.').replace('{0}', combo)
            : null,
      );
      setShortcuts([...shortcuts.filter((s) => s.combo !== combo && !same(s, capture)), { tab: capture.tab, en: capture.en, combo }]);
      setCapture(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture, shortcuts, setShortcuts]);

  const shown = useMemo(() => {
    const w = normalizeForSearch(query, false).split(/\s+/).filter(Boolean);
    return cmds.filter((c) => w.every((x) => c.hay.includes(x))).slice(0, 200);
  }, [cmds, query]);
  const tabName = (t: RibbonTab) => translate(RIBBON_TABS.find((x) => x.id === t)?.label ?? t);
  const labelOf = (c: CommandRef) => cmds.find((x) => same(x, c))?.label ?? translate(c.en);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Customize" width={720} testId="customize-modal" footer={<Button onClick={close}>Close</Button>}>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'quick', label: 'Quick Access toolbar' },
          { value: 'keys', label: 'Keyboard shortcuts' },
        ]}
      />
      <div className="grid grid-cols-2 gap-4">
        <div className="flex min-h-0 flex-col">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a command…" aria-label="Find a command" data-testid="customize-search" />
          <div className="mt-2 h-[320px] overflow-auto rounded-md border border-app">
            {shown.map((c) => (
              <div key={`${c.tab}:${c.en}`} className="flex items-center gap-2 border-b border-app px-2 py-1 text-[12.5px] last:border-0" data-testid="customize-command">
                <span className="h-4 w-4 shrink-0 [&>svg]:h-4 [&>svg]:w-4" dangerouslySetInnerHTML={{ __html: c.svg }} />
                <span className="min-w-0 flex-1 truncate" data-no-translate>
                  {c.label}
                </span>
                <span className="shrink-0 text-[10.5px] text-muted" data-no-translate>
                  {tabName(c.tab)}
                </span>
                {tab === 'quick' ? (
                  <button type="button" aria-label="Add to Quick Access" title={translate('Add to Quick Access')} disabled={quick.some((q) => same(q, c))} className="rounded p-1 hover-app disabled:opacity-30" onClick={() => setQuick([...quick, { tab: c.tab, en: c.en, svg: c.svg }])} data-testid="customize-add">
                    <Plus size={13} />
                  </button>
                ) : (
                  <button type="button" aria-label="Set shortcut" title={translate('Set shortcut')} className="rounded p-1 hover-app" onClick={() => (setWarning(null), setCapture(c))} data-testid="customize-set-key">
                    <Keyboard size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          {tab === 'quick' ? (
            <>
              <p className="mb-2 text-xs text-muted">Shown next to the logo, on every tab.</p>
              <div className="h-[320px] overflow-auto rounded-md border border-app" data-testid="customize-quick">
                {quick.length === 0 ? <p className="p-3 text-xs text-muted">No commands yet: add some with +.</p> : null}
                {quick.map((q, i) => (
                  <div key={`${q.tab}:${q.en}`} className="flex items-center gap-2 border-b border-app px-2 py-1 text-[12.5px] last:border-0">
                    <span className="h-4 w-4 shrink-0 [&>svg]:h-4 [&>svg]:w-4" dangerouslySetInnerHTML={{ __html: q.svg }} />
                    <span className="min-w-0 flex-1 truncate" data-no-translate>
                      {labelOf(q)}
                    </span>
                    <button type="button" aria-label="Move up" disabled={i === 0} className="rounded p-1 hover-app disabled:opacity-30" onClick={() => setQuick(quick.map((x, j) => (j === i - 1 ? q : j === i ? quick[i - 1] : x)))}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" aria-label="Move down" disabled={i === quick.length - 1} className="rounded p-1 hover-app disabled:opacity-30" onClick={() => setQuick(quick.map((x, j) => (j === i + 1 ? q : j === i ? quick[i + 1] : x)))}>
                      <ArrowDown size={13} />
                    </button>
                    <button type="button" aria-label="Remove" className="rounded p-1 hover-app" onClick={() => setQuick(quick.filter((_, j) => j !== i))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted">Click the keyboard next to a command, then press the keys (Esc cancels).</p>
              {capture ? (
                <Callout kind="info">
                  <span data-testid="customize-capturing">{translate('Press the keys for “{0}”…').replace('{0}', capture.label)}</span>
                </Callout>
              ) : null}
              {warning ? <Callout kind="warn">{warning}</Callout> : null}
              <div className="mt-2 h-[120px] overflow-auto rounded-md border border-app" data-testid="customize-keys">
                {shortcuts.length === 0 ? <p className="p-3 text-xs text-muted">No shortcuts of your own yet.</p> : null}
                {shortcuts.map((k) => (
                  <div key={k.combo} className="flex items-center gap-2 border-b border-app px-2 py-1 text-[12.5px] last:border-0">
                    <kbd className="shrink-0 rounded border border-app bg-panel-2 px-1.5 text-[11px]" data-no-translate>
                      {k.combo}
                    </kbd>
                    <span className="min-w-0 flex-1 truncate" data-no-translate>
                      {labelOf(k)}
                    </span>
                    <button type="button" aria-label="Remove" className="rounded p-1 hover-app" onClick={() => setShortcuts(shortcuts.filter((x) => x.combo !== k.combo))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Built-in shortcuts</div>
              <div className="h-[130px] overflow-auto rounded-md border border-app" data-testid="customize-builtin">
                {BUILT_IN_SHORTCUTS.map((b) => {
                  const mine = shortcuts.find((k) => k.combo === b.combo || b.aliases?.includes(k.combo));
                  return (
                    <div key={b.combo} className="flex items-center gap-2 border-b border-app px-2 py-0.5 text-[12px] last:border-0">
                      <kbd className={`shrink-0 rounded border border-app bg-panel-2 px-1.5 text-[11px] ${mine ? 'line-through opacity-60' : ''}`} data-no-translate>
                        {b.combo}
                      </kbd>
                      <span className={`min-w-0 flex-1 truncate ${mine ? 'text-muted' : ''}`}>{b.label}</span>
                      {mine ? (
                        <span className="shrink-0 text-[10.5px] text-muted" data-no-translate>
                          {translate('Replaced by “{0}”').replace('{0}', labelOf(mine))}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
      <div ref={hidden} aria-hidden="true" style={{ position: 'fixed', left: -20000, top: 0, width: 6000, pointerEvents: 'none' }}>
        {open
          ? RIBBON_TABS.map((t) => (
              <div key={t.id} data-tab={t.id} className="flex">
                <TabContent tab={t.id} />
              </div>
            ))
          : null}
      </div>
    </Dialog>
  );
}

/** The Quick Access toolbar (next to the logo). */
export function QuickAccessBar() {
  const quick = useCustomize((c) => c.quick);
  if (!quick.length) return null;
  return (
    <div className="flex items-center gap-0.5" data-testid="quick-access">
      {quick.map((q) => (
        <button
          key={`${q.tab}:${q.en}`}
          type="button"
          aria-label={q.en}
          title={translate(q.en)}
          data-testid="quick-access-item"
          className="flex h-8 w-8 items-center justify-center rounded-md hover-app [&>svg]:h-[17px] [&>svg]:w-[17px]"
          onClick={() => void import('@/store/customize').then((m) => m.runCommand(q))}
          dangerouslySetInnerHTML={{ __html: q.svg }}
        />
      ))}
    </div>
  );
}
