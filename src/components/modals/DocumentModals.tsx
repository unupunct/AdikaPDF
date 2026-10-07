/** Page organizer, split/extract, password protection, compression, OCR, PDF/A, about. */
import { useEffect, useMemo, useState } from 'react';
import { Copy, FilePlus2, Merge, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import { PageThumbnail } from '@/components/sidebar/PageThumbnail';
import { extractPages, parseRanges, runCompress, runOcr, runPdfA, splitAtSeparators, splitByBookmarks, splitBySize, splitDocument } from '@/actions/convert';
import { mergeDialog } from '@/actions/document';
import { protectDocument } from '@/actions/security';
import type { PdfPermissions } from '@/lib/crypto/encrypt';
import { AdikaLogo } from '@/components/shell/AdikaLogo';
import { logsFolder, openLogsFolder } from '@/lib/log';
import { APP_VERSION, checkForUpdates, useUpdates } from '@/lib/updates';
import { openExternal } from '@/lib/platform';

function UpdateInfo() {
  const { status, latest, error, auto, setAuto } = useUpdates();
  return (
    <div className="mt-4 rounded-lg border border-app px-3 py-2 text-[11.5px]" data-testid="update-info">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Updates</span>
          <span className="block text-muted" data-testid="update-status">
            {status === 'checking'
              ? 'Checking GitHub…'
              : status === 'latest'
                ? `You have the latest version (${APP_VERSION}).`
                : status === 'available' && latest
                  ? `Version ${latest.version} is available.`
                  : status === 'error'
                    ? `Could not check: ${error}`
                    : 'Asks GitHub for the latest version; nothing else is sent.'}
          </span>
        </span>
        {status === 'available' && latest ? (
          <Button size="sm" variant="primary" onClick={() => void openExternal(latest.url)} data-testid="update-download">
            Download
          </Button>
        ) : (
          <Button size="sm" disabled={status === 'checking'} onClick={() => void checkForUpdates()} data-testid="update-check">
            Check for updates
          </Button>
        )}
      </div>
      <div className="mt-1.5">
        <Checkbox checked={auto} onChange={setAuto} label="Check automatically once a week" />
      </div>
    </div>
  );
}

function LogsInfo() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    void logsFolder().then(setPath);
  }, []);
  if (!path) return null;
  return (
    <div className="mt-4 flex items-center gap-2 rounded-lg border border-app px-3 py-2 text-[11.5px]" data-testid="logs-info">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">Logs</span>
        <span className="block break-all text-muted" data-testid="logs-path">
          {path}
        </span>
      </span>
      <Button size="sm" onClick={() => void openLogsFolder()} data-testid="open-logs">
        Open logs folder
      </Button>
    </div>
  );
}
import { cn } from '@/lib/cn';
import { OCR_LANGUAGES } from '@/lib/pdf/ocr';
import type { PdfALevel } from '@/lib/pdf/pdfa';
import { pickFiles } from '@/lib/platform';

const PDFA_HINTS: Record<PdfALevel, string> = {
  '1b': 'Accepted by the most archives. Transparency and layers are removed or flagged.',
  '2b': 'The usual choice for long-term storage and e-government submissions.',
  '3b': 'Like 2b, and keeps attached files (e.g. the editable original) inside the archive.',
};

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xml: 'application/xml',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return map[ext] ?? 'application/octet-stream';
}

const OCR_LANG_KEY = 'adika.ocrLangs';

export function loadOcrLangs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OCR_LANG_KEY) ?? 'null') as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length) return v as string[];
  } catch {
    /* ignore */
  }
  return ['ron', 'eng'];
}

export function saveOcrLangs(langs: string[]): void {
  try {
    localStorage.setItem(OCR_LANG_KEY, JSON.stringify(langs));
  } catch {
    /* ignore */
  }
}

const close = () => usePDFStore.getState().openModal(null);

// ================================================================ organizer

export function OrganizerModal() {
  const open = usePDFStore((s) => s.modal === 'organizer');
  const pages = usePDFStore((s) => s.pages);
  const [sel, setSel] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const s = usePDFStore.getState();

  useEffect(() => {
    if (open) setSel([]);
  }, [open]);

  const click = (e: React.MouseEvent, id: string, i: number) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSel(pages.slice(a, b + 1).map((p) => p.id));
    } else if (e.ctrlKey || e.metaKey) {
      setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
      setAnchor(i);
    } else {
      setSel([id]);
      setAnchor(i);
    }
  };

  const drop = () => {
    if (!dragId || dropAt === null) return;
    const moving = sel.includes(dragId) ? pages.filter((p) => sel.includes(p.id)).map((p) => p.id) : [dragId];
    const rest = pages.map((p) => p.id).filter((id) => !moving.includes(id));
    const before = pages.slice(0, dropAt).filter((p) => !moving.includes(p.id)).length;
    rest.splice(before, 0, ...moving);
    s.reorderPages(rest);
    setDragId(null);
    setDropAt(null);
  };

  const selectedNumbers = pages.map((p, i) => (sel.includes(p.id) ? i + 1 : 0)).filter(Boolean);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Organize pages"
      description="Drag to reorder. Click to select, Ctrl-click to add, Shift-click for a range."
      width={1060}
      testId="organizer-modal"
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {pages.length} pages{sel.length ? ` · ${sel.length} selected` : ''}
          </span>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Button size="sm" disabled={!sel.length} onClick={() => s.rotatePages(sel, 270)}>
          <RotateCcw size={13} /> Rotate left
        </Button>
        <Button size="sm" disabled={!sel.length} onClick={() => s.rotatePages(sel, 90)} data-testid="org-rotate-right">
          <RotateCw size={13} /> Rotate right
        </Button>
        <Button size="sm" disabled={!sel.length} onClick={() => s.duplicatePages(sel)}>
          <Copy size={13} /> Duplicate
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const last = sel.length ? Math.max(...sel.map((id) => pages.findIndex((p) => p.id === id))) + 1 : pages.length;
            s.insertBlankPage(last);
          }}
        >
          <FilePlus2 size={13} /> Insert blank
        </Button>
        <Button size="sm" onClick={() => void mergeDialog()}>
          <Merge size={13} /> Add PDF…
        </Button>
        <Button size="sm" disabled={!sel.length} onClick={() => void extractPages(selectedNumbers)}>
          Extract selected…
        </Button>
        <Button size="sm" variant="danger" disabled={!sel.length || sel.length >= pages.length} onClick={() => { s.deletePages(sel); setSel([]); }} data-testid="org-delete">
          <Trash2 size={13} /> Delete
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setSel(pages.map((p) => p.id))}>
          Select all
        </Button>
      </div>
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
        onDragOver={(e) => dragId && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          drop();
        }}
      >
        {pages.map((p, i) => (
          <div
            key={p.id}
            draggable
            data-testid={`org-page-${i + 1}`}
            onDragStart={() => setDragId(p.id)}
            onDragEnd={() => {
              setDragId(null);
              setDropAt(null);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
            }}
            onClick={(e) => click(e, p.id, i)}
            onDoubleClick={() => {
              s.scrollToPage(p.id);
              close();
            }}
            className={cn(
              'relative flex cursor-default flex-col items-center gap-1 rounded-lg p-2',
              sel.includes(p.id) ? 'bg-brand-100 ring-2 ring-brand-500 dark:bg-brand-900/40' : 'hover-app',
              dragId === p.id && 'opacity-40',
            )}
          >
            {dropAt === i && dragId ? <div className="absolute -left-2 bottom-2 top-2 w-0.5 rounded bg-brand-500" /> : null}
            {dropAt === i + 1 && i === pages.length - 1 && dragId ? <div className="absolute -right-2 bottom-2 top-2 w-0.5 rounded bg-brand-500" /> : null}
            <PageThumbnail page={p} width={130} />
            <span className="text-[11px] text-muted">
              {i + 1}
              {p.kind === 'blank' ? ' · blank' : ''}
              {p.userRotation ? ` · ${p.userRotation}°` : ''}
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ================================================================ split

export function SplitModal() {
  const open = usePDFStore((s) => s.modal === 'split');
  const count = usePDFStore((s) => s.pages.length);
  const [mode, setMode] = useState<'every' | 'ranges' | 'extract' | 'separators' | 'bookmarks' | 'size'>('every');
  const [maxMb, setMaxMb] = useState(10);
  const [atBlank, setAtBlank] = useState(true);
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState('1-2, 3-');
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    try {
      setError(null);
      if (mode === 'every') {
        const n = Math.max(1, Math.floor(every));
        const chunks: number[][] = [];
        for (let i = 1; i <= count; i += n) chunks.push(Array.from({ length: Math.min(n, count - i + 1) }, (_, k) => i + k));
        close();
        await splitDocument(chunks);
      } else if (mode === 'bookmarks') {
        close();
        await splitByBookmarks();
      } else if (mode === 'size') {
        close();
        await splitBySize(maxMb);
      } else if (mode === 'separators') {
        close();
        await splitAtSeparators({ atBlank });
      } else if (mode === 'ranges') {
        const parsed = parseRanges(ranges, count);
        close();
        await splitDocument(parsed);
      } else {
        const pagesList = parseRanges(ranges, count).flat();
        close();
        await extractPages([...new Set(pagesList)]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Split or extract pages"
      width={620}
      testId="split-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void run()} data-testid="split-run">
            {mode === 'extract' ? 'Extract' : 'Split'}
          </Button>
        </>
      }
    >
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { value: 'every', label: 'Every N pages' },
          { value: 'ranges', label: 'By ranges' },
          { value: 'bookmarks', label: 'Bookmarks' },
          { value: 'size', label: 'Size' },
          { value: 'separators', label: 'At separators' },
          { value: 'extract', label: 'Extract' },
        ]}
      />
      {mode === 'bookmarks' ? (
        <p className="mb-2 text-xs text-muted">One file per top-level bookmark (chapter), named after it. Pages before the first bookmark become a file of their own.</p>
      ) : mode === 'size' ? (
        <Field label="Largest file (MB)" hint="For e-mail limits: parts are filled page by page up to this size.">
          <Input type="number" min={0.5} step={0.5} value={maxMb} onChange={(e) => setMaxMb(Number(e.target.value) || 10)} data-testid="split-max-mb" />
        </Field>
      ) : mode === 'separators' ? (
        <>
          <p className="mb-2 text-xs text-muted">Splits a scanned batch at Adika separator sheets (their barcode names the next part; print them from Scan to PDF) and, if you want, at blank pages. The separator and blank pages are left out.</p>
          <Checkbox checked={atBlank} onChange={setAtBlank} label="Blank pages also start a new part" />
        </>
      ) : mode === 'every' ? (
        <Field label="Pages per file" hint={`${count} pages → ${Math.ceil(count / Math.max(1, every))} files (saved as a ZIP when more than one).`}>
          <Input type="number" min={1} max={count} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
        </Field>
      ) : (
        <Field label={mode === 'extract' ? 'Pages to extract into one PDF' : 'Ranges (one file each)'} hint={`e.g. “1-3, 5, 8-” · document has ${count} pages`}>
          <Input value={ranges} onChange={(e) => setRanges(e.target.value)} data-testid="split-ranges" />
        </Field>
      )}
      {error ? <Callout kind="error">{error}</Callout> : null}
    </Dialog>
  );
}

// ================================================================ password protect

const DEFAULT_PERMS: PdfPermissions = {
  print: true,
  printHighQuality: true,
  modify: false,
  copy: false,
  annotate: true,
  fillForms: true,
  extractForAccessibility: true,
  assemble: false,
};

export function PasswordModal() {
  const open = usePDFStore((s) => s.modal === 'password');
  const [userPw, setUserPw] = useState('');
  const [userPw2, setUserPw2] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [requireOpen, setRequireOpen] = useState(true);
  const [perms, setPerms] = useState<PdfPermissions>(DEFAULT_PERMS);
  const mismatch = requireOpen && userPw !== userPw2;
  const weak = requireOpen && userPw.length > 0 && userPw.length < 6;
  const valid = (!requireOpen || (userPw.length > 0 && !mismatch)) && (ownerPw.length > 0 || requireOpen);

  const run = async () => {
    const owner = ownerPw || randomPassword();
    const user = requireOpen ? userPw : '';
    if (owner === user && user) {
      usePDFStore.getState().toast('The permissions password must differ from the open password, or restrictions cannot be enforced.', 'error');
      return;
    }
    close();
    setUserPw('');
    setUserPw2('');
    setOwnerPw('');
    await protectDocument(user, owner, perms);
  };

  const P = ({ k, label }: { k: keyof PdfPermissions; label: string }) => <Checkbox checked={perms[k]} label={label} onChange={(v) => setPerms({ ...perms, [k]: v })} />;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Password protection"
      description="AES-256 encryption (PDF 2.0 / Acrobat X and later). Works in every modern PDF reader."
      width={540}
      testId="password-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void run()} data-testid="protect-run">
            Encrypt and save copy
          </Button>
        </>
      }
    >
      <Checkbox checked={requireOpen} onChange={setRequireOpen} label="Require a password to open the document" />
      {requireOpen ? (
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Field label="Open password">
            <Input type="password" value={userPw} onChange={(e) => setUserPw(e.target.value)} autoComplete="new-password" data-testid="protect-user" />
          </Field>
          <Field label="Confirm">
            <Input type="password" value={userPw2} onChange={(e) => setUserPw2(e.target.value)} autoComplete="new-password" data-testid="protect-user2" />
          </Field>
        </div>
      ) : null}
      {mismatch && userPw2 ? <Callout kind="error">The passwords do not match.</Callout> : null}
      {weak ? <Callout kind="warn">Short passwords can be guessed. Use at least 8–10 characters.</Callout> : null}
      <Field label="Permissions password (owner)" hint={requireOpen ? 'Optional — a random one is generated if empty, so the restrictions below still apply.' : 'Required to restrict printing, copying or editing without an open password.'}>
        <Input type="password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} autoComplete="new-password" data-testid="protect-owner" />
      </Field>
      <div className="grid grid-cols-2 gap-x-4">
        <P k="print" label="Allow printing" />
        <P k="printHighQuality" label="High-quality printing" />
        <P k="copy" label="Allow copying text & images" />
        <P k="modify" label="Allow editing" />
        <P k="annotate" label="Allow comments" />
        <P k="fillForms" label="Allow form filling & signing" />
        <P k="assemble" label="Allow page assembly" />
        <P k="extractForAccessibility" label="Screen readers" />
      </div>
      <Callout kind="info">Permission flags are honoured by standard readers; only the open password provides real cryptographic protection.</Callout>
    </Dialog>
  );
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ================================================================ compress

export function CompressModal() {
  const open = usePDFStore((s) => s.modal === 'compress');
  const [preset, setPreset] = useState<'balanced' | 'strong' | 'light'>('balanced');
  const [strip, setStrip] = useState(true);
  const [result, setResult] = useState<{ before: number; after: number } | null>(null);
  const presets = { light: { imageQuality: 0.85, maxImageDpi: 220 }, balanced: { imageQuality: 0.72, maxImageDpi: 150 }, strong: { imageQuality: 0.55, maxImageDpi: 100 } };

  useEffect(() => {
    if (open) setResult(null);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Compress PDF"
      description="Images are re-encoded and down-sampled on this computer; text and vector graphics are untouched."
      width={480}
      testId="compress-modal"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button
            variant="primary"
            data-testid="compress-run"
            onClick={async () => {
              const r = await runCompress({ ...presets[preset], stripMetadata: strip });
              if (r) setResult(r);
            }}
          >
            Compress and save copy
          </Button>
        </>
      }
    >
      <Field label="Level">
        <Select
          value={preset}
          onChange={setPreset}
          ariaLabel="Compression level"
          options={[
            { value: 'light', label: 'Light — 220 DPI, high quality' },
            { value: 'balanced', label: 'Balanced — 150 DPI (screen & print)' },
            { value: 'strong', label: 'Strong — 100 DPI, smallest file' },
          ]}
        />
      </Field>
      <Checkbox checked={strip} onChange={setStrip} label="Remove metadata and hidden data" />
      {result ? (
        <Callout kind={result.after < result.before ? 'success' : 'info'}>
          {fmt(result.before)} → {fmt(result.after)} ({Math.round((1 - result.after / result.before) * 100)}% smaller)
        </Callout>
      ) : null}
    </Dialog>
  );
}

function fmt(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// ================================================================ OCR

export function OcrModal() {
  const open = usePDFStore((s) => s.modal === 'ocr');
  const count = usePDFStore((s) => s.pages.length);
  const current = usePDFStore((s) => s.pages.findIndex((p) => p.id === s.currentPageId) + 1);
  const [scope, setScope] = useState<'all' | 'current' | 'range'>('all');
  const [range, setRange] = useState('1-');
  const [dpi, setDpi] = useState(300);
  const [langs, setLangs] = useState<string[]>(() => loadOcrLangs());
  const [output, setOutput] = useState<'searchable' | 'sans' | 'serif'>('searchable');
  const [straighten, setStraighten] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const toggleLang = (code: string) => {
    const next = langs.includes(code) ? langs.filter((l) => l !== code) : [...langs, code];
    setLangs(next.length ? next : ['eng']);
  };

  const run = async () => {
    try {
      const pageNumbers = scope === 'all' ? Array.from({ length: count }, (_, i) => i + 1) : scope === 'current' ? [Math.max(1, current)] : [...new Set(parseRanges(range, count).flat())];
      saveOcrLangs(langs);
      close();
      await runOcr({ pageNumbers, dpi, lang: langs.join('+'), straighten, editable: output === 'searchable' ? undefined : { family: output } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Recognise text (OCR)"
      description="Makes scanned pages searchable, or turns their text into editable text. Runs offline."
      width={480}
      testId="ocr-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void run()} data-testid="ocr-run">
            Run OCR
          </Button>
        </>
      }
    >
      <Field label="Pages">
        <Select value={scope} onChange={setScope} ariaLabel="OCR pages" options={[{ value: 'all', label: `All ${count} pages` }, { value: 'current', label: `Current page (${current})` }, { value: 'range', label: 'Page range…' }]} />
      </Field>
      {scope === 'range' ? (
        <Field label="Range">
          <Input value={range} onChange={(e) => setRange(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Result" hint={output === 'searchable' ? 'The scan stays as it is; invisible text makes it searchable and copyable.' : 'The scanned text is replaced by real text in a similar font, size and colour, which can be edited. Pictures and signatures stay.'}>
        <Select
          value={output}
          onChange={setOutput}
          ariaLabel="OCR result"
          options={[
            { value: 'searchable', label: 'Searchable (invisible text layer)' },
            { value: 'serif', label: 'Editable text, serif font (letters, contracts)' },
            { value: 'sans', label: 'Editable text, sans-serif font (forms, reports)' },
          ]}
        />
      </Field>
      <Field label="Resolution" hint="300 DPI is best for typical scans; 400 for small print.">
        <Select value={String(dpi)} onChange={(v) => setDpi(Number(v))} ariaLabel="OCR resolution" options={[{ value: '200', label: '200 DPI (fast)' }, { value: '300', label: '300 DPI (recommended)' }, { value: '400', label: '400 DPI (small text)' }]} />
      </Field>
      {output === 'searchable' ? (
        <Checkbox checked={straighten} onChange={setStraighten} label="Straighten page orientation" />
      ) : null}
      <Field label="Document languages" hint="Pick every language that appears in the scan. Fewer languages = faster and more accurate.">
        <div className="flex flex-wrap gap-1.5" data-testid="ocr-langs">
          {OCR_LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              aria-pressed={langs.includes(l.code)}
              onClick={() => toggleLang(l.code)}
              className={cn('rounded-full border px-2.5 py-1 text-xs', langs.includes(l.code) ? 'border-brand-600 bg-brand-600 text-white' : 'border-app hover-app')}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Field>
      {error ? <Callout kind="error">{error}</Callout> : null}
    </Dialog>
  );
}

// ================================================================ PDF/A

export function PdfaModal() {
  const open = usePDFStore((s) => s.modal === 'pdfa');
  const fileName = usePDFStore((s) => s.fileName);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [level, setLevel] = useState<PdfALevel>('2b');
  const [attachments, setAttachments] = useState<Array<{ name: string; mime: string; bytes: Uint8Array }>>([]);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  useEffect(() => {
    if (open) {
      setTitle((fileName ?? 'Document').replace(/\.pdf$/i, ''));
      setWarnings(null);
    }
  }, [open, fileName]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Convert to PDF/A (archival)"
      description="Embeds an sRGB output intent and XMP metadata, and removes JavaScript and encryption."
      width={560}
      testId="pdfa-modal"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" onClick={async () => setWarnings((await runPdfA({ title, author, level, attachments: level === '3b' ? attachments : undefined })) ?? null)} data-testid="pdfa-run">
            Convert and save copy
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Author">
          <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </Field>
      </div>
      <Field label="Standard" hint={PDFA_HINTS[level]}>
        <Select
          value={level}
          onChange={setLevel}
          ariaLabel="PDF/A level"
          options={[
            { value: '1b', label: 'PDF/A-1b — widest compatibility (PDF 1.4, no transparency)' },
            { value: '2b', label: 'PDF/A-2b — recommended (transparency, layers allowed)' },
            { value: '3b', label: 'PDF/A-3b — with embedded source files' },
          ]}
        />
      </Field>
      {level === '3b' ? (
        <div className="mb-3">
          <Button
            size="sm"
            onClick={async () => {
              const files = await pickFiles([{ name: 'Any file', extensions: ['*'] }], true);
              setAttachments([...attachments, ...files.map((f) => ({ name: f.name, mime: guessMime(f.name), bytes: f.bytes }))]);
            }}
          >
            Attach source files…
          </Button>
          <span className="ml-2 text-xs text-muted">{attachments.length ? attachments.map((a) => a.name).join(', ') : 'e.g. the original .docx or .xlsx'}</span>
        </div>
      ) : null}
      {warnings ? (
        warnings.length ? (
          <Callout kind="warn">
            <div className="mb-1 font-semibold">Check before archiving:</div>
            <ul className="list-disc pl-4">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          <Callout kind="success">Converted. No problems detected.</Callout>
        )
      ) : null}
    </Dialog>
  );
}

// ================================================================ about

export function AboutModal() {
  const open = usePDFStore((s) => s.modal === 'about');
  const shortcuts = useMemo(
    () => [
      ['Ctrl+O / Ctrl+S / Ctrl+Shift+S', 'Open / Save / Save as'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
      ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy / Paste / Duplicate'],
      ['Delete', 'Delete selection'],
      ['Arrows (+Shift)', 'Nudge 1 pt (10 pt)'],
      ['Ctrl+F', 'Find'],
      ['Ctrl+wheel, Ctrl+= / Ctrl+-', 'Zoom'],
      ['V H T R E L A P', 'Select, Hand, Text, Rect, Ellipse, Line, Arrow, Pen'],
      ['Esc', 'Cancel tool / deselect'],
    ],
    [],
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="About" width={520} footer={<Button variant="primary" onClick={close}>Close</Button>}>
      <AdikaLogo className="mx-auto mb-3 h-14" />
      <p className="mb-4 text-center text-xs text-muted">Version {APP_VERSION} · Privacy-first, offline PDF editor · MIT licence</p>
      <table className="w-full text-xs">
        <tbody>
          {shortcuts.map(([k, v]) => (
            <tr key={k} className="border-b border-app last:border-0">
              <td className="py-1.5 pr-3 font-mono text-[11px]">{k}</td>
              <td className="py-1.5 text-muted">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <UpdateInfo />
      <LogsInfo />
      <p className="mt-4 text-[11px] text-muted">
        Built with pdf.js (Mozilla), pdf-lib, Konva, node-forge, Tesseract.js, libheif (LGPL-3.0), postal-mime, msgreader, dxf-parser, Noto fonts (SIL OFL) and Tauri.
      </p>
    </Dialog>
  );
}
