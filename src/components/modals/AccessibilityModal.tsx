/** Protect → Accessibility: the checker, and the fixes (tags, title, language, picture descriptions). */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select } from '@/components/ui/primitives';
import { LANGUAGES } from '@/lib/pdf/accessibility';
import { useLang } from '@/lib/i18n';
import type { AccessReport } from '@/actions/accessibility';

export function AccessibilityModal() {
  const open = usePDFStore((s) => s.modal === 'accessibility');
  const fileName = usePDFStore((s) => s.fileName);
  const uiLang = useLang((s) => s.lang);
  const close = () => usePDFStore.getState().openModal(null);
  const [report, setReport] = useState<AccessReport | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState('ro-RO');
  const [alt, setAlt] = useState<Record<string, string>>({});
  const [decorative, setDecorative] = useState<string[]>([]);
  const [tag, setTag] = useState(true);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const { checkCurrentAccessibility, figurePreviews } = await import('@/actions/accessibility');
      const r = await checkCurrentAccessibility();
      if (!r) return;
      setReport(r);
      setTitle(r.title || (fileName ?? '').replace(/\.pdf$/i, ''));
      setLang(r.lang || (uiLang === 'ro' ? 'ro-RO' : 'en-US'));
      setAlt(Object.fromEntries(r.figures.map((f) => [f.key, f.alt])));
      setDecorative([]);
      setTag(!r.tagged);
      void figurePreviews(r.figures).then(setPreviews).catch(() => setPreviews({}));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fix = async () => {
    const { makeCurrentAccessible } = await import('@/actions/accessibility');
    if (await makeCurrentAccessible({ title, lang, alt, decorative, tag })) await run();
  };

  const failed = report?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const langKnown = LANGUAGES.some((l) => l.code === lang);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Accessibility"
      description="Checks what screen readers need (tags and reading order, title, language, picture descriptions, form fields, links) and fixes it in a copy of the document."
      width={700}
      testId="accessibility-modal"
      footer={
        <>
          <Button onClick={() => void run()} disabled={loading} data-testid="a11y-recheck">
            <RefreshCw size={14} /> Check again
          </Button>
          <div className="flex-1" />
          <Button onClick={close}>Close</Button>
          <Button variant="primary" disabled={!report || loading || !title.trim()} onClick={() => void fix()} data-testid="a11y-fix">
            Make accessible and save
          </Button>
        </>
      }
    >
      {loading && !report ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> Checking…
        </div>
      ) : null}
      {report ? (
        <>
          <div className="mb-3 rounded-lg border border-app" data-testid="a11y-checks">
            {report.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2 border-b border-app px-3 py-1.5 text-xs last:border-b-0" data-testid={`a11y-check-${c.id}`} data-status={c.status}>
                {c.status === 'pass' ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent-600" />
                ) : c.status === 'warn' ? (
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-rose-600" />
                )}
                <span className="w-44 shrink-0 font-medium">{c.title}</span>
                <span className="min-w-0 flex-1 text-muted">{c.detail}</span>
                {c.status !== 'pass' && c.fixable ? <span className="shrink-0 text-[10px] text-brand-600">Fixed below</span> : null}
              </div>
            ))}
          </div>
          {failed === 0 ? <Callout kind="success">No problems found that can be fixed here.</Callout> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="a11y-title" />
            </Field>
            <Field label="Language">
              <Select
                value={lang}
                ariaLabel="Document language"
                onChange={setLang}
                options={[...(langKnown ? [] : [{ value: lang, label: lang }]), ...LANGUAGES.map((l) => ({ value: l.code, label: `${l.label} (${l.code})` }))]}
              />
            </Field>
          </div>
          {!report.tagged ? (
            <Checkbox
              checked={tag}
              onChange={setTag}
              label="Tag the document: paragraphs and headings in reading order, pictures, links, form fields; decoration as artifacts"
            />
          ) : (
            <p className="mb-2 text-[11px] text-muted">The document is already tagged: its tags are kept; only descriptions, title and language are added.</p>
          )}
          {report.figures.length ? (
            <div className="mt-2">
              <div className="mb-1 text-xs font-semibold">Pictures</div>
              <div className="grid max-h-64 gap-2 overflow-auto pr-1" data-testid="a11y-figures">
                {report.figures.map((f, i) => (
                  <div key={f.key} className="flex items-start gap-3 rounded-md border border-app p-2" data-testid="a11y-figure">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-[var(--hover)]">
                      {previews[f.key] ? <img src={previews[f.key]} alt="" className="max-h-16 max-w-16 object-contain" /> : <span className="text-[10px] text-muted">{`p. ${f.page}`}</span>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 text-[11px] text-muted">{`Picture ${i + 1}, page ${f.page}`}</div>
                      <Input
                        value={alt[f.key] ?? ''}
                        placeholder="Describe what the picture shows"
                        disabled={decorative.includes(f.key)}
                        onChange={(e) => setAlt((a) => ({ ...a, [f.key]: e.target.value }))}
                        data-testid={`a11y-alt-${i}`}
                      />
                      {!report.tagged ? (
                        <Checkbox
                          checked={decorative.includes(f.key)}
                          onChange={(v) => setDecorative((d) => (v ? [...d, f.key] : d.filter((k) => k !== f.key)))}
                          label="Decoration only (screen readers skip it)"
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
