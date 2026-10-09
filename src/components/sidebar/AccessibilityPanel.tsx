/**
 * Accessibility panel: the PDF/UA-1 check (Matterhorn Protocol) grouped by
 * checkpoint. Click an issue to see it on its page; tick the fixes to apply
 * or use "Fix all safe issues"; save the report as PDF, HTML or text; turn
 * on Reading order. The checks a person has to make are listed last.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ListOrdered, RefreshCw, Wrench, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { useA11y } from '@/store/a11y';
import { Button, Checkbox, Select } from '@/components/ui/primitives';
import { LANGUAGES } from '@/lib/pdf/accessibility';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { CHECKPOINTS, type UaFix, type UaIssue } from '@/lib/pdf/pdfua';

const FIX_LABELS: Record<UaFix, string> = {
  tagDocument: 'Tag the document',
  untagged: 'Tag untagged content (headers, footers, page numbers and drawings as artifacts)',
  metadata: 'Write PDF/UA metadata and title',
  displayDocTitle: 'Show the title in the window',
  language: 'Set the document language',
  marked: 'Mark the document as tagged',
  suspects: 'Clear the Suspects flag',
  roleMap: 'Map custom tags to standard ones',
  annotTags: 'Tag links, fields and comments',
  tabs: 'Tab order follows the structure',
  linkContents: 'Describe links',
  fieldTU: 'Describe form fields',
  listBody: 'Repair list structure',
  listNumbering: 'Set list numbering',
  thScope: 'Guess table header scope (first row: column, first column: row)',
  noteIds: 'Give notes unique IDs',
  ocConfig: 'Name layer configurations',
  fileSpec: 'File names for attachments',
  cidSet: 'Remove incomplete CIDSet',
};

export function AccessibilityPanel() {
  const report = useA11y((s) => s.report);
  const checking = useA11y((s) => s.checking);
  const orderMode = useA11y((s) => s.orderMode);
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const uiLang = useLang((s) => s.lang);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Set<UaFix>>(new Set());
  const [lang, setLang] = useState(uiLang === 'ro' ? 'ro-RO' : 'en-US');
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    if (hasDoc && !report && !checking) void import('@/actions/pdfua').then((m) => m.runPdfUaCheck());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDoc]);

  const groups = useMemo(() => {
    const by = new Map<string, UaIssue[]>();
    for (const i of report?.issues ?? []) by.set(i.checkpoint, [...(by.get(i.checkpoint) ?? []), i]);
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [report]);
  const fixes = useMemo(() => [...new Set((report?.issues ?? []).filter((i) => i.fix).map((i) => i.fix!))], [report]);
  const safe = useMemo(() => [...new Set((report?.issues ?? []).filter((i) => i.fix && !i.confirm).map((i) => i.fix!))], [report]);
  const act = () => import('@/actions/pdfua');

  return (
    <>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>PDF/UA</span>
        <button type="button" title="Check again" aria-label="Check again" data-testid="pdfua-recheck" disabled={!hasDoc || checking} onClick={() => void act().then((m) => m.runPdfUaCheck())} className="rounded p-1 hover-app">
          <RefreshCw size={13} className={checking ? 'animate-spin' : undefined} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 text-[12px]" data-testid="pdfua-panel">
        {!hasDoc ? <p className="p-1 text-xs text-muted">Open a document to check it.</p> : null}
        <Button size="sm" className="mb-2 w-full" aria-pressed={orderMode} data-testid="pdfua-reading-order" onClick={() => void act().then((m) => m.setReadingOrderMode(!orderMode))} disabled={!hasDoc}>
          <ListOrdered size={13} /> {orderMode ? 'Close reading order' : 'Reading order'}
        </Button>
        {report ? (
          <>
            <p className={cn('mb-2 rounded-md px-2 py-1.5 text-[11px]', report.issues.length ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200')} data-testid="pdfua-summary" data-count={report.issues.length}>
              {report.issues.length ? `${report.issues.length} failure(s) of PDF/UA-1 (Matterhorn Protocol).` : 'No failures of the machine-checkable PDF/UA conditions.'}
            </p>
            {groups.map(([cp, list]) => {
              const isOpen = open.has(cp);
              return (
                <div key={cp} className="mb-1 rounded-md border border-app" data-testid="pdfua-group" data-checkpoint={cp}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 px-1.5 py-1 text-left font-medium hover-app"
                    onClick={() => setOpen((o) => {
                      const n = new Set(o);
                      if (n.has(cp)) n.delete(cp);
                      else n.add(cp);
                      return n;
                    })}
                  >
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <XCircle size={12} className="shrink-0 text-rose-600" />
                    <span className="min-w-0 flex-1 truncate">{`${cp} ${CHECKPOINTS[cp] ?? ''}`}</span>
                    <span className="text-[11px] text-muted">{list.length}</span>
                  </button>
                  {isOpen
                    ? list.map((i, k) => (
                        <button
                          key={k}
                          type="button"
                          data-testid="pdfua-issue"
                          data-condition={i.condition}
                          onClick={() => void act().then((m) => m.goToIssue(i))}
                          className="block w-full border-t border-app px-2 py-1 text-left hover-app"
                        >
                          <span className="font-mono text-[10px] text-rose-700 dark:text-rose-300">{i.condition}</span>{' '}
                          <span>{i.message}</span>
                          <span className="mt-0.5 block text-[10px] text-muted">
                            {[i.page !== null ? `Page ${i.page + 1}` : '', i.tag ? `<${i.tag}>` : '', !i.fix ? 'Needs a person' : i.confirm ? 'Fix after confirming' : 'Fixable'].filter(Boolean).join(' · ')}
                          </span>
                        </button>
                      ))
                    : null}
                </div>
              );
            })}
            {fixes.length ? (
              <div className="mt-2 rounded-md border border-app p-2" data-testid="pdfua-fixes">
                <div className="mb-1 flex items-center gap-1 font-semibold">
                  <Wrench size={12} /> Fixes
                </div>
                {fixes.map((f) => (
                  <Checkbox key={f} checked={chosen.has(f)} onChange={(v) => setChosen((c) => { const n = new Set(c); if (v) n.add(f); else n.delete(f); return n; })} label={FIX_LABELS[f]} />
                ))}
                {fixes.includes('language') || fixes.includes('tagDocument') ? (
                  <div className="my-1">
                    <Select value={lang} ariaLabel="Document language" onChange={setLang} options={LANGUAGES.map((l) => ({ value: l.code, label: `${l.label} (${l.code})` }))} />
                  </div>
                ) : null}
                <div className="mt-1.5 flex flex-col gap-1">
                  <Button size="sm" disabled={!chosen.size} onClick={() => void act().then((m) => m.applyPdfUaFixes([...chosen].filter((f) => fixes.includes(f)), lang)).then(() => setChosen(new Set()))} data-testid="pdfua-fix-selected">
                    Fix selected
                  </Button>
                  <Button size="sm" variant="primary" disabled={!safe.length} onClick={() => void act().then((m) => m.applyPdfUaFixes(safe, lang))} data-testid="pdfua-fix-safe">
                    Fix all safe issues
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="mt-2 rounded-md border border-app">
              <button type="button" className="flex w-full items-center gap-1 px-1.5 py-1 text-left font-medium hover-app" onClick={() => setShowManual((v) => !v)} data-testid="pdfua-manual-toggle">
                {showManual ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <AlertTriangle size={12} className="text-amber-600" /> Needs a person to check
              </button>
              {showManual
                ? report.manual.map((m, k) => (
                    <div key={k} className="border-t border-app px-2 py-1">
                      <div className="font-medium">{`${m.checkpoint} ${m.title}`}</div>
                      <div className="text-[11px] text-muted">{m.guidance}</div>
                    </div>
                  ))
                : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1" data-testid="pdfua-export">
              <span className="text-[11px] text-muted">Save report:</span>
              <Button size="sm" onClick={() => void act().then((m) => m.savePdfUaReport('pdf'))} data-testid="pdfua-save-pdf">PDF</Button>
              <Button size="sm" onClick={() => void act().then((m) => m.savePdfUaReport('html'))} data-testid="pdfua-save-html">HTML</Button>
              <Button size="sm" onClick={() => void act().then((m) => m.savePdfUaReport('txt'))} data-testid="pdfua-save-txt">Text</Button>
            </div>
            {!report.issues.length ? (
              <p className="mt-2 flex items-center gap-1 text-[11px] text-muted">
                <CheckCircle2 size={12} className="text-accent-600" /> Also go through the checks a person has to make.
              </p>
            ) : null}
          </>
        ) : hasDoc ? (
          <p className="p-1 text-xs text-muted">Checking…</p>
        ) : null}
      </div>
    </>
  );
}
