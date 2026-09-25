import { CheckCircle2, Info, Upload, X, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Progress } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

export function Toasts() {
  const toasts = usePDFStore((s) => s.toasts);
  const dismiss = usePDFStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[80] flex w-[380px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel px-3 py-2.5 text-[13px] shadow-lg',
            t.kind === 'error' ? 'border-rose-300 dark:border-rose-800' : t.kind === 'success' ? 'border-emerald-300 dark:border-emerald-800' : 'border-app',
          )}
        >
          {t.kind === 'error' ? <XCircle size={16} className="mt-0.5 shrink-0 text-rose-600" /> : t.kind === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" /> : <Info size={16} className="mt-0.5 shrink-0 text-brand-600" />}
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-[var(--text)]">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function BusyOverlay() {
  const busy = usePDFStore((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/30 backdrop-blur-[1px]" data-testid="busy">
      <div className="w-[360px] rounded-xl border border-app bg-panel p-5 shadow-2xl">
        <div className="mb-3 text-[13px] font-medium">{busy.message}</div>
        <Progress value={busy.progress} />
      </div>
    </div>
  );
}

export function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-3 z-[85] flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-500/10">
      <div className="flex flex-col items-center gap-2 rounded-xl bg-panel px-8 py-6 text-center shadow-xl">
        <Upload className="text-brand-600" size={28} />
        <div className="text-sm font-medium">Drop to open</div>
        <div className="text-xs text-muted">PDF opens · with a document open, PDFs and images are added · Office files are converted</div>
      </div>
    </div>
  );
}
