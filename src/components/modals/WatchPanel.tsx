/** Batch → Watched folders: PDFs arriving in a folder are processed with a saved sequence while Adika runs. */
import { useEffect, useState } from 'react';
import { CheckCircle2, FolderOpen, MinusCircle, Plus, Trash2, XCircle } from 'lucide-react';
import { Button, Callout, Checkbox, Select } from '@/components/ui/primitives';
import { isDesktop, pickFolder } from '@/lib/platform';
import { CLI_HELP } from '@/lib/cli';
import type { ActionSequence } from '@/lib/batch';
import type { WatchedFolder, WatchEvent } from '@/actions/automation';

export function WatchPanel({ sequences }: { sequences: ActionSequence[] }) {
  const [list, setList] = useState<WatchedFolder[]>([]);
  const [events, setEvents] = useState<WatchEvent[]>([]);

  useEffect(() => {
    let off: (() => void) | undefined;
    void import('@/actions/automation').then((m) => {
      setList(m.loadWatched());
      setEvents(m.watchEvents());
      off = m.onWatchEvents(() => setEvents(m.watchEvents()));
    });
    return () => off?.();
  }, []);

  const save = (next: WatchedFolder[]) => {
    setList(next);
    void import('@/actions/automation').then((m) => m.saveWatched(next));
  };
  const change = (id: string, p: Partial<WatchedFolder>) => save(list.map((w) => (w.id === id ? { ...w, ...p } : w)));
  const add = async () => {
    const folder = await pickFolder();
    if (!folder) return;
    save([...list, { id: `watch-${Date.now().toString(36)}`, folder, sequenceId: sequences[0]?.id ?? '', outFolder: '', enabled: !!sequences[0] }]);
  };

  return (
    <div data-testid="watch-panel">
      {!isDesktop ? <Callout kind="warn">Watched folders need the Adika desktop app.</Callout> : null}
      <p className="mb-2 text-xs text-muted">
        PDFs copied into a watched folder are processed with a saved action sequence while Adika is open. Results go to the folder&apos;s Output subfolder (or the one you choose); the originals move to Processed (or Failed).
      </p>
      {!sequences.length ? <Callout kind="info">Save an action sequence first (Action sequence tab).</Callout> : null}
      <div className="mb-2 grid gap-2">
        {list.map((w) => (
          <div key={w.id} className="rounded-md border border-app p-2 text-xs" data-testid="watch-item">
            <div className="mb-1 flex items-center gap-2">
              <Checkbox checked={w.enabled} onChange={(v) => change(w.id, { enabled: v })} label="" ariaLabel="Watch this folder" />
              <span className="min-w-0 flex-1 truncate font-medium" title={w.folder} data-no-translate>
                {w.folder}
              </span>
              <Button size="icon" variant="ghost" aria-label="Stop watching this folder" onClick={() => save(list.filter((x) => x.id !== w.id))}>
                <Trash2 size={13} />
              </Button>
            </div>
            <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
              <Select
                value={w.sequenceId}
                ariaLabel="Sequence"
                onChange={(v: string) => change(w.id, { sequenceId: v })}
                options={[{ value: '', label: '(choose a sequence)' }, ...sequences.map((s) => ({ value: s.id, label: s.name }))]}
              />
              <Button
                size="sm"
                onClick={async () => {
                  const f = await pickFolder();
                  if (f) change(w.id, { outFolder: f });
                }}
                title={w.outFolder || 'Output subfolder'}
              >
                <FolderOpen size={13} /> <span className="truncate">{w.outFolder ? w.outFolder.split(/[\\/]/).pop() : 'Output subfolder'}</span>
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button size="sm" onClick={() => void add()} disabled={!isDesktop} data-testid="watch-add">
        <Plus size={13} /> Watch a folder…
      </Button>
      {events.length ? (
        <ul className="mt-3 max-h-32 overflow-auto rounded-md border border-app text-[11px]" data-testid="watch-events">
          {events.map((e, i) => (
            <li key={i} className="flex items-center gap-2 border-b border-app px-2 py-1 last:border-0">
              {e.status === 'done' ? <CheckCircle2 size={12} className="text-accent-600" /> : e.status === 'skipped' ? <MinusCircle size={12} className="text-amber-600" /> : <XCircle size={12} className="text-rose-600" />}
              <span className="text-muted">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="min-w-0 flex-1 truncate" data-no-translate>
                {`${e.file} → ${e.message}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="mt-3 text-xs">
        <summary className="cursor-default text-brand-600">Command line…</summary>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--hover)] p-2 text-[11px]" data-no-translate data-testid="cli-help">
          {CLI_HELP}
        </pre>
      </details>
    </div>
  );
}
