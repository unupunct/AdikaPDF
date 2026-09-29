/** "Create PDF from…" (import) and "Export PDF to…" dialogs. */
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Camera, DraftingCompass, FileImage, FileType2, Globe, ScanLine, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { useModalArgs, type ImportKind } from '@/store/useModalArgs';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import {
  deliverPdf,
  exportAs,
  imagesToPdf,
  importDocuments,
  importDxf,
  importOfficeDocuments,
  importTextLike,
  importUrl,
  parseRanges,
  pickImagesAsDataUrls,
  scanToPdf,
  type DxfToPdfOptions,
  type ExportFormat,
  type HtmlPageOptions,
  type ImagesToPdfOptions,
} from '@/actions/convert';
import { batchExtractFormCsv } from '@/actions/security';
import { withBusy } from '@/actions/document';
import { converterAvailability, isDesktop, pickFiles, type ConverterAvailability } from '@/lib/platform';

const close = () => usePDFStore.getState().openModal(null);

// ================================================================ import

export function ImportModal() {
  const open = usePDFStore((s) => s.modal === 'import');
  const hasDoc = usePDFStore((s) => s.pages.length > 0 && !s.readOnlyReason);
  const kind = useModalArgs((s) => s.importKind);
  const setKind = (importKind: ImportKind) => useModalArgs.setState({ importKind });
  const [append, setAppend] = useState(false);
  const [avail, setAvail] = useState<ConverterAvailability | null>(null);
  const [images, setImages] = useState<Array<{ src: string; width: number; height: number; name: string }>>([]);
  const [imgOpts, setImgOpts] = useState<ImagesToPdfOptions>({ pageSize: 'a4', orientation: 'auto', marginMm: 10 });
  const [htmlOpts, setHtmlOpts] = useState<HtmlPageOptions>({ pageSize: 'A4', landscape: false, marginMm: 15 });
  const [url, setUrl] = useState('https://');
  const [textKind, setTextKind] = useState<'html' | 'markdown' | 'text'>('html');

  useEffect(() => {
    if (!open) return;
    setImages([]);
    setAppend(false);
    void converterAvailability().then(setAvail);
  }, [open]);

  useEffect(() => {
    if (kind === 'markdown') setTextKind('markdown');
    if (kind === 'html') setTextKind('html');
  }, [kind]);

  const officeReady = avail ? avail.word || avail.excel || avail.powerpoint || avail.libreoffice : false;
  const run = async (fn: () => Promise<void>) => {
    close();
    await fn();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Create PDF" width={640} testId="import-modal">
      <Tabs
        value={kind === 'markdown' ? 'html' : kind}
        onChange={setKind}
        tabs={[
          { value: 'office', label: 'Office' },
          { value: 'images', label: 'Images' },
          { value: 'html', label: 'Web & text' },
          { value: 'documents', label: 'E-books & mail' },
          { value: 'cad', label: 'CAD' },
          { value: 'scan', label: 'Scan / camera' },
        ]}
      />
      {hasDoc ? <Checkbox checked={append} onChange={setAppend} label="Append to the open document instead of creating a new one" /> : null}
      <div className="mt-3" />

      {kind === 'office' ? (
        <>
          <p className="mb-3 text-xs text-muted">Word (.docx, .doc, .rtf, .odt), Excel (.xlsx, .xls, .csv, .ods) and PowerPoint (.pptx, .ppt, .odp). Fonts, tables, headings, bookmarks, print areas and page breaks come out exactly as Office prints them.</p>
          {avail ? (
            <Callout kind={officeReady ? 'success' : 'warn'}>
              {officeReady
                ? `Converter: ${[avail.word && 'Word', avail.excel && 'Excel', avail.powerpoint && 'PowerPoint'].filter(Boolean).join(', ') || 'LibreOffice'}${avail.libreoffice ? ' (LibreOffice as fallback)' : ''}.`
                : isDesktop
                  ? 'Microsoft Office or LibreOffice must be installed to convert Office documents.'
                  : 'Office conversion needs the Adika desktop app.'}
            </Callout>
          ) : null}
          <Button variant="primary" disabled={!officeReady} onClick={() => void run(() => importOfficeDocuments(append))} data-testid="import-office-pick">
            <FileType2 size={15} /> Choose documents…
          </Button>
        </>
      ) : null}

      {kind === 'images' ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Button onClick={async () => setImages([...images, ...(await pickImagesAsDataUrls())])} data-testid="import-images-pick">
              <FileImage size={15} /> Add images…
            </Button>
            <span className="text-xs text-muted">{images.length ? `${images.length} image(s) — one page each, in this order` : 'PNG, JPG, WebP, GIF, BMP, TIFF (multi-page)'}</span>
          </div>
          {images.length ? (
            <div className="mb-3 flex max-h-40 flex-wrap gap-2 overflow-auto rounded-lg border border-app p-2">
              {images.map((img, i) => (
                <div key={i} className="group relative h-20 w-16 overflow-hidden rounded border border-app bg-white">
                  <img src={img.src} alt={img.name} className="h-full w-full object-contain" />
                  <button type="button" aria-label="Remove" onClick={() => setImages(images.filter((_, j) => j !== i))} className="absolute right-0.5 top-0.5 hidden rounded bg-rose-600 p-0.5 text-white group-hover:block">
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <ImageOptions value={imgOpts} onChange={setImgOpts} />
          <Button
            variant="primary"
            disabled={!images.length}
            data-testid="import-images-run"
            onClick={() =>
              void run(async () => {
                await withBusy('Creating PDF from images…', async () => deliverPdf(await imagesToPdf(images, imgOpts), `${images[0].name.replace(/\.[^.]+$/, '')}.pdf`, append));
              })
            }
          >
            Create PDF
          </Button>
        </>
      ) : null}

      {kind === 'html' || kind === 'markdown' ? (
        <>
          {!avail?.edge ? <Callout kind="warn">{isDesktop ? 'Microsoft Edge was not found; it renders web pages to PDF.' : 'Web and text conversion needs the Adika desktop app.'}</Callout> : null}
          <HtmlOptions value={htmlOpts} onChange={setHtmlOpts} />
          <Field label="Web page address" hint="Rendered with Microsoft Edge (headless) with CSS layout and clickable links kept.">
            <div className="flex gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" data-testid="import-url" />
              <Button disabled={!/^https?:\/\/.+\..+/.test(url) || !avail?.edge} onClick={() => void run(() => importUrl(url.trim(), append))}>
                <Globe size={14} /> Convert
              </Button>
            </div>
          </Field>
          <Field label="Or a file">
            <div className="flex gap-2">
              <Select value={textKind} onChange={setTextKind} ariaLabel="File type" options={[{ value: 'html', label: 'HTML page (.html)' }, { value: 'markdown', label: 'Markdown (.md)' }, { value: 'text', label: 'Plain text (.txt)' }]} />
              <Button disabled={!avail?.edge} onClick={() => void run(() => importTextLike(textKind, htmlOpts, append))}>
                Choose file…
              </Button>
            </div>
          </Field>
        </>
      ) : null}

      {kind === 'documents' ? (
        <>
          <p className="mb-3 text-xs text-muted">
            EPUB e-books (DRM-free), e-mails (.eml, Outlook .msg, .mht) and XPS / OpenXPS documents. E-mail attachments are kept inside the PDF; remote images in e-mails are blocked for privacy.
          </p>
          {!avail?.edge ? <Callout kind="warn">EPUB and e-mail conversion use Microsoft Edge to lay out pages; XPS works without it.</Callout> : null}
          <HtmlOptions value={htmlOpts} onChange={setHtmlOpts} />
          <Button variant="primary" onClick={() => void run(() => importDocuments(htmlOpts, append))} data-testid="import-documents-pick">
            <BookOpen size={15} /> Choose files…
          </Button>
        </>
      ) : null}

      {kind === 'cad' ? <CadPanel append={append} run={run} /> : null}

      {kind === 'scan' ? <ScanPanel append={append} imgOpts={imgOpts} setImgOpts={setImgOpts} run={run} /> : null}
    </Dialog>
  );
}

function CadPanel({ append, run }: { append: boolean; run: (fn: () => Promise<void>) => Promise<void> }) {
  const [o, setO] = useState<DxfToPdfOptions>({ paper: 'auto', orientation: 'auto', marginMm: 10, blackOnWhite: true, lineWeightMm: 0.25, layers: true });
  return (
    <>
      <p className="mb-3 text-xs text-muted">AutoCAD DXF drawings (ASCII, any version) become vector PDFs. Each CAD layer can become a PDF layer you can switch on and off. DWG files must first be saved as DXF.</p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Paper">
          <Select value={o.paper} onChange={(paper) => setO({ ...o, paper })} ariaLabel="Paper" options={[{ value: 'auto', label: 'Fit drawing' }, { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }, { value: 'A2', label: 'A2' }, { value: 'Letter', label: 'Letter' }]} />
        </Field>
        <Field label="Orientation">
          <Select value={o.orientation} disabled={o.paper === 'auto'} onChange={(orientation) => setO({ ...o, orientation })} ariaLabel="Orientation" options={[{ value: 'auto', label: 'Automatic' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
        </Field>
        <Field label="Margin (mm)">
          <Input type="number" min={0} max={50} value={o.marginMm} onChange={(e) => setO({ ...o, marginMm: Math.max(0, Number(e.target.value)) })} />
        </Field>
      </div>
      <Field label="Default line weight (mm)">
        <Input type="number" min={0.05} max={2} step={0.05} value={o.lineWeightMm} onChange={(e) => setO({ ...o, lineWeightMm: Math.max(0.05, Number(e.target.value)) })} />
      </Field>
      <Checkbox checked={o.blackOnWhite} onChange={(blackOnWhite) => setO({ ...o, blackOnWhite })} label="Black lines on white paper (print style)" />
      <Checkbox checked={o.layers} onChange={(layers) => setO({ ...o, layers })} label="Keep CAD layers as PDF layers" />
      <Button className="mt-2" variant="primary" onClick={() => void run(() => importDxf(o, append))} data-testid="import-dxf-pick">
        <DraftingCompass size={15} /> Choose DXF drawings…
      </Button>
    </>
  );
}

function ImageOptions({ value, onChange }: { value: ImagesToPdfOptions; onChange: (v: ImagesToPdfOptions) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="Page size">
        <Select value={value.pageSize} onChange={(pageSize) => onChange({ ...value, pageSize })} ariaLabel="Page size" options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'fit', label: 'Fit to image' }]} />
      </Field>
      <Field label="Orientation">
        <Select value={value.orientation} disabled={value.pageSize === 'fit'} onChange={(orientation) => onChange({ ...value, orientation })} ariaLabel="Orientation" options={[{ value: 'auto', label: 'Automatic' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
      </Field>
      <Field label="Margin (mm)">
        <Input type="number" min={0} max={50} value={value.marginMm} onChange={(e) => onChange({ ...value, marginMm: Math.max(0, Number(e.target.value)) })} />
      </Field>
    </div>
  );
}

function HtmlOptions({ value, onChange }: { value: HtmlPageOptions; onChange: (v: HtmlPageOptions) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="Paper">
        <Select value={value.pageSize} onChange={(pageSize) => onChange({ ...value, pageSize })} ariaLabel="Paper" options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }]} />
      </Field>
      <Field label="Orientation">
        <Select value={value.landscape ? 'l' : 'p'} onChange={(v) => onChange({ ...value, landscape: v === 'l' })} ariaLabel="Orientation" options={[{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }]} />
      </Field>
      <Field label="Margin (mm)">
        <Input type="number" min={0} max={50} value={value.marginMm} onChange={(e) => onChange({ ...value, marginMm: Math.max(0, Number(e.target.value)) })} />
      </Field>
    </div>
  );
}

function ScanPanel({ append, imgOpts, setImgOpts, run }: { append: boolean; imgOpts: ImagesToPdfOptions; setImgOpts: (v: ImagesToPdfOptions) => void; run: (fn: () => Promise<void>) => Promise<void> }) {
  const [mode, setMode] = useState<'scanner' | 'camera'>('scanner');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [shots, setShots] = useState<Array<{ src: string; width: number; height: number }>>([]);
  const [camError, setCamError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'camera') return;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      })
      .catch((e: unknown) => setCamError(e instanceof Error ? e.message : 'Camera unavailable'));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    setShots([...shots, { src: c.toDataURL('image/jpeg', 0.9), width: c.width, height: c.height }]);
  };

  return (
    <>
      <Tabs value={mode} onChange={setMode} tabs={[{ value: 'scanner', label: 'Scanner (WIA)' }, { value: 'camera', label: 'Camera' }]} />
      <ImageOptions value={imgOpts} onChange={setImgOpts} />
      {mode === 'scanner' ? (
        <>
          <p className="mb-3 text-xs text-muted">Uses the Windows scanner dialog (choose colour, resolution and area there). After each page you can scan another.</p>
          <Button variant="primary" disabled={!isDesktop} onClick={() => void run(() => scanToPdf(imgOpts, append))}>
            <ScanLine size={15} /> Start scanning
          </Button>
        </>
      ) : (
        <>
          {camError ? <Callout kind="error">{camError}</Callout> : null}
          <video ref={videoRef} className="mb-3 aspect-video w-full rounded-lg bg-black" muted playsInline />
          <div className="mb-3 flex items-center gap-2">
            <Button onClick={capture} disabled={!!camError}>
              <Camera size={15} /> Capture page
            </Button>
            <span className="text-xs text-muted">{shots.length} page(s) captured</span>
          </div>
          <Button
            variant="primary"
            disabled={!shots.length}
            onClick={() => void run(async () => {
              await withBusy('Creating PDF…', async () => deliverPdf(await imagesToPdf(shots, imgOpts), 'Camera scan.pdf', append));
            })}
          >
            {shots.length ? `Create PDF from ${shots.length} capture${shots.length === 1 ? '' : 's'}` : 'Create PDF'}
          </Button>
        </>
      )}
    </>
  );
}

// ================================================================ export

const FORMATS: Array<{ value: ExportFormat; label: string; hint: string }> = [
  { value: 'docx', label: 'Word (.docx)', hint: 'Keeps fonts, bold/italic, colours, alignment, indents, spacing, lists, tables, columns and images.' },
  { value: 'odt', label: 'OpenDocument (.odt)', hint: 'For LibreOffice / OpenOffice; same layout as Word: fonts, colours, alignment, tables, columns, images, headers/footers.' },
  { value: 'rtf', label: 'Rich Text (.rtf)', hint: 'Opens in any word processor; keeps fonts, colours, alignment, tables, columns and images.' },
  { value: 'xlsx', label: 'Excel (.xlsx)', hint: 'Tables from borders or text alignment (wrapped cells stay one row); numbers become numeric cells. One sheet per page.' },
  { value: 'csv', label: 'CSV table (.csv)', hint: 'The tables found in the PDF, one row per table row (all paragraphs if there are no tables).' },
  { value: 'pptx', label: 'PowerPoint (.pptx)', hint: 'One slide per page (page image), with the page text in the speaker notes.' },
  { value: 'png', label: 'PNG images (ZIP)', hint: 'Lossless page images.' },
  { value: 'jpeg', label: 'JPEG images (ZIP)', hint: 'Smaller page images.' },
  { value: 'tiff', label: 'TIFF (multi-page)', hint: 'One multi-page TIFF file, uncompressed.' },
  { value: 'svg', label: 'SVG (ZIP)', hint: 'Page artwork as an embedded image with real, selectable SVG text on top.' },
  { value: 'html', label: 'HTML5 page', hint: 'A single self-contained, responsive web page with selectable text.' },
  { value: 'epub', label: 'EPUB e-book (.epub)', hint: 'Reflowable e-book with chapters from the headings, lists and tables, for e-readers and phones.' },
  { value: 'md', label: 'Markdown (.md)', hint: 'Clean text: joined paragraphs, headings, bold/italic, lists and tables.' },
  { value: 'txt', label: 'Plain text (.txt)', hint: 'Just the text, for search or AI tools.' },
  { value: 'json', label: 'JSON data (.json)', hint: 'Structured text with positions, fonts, outline, metadata and form-field values.' },
];

export function ExportModal() {
  const open = usePDFStore((s) => s.modal === 'export');
  const count = usePDFStore((s) => s.pages.length);
  const format = useModalArgs((s) => s.exportFormat);
  const [tab, setTab] = useState<'convert' | 'forms'>('convert');
  const [dpi, setDpi] = useState(150);
  const [docxLayout, setDocxLayout] = useState<'flow' | 'exact'>('flow');
  const [scope, setScope] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState('1-');
  const [error, setError] = useState<string | null>(null);
  const info = FORMATS.find((f) => f.value === format) ?? FORMATS[0];
  const raster = ['pptx', 'png', 'jpeg', 'tiff', 'svg', 'html'].includes(format);

  useEffect(() => {
    if (open) {
      setError(null);
      setTab('convert');
    }
  }, [open]);

  const run = async () => {
    try {
      const pageNumbers = scope === 'all' ? undefined : [...new Set(parseRanges(range, count).flat())];
      close();
      await exportAs({ format, dpi, pageNumbers, quality: 0.88, docxLayout });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Export"
      width={560}
      testId="export-modal"
      footer={
        tab === 'convert' ? (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={count === 0} onClick={() => void run()} data-testid="export-run">
              Export
            </Button>
          </>
        ) : undefined
      }
    >
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'convert', label: 'Convert this PDF' }, { value: 'forms', label: 'Collect form data' }]} />
      {tab === 'convert' ? (
        <>
          <Field label="Format" hint={info.hint}>
            <Select value={format} onChange={(exportFormat) => useModalArgs.setState({ exportFormat })} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} ariaLabel="Export format" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pages">
              <Select value={scope} onChange={setScope} ariaLabel="Pages" options={[{ value: 'all', label: `All ${count} pages` }, { value: 'range', label: 'Range…' }]} />
            </Field>
            {raster ? (
              <Field label="Resolution">
                <Select
                  value={String(dpi)}
                  onChange={(v) => setDpi(Number(v))}
                  ariaLabel="Resolution"
                  options={[72, 96, 150, 200, 300, 600].map((d) => ({ value: String(d), label: `${d} DPI${d === 150 ? ' (default)' : d === 600 ? ' (print)' : ''}` }))}
                />
              </Field>
            ) : null}
            {format === 'docx' ? (
              <Field label="Layout">
                <Select
                  value={docxLayout}
                  onChange={setDocxLayout}
                  ariaLabel="Word layout"
                  options={[
                    { value: 'flow', label: 'Flowing text (easy to edit)' },
                    { value: 'exact', label: 'Exact layout (looks like the PDF)' },
                  ]}
                />
              </Field>
            ) : null}
          </div>
          {format === 'docx' && docxLayout === 'exact' ? (
            <p className="mb-3 text-xs text-muted">Every paragraph, table and picture stays where it is on the PDF page, in text frames. Best for forms and designed pages; for longer edits choose Flowing text.</p>
          ) : null}
          {scope === 'range' ? (
            <Field label="Range" hint="e.g. 1-3, 7">
              <Input value={range} onChange={(e) => setRange(e.target.value)} />
            </Field>
          ) : null}
          {error ? <Callout kind="error">{error}</Callout> : null}
        </>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">Pick the filled-in PDF forms you received. Adika builds one CSV with a row per file and a column per field.</p>
          <Button
            variant="primary"
            onClick={async () => {
              const files = await pickFiles([{ name: 'PDF forms', extensions: ['pdf'] }], true);
              if (!files.length) return;
              close();
              await withBusy('Reading forms…', () => batchExtractFormCsv(files));
            }}
          >
            Choose PDF forms…
          </Button>
        </>
      )}
    </Dialog>
  );
}
