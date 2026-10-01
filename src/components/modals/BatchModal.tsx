/** Convert → Batch: pick PDFs, then one operation or a saved action sequence, run on all of them. */
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, FilePlus2, Loader2, MinusCircle, Plus, Save, Trash2, X, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import { BATCH_OPS, sequenceProblem, sequenceSuffix, type ActionSequence, type BatchKind, type BatchOp, type CompressLevel } from '@/lib/batch';
import { OCR_LANGUAGES } from '@/lib/pdf/ocr';
import type { BatchResult } from '@/actions/batch';
import { WatchPanel } from './WatchPanel';

const name = (p: string) => p.split(/[\\/]/).pop() ?? p;

function defaultOp(kind: BatchKind): BatchOp {
  switch (kind) {
    case 'ocr':
      return { kind, lang: 'ron+eng' };
    case 'compress':
      return { kind, level: 'balanced' };
    case 'watermark':
      return { kind, text: 'CONFIDENȚIAL' };
    case 'pageNumbers':
      return { kind, format: '{page} / {pages}' };
    case 'protect':
      return { kind, userPassword: '' };
    default:
      return { kind } as BatchOp;
  }
}

/** The settings of one operation (language, strength, text, password). */
function OpParams({ op, onChange, repeat, onRepeat, testPrefix = 'batch' }: { op: BatchOp; onChange: (op: BatchOp) => void; repeat: string; onRepeat: (v: string) => void; testPrefix?: string }) {
  const langOptions = [{ value: 'ron+eng', label: 'Română + English' }, ...OCR_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))];
  switch (op.kind) {
    case 'ocr':
      return (
        <Field label="Language">
          <Select value={op.lang} onChange={(lang: string) => onChange({ ...op, lang })} options={langOptions} ariaLabel="OCR language" />
        </Field>
      );
    case 'compress':
      return (
        <Field label="Strength">
          <Select
            value={op.level}
            onChange={(level: CompressLevel) => onChange({ ...op, level })}
            ariaLabel="Compression"
            options={[
              { value: 'light', label: 'Light (best quality)' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'strong', label: 'Strong (smallest)' },
            ]}
          />
        </Field>
      );
    case 'watermark':
      return (
        <Field label="Watermark text">
          <Input value={op.text} onChange={(e) => onChange({ ...op, text: e.target.value })} data-testid={`${testPrefix}-watermark`} />
        </Field>
      );
    case 'pageNumbers':
      return (
        <Field label="Page number text" hint="{page} is the page number, {pages} the page count, {file} the file name.">
          <Input value={op.format} onChange={(e) => onChange({ ...op, format: e.target.value })} data-testid={`${testPrefix}-pagenumbers`} />
        </Field>
      );
    case 'protect':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Password">
            <Input type="password" value={op.userPassword} onChange={(e) => onChange({ ...op, userPassword: e.target.value })} data-testid={`${testPrefix}-pw`} />
          </Field>
          <Field label="Repeat password">
            <Input type="password" value={repeat} onChange={(e) => onRepeat(e.target.value)} data-testid={`${testPrefix}-pw2`} />
          </Field>
          {op.userPassword && repeat && op.userPassword !== repeat ? <p className="col-span-2 text-[11px] text-rose-600">The passwords differ.</p> : null}
        </div>
      );
    default:
      return null;
  }
}

const opValid = (op: BatchOp, repeat: string) =>
  op.kind === 'watermark' ? !!op.text.trim() : op.kind === 'protect' ? !!op.userPassword && op.userPassword === repeat : true;

export function BatchModal() {
  const open = usePDFStore((s) => s.modal === 'batch');
  const close = () => usePDFStore.getState().openModal(null);
  const [files, setFiles] = useState<string[]>([]);
  const [mode, setMode] = useState<'single' | 'sequence' | 'watch'>('single');
  const [single, setSingle] = useState<BatchOp>(defaultOp('ocr'));
  const [pw2, setPw2] = useState('');
  const [sequences, setSequences] = useState<ActionSequence[]>([]);
  const [seqId, setSeqId] = useState<string>('');
  const [seqName, setSeqName] = useState('');
  const [steps, setSteps] = useState<BatchOp[]>([defaultOp('ocr'), defaultOp('compress')]);
  const [seqPw2, setSeqPw2] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const cancel = useRef(false);

  useEffect(() => {
    if (open) {
      // After a finished run, start with an empty list.
      if (results) setFiles([]);
      setResults(null);
      setProgress(null);
      void import('@/actions/batch').then((m) => setSequences(m.loadSequences()));
    }
  }, [open]);

  const add = async () => {
    const { pickBatchFiles } = await import('@/actions/batch');
    const picked = await pickBatchFiles();
    setResults(null);
    setFiles((cur) => [...cur, ...picked.filter((p) => !cur.includes(p))]);
  };

  const protectStep = steps.find((s) => s.kind === 'protect');
  const seqProblem = sequenceProblem(steps) ?? (protectStep && protectStep.kind === 'protect' && protectStep.userPassword !== seqPw2 ? 'The passwords differ.' : null);
  const job = (): BatchOp | ActionSequence | null =>
    mode === 'single' ? (opValid(single, pw2) ? single : null) : seqProblem ? null : { id: seqId || 'unsaved', name: seqName.trim() || 'processed', steps };

  const run = async () => {
    const j = job();
    if (!j || !files.length) return;
    setRunning(true);
    cancel.current = false;
    setResults(null);
    try {
      const { runBatch } = await import('@/actions/batch');
      const r = await runBatch(files, j, (done, total, current) => setProgress({ done, total, current }), () => cancel.current);
      setResults(r);
      const ok = r.filter((x) => x.status === 'done').length;
      usePDFStore.getState().toast(`Batch finished: ${ok} of ${r.length} file${r.length === 1 ? '' : 's'} done. Results are saved next to the originals.`, ok === r.length ? 'success' : 'info');
    } finally {
      setRunning(false);
    }
  };

  const pickSequence = (id: string) => {
    setSeqId(id);
    const s = sequences.find((x) => x.id === id);
    setSeqName(s?.name ?? '');
    setSteps(s ? s.steps.map((x) => ({ ...x })) : [defaultOp('ocr'), defaultOp('compress')]);
    setSeqPw2('');
  };
  const saveSeq = async () => {
    const { saveSequence } = await import('@/actions/batch');
    const list = saveSequence({ id: seqId || undefined, name: seqName, steps });
    setSequences(list);
    setSeqId(list.find((s) => s.name.toLowerCase() === seqName.trim().toLowerCase())?.id ?? '');
    usePDFStore.getState().toast(`Sequence “${seqName.trim()}” saved.`, 'success');
  };
  const deleteSeq = async () => {
    const { deleteSequence } = await import('@/actions/batch');
    setSequences(deleteSequence(seqId));
    pickSequence('');
  };
  const setStep = (i: number, op: BatchOp) => setSteps((cur) => cur.map((s, k) => (k === i ? op : s)));
  const moveStep = (i: number, d: -1 | 1) =>
    setSteps((cur) => {
      const next = [...cur];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });

  const ready = !!job() && files.length > 0 && !running;
  const suffix = mode === 'single' ? BATCH_OPS.find((o) => o.kind === single.kind)!.suffix : sequenceSuffix(seqName);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !running && close()}
      title="Batch processing"
      description="Runs one operation or a sequence of steps on many PDF files. Each result is saved next to its original with a suffix (for example raport-ocr.pdf); originals are never changed."
      width={640}
      testId="batch-modal"
      footer={
        <>
          {running ? (
            <Button onClick={() => (cancel.current = true)}>Stop after this file</Button>
          ) : (
            <Button onClick={close}>Close</Button>
          )}
          {mode !== 'watch' ? (
            <Button variant="primary" disabled={!ready} onClick={() => void run()} data-testid="batch-run">
              {running ? <Loader2 size={13} className="animate-spin" /> : null}
              {`Run on ${files.length} file${files.length === 1 ? '' : 's'}`}
            </Button>
          ) : null}
        </>
      }
    >
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { value: 'single', label: 'One operation' },
          { value: 'sequence', label: 'Action sequence' },
          { value: 'watch', label: 'Watched folders' },
        ]}
      />
      {mode === 'watch' ? <WatchPanel sequences={sequences} /> : null}
      <div className={mode === 'watch' ? 'hidden' : 'mb-3'}>
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
      {mode === 'watch' ? null : mode === 'single' ? (
        <>
          <div className="mb-3 grid gap-1">
            {BATCH_OPS.map((o) => (
              <label key={o.kind} className="flex items-center gap-2 text-[12.5px]">
                <input type="radio" name="batch-op" checked={single.kind === o.kind} onChange={() => setSingle(defaultOp(o.kind))} disabled={running} data-testid={`batch-op-${o.kind}`} />
                {o.label} <span className="text-muted">({o.suffix})</span>
              </label>
            ))}
          </div>
          <OpParams op={single} onChange={setSingle} repeat={pw2} onRepeat={setPw2} />
        </>
      ) : (
        <div data-testid="sequence-editor">
          <div className="mb-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field label="Saved sequences">
              <Select
                value={seqId}
                ariaLabel="Saved sequence"
                onChange={(v: string) => pickSequence(v)}
                options={[{ value: '', label: 'New sequence' }, ...sequences.map((s) => ({ value: s.id, label: s.name }))]}
              />
            </Field>
            <Field label="Name">
              <Input value={seqName} placeholder="e.g. Scans to archive" onChange={(e) => setSeqName(e.target.value)} data-testid="seq-name" />
            </Field>
            <div className="mb-3 flex gap-1">
              <Button size="sm" disabled={!seqName.trim() || !!sequenceProblem(steps.map((s) => (s.kind === 'protect' ? { ...s, userPassword: 'x' } : s)))} onClick={() => void saveSeq()} data-testid="seq-save" title="Save the steps (passwords are not saved)">
                <Save size={13} /> Save
              </Button>
              {seqId ? (
                <Button size="sm" variant="ghost" aria-label="Delete sequence" onClick={() => void deleteSeq()} data-testid="seq-delete">
                  <Trash2 size={13} />
                </Button>
              ) : null}
            </div>
          </div>
          <ol className="mb-2 grid gap-2">
            {steps.map((s, i) => (
              <li key={i} className="rounded-md border border-app p-2" data-testid="seq-step">
                <div className="mb-1 flex items-center gap-2">
                  <span className="w-5 text-center text-xs font-semibold text-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Select
                      value={s.kind}
                      ariaLabel={`Step ${i + 1}`}
                      onChange={(k: BatchKind) => setStep(i, defaultOp(k))}
                      options={BATCH_OPS.map((o) => ({ value: o.kind, label: o.label }))}
                    />
                  </div>
                  <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                    <ArrowUp size={13} />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}>
                    <ArrowDown size={13} />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Remove step" onClick={() => setSteps((cur) => cur.filter((_, k) => k !== i))}>
                    <X size={13} />
                  </Button>
                </div>
                {['ocr', 'compress', 'watermark', 'pageNumbers', 'protect'].includes(s.kind) ? (
                  <div className="pl-7">
                    <OpParams op={s} onChange={(op) => setStep(i, op)} repeat={seqPw2} onRepeat={setSeqPw2} testPrefix={`seq-${i}`} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="mb-2 flex items-center justify-between">
            <Button size="sm" onClick={() => setSteps((cur) => [...cur, defaultOp('flatten')])} data-testid="seq-add-step">
              <Plus size={13} /> Add step
            </Button>
            <span className="text-[11px] text-muted">
              Results: <span data-no-translate>name{suffix}.pdf</span>
            </span>
          </div>
          {seqProblem ? <p className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="seq-problem">{seqProblem}</p> : null}
        </div>
      )}
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
