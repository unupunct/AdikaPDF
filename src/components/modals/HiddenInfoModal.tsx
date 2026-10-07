/** Protect → Hidden info: what the document carries besides its visible pages, with counts, examples and removal. */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog } from '@/components/ui/primitives';
import { HIDDEN_KINDS, type HiddenFinding, type HiddenKind } from '@/lib/pdf/hiddenInfo';

/** Kinds people often want to keep: not ticked by default. */
const KEEP_BY_DEFAULT = new Set<HiddenKind>(['formData', 'hiddenText', 'bookmarks', 'tags', 'comments']);

export function HiddenInfoModal() {
  const open = usePDFStore((s) => s.modal === 'hiddenInfo');
  const close = () => usePDFStore.getState().openModal(null);
  const [found, setFound] = useState<HiddenFinding[] | null>(null);
  const [chosen, setChosen] = useState<Set<HiddenKind>>(new Set());
  const [expanded, setExpanded] = useState<HiddenKind | null>(null);
  const [loading, setLoading] = useState(false);

  const scan = async () => {
    setLoading(true);
    try {
      const { scanCurrentHiddenInfo } = await import('@/actions/hiddenInfo');
      const r = await scanCurrentHiddenInfo();
      setFound(r);
      setChosen(new Set((r ?? []).filter((f) => f.count > 0 && !KEEP_BY_DEFAULT.has(f.kind)).map((f) => f.kind)));
    } catch (e) {
      usePDFStore.getState().toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void scan();
    else setFound(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const remove = async () => {
    const { removeCurrentHiddenInfo } = await import('@/actions/hiddenInfo');
    if (await removeCurrentHiddenInfo([...chosen])) await scan();
  };

  const byKind = new Map((found ?? []).map((f) => [f.kind, f]));
  const total = (found ?? []).reduce((n, f) => n + (f.count > 0 ? 1 : 0), 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Remove hidden information"
      description="What the document carries besides its visible pages. Tick what to remove; the change can be undone until you save."
      width={640}
      testId="hidden-info-modal"
      footer={
        <>
          <Button onClick={() => void scan()} disabled={loading} data-testid="hidden-info-rescan">
            <RefreshCw size={14} /> Scan again
          </Button>
          <div className="flex-1" />
          <Button onClick={close}>Close</Button>
          <Button variant="primary" disabled={loading || chosen.size === 0} onClick={() => void remove()} data-testid="hidden-info-remove">
            Remove selected
          </Button>
        </>
      }
    >
      {loading && !found ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> Scanning…
        </div>
      ) : null}
      {found && total === 0 ? <Callout kind="success">No hidden information found.</Callout> : null}
      {(byKind.get('revisions')?.count ?? 0) > 0 ? <Callout kind="warn">Any removal keeps only the current version of the file: earlier versions go, and digital signatures will no longer be valid.</Callout> : null}
      {found ? (
        <div className="divide-y divide-[var(--color-border)]">
          {HIDDEN_KINDS.map(({ kind, label, hint }) => {
            const f = byKind.get(kind);
            const count = f?.count ?? 0;
            const isOpen = expanded === kind && !!f?.preview.length;
            return (
              <div key={kind} className="py-1" data-testid={`hidden-${kind}`}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={chosen.has(kind)}
                    disabled={count === 0}
                    onChange={(v) => setChosen((c) => {
                      const next = new Set(c);
                      if (v) next.add(kind);
                      else next.delete(kind);
                      return next;
                    })}
                    label={label}
                  />
                  <span className="text-xs text-muted" data-no-translate>
                    {count}
                  </span>
                  <div className="flex-1" />
                  {f?.preview.length ? (
                    <button type="button" className="flex items-center gap-1 text-xs text-muted hover:text-[var(--color-fg)]" onClick={() => setExpanded(isOpen ? null : kind)}>
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details
                    </button>
                  ) : null}
                </div>
                <div className="pl-6 text-[11px] text-muted">{hint}</div>
                {isOpen ? (
                  <ul className="mt-1 max-h-40 overflow-auto rounded border border-[var(--color-border)] px-2 py-1 pl-6 text-[11px]" data-no-translate>
                    {f!.preview.map((p, i) => (
                      <li key={i} className="truncate" title={p}>
                        {p}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </Dialog>
  );
}
