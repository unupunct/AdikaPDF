/** Convert → Batch: pick PDFs, pick one operation, run it on all of them. */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FilePlus2, Loader2, MinusCircle, X, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Dialog, Field, Input, Select } from '@/components/ui/primitives';
import { BATCH_OPS, type BatchKind, type BatchOp, type CompressLevel } from '@/lib/batch';
import { OCR_LANGUAGES } from '@/lib/pdf/ocr';
import type { BatchResult } from '@/actions/batch';

const name = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function BatchModal() {
  const open = usePDFStore((s) => s.modal === 'batch');
  const close = () => usePDFStore.getState().openModal(null);
  const [files, setFiles] = useState<string[]>([]);
  const [kind, setKind] = useState<BatchKind>('ocr');
  const [lang, setLang] = useState('ron+eng');
  const [level, setLevel] = useState<CompressLevel>('balanced');
  const [text, setText] = useState('CONFIDENȚIAL');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const cancel = useRef(false);

  useEffect(() => {
    if (open) {
      setResults(null);
      setProgress(null);
    }
  }, [open]);

  const add = async () => {
    const { pickBatchFiles } = await import('@/actions/batch');
    const picked = await pickBatchFiles();
    setResults(null);
    setFiles((cur) => [...cur, ...picked.filter((p) => !cur.includes(p))]);
  };

  const op = (): BatchOp | null => {
    switch (kind) {
      case 'ocr':
        return { kind, lang };
      case 'compress':
        return { kind, level };
      case 'watermark':
        return text.trim() ? { kind, text: text.trim() } : null;
      case 'protect':
        return pw && pw === pw2 ? { kind, userPassword: pw } : null;
      default:
        return { kind };
    }
  };

  const run = async () => {
    const o = op();
    if (!o || !files.length) return;
    setRunning(true);
    cancel.current = false;
    setResults(null);
    try {
      const { runBatch } = await import('@/actions/batch');
      const r = await runBatch(files, o, (done, total, current) => setProgress({ done, total, current }), () => cancel.current);
      setResults(r);
      const ok = r.filter((x) => x.status === 'done').length;
      usePDFStore.getState().toast(`Batch finished: ${ok} of ${r.length} file${r.length === 1 ? '' : 's'} done. Results are saved next to the originals.`, ok === r.length ? 'success' : 'info');
    } finally {
      setRunning(false);
    }
  };

  const ready = !!op() && files.length > 0 && !running;
  const langOptions = [{ value: 'ron+eng', label: 'Română + English' }, ...OCR_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !running && close()}
      title="Batch processing"
      description="Runs one operation on many PDF files. Each result is saved next to its original with a suffix (for example raport-ocr.pdf); originals are never changed."
      width={620}
      testId="batch-modal"
      footer={
        <>
          {running ? (
            <Button onClick={() => (cancel.current = true)}>Stop after this file</Button>
          ) : (
            <Button onClick={close}>Close</Button>
          )}
          <Button variant="primary" disabled={!ready} onClick={() => void run()} data-testid="batch-run">
            {running ? <Loader2 size={13} className="animate-spin" /> : null}
            {`Run on ${files.length} file${files.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold">Files</span>
          <Button size="sm" onClick={() => void add()} disabled={running} data-testid="batch-add">
            <FilePlus2 size={13} /> Add PDFs…
          </Button>
        </div>
        {files.length ? (
          <ul className="max-h-36 overflow-auto rounded-md border border-app text-[12px]" data-testid="batch-files">
            {files.map((f) => {
              const r = results?.find((x) => x.input === f);
              return (
                <li key={f} className="flex items-center gap-2 border-b border-app px-2 py-1 last:border-0" title={f}>
                  {r ? (
                    r.status === 'done' ? <CheckCircle2 size={13} className="text-accent-600" /> : r.status === 'skipped' ? <MinusCircle size={13} className="text-amber-600" /> : <XCircle size={13} className="text-rose-600" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate" data-no-translate>
                    {name(f)}
                  </span>
                  {r ? <span className="max-w-[55%] truncate text-muted" data-testid="batch-result">{r.status === 'done' ? `→ ${name(r.output!)}${r.message ? ` (${r.message})` : ''}` : r.message}</span> : null}
                  {!running && !r ? (
                    <button type="button" aria-label="Remove" className="rounded p-0.5 hover-app" onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}>
                      <X size={12} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-app px-3 py-4 text-center text-[12px] text-muted">No files yet. Add the PDFs to process.</p>
        )}
      </div>
      <div className="mb-3 grid gap-1">
        {BATCH_OPS.map((o) => (
          <label key={o.kind} className="flex items-center gap-2 text-[12.5px]">
            <input type="radio" name="batch-op" checked={kind === o.kind} onChange={() => setKind(o.kind)} disabled={running} data-testid={`batch-op-${o.kind}`} />
            {o.label} <span className="text-muted">({o.suffix})</span>
          </label>
        ))}
      </div>
      {kind === 'ocr' ? (
        <Field label="Language">
          <Select value={lang} onChange={setLang} options={langOptions} ariaLabel="OCR language" />
        </Field>
      ) : kind === 'compress' ? (
        <Field label="Strength">
          <Select value={level} onChange={(v: CompressLevel) => setLevel(v)} ariaLabel="Compression" options={[{ value: 'light', label: 'Light (best quality)' }, { value: 'balanced', label: 'Balanced' }, { value: 'strong', label: 'Strong (smallest)' }]} />
        </Field>
      ) : kind === 'watermark' ? (
        <Field label="Watermark text">
          <Input value={text} onChange={(e) => setText(e.target.value)} data-testid="batch-watermark" />
        </Field>
      ) : kind === 'protect' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Password">
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="batch-pw" />
          </Field>
          <Field label="Repeat password">
            <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} data-testid="batch-pw2" />
          </Field>
          {pw && pw2 && pw !== pw2 ? <p className="col-span-2 text-[11px] text-rose-600">The passwords differ.</p> : null}
        </div>
      ) : null}
      {progress && running ? (
        <Callout kind="info">
          <span data-testid="batch-progress">
            File {Math.min(progress.done + 1, progress.total)} of {progress.total}: {progress.current}
          </span>
        </Callout>
      ) : null}
    </Dialog>
  );
}
