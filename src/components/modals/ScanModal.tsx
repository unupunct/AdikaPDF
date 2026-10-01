/** Convert → Scan: scanner settings, cleanup, the scanned pages, and the PDF(s). */
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Loader2, Printer, RefreshCw, RotateCw, ScanLine, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Select } from '@/components/ui/primitives';
import { errorMessage } from '@/actions/document';
import { isDesktop, wiaDevices, type ScannerInfo } from '@/lib/platform';
import { OCR_LANGUAGES } from '@/lib/pdf/ocr';
import { loadOcrLangs } from './DocumentModals';
import type { PageCleanup, PaperSize, ScanPageItem, ScanSettings, ScanSource } from '@/actions/scan';
import type { ScanMode } from '@/lib/scan/scanPdf';
import { cn } from '@/lib/cn';

const PREFS = 'adika.scanPrefs';
interface Prefs {
  settings: Omit<ScanSettings, 'device'> & { device?: string };
  cleanup: PageCleanup;
  splitAtBlank: boolean;
  removeBlank: boolean;
  ocr: boolean;
}
const DEFAULTS: Prefs = {
  settings: { source: 'flatbed', mode: 'color', dpi: 300, paper: 'a4' },
  cleanup: { mode: 'color', deskew: true, despeckle: true, edges: true, orient: true },
  splitAtBlank: false,
  removeBlank: true,
  ocr: false,
};
function loadPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>;
    return { ...DEFAULTS, ...v, settings: { ...DEFAULTS.settings, ...v.settings }, cleanup: { ...DEFAULTS.cleanup, ...v.cleanup } };
  } catch {
    return DEFAULTS;
  }
}

export function ScanModal() {
  const open = usePDFStore((s) => s.modal === 'scan');
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const close = () => usePDFStore.getState().openModal(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [devices, setDevices] = useState<ScannerInfo[] | null>(null);
  const [pages, setPages] = useState<ScanPageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dirtyCleanup, setDirtyCleanup] = useState(false);
  const [append, setAppend] = useState(false);
  const [sepNames, setSepNames] = useState('');

  const update = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p, settings: { ...cur.settings, ...p.settings }, cleanup: { ...cur.cleanup, ...p.cleanup } };
      try {
        localStorage.setItem(PREFS, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });

  const findDevices = async () => {
    setDevices(null);
    setError(null);
    try {
      const d = await wiaDevices();
      setDevices(d);
      if (d.length && !d.some((x) => x.id === prefs.settings.device)) update({ settings: { ...prefs.settings, device: d[0].id } });
    } catch (e) {
      setDevices([]);
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    if (open && isDesktop) void findDevices();
    if (open) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const device = devices?.find((d) => d.id === prefs.settings.device) ?? null;
  const cleanup: PageCleanup = { ...prefs.cleanup, mode: prefs.settings.mode };
  const run = async (fn: () => Promise<ScanPageItem[] | undefined>) => {
    setError(null);
    try {
      const got = await fn();
      if (got?.length) setPages((cur) => [...cur, ...got]);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const scan = () => run(async () => (await import('@/actions/scan')).scanPages({ ...prefs.settings, device: prefs.settings.device ?? '' }, cleanup));
  const pictures = () => run(async () => (await import('@/actions/scan')).addPictures(cleanup));
  const applyCleanup = async () => {
    const r = await (await import('@/actions/scan')).reprocess(pages, cleanup);
    if (r) setPages(r);
    setDirtyCleanup(false);
  };
  const create = async () => {
    const langs = loadOcrLangs().join('+');
    const ok = await (await import('@/actions/scan')).createScanPdfs(pages, { splitAtBlank: prefs.splitAtBlank, removeBlank: prefs.removeBlank, ocr: prefs.ocr ? langs : null, append });
    if (ok) {
      setPages([]);
      close();
    }
  };
  const setCleanup = (c: Partial<PageCleanup>) => {
    update({ cleanup: { ...prefs.cleanup, ...c } });
    if (pages.length) setDirtyCleanup(true);
  };
  const move = (i: number, d: -1 | 1) =>
    setPages((cur) => {
      const n = [...cur];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  const docs = (() => {
    let n = 0;
    let started = false;
    for (const p of pages) {
      if (p.role.kind === 'separator' || (p.role.kind === 'blank' && prefs.splitAtBlank)) started = false;
      else if (!(p.role.kind === 'blank' && prefs.removeBlank) && !started) {
        n++;
        started = true;
      }
    }
    return n;
  })();
  const langLabel = loadOcrLangs()
    .map((c) => OCR_LANGUAGES.find((l) => l.code === c)?.label ?? c)
    .join(', ');

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Scan to PDF"
      description="Scan with your scanner (flatbed or document feeder) or add photos of documents. Pages are straightened and cleaned up; blank pages and separator sheets can split the batch into several PDFs."
      width={900}
      testId="scan-modal"
      footer={
        <>
          {hasDoc ? <Checkbox checked={append} onChange={setAppend} label="Add to the open document" /> : null}
          <div className="flex-1" />
          <Button onClick={close}>Close</Button>
          <Button variant="primary" disabled={!pages.length || !docs} onClick={() => void create()} data-testid="scan-create">
            {docs > 1 ? `Create ${docs} PDFs` : 'Create PDF'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[280px_1fr] gap-4">
        <div className="min-w-0">
          <Field label="Scanner">
            <div className="flex gap-1">
              <select
                aria-label="Scanner"
                className="h-8 min-w-0 flex-1 rounded-md border border-app bg-panel-2 px-2 text-[13px]"
                value={prefs.settings.device ?? ''}
                onChange={(e) => update({ settings: { ...prefs.settings, device: e.target.value } })}
                data-testid="scan-device"
              >
                {devices === null ? <option value="">Looking for scanners…</option> : null}
                {devices?.length === 0 ? <option value="">No scanner found</option> : null}
                {devices?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="icon" aria-label="Look for scanners again" onClick={() => void findDevices()} disabled={!isDesktop}>
                {devices === null && isDesktop ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </Button>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Source">
              <Select
                value={prefs.settings.source}
                ariaLabel="Source"
                onChange={(v: ScanSource) => update({ settings: { ...prefs.settings, source: v } })}
                options={[
                  { value: 'flatbed', label: 'Flatbed' },
                  { value: 'feeder', label: 'Feeder' },
                  { value: 'duplex', label: 'Feeder, both sides' },
                ]}
              />
            </Field>
            <Field label="Colour">
              <Select
                value={prefs.settings.mode}
                ariaLabel="Colour mode"
                onChange={(v: ScanMode) => {
                  update({ settings: { ...prefs.settings, mode: v } });
                  if (pages.length) setDirtyCleanup(true);
                }}
                options={[
                  { value: 'color', label: 'Colour' },
                  { value: 'gray', label: 'Grey' },
                  { value: 'bw', label: 'Black and white (smallest)' },
                ]}
              />
            </Field>
            <Field label="Resolution">
              <Select
                value={String(prefs.settings.dpi)}
                ariaLabel="Scan resolution"
                onChange={(v) => update({ settings: { ...prefs.settings, dpi: Number(v) } })}
                options={[150, 200, 300, 400, 600].map((d) => ({ value: String(d), label: `${d} DPI` }))}
              />
            </Field>
            <Field label="Paper">
              <Select
                value={prefs.settings.paper}
                ariaLabel="Paper size"
                onChange={(v: PaperSize) => update({ settings: { ...prefs.settings, paper: v } })}
                options={[
                  { value: 'a4', label: 'A4' },
                  { value: 'a5', label: 'A5' },
                  { value: 'letter', label: 'Letter' },
                  { value: 'legal', label: 'Legal' },
                  { value: 'auto', label: 'Whole scan area' },
                ]}
              />
            </Field>
          </div>
          {device && prefs.settings.source !== 'flatbed' && !device.feeder ? <Callout kind="warn">This scanner reports no document feeder.</Callout> : null}
          <div className="mb-3 flex gap-2">
            <Button variant="accent" disabled={!isDesktop || !device} onClick={() => void scan()} data-testid="scan-now">
              <ScanLine size={14} /> Scan
            </Button>
            <Button onClick={() => void pictures()} data-testid="scan-add-pictures">
              <ImagePlus size={14} /> Add pictures…
            </Button>
          </div>
          <div className="mb-1 text-xs font-semibold">Cleanup</div>
          <Checkbox checked={!!prefs.cleanup.deskew} onChange={(v) => setCleanup({ deskew: v })} label="Straighten crooked pages" />
          <Checkbox checked={!!prefs.cleanup.orient} onChange={(v) => setCleanup({ orient: v })} label="Turn sideways and upside-down pages" />
          <Checkbox checked={!!prefs.cleanup.despeckle} onChange={(v) => setCleanup({ despeckle: v })} label="Remove specks and dust" />
          <Checkbox checked={!!prefs.cleanup.edges} onChange={(v) => setCleanup({ edges: v })} label="Remove dark scanner edges" />
          {dirtyCleanup ? (
            <Button size="sm" onClick={() => void applyCleanup()} data-testid="scan-apply-cleanup">
              Apply to the scanned pages
            </Button>
          ) : null}
          <div className="mb-1 mt-3 text-xs font-semibold">Pages and documents</div>
          <Checkbox checked={prefs.removeBlank} onChange={(v) => update({ removeBlank: v })} label="Remove blank pages" />
          <Checkbox checked={prefs.splitAtBlank} onChange={(v) => update({ splitAtBlank: v })} label="A blank page starts a new document" />
          <Checkbox checked={prefs.ocr} onChange={(v) => update({ ocr: v })} label={`Make the text searchable (OCR: ${langLabel})`} />
          <details className="mt-2 text-xs">
            <summary className="cursor-default text-brand-600">Separator sheets…</summary>
            <p className="my-1 text-[11px] text-muted">Print a separator sheet and put it before each document in the feeder: the batch is split there, and the document takes the name printed on the sheet.</p>
            <textarea
              className="mb-1 h-16 w-full rounded-md border border-app bg-panel-2 p-1 text-xs"
              placeholder="Document names, one per line (optional)"
              value={sepNames}
              onChange={(e) => setSepNames(e.target.value)}
              data-testid="scan-sep-names"
            />
            <Button
              size="sm"
              onClick={() =>
                void import('@/actions/scan').then((m) =>
                  m.saveSeparatorSheets(
                    sepNames
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  ),
                )
              }
              data-testid="scan-sep-save"
            >
              <Printer size={13} /> Save separator sheets (PDF)
            </Button>
          </details>
        </div>
        <div className="min-w-0">
          {error ? <Callout kind="error">{error}</Callout> : null}
          {!pages.length ? (
            <div className="flex h-full min-h-64 items-center justify-center rounded-lg border border-dashed border-app p-6 text-center text-xs text-muted">
              {isDesktop && devices?.length === 0
                ? 'No scanner found. Connect a scanner (WIA driver), or add photos of the pages with Add pictures.'
                : 'Scanned pages appear here. Scan again to add more pages.'}
            </div>
          ) : (
            <>
              <div className="mb-2 text-xs text-muted" data-testid="scan-summary">
                {`${pages.length} page${pages.length === 1 ? '' : 's'} · ${docs} document${docs === 1 ? '' : 's'}`}
              </div>
              <div className="grid max-h-[430px] grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 overflow-auto pr-1" data-testid="scan-pages">
                {pages.map((p, i) => (
                  <div key={p.id} className="group relative rounded-md border border-app p-1" data-testid="scan-page" data-role={p.role.kind}>
                    <img src={p.thumb} alt="" className={cn('mx-auto h-36 object-contain', p.role.kind !== 'content' && 'opacity-40')} />
                    <div className="mt-1 flex items-center justify-between text-[10px]">
                      <span className="text-muted">{i + 1}</span>
                      {p.role.kind === 'blank' ? <span className="rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Blank</span> : null}
                      {p.role.kind === 'separator' ? (
                        <span className="max-w-[85px] truncate rounded bg-brand-50 px-1 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200" title={p.role.name ?? ''} data-testid="scan-separator">
                          {p.role.name ? `Split: ${p.role.name}` : 'Split'}
                        </span>
                      ) : null}
                      {p.skew || p.rotated ? <span className="text-muted" title="Straightened / turned">{p.rotated ? `${p.rotated}°` : `${p.skew.toFixed(1)}°`}</span> : null}
                    </div>
                    <div className="absolute right-1 top-1 hidden gap-0.5 rounded bg-panel/90 p-0.5 shadow group-hover:flex">
                      <button type="button" aria-label="Move left" disabled={i === 0} className="rounded p-0.5 hover-app" onClick={() => move(i, -1)}>
                        <ArrowLeft size={12} />
                      </button>
                      <button type="button" aria-label="Move right" disabled={i === pages.length - 1} className="rounded p-0.5 hover-app" onClick={() => move(i, 1)}>
                        <ArrowRight size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="Turn"
                        className="rounded p-0.5 hover-app"
                        onClick={() => void import('@/actions/scan').then(async (m) => {
                          const turned = await m.turnPage(p, cleanup);
                          setPages((cur) => cur.map((x) => (x.id === p.id ? turned : x)));
                        })}
                      >
                        <RotateCw size={12} />
                      </button>
                      <button type="button" aria-label="Remove page" className="rounded p-0.5 hover-app" onClick={() => setPages((cur) => cur.filter((x) => x.id !== p.id))}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="mt-2 text-[11px] text-muted">
            {prefs.settings.mode === 'bw' ? 'Black and white pages are stored with fax (Group 4) compression: about 30–60 KB per page.' : 'Colour and grey pages are stored as JPEG.'}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
