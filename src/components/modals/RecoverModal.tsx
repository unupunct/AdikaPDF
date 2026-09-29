/** Shown at start-up when unsaved documents were left by a crash. */
import { useState } from 'react';
import { create } from 'zustand';
import { LifeBuoy } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Checkbox, Dialog } from '@/components/ui/primitives';
import type { BackupInfo } from '@/lib/recovery';

export const useRecoverList = create<{ items: BackupInfo[] }>()(() => ({ items: [] }));

export function RecoverModal() {
  const open = usePDFStore((s) => s.modal === 'recover');
  const items = useRecoverList((s) => s.items);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = chosen ?? new Set(items.map((i) => i.dir));
  const close = () => usePDFStore.getState().openModal(null);

  const recover = async () => {
    setBusy(true);
    try {
      const { recoverBackups, discardBackups } = await import('@/lib/recovery');
      const keep = items.filter((i) => picked.has(i.dir)).map((i) => i.dir);
      const n = await recoverBackups(keep);
      await discardBackups(items.filter((i) => !picked.has(i.dir)).map((i) => i.dir));
      useRecoverList.setState({ items: [] });
      close();
      usePDFStore.getState().toast(`Recovered ${n} document${n === 1 ? '' : 's'}. Save to keep the changes.`, 'success');
    } catch (e) {
      usePDFStore.getState().toast(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    const { discardBackups } = await import('@/lib/recovery');
    await discardBackups(items.map((i) => i.dir));
    useRecoverList.setState({ items: [] });
    close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && close()}
      title="Recover unsaved documents"
      description="Adika PDF Editor closed before these documents were saved. Their last automatic backups can be opened again."
      width={520}
      testId="recover-modal"
      footer={
        <>
          <Button onClick={() => void discard()} disabled={busy} data-testid="recover-discard">
            Discard
          </Button>
          <Button variant="primary" onClick={() => void recover()} disabled={busy || picked.size === 0} data-testid="recover-open">
            Recover
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {items.map((i) => (
          <div key={i.dir} className="flex items-center gap-2 rounded-md border border-app px-2.5 py-2">
            <LifeBuoy size={15} className="text-brand-600" />
            <div className="min-w-0 flex-1">
              <Checkbox
                checked={picked.has(i.dir)}
                onChange={(on) => {
                  const next = new Set(picked);
                  if (on) next.add(i.dir);
                  else next.delete(i.dir);
                  setChosen(next);
                }}
                label={<span data-no-translate className="font-medium">{i.fileName}</span>}
              />
              <div className="pl-6 text-[11px] text-muted">
                <span>{`${i.pages} page${i.pages === 1 ? '' : 's'}`}</span> · <span>{`${i.edits} edit${i.edits === 1 ? '' : 's'}`}</span> ·{' '}
                <span data-no-translate>{new Date(i.savedAt).toLocaleString()}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
