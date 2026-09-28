/** The Tools hub: the ten one-click conversions, plus merge ordering. */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Combine, FileArchive, FileImage, FileInput, FileSpreadsheet, FileText, Image as ImageIcon, Presentation, Sheet, Trash2, Type } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Dialog } from '@/components/ui/primitives';
import { QUICK_TOOLS, mergeFiles, pickPdfsForMerge, runQuickTool, type QuickToolId } from '@/actions/quickTools';
import type { PickedFile } from '@/lib/platform';

const ICONS: Record<QuickToolId, { icon: React.ReactNode; color: string }> = {
  'pdf-word': { icon: <FileText size={22} />, color: '#2563eb' },
  'pdf-jpg': { icon: <FileImage size={22} />, color: '#d97706' },
  'word-pdf': { icon: <Type size={22} />, color: '#1d4ed8' },
  'jpg-pdf': { icon: <ImageIcon size={22} />, color: '#ca8a04' },
  merge: { icon: <Combine size={22} />, color: '#7c3aed' },
  'pdf-ppt': { icon: <Presentation size={22} />, color: '#ea580c' },
  compress: { icon: <FileArchive size={22} />, color: '#059669' },
  'ppt-pdf': { icon: <FileInput size={22} />, color: '#c2410c' },
  'pdf-excel': { icon: <FileSpreadsheet size={22} />, color: '#16a34a' },
  'excel-pdf': { icon: <Sheet size={22} />, color: '#15803d' },
};

/** Tile grid used in the Tools dialog and on the welcome screen. */
export function QuickToolGrid({ onPick, compact = false }: { onPick: (id: QuickToolId) => void; compact?: boolean }) {
  return (
    <div className={compact ? 'grid grid-cols-5 gap-2' : 'grid grid-cols-2 gap-3 sm:grid-cols-5'} data-testid="quick-tools">
      {QUICK_TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          data-testid={`quick-${t.id}`}
          onClick={() => onPick(t.id)}
          title={t.hint}
          className="flex flex-col items-center gap-1.5 rounded-lg border border-app bg-panel px-2 py-3 text-center hover:border-brand-400 hover:shadow-sm"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg text-white" style={{ background: ICONS[t.id].color }}>
            {ICONS[t.id].icon}
          </span>
          <span className="text-[12px] font-semibold leading-tight">{t.title}</span>
          {compact ? null : <span className="text-[10.5px] leading-tight text-muted">{t.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** Starts a tool from anywhere (welcome screen, ribbon). Merge opens the ordering dialog. */
export async function startQuickTool(id: QuickToolId): Promise<void> {
  if (id === 'merge') {
    const files = await pickPdfsForMerge();
    if (files.length === 0) return;
    mergeQueue = files;
    usePDFStore.getState().openModal('tools');
    window.dispatchEvent(new Event('adika:merge-queue'));
    return;
  }
  usePDFStore.getState().openModal(null);
  await runQuickTool(id);
}

let mergeQueue: PickedFile[] = [];

export function ToolsModal() {
  const open = usePDFStore((s) => s.modal === 'tools');
  const close = () => {
    mergeQueue = [];
    setFiles([]);
    usePDFStore.getState().openModal(null);
  };
  const [files, setFiles] = useState<PickedFile[]>([]);

  // Pick up files queued by startQuickTool('merge').
  useEffect(() => {
    const take = () => setFiles(mergeQueue);
    window.addEventListener('adika:merge-queue', take);
    return () => window.removeEventListener('adika:merge-queue', take);
  }, []);
  useEffect(() => {
    if (open && mergeQueue.length) setFiles(mergeQueue);
  }, [open]);

  const move = (i: number, d: number) => {
    const next = [...files];
    const [f] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, f);
    setFiles(next);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={files.length ? 'Merge PDFs' : 'Tools'} description={files.length ? 'Put the files in order, then merge.' : 'Convert and combine files without opening them first. Everything runs on this computer.'} width={files.length ? 520 : 860} testId="tools-modal"
      footer={
        files.length ? (
          <>
            <Button onClick={async () => setFiles([...files, ...(await pickPdfsForMerge())])}>Add files…</Button>
            <div className="flex-1" />
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="merge-run"
              disabled={files.length < 2}
              onClick={() => {
                const list = files;
                close();
                void mergeFiles(list);
              }}
            >
              Merge {files.length} files
            </Button>
          </>
        ) : undefined
      }
    >
      {files.length ? (
        <div className="flex flex-col gap-1" data-testid="merge-list">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-app px-2 py-1.5 text-[13px]">
              <span className="w-5 text-right text-xs text-muted">{i + 1}</span>
              <FileText size={14} className="text-brand-600" />
              <span className="min-w-0 flex-1 truncate" data-testid="merge-item">
                {f.name}
              </span>
              <span className="text-[11px] text-muted">{(f.bytes.length / 1024).toFixed(0)} KB</span>
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 hover-app disabled:opacity-30" data-testid="merge-up">
                <ArrowUp size={13} />
              </button>
              <button type="button" aria-label="Move down" disabled={i === files.length - 1} onClick={() => move(i, 1)} className="rounded p-1 hover-app disabled:opacity-30">
                <ArrowDown size={13} />
              </button>
              <button type="button" aria-label="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="rounded p-1 text-rose-600 hover-app">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <QuickToolGrid onPick={(id) => void startQuickTool(id)} />
      )}
    </Dialog>
  );
}
