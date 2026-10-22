/**
 * The simple ribbon: the commands most people need, grouped by task, in one
 * row. Labels match the full ribbon's where the command is the same, so
 * Quick Access and the tool search use these buttons in simple mode.
 */
import {
  Cloud,
  Combine,
  EyeOff,
  Eraser,
  FileArchive,
  FileKey2,
  FileOutput,
  FilePlus2,
  FileStack,
  FolderOpen,
  Highlighter,
  KeyRound,
  Landmark,
  LayoutGrid,
  Lock,
  Mail,
  PanelsTopLeft,
  Printer,
  Receipt,
  ReceiptText,
  Save,
  ScanSearch,
  ScanText,
  ShieldCheck,
  Signature,
  StickyNote,
  TextCursorInput,
  Type,
  Usb,
  FileText,
  FileSpreadsheet,
  Presentation,
  FileImage,
  BadgeCheck,
} from 'lucide-react';
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { useUiMode } from '@/store/uiMode';
import { useModalArgs } from '@/store/useModalArgs';
import { openDialog, saveDocument, mergeDialog } from '@/actions/document';
import type { ExportFormat } from '@/actions/convert';
import type { QuickToolId } from '@/actions/quickTools';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator } from '@/components/ui/primitives';
import { Big, Group, I, i, MenuButton, Small, Stack } from './parts';
import { ToolBtn } from './ReaderTabs';

const quickTool = (id: QuickToolId) => void import('@/components/modals/ToolsModal').then((m) => m.startQuickTool(id));

export function SimpleRibbon() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const editable = usePDFStore((s) => s.pages.length > 0 && !s.readOnlyReason);
  const canSign = usePDFStore((s) => s.pages.length > 0 && !blockedReason(s, 'forms'));
  const pagesOk = usePDFStore((s) => s.pages.length > 0 && !blockedReason(s, 'pages'));
  const open = (m: Parameters<ReturnType<typeof usePDFStore.getState>['openModal']>[0]) => usePDFStore.getState().openModal(m);
  // With a document open: export it; without: pick a PDF and convert it (as the Tools hub does).
  const convert = (format: ExportFormat, tool: QuickToolId) => {
    if (!usePDFStore.getState().pages.length) return quickTool(tool);
    useModalArgs.setState({ exportFormat: format });
    open('export');
  };
  return (
    <>
      <Group label="File">
        <Big icon={<FolderOpen size={I} />} label="Open" onClick={() => void openDialog()} tip="Open a PDF (Ctrl+O)" testId="simple-open" />
        <Big icon={<Save size={I} />} label="Save" disabled={!editable} onClick={() => void saveDocument(false)} tip="Save (Ctrl+S)" testId="simple-save" />
        <Stack>
          <Small icon={<Printer size={i} />} label="Print" disabled={!hasDoc} onClick={() => open('print')} tip="Print (Ctrl+P): several pages per sheet, booklet, poster" testId="simple-print" />
          <Small icon={<Mail size={i} />} label="E-mail" disabled={!hasDoc} onClick={() => void import('@/actions/share').then((m) => m.emailDocument())} tip="Send the document as an attachment from your mail program" testId="simple-email" />
        </Stack>
      </Group>
      <Group label="Edit & comment">
        <ToolBtn tool="editText" icon={<TextCursorInput size={I} />} label="Edit text" tip="Click existing text to edit it" />
        <Stack>
          <ToolBtn big={false} tool="text" icon={<Type size={i} />} label="Add text" tip="Click to add a text box (T)" />
          <ToolBtn big={false} tool="markup-highlight" icon={<Highlighter size={i} />} label="Highlight" tip="Select text to highlight it" />
          <ToolBtn big={false} tool="note" icon={<StickyNote size={i} />} label="Note" tip="Click to add a sticky note (N)" />
        </Stack>
      </Group>
      <Group label="Sign">
        <Big icon={<Signature size={I} />} label="Fill & Sign" disabled={!canSign} onClick={() => open('signature')} tip="Draw, type or upload your signature and place it" testId="simple-fill-sign" />
        <DropdownMenu>
          <MenuButton icon={<FileKey2 size={I} />} label="Digital signature" disabled={!hasDoc} testId="simple-digital-sign" tip="Sign with a certificate: a .pfx file, a USB token or smart card, a certificate installed in Windows or a cloud signature" />
          <DropdownContent>
            <DropdownItem icon={<FileKey2 size={14} />} onSelect={() => open('certificate')} testId="simple-cert-sign">
              Certificate ID
            </DropdownItem>
            <DropdownItem icon={<Usb size={14} />} onSelect={() => open('token')}>
              Token / smart card
            </DropdownItem>
            <DropdownItem icon={<KeyRound size={14} />} onSelect={() => open('winstore')}>
              Windows certificate
            </DropdownItem>
            <DropdownItem icon={<Cloud size={14} />} onSelect={() => open('cloudsign')}>
              Cloud signature
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
        <Stack>
          <Small icon={<FileStack size={i} />} label="Sign many files" onClick={() => open('batchsign')} tip="Sign many PDFs at once with one certificate, token or cloud signature: the PIN is asked once" testId="simple-batch-sign" />
          <Small icon={<BadgeCheck size={i} />} label="Verify" disabled={!hasDoc} onClick={() => open('verify')} tip="Check signatures, certificate chain and revocation" testId="simple-verify" />
        </Stack>
      </Group>
      <Group label="Pages">
        <Big icon={<Combine size={I} />} label="Combine PDFs" onClick={() => (usePDFStore.getState().pages.length ? void mergeDialog() : quickTool('merge'))} tip="Combine several PDFs in the order you choose" testId="simple-combine" />
        <Stack>
          <Small icon={<LayoutGrid size={i} />} label="Organize" disabled={!pagesOk} onClick={() => open('organizer')} tip="Grid view: drag, rotate, delete, insert pages" testId="simple-organize" />
          <Small icon={<FileArchive size={i} />} label="Compress" onClick={() => (usePDFStore.getState().pages.length ? open('compress') : quickTool('compress'))} tip="Smaller files, same text quality" testId="simple-compress" />
          <Small icon={<ScanText size={i} />} label="OCR" disabled={!hasDoc} onClick={() => open('ocr')} tip="Make scanned pages searchable" testId="simple-ocr" />
        </Stack>
      </Group>
      <Group label="Convert">
        <DropdownMenu>
          <MenuButton icon={<FileOutput size={I} />} label="Convert" testId="simple-convert" tip="PDF to Word, Excel, PowerPoint or pictures; Word, Excel, pictures and more to PDF" />
          <DropdownContent>
            <DropdownItem icon={<FileText size={14} />} onSelect={() => convert('docx', 'pdf-word')} testId="simple-to-word">
              PDF to Word
            </DropdownItem>
            <DropdownItem icon={<FileSpreadsheet size={14} />} onSelect={() => convert('xlsx', 'pdf-excel')}>
              PDF to Excel
            </DropdownItem>
            <DropdownItem icon={<Presentation size={14} />} onSelect={() => convert('pptx', 'pdf-ppt')}>
              PDF to PPT
            </DropdownItem>
            <DropdownItem icon={<FileImage size={14} />} onSelect={() => convert('png', 'pdf-jpg')}>
              PDF to JPG
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem icon={<FilePlus2 size={14} />} onSelect={() => open('import')} testId="simple-create">
              Create PDF
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      </Group>
      <Group label="Protect">
        <DropdownMenu>
          <MenuButton icon={<ShieldCheck size={I} />} label="Protect" disabled={!hasDoc} testId="simple-protect" tip="Password, redaction (blacking out for good) and hidden information" />
          <DropdownContent>
            <DropdownItem icon={<Lock size={14} />} onSelect={() => open('password')} testId="simple-password">
              Password
            </DropdownItem>
            <DropdownItem icon={<Eraser size={14} />} onSelect={() => usePDFStore.getState().setTool('redact')}>
              Mark redaction
            </DropdownItem>
            <DropdownItem icon={<ScanSearch size={14} />} onSelect={() => open('find-redact')}>
              Find & redact
            </DropdownItem>
            <DropdownItem icon={<EyeOff size={14} />} onSelect={() => open('hiddenInfo')}>
              Hidden info
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      </Group>
      <Group label="E-invoice">
        <DropdownMenu>
          <MenuButton icon={<Receipt size={I} />} label="e-Factura" testId="simple-efactura" tip="Create, open and send e-Factura invoices" />
          <DropdownContent>
            <DropdownItem icon={<ReceiptText size={14} />} onSelect={() => void import('@/actions/einvoiceCreate').then((m) => m.openNewEInvoice())} testId="simple-einvoice-new">
              New e-invoice
            </DropdownItem>
            <DropdownItem icon={<Receipt size={14} />} onSelect={() => open('einvoice')}>
              E-invoice
            </DropdownItem>
            <DropdownItem icon={<Landmark size={14} />} onSelect={() => void import('@/actions/anaf').then((m) => m.openAnafDialog())}>
              ANAF e-Factura
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      </Group>
      <Group label="All commands">
        <Big icon={<PanelsTopLeft size={I} />} label="More tools" onClick={() => useUiMode.getState().setMode('full')} tip="Show the full ribbon with every command (Simple ribbon on the View tab comes back here)" testId="simple-more-tools" />
      </Group>
    </>
  );
}
