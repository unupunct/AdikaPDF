import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Info, Upload, X, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { useDnd } from '@/store/dnd';
import { Button, Progress } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

export function Toasts() {
  const toasts = usePDFStore((s) => s.toasts);
  const dismiss = usePDFStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[80] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
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
          {t.kind === 'error' ? <XCircle size={16} className="mt-0.5 shrink-0 text-rose-600" /> : t.kind === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" /> : <Info size={16} className="mt-0.5 shrink-0 text-brand-600" />}
          <span className="min-w-0 flex-1 break-words">
            {t.message}
            {t.action ? (
              <button
                type="button"
                data-testid="toast-action"
                className="ml-2 font-medium text-brand-700 underline hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.run();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </span>
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
  const abort = busy?.abort;
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => setCancelling(false), [abort]);
  // Esc cancels; the overlay is modal, so keys never reach the page behind it.
  useEffect(() => {
    if (!abort) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setCancelling(true);
      abort.abort();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [abort]);
  if (!busy) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/30 backdrop-blur-[1px]" data-testid="busy">
      <div className="w-[min(360px,calc(100vw-2rem))] rounded-xl border border-app bg-panel p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label={busy.message}>
        <div className="mb-3 text-[13px] font-medium" aria-live="polite">
          {cancelling ? 'Cancelling…' : busy.message}
        </div>
        <Progress value={busy.progress} label={busy.message} />
        {abort ? (
          <div className="mt-4 flex justify-end">
            <Button
              size="sm"
              data-testid="busy-cancel"
              disabled={cancelling}
              autoFocus
              onClick={() => {
                setCancelling(true);
                abort.abort();
              }}
            >
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * While files (or page thumbnails) are dragged over the window: what a drop
 * here does, or why it is refused. Files get a frame around the window; pages
 * only the label. The label is a live region, so screen readers hear it too.
 */
export function DropOverlay() {
  const { active, label, rejected } = useDnd();
  if (!active) return null;
  const files = active === 'files';
  return (
    <div
      data-testid="drop-overlay"
      data-rejected={rejected ? 'true' : undefined}
      className={cn(
        'pointer-events-none fixed inset-3 z-[85] flex items-end justify-center rounded-2xl pb-14',
        files && 'border-2 border-dashed',
        files && (rejected ? 'border-rose-500 bg-rose-500/5' : 'border-brand-500 bg-brand-500/5'),
      )}
    >
      {label ? (
        <div className={cn('flex max-w-[min(520px,90vw)] items-center gap-2 rounded-xl bg-panel px-4 py-2.5 text-[13px] font-medium shadow-xl ring-1', rejected ? 'text-rose-700 ring-rose-300 dark:text-rose-300' : 'ring-brand-300')} role="status" aria-live="polite" data-testid="drop-label">
          {rejected ? <Ban size={18} className="shrink-0" /> : <Upload className="shrink-0 text-brand-600" size={18} />}
          <span>{label}</span>
        </div>
      ) : null}
    </div>
  );
}
