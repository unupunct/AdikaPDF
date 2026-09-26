/**
 * Top ribbon: Home, Edit, Sign, Organize, Forms, Security, Convert. Every
 * button maps to a store action or an operation in src/actions.
 */
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  BadgeCheck,
  BookCopy,
  Brush,
  Camera,
  CheckSquare,
  ChevronDown,
  Circle,
  CircleDot,
  Copy,
  Eraser,
  FileArchive,
  FileCheck2,
  FileCode2,
  FileDown,
  FileImage,
  FileInput,
  FileOutput,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderOpen,
  Hand,
  Highlighter,
  ImagePlus,
  Layers,
  LayoutGrid,
  ListChecks,
  Lock,
  Maximize,
  Minus,
  MousePointer2,
  MoveHorizontal,
  PenLine,
  PenTool,
  Presentation,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  SaveAll,
  ScanLine,
  ScanText,
  Scissors,
  Search,
  ShieldCheck,
  ShieldOff,
  Signature,
  Square,
  SquareStack,
  Stamp,
  TableProperties,
  Trash2,
  Type,
  TextCursorInput,
  Undo2,
  Usb,
  ZoomIn,
  ZoomOut,
  Merge,
  BringToFront,
  SendToBack,
  FileKey2,
} from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import type { RibbonTab, ToolId } from '@/types';
import { Tooltip, DropdownMenu, DropdownTrigger, DropdownContent, DropdownItem } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { closeDocumentAction, mergeDialog, openDialog, saveDocument } from '@/actions/document';
import { exportFormCsv } from '@/actions/security';
import { flattenCurrent, pickImagesAsDataUrls } from '@/actions/convert';
import { useModalArgs, type ImportKind } from '@/store/useModalArgs';
import type { ExportFormat } from '@/actions/convert';

const TABS: Array<{ id: RibbonTab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'edit', label: 'Edit' },
  { id: 'sign', label: 'Sign' },
  { id: 'organize', label: 'Organize' },
  { id: 'forms', label: 'Forms' },
  { id: 'security', label: 'Security' },
  { id: 'convert', label: 'Convert' },
];

export function Ribbon() {
  const tab = usePDFStore((s) => s.ribbonTab);
  const setTab = usePDFStore((s) => s.setRibbonTab);
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  return (
    <div className="shrink-0 border-b border-app bg-panel">
      <div role="tablist" aria-label="Ribbon" className="flex h-8 items-end gap-0.5 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            data-testid={`tab-${t.id}`}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'relative h-7 rounded-t-md px-3 text-[13px] font-medium',
              tab === t.id ? 'text-brand-700 dark:text-brand-300' : 'text-muted hover:text-[var(--text)]',
            )}
          >
            {t.label}
            {tab === t.id ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-brand-600" /> : null}
          </button>
        ))}
      </div>
      <div className={cn('flex h-[84px] items-stretch gap-0 overflow-x-auto border-t border-app px-1.5 py-1.5', !hasDoc && tab !== 'home' && tab !== 'convert' && 'opacity-60')}>
        {tab === 'home' && <HomeTab />}
        {tab === 'edit' && <EditTab />}
        {tab === 'sign' && <SignTab />}
        {tab === 'organize' && <OrganizeTab />}
        {tab === 'forms' && <FormsTab />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'convert' && <ConvertTab />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ building blocks

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col border-r border-app px-1.5 last:border-r-0">
      <div className="flex flex-1 items-start gap-0.5">{children}</div>
      <div className="text-center text-[10px] leading-3 text-muted">{label}</div>
    </div>
  );
}

interface BtnProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  tip?: string;
  testId?: string;
}

function Big({ icon, label, onClick, active, disabled, tip, testId }: BtnProps) {
  return (
    <Tooltip content={tip ?? label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex h-[60px] min-w-[54px] flex-col items-center justify-center gap-1 rounded-md px-1.5 text-[11px] leading-tight disabled:opacity-40',
          active ? 'bg-brand-100 text-brand-800 ring-1 ring-brand-300 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700' : 'hover-app',
        )}
      >
        <span className={cn(active ? 'text-brand-700 dark:text-brand-200' : 'text-brand-600 dark:text-brand-400')}>{icon}</span>
        <span className="max-w-[72px] text-center">{label}</span>
      </button>
    </Tooltip>
  );
}

function Small({ icon, label, onClick, active, disabled, tip, testId }: BtnProps) {
  return (
    <Tooltip content={tip ?? label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex h-[19px] items-center gap-1.5 rounded px-1.5 text-[11.5px] disabled:opacity-40',
          active ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-100' : 'hover-app',
        )}
      >
        <span className="text-brand-600 dark:text-brand-400">{icon}</span>
        {label}
      </button>
    </Tooltip>
  );
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col justify-start gap-px py-0.5">{children}</div>;
}

function ToolBtn({ tool, icon, label, tip, big = true }: { tool: ToolId; icon: ReactNode; label: string; tip?: string; big?: boolean }) {
  const active = usePDFStore((s) => s.tool === tool);
  const hasDoc = usePDFStore((s) => s.pages.length > 0 && !s.readOnlyReason);
  const setTool = usePDFStore((s) => s.setTool);
  const B = big ? Big : Small;
  return <B icon={icon} label={label} tip={tip} active={active} disabled={!hasDoc} onClick={() => setTool(active ? 'select' : tool)} testId={`tool-${tool}`} />;
}

function useDoc() {
  const s = usePDFStore();
  return { hasDoc: s.pages.length > 0, editable: s.pages.length > 0 && !s.readOnlyReason, s };
}

const I = 22;
const i = 14;

// ------------------------------------------------------------------ tabs

function HomeTab() {
  const { hasDoc, editable, s } = useDoc();
  const zoomPct = Math.round(s.zoom * 100);
  return (
    <>
      <Group label="File">
        <Big icon={<FolderOpen size={I} />} label="Open" onClick={() => void openDialog()} tip="Open a PDF (Ctrl+O)" testId="btn-open" />
        <Big icon={<Save size={I} />} label="Save" disabled={!editable} onClick={() => void saveDocument(false)} tip="Save (Ctrl+S)" testId="btn-save" />
        <Stack>
          <Small icon={<SaveAll size={i} />} label="Save as…" disabled={!editable} onClick={() => void saveDocument(true)} tip="Save a copy (Ctrl+Shift+S)" testId="btn-save-as" />
          <Small icon={<FilePlus2 size={i} />} label="Create PDF" onClick={() => s.openModal('import')} testId="btn-create" />
          <Small icon={<FileDown size={i} />} label="Close" disabled={!hasDoc} onClick={() => void closeDocumentAction()} />
        </Stack>
      </Group>
      <Group label="History">
        <Stack>
          <Small icon={<Undo2 size={i} />} label="Undo" disabled={s.past.length === 0} onClick={s.undo} tip="Undo (Ctrl+Z)" testId="btn-undo" />
          <Small icon={<Redo2 size={i} />} label="Redo" disabled={s.future.length === 0} onClick={s.redo} tip="Redo (Ctrl+Y)" testId="btn-redo" />
        </Stack>
      </Group>
      <Group label="Tools">
        <ToolBtn tool="select" icon={<MousePointer2 size={I} />} label="Select" tip="Select and move (V)" />
        <ToolBtn tool="pan" icon={<Hand size={I} />} label="Hand" tip="Pan the page (H, or hold the middle mouse button)" />
        <ToolBtn tool="editText" icon={<TextCursorInput size={I} />} label="Edit text" tip="Click existing text to edit it" />
      </Group>
      <Group label="View">
        <Stack>
          <div className="flex items-center gap-0.5">
            <Small icon={<ZoomOut size={i} />} label="" tip="Zoom out (Ctrl+-)" disabled={!hasDoc} onClick={() => s.setZoom(s.zoom / 1.2)} testId="btn-zoom-out" />
            <span data-testid="zoom-level" className="w-12 text-center text-[11.5px] tabular-nums">{zoomPct}%</span>
            <Small icon={<ZoomIn size={i} />} label="" tip="Zoom in (Ctrl+=)" disabled={!hasDoc} onClick={() => s.setZoom(s.zoom * 1.2)} testId="btn-zoom-in" />
          </div>
          <Small icon={<MoveHorizontal size={i} />} label="Fit width" active={s.fitMode === 'width'} disabled={!hasDoc} onClick={() => s.setZoom(s.zoom, 'width')} />
          <Small icon={<Maximize size={i} />} label="Fit page" active={s.fitMode === 'page'} disabled={!hasDoc} onClick={() => s.setZoom(s.zoom, 'page')} />
        </Stack>
        <Big icon={<Search size={I} />} label="Find" disabled={!hasDoc} onClick={() => s.setSearch({ open: true })} tip="Search the document (Ctrl+F)" testId="btn-find" />
      </Group>
      <Group label="Quick actions">
        <Big icon={<Signature size={I} />} label="Fill & Sign" disabled={!editable} onClick={() => s.openModal('signature')} />
        <Big icon={<LayoutGrid size={I} />} label="Organize" disabled={!editable} onClick={() => s.openModal('organizer')} />
        <Big icon={<FileOutput size={I} />} label="Export" disabled={!hasDoc} onClick={() => s.openModal('export')} />
      </Group>
    </>
  );
}

function StyleQuick() {
  const style = usePDFStore((s) => s.style);
  const setStyle = usePDFStore((s) => s.setStyle);
  return (
    <Stack>
      <label className="flex h-[19px] items-center gap-1.5 px-1 text-[11.5px]">
        <span className="w-10 text-muted">Stroke</span>
        <input type="color" aria-label="Stroke colour" value={style.stroke} onChange={(e) => setStyle({ stroke: e.target.value })} className="h-4 w-7 rounded border border-app" />
      </label>
      <label className="flex h-[19px] items-center gap-1.5 px-1 text-[11.5px]">
        <span className="w-10 text-muted">Fill</span>
        <input type="color" aria-label="Fill colour" value={style.fill ?? '#ffffff'} onChange={(e) => setStyle({ fill: e.target.value })} className="h-4 w-7 rounded border border-app" />
        <button type="button" className={cn('rounded px-1 text-[10px]', style.fill === null ? 'bg-brand-600 text-white' : 'hover-app')} onClick={() => setStyle({ fill: null })}>
          none
        </button>
      </label>
      <label className="flex h-[19px] items-center gap-1.5 px-1 text-[11.5px]">
        <span className="w-10 text-muted">Width</span>
        <input type="range" aria-label="Stroke width" min={0.5} max={12} step={0.5} value={style.strokeWidth} onChange={(e) => setStyle({ strokeWidth: Number(e.target.value) })} className="w-16" />
        <span className="w-6 tabular-nums">{style.strokeWidth}</span>
      </label>
    </Stack>
  );
}

function EditTab() {
  const { editable, s } = useDoc();
  const sel = s.selectedIds;
  const pickImage = async () => {
    const imgs = await pickImagesAsDataUrls();
    if (imgs[0]) s.setPendingImage(imgs[0]);
    if (imgs[0]) s.toast('Click on the page where the image should go.', 'info');
  };
  return (
    <>
      <Group label="Text">
        <ToolBtn tool="editText" icon={<TextCursorInput size={I} />} label="Edit text" tip="Click any existing text to replace it" />
        <ToolBtn tool="text" icon={<Type size={I} />} label="Add text" tip="Click to add a text box (T)" />
      </Group>
      <Group label="Insert">
        <Big icon={<ImagePlus size={I} />} label="Image" disabled={!editable} onClick={() => void pickImage()} active={s.tool === 'image'} testId="btn-image" />
      </Group>
      <Group label="Draw">
        <ToolBtn tool="rect" icon={<Square size={I} />} label="Rectangle" tip="Rectangle (R) — Shift for a square" />
        <ToolBtn tool="ellipse" icon={<Circle size={I} />} label="Ellipse" tip="Ellipse (E) — Shift for a circle" />
        <Stack>
          <ToolBtn big={false} tool="line" icon={<Minus size={i} />} label="Line" tip="Line (L) — Shift snaps to 45°" />
          <ToolBtn big={false} tool="arrow" icon={<ArrowUpRight size={i} />} label="Arrow" tip="Arrow (A)" />
          <ToolBtn big={false} tool="pen" icon={<Brush size={i} />} label="Freehand" tip="Freehand pen (P)" />
        </Stack>
        <ToolBtn tool="highlight" icon={<Highlighter size={I} />} label="Highlight" tip="Highlight an area" />
      </Group>
      <Group label="Style">
        <StyleQuick />
      </Group>
      <Group label="Arrange">
        <Stack>
          <Small icon={<BringToFront size={i} />} label="Bring to front" disabled={sel.length !== 1} onClick={() => s.reorderObject(sel[0], 'front')} />
          <Small icon={<SendToBack size={i} />} label="Send to back" disabled={sel.length !== 1} onClick={() => s.reorderObject(sel[0], 'back')} />
          <Small icon={<Layers size={i} />} label="Forward" disabled={sel.length !== 1} onClick={() => s.reorderObject(sel[0], 'forward')} />
        </Stack>
        <Stack>
          <Small icon={<Copy size={i} />} label="Duplicate" disabled={sel.length === 0} onClick={() => s.duplicateObjects(sel)} />
          <Small icon={<Trash2 size={i} />} label="Delete" disabled={sel.length === 0} onClick={() => s.deleteObjects(sel)} />
        </Stack>
      </Group>
    </>
  );
}

function SignTab() {
  const { hasDoc, editable, s } = useDoc();
  return (
    <>
      <Group label="Electronic signature">
        <Big icon={<Signature size={I} />} label="Sign" disabled={!editable} onClick={() => s.openModal('signature')} tip="Draw, type or upload your signature and place it" testId="btn-sign" />
        <SavedSignaturesMenu />
      </Group>
      <Group label="Digital signature (certificate)">
        <Big icon={<FileKey2 size={I} />} label="Certificate ID" disabled={!hasDoc} onClick={() => s.openModal('certificate')} tip="Sign with a .pfx/.p12 certificate or create a self-signed ID" testId="btn-cert-sign" />
        <Big icon={<Usb size={I} />} label="Token / smart card" disabled={!hasDoc} onClick={() => s.openModal('token')} tip="Sign with a USB token or smart card (PKCS#11)" testId="btn-token-sign" />
        <ToolBtn tool="field-signature" icon={<PenLine size={I} />} label="Signature field" tip="Draw an empty signature field for someone else to sign" />
      </Group>
      <Group label="Validation">
        <Big icon={<BadgeCheck size={I} />} label="Verify" disabled={!hasDoc} onClick={() => s.openModal('verify')} tip="Check signatures, certificate chain and revocation" testId="btn-verify" />
      </Group>
    </>
  );
}

function SavedSignaturesMenu() {
  const saved = usePDFStore((s) => s.savedSignatures);
  const editable = usePDFStore((s) => s.pages.length > 0 && !s.readOnlyReason);
  const setPending = usePDFStore((s) => s.setPendingSignature);
  const toast = usePDFStore((s) => s.toast);
  return (
    <DropdownMenu>
      <DropdownTrigger asChild disabled={!editable || saved.length === 0}>
        <button type="button" className="flex h-[60px] min-w-[54px] flex-col items-center justify-center gap-1 rounded-md px-1.5 text-[11px] hover-app disabled:opacity-40">
          <Stamp size={I} className="text-brand-600 dark:text-brand-400" />
          <span className="flex items-center gap-0.5">
            Saved <ChevronDown size={10} />
          </span>
        </button>
      </DropdownTrigger>
      <DropdownContent>
        {saved.map((sig) => (
          <DropdownItem
            key={sig.id}
            onSelect={() => {
              setPending(sig);
              toast('Click on the page to place the signature.', 'info');
            }}
          >
            <img src={sig.src} alt="" className="h-7 max-w-[120px] rounded bg-white object-contain" />
            <span className="text-xs">{sig.kind === 'initials' ? 'Initials' : 'Signature'}</span>
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

function OrganizeTab() {
  const { editable, s } = useDoc();
  const current = s.currentPageId;
  const idx = s.pages.findIndex((p) => p.id === current);
  return (
    <>
      <Group label="Pages">
        <Big icon={<LayoutGrid size={I} />} label="Organizer" disabled={!editable} onClick={() => s.openModal('organizer')} tip="Grid view: drag, rotate, delete, insert pages" testId="btn-organizer" />
        <Stack>
          <Small icon={<RotateCcw size={i} />} label="Rotate left" disabled={!editable || !current} onClick={() => current && s.rotatePages([current], 270)} />
          <Small icon={<RotateCw size={i} />} label="Rotate right" disabled={!editable || !current} onClick={() => current && s.rotatePages([current], 90)} testId="btn-rotate-right" />
          <Small icon={<Trash2 size={i} />} label="Delete page" disabled={!editable || !current || s.pages.length < 2} onClick={() => current && s.deletePages([current])} />
        </Stack>
        <Stack>
          <Small icon={<FilePlus2 size={i} />} label="Insert blank" disabled={!editable} onClick={() => s.insertBlankPage(idx + 1)} testId="btn-insert-blank" />
          <Small icon={<SquareStack size={i} />} label="Duplicate page" disabled={!editable || !current} onClick={() => current && s.duplicatePages([current])} />
        </Stack>
      </Group>
      <Group label="Combine & split">
        <Big icon={<Merge size={I} />} label="Merge PDFs" disabled={!editable} onClick={() => void mergeDialog()} tip="Append other PDF files" testId="btn-merge" />
        <Big icon={<Scissors size={I} />} label="Split / Extract" disabled={!editable} onClick={() => s.openModal('split')} testId="btn-split" />
      </Group>
    </>
  );
}

function FormsTab() {
  const { hasDoc, s } = useDoc();
  return (
    <>
      <Group label="Add fields">
        <ToolBtn tool="field-text" icon={<TextCursorInput size={I} />} label="Text field" />
        <ToolBtn tool="field-checkbox" icon={<CheckSquare size={I} />} label="Checkbox" />
        <ToolBtn tool="field-radio" icon={<CircleDot size={I} />} label="Radio" tip="Radio buttons placed in a row join the same group" />
        <ToolBtn tool="field-dropdown" icon={<ListChecks size={I} />} label="Dropdown" />
        <ToolBtn tool="field-signature" icon={<PenLine size={I} />} label="Signature" />
      </Group>
      <Group label="Data">
        <Big icon={<TableProperties size={I} />} label="Fill form" disabled={!hasDoc} onClick={() => usePDFStore.setState({ inspectorOpen: true, selectedIds: [] })} tip="Fill existing form fields in the right panel" />
        <Big icon={<FileSpreadsheet size={I} />} label="Export CSV" disabled={!hasDoc} onClick={() => void exportFormCsv()} tip="Export field values as CSV" />
        <Big icon={<BookCopy size={I} />} label="Batch CSV" onClick={() => s.openModal('export')} tip="Collect answers from many filled PDFs into one CSV (Convert → Export)" />
      </Group>
      <Group label="Finish">
        <Big icon={<Stamp size={I} />} label="Flatten" disabled={!hasDoc} onClick={() => void flattenCurrent()} tip="Burn fields, annotations and signatures into the page so they can no longer be changed" />
      </Group>
    </>
  );
}

function SecurityTab() {
  const { hasDoc, s } = useDoc();
  return (
    <>
      <Group label="Redaction">
        <ToolBtn tool="redact" icon={<Eraser size={I} />} label="Mark redaction" tip="Draw boxes over content to remove permanently" />
        <Big
          icon={<ScanLine size={I} />}
          label="Apply & save"
          disabled={!hasDoc || !s.objects.some((o) => o.type === 'redact')}
          onClick={() => void saveDocument(true)}
          tip="Save a copy with marked content destroyed (pixels and text)"
          testId="btn-apply-redactions"
        />
      </Group>
      <Group label="Protection">
        <Big icon={<Lock size={I} />} label="Password" disabled={!hasDoc} onClick={() => s.openModal('password')} tip="AES-256 encryption and permissions" testId="btn-protect" />
        <Big icon={<ShieldOff size={I} />} label="Sanitize" disabled={!hasDoc} onClick={() => void import('@/actions/security').then((m) => m.sanitizeDocument())} tip="Remove metadata, XMP and hidden info" />
      </Group>
      <Group label="Signatures">
        <Big icon={<ShieldCheck size={I} />} label="Verify" disabled={!hasDoc} onClick={() => s.openModal('verify')} />
      </Group>
    </>
  );
}

function ConvertTab() {
  const { hasDoc, s } = useDoc();
  const openExport = (exportFormat: ExportFormat) => {
    useModalArgs.setState({ exportFormat });
    s.openModal('export');
  };
  const openImport = (importKind: ImportKind) => {
    useModalArgs.setState({ importKind });
    s.openModal('import');
  };
  return (
    <>
      <Group label="Create PDF from">
        <Big icon={<FileType2 size={I} />} label="Office" onClick={() => openImport('office')} tip="Word, Excel, PowerPoint (uses Microsoft Office on this PC)" testId="btn-import-office" />
        <Big icon={<FileImage size={I} />} label="Images" onClick={() => openImport('images')} tip="PNG, JPG, WebP, TIFF, GIF, BMP" testId="btn-import-images" />
        <Stack>
          <Small icon={<FileCode2 size={i} />} label="HTML / URL" onClick={() => openImport('html')} />
          <Small icon={<FileText size={i} />} label="Markdown / text" onClick={() => openImport('markdown')} />
          <Small icon={<Camera size={i} />} label="Scanner / camera" onClick={() => openImport('scan')} />
        </Stack>
        <Stack>
          <Small icon={<BookCopy size={i} />} label="EPUB / e-mail / XPS" onClick={() => openImport('documents')} testId="btn-import-documents" />
          <Small icon={<PenTool size={i} />} label="CAD (DXF)" onClick={() => openImport('cad')} testId="btn-import-cad" />
        </Stack>
      </Group>
      <Group label="Export PDF to">
        <Big icon={<FileInput size={I} />} label="Word" disabled={!hasDoc} onClick={() => openExport('docx')} testId="btn-export-docx" />
        <Big icon={<FileSpreadsheet size={I} />} label="Excel" disabled={!hasDoc} onClick={() => openExport('xlsx')} />
        <Big icon={<Presentation size={I} />} label="PowerPoint" disabled={!hasDoc} onClick={() => openExport('pptx')} />
        <Stack>
          <Small icon={<FileImage size={i} />} label="Images" disabled={!hasDoc} onClick={() => openExport('png')} />
          <Small icon={<PenTool size={i} />} label="SVG" disabled={!hasDoc} onClick={() => openExport('svg')} />
          <Small icon={<FileCode2 size={i} />} label="HTML / Markdown" disabled={!hasDoc} onClick={() => openExport('html')} />
        </Stack>
        <Stack>
          <Small icon={<FileText size={i} />} label="ODT / RTF" disabled={!hasDoc} onClick={() => openExport('odt')} />
          <Small icon={<BookCopy size={i} />} label="EPUB" disabled={!hasDoc} onClick={() => openExport('epub')} />
          <Small icon={<TableProperties size={i} />} label="CSV / JSON" disabled={!hasDoc} onClick={() => openExport('csv')} />
        </Stack>
      </Group>
      <Group label="Optimize">
        <Big icon={<ScanText size={I} />} label="OCR" disabled={!hasDoc} onClick={() => s.openModal('ocr')} tip="Make scanned pages searchable" testId="btn-ocr" />
        <Big icon={<FileArchive size={I} />} label="Compress" disabled={!hasDoc} onClick={() => s.openModal('compress')} testId="btn-compress" />
        <Big icon={<FileCheck2 size={I} />} label="PDF/A" disabled={!hasDoc} onClick={() => s.openModal('pdfa')} tip="Archival PDF/A-2b" />
        <Big icon={<Stamp size={I} />} label="Flatten" disabled={!hasDoc} onClick={() => void flattenCurrent()} />
      </Group>
    </>
  );
}
