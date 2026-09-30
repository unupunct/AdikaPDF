/** Convert → Print production: preflight, colours, output preview, bleed and printer marks. */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import type { InkPreview, PreflightProfile } from '@/actions/printProduction';
import type { PreflightIssue } from '@/lib/print/pdfx';

type Tab = 'preflight' | 'colors' | 'preview' | 'marks';

export function PrintProductionModal() {
  const open = usePDFStore((s) => s.modal === 'printprod');
  const pageCount = usePDFStore((s) => s.pages.length);
  const current = usePDFStore((s) => Math.max(1, s.pages.findIndex((p) => p.id === s.currentPageId) + 1));
  const close = () => usePDFStore.getState().openModal(null);
  const [tab, setTab] = useState<Tab>('preflight');
  const [profile, setProfile] = useState<PreflightProfile>('x4');
  const [issues, setIssues] = useState<PreflightIssue[] | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<InkPreview | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [limit, setLimit] = useState(300);
  const [plates, setPlates] = useState({ c: true, m: true, y: true, k: true });
  const [showLimit, setShowLimit] = useState(true);
  const [marks, setMarks] = useState({ bleedMm: 3, crop: true, registration: true, colorBars: true, pageInfo: true });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (open) {
      setIssues(null);
      setNotes(null);
      setPreview(null);
      setPageNo(current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const check = async (p = profile) => {
    const { preflightCurrent } = await import('@/actions/printProduction');
    setIssues((await preflightCurrent(p)) ?? null);
  };

  const loadPreview = async (n = pageNo) => {
    const { inkPreview } = await import('@/actions/printProduction');
    setPreview((await inkPreview(n, limit)) ?? null);
  };

  useEffect(() => {
    if (open && tab === 'preview' && !preview) void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !preview) return;
    void import('@/lib/print/marks').then(({ platePicture }) => {
      c.width = preview.width;
      c.height = preview.height;
      const img = new ImageData(platePicture(preview.plates, preview.total, plates, showLimit ? limit : null) as Uint8ClampedArray<ArrayBuffer>, preview.width, preview.height);
      c.getContext('2d')?.putImageData(img, 0, 0);
    });
  }, [preview, plates, limit, showLimit]);

  const overLimit = preview ? (() => {
    let n = 0;
    for (const t of preview.total) if (t > limit) n++;
    return n / preview.total.length;
  })() : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Print production"
      description="Prepare the document for a print shop: check it against PDF/X or PDF/A, convert colours, look at the inks, add bleed and printer marks. Results are saved as a copy."
      width={720}
      testId="printprod-modal"
      footer={<Button onClick={close}>Close</Button>}
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'preflight', label: 'Preflight' },
          { value: 'colors', label: 'Colours' },
          { value: 'preview', label: 'Output preview' },
          { value: 'marks', label: 'Marks and bleed' },
        ]}
      />
      {tab === 'preflight' ? (
        <>
          <div className="mb-3 flex items-end gap-2">
            <div className="flex-1">
              <Field label="Standard">
                <Select
                  value={profile}
                  ariaLabel="Preflight standard"
                  onChange={(v: PreflightProfile) => {
                    setProfile(v);
                    setIssues(null);
                    setNotes(null);
                  }}
                  options={[
                    { value: 'x4', label: 'PDF/X-4 (modern print: transparency and RGB allowed)' },
                    { value: 'x1a', label: 'PDF/X-1a:2003 (CMYK only, no transparency)' },
                    { value: 'pdfa', label: 'PDF/A-2b (long-term archiving)' },
                  ]}
                />
              </Field>
            </div>
            <Button className="mb-3" onClick={() => void check()} data-testid="preflight-run">
              Check
            </Button>
          </div>
          {issues ? (
            issues.length ? (
              <div className="mb-3 rounded-lg border border-app" data-testid="preflight-issues">
                {issues.map((i, k) => (
                  <div key={k} className="flex items-start gap-2 border-b border-app px-3 py-1.5 text-xs last:border-b-0" data-testid="preflight-issue">
                    {i.fixable ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-rose-600" />}
                    <span className="w-40 shrink-0 font-medium">{i.rule}</span>
                    <span className="min-w-0 flex-1 text-muted">
                      {i.detail}
                      {i.pages?.length ? ` (${i.pages.length > 6 ? `${i.pages.slice(0, 6).join(', ')}…` : `page ${i.pages.join(', ')}`})` : ''}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">{i.fixable ? 'fixed by converting' : 'fix it yourself'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div data-testid="preflight-ok">
                <Callout kind="success">No problems found.</Callout>
              </div>
            )
          ) : null}
          {profile !== 'pdfa' ? (
            <>
              <Button
                variant="primary"
                onClick={() =>
                  void import('@/actions/printProduction').then(async (m) => {
                    setNotes((await m.convertCurrentToPdfX(profile)) ?? null);
                    await check(profile);
                  })
                }
                data-testid="preflight-convert"
              >
                {profile === 'x4' ? 'Convert to PDF/X-4' : 'Convert to PDF/X-1a'}
              </Button>
              <p className="mt-2 text-[11px] text-muted">
                The output intent is a generic CMYK condition; print shops convert to their own printing condition. {profile === 'x1a' ? 'Pages with transparency or missing fonts are rasterised at 300 DPI.' : ''}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted">Use Convert → PDF/A to make an archival copy.</p>
          )}
          {notes?.length ? <Callout kind="info">{notes.join(' ')}</Callout> : null}
        </>
      ) : tab === 'colors' ? (
        <>
          <p className="mb-3 text-xs text-muted">Converts text, drawings, pictures and gradients. Spot colours and some special gradients are kept and listed.</p>
          <div className="flex gap-2">
            <Button onClick={() => void import('@/actions/printProduction').then((m) => m.convertCurrentColors('gray'))} data-testid="colors-gray">
              Convert to grey (black-and-white printing)
            </Button>
            <Button onClick={() => void import('@/actions/printProduction').then((m) => m.convertCurrentColors('cmyk'))} data-testid="colors-cmyk">
              Convert to CMYK
            </Button>
          </div>
        </>
      ) : tab === 'preview' ? (
        <div className="grid grid-cols-[1fr_220px] gap-4">
          <div className="flex min-h-64 items-center justify-center rounded-lg bg-[var(--hover)] p-2">
            <canvas ref={canvasRef} className="max-h-[420px] max-w-full shadow" data-testid="ink-canvas" />
          </div>
          <div className="text-xs">
            <Field label="Page">
              <Input
                type="number"
                min={1}
                max={pageCount}
                value={pageNo}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(pageCount, Number(e.target.value) || 1));
                  setPageNo(n);
                  void loadPreview(n);
                }}
              />
            </Field>
            <div className="mb-2 font-semibold">Separations</div>
            {(['c', 'm', 'y', 'k'] as const).map((k) => (
              <Checkbox key={k} checked={plates[k]} onChange={(v) => setPlates((p) => ({ ...p, [k]: v }))} label={{ c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' }[k]} />
            ))}
            <Field label="Total ink limit (%)">
              <Input type="number" min={100} max={400} step={10} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 300)} data-testid="ink-limit" />
            </Field>
            <Checkbox checked={showLimit} onChange={setShowLimit} label="Show areas over the limit" />
            {preview ? (
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5" data-testid="ink-stats">
                <dt className="text-muted">Highest total ink</dt>
                <dd>{preview.stats.maxTotal}%</dd>
                <dt className="text-muted">Over the limit</dt>
                <dd>{(overLimit * 100).toFixed(1)}%</dd>
                <dt className="text-muted">Average C / M / Y / K</dt>
                <dd>{`${preview.stats.average.c} / ${preview.stats.average.m} / ${preview.stats.average.y} / ${preview.stats.average.k}`}</dd>
              </dl>
            ) : null}
            <p className="mt-2 text-[11px] text-muted">Estimated from the screen colours with a generic CMYK model; the print shop's separation can differ.</p>
          </div>
        </div>
      ) : (
        <>
          <Field label="Bleed (mm)" hint="Artwork that runs to the edge must extend into the bleed; 3 mm is usual.">
            <Input type="number" min={0} max={20} step={0.5} value={marks.bleedMm} onChange={(e) => setMarks({ ...marks, bleedMm: Number(e.target.value) || 0 })} data-testid="marks-bleed" />
          </Field>
          <Checkbox checked={marks.crop} onChange={(v) => setMarks({ ...marks, crop: v })} label="Crop marks" />
          <Checkbox checked={marks.registration} onChange={(v) => setMarks({ ...marks, registration: v })} label="Registration marks" />
          <Checkbox checked={marks.colorBars} onChange={(v) => setMarks({ ...marks, colorBars: v })} label="Colour bars" />
          <Checkbox checked={marks.pageInfo} onChange={(v) => setMarks({ ...marks, pageInfo: v })} label="Page information (file name, page)" />
          <Button variant="primary" className="mt-2" onClick={() => void import('@/actions/printProduction').then((m) => m.addMarksToCurrent(marks))} data-testid="marks-add">
            Add bleed and marks
          </Button>
          <p className="mt-2 text-[11px] text-muted">The trim box keeps the finished page size; the page grows by the bleed and the marks around it.</p>
        </>
      )}
    </Dialog>
  );
}
