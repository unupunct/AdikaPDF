/**
 * Document-level operations wired to the ribbon, keyboard shortcuts and
 * drag-and-drop: open, save, save as, merge, export bytes.
 */
import { currentDoc, primarySourceId, usePDFStore } from '@/store/usePDFStore';
import { askConfirm, askPassword } from '@/store/useDialogs';
import { buildPdf, ExportError, type ExportOptions, type RasterResult } from '@/lib/pdf/exportPdf';
import { PasswordRequiredError, canvasToBytes, rasterizePage } from '@/lib/pdf/pdfService';
import { fileStamp, pickFiles, saveBytes, readFile, type FileFilter } from '@/lib/platform';
import { activeTabIsEmpty, newTab, removeTab, switchTab, useTabs } from '@/store/tabs';
import { addRecent } from '@/lib/recent';
import { errorText, log } from '@/lib/log';
import { verifyPdfSignatures } from '@/lib/crypto/digitalSignature';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import type { PageRef } from '@/types';
import type { Rect } from '@/lib/geometry';
import { formattedDisplay } from '@/store/formView';

export const PDF_FILTER: FileFilter[] = [{ name: 'PDF documents', extensions: ['pdf'] }];

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Unexpected error';
}

/** Runs `fn` with the busy overlay and turns failures into an error toast. */
export async function withBusy<T>(message: string, fn: (progress: (msg: string, fraction: number | null) => void) => Promise<T>): Promise<T | undefined> {
  const store = usePDFStore.getState();
  store.setBusy({ message, progress: null });
  try {
    return await fn((msg, fraction) => usePDFStore.getState().setBusy({ message: msg, progress: fraction }));
  } catch (e) {
    console.error(e);
    log('error', `${message} failed: ${errorText(e)}`);
    usePDFStore.getState().toast(errorMessage(e), 'error');
    return undefined;
  } finally {
    usePDFStore.getState().setBusy(null);
  }
}

async function confirmDiscard(): Promise<boolean> {
  const s = usePDFStore.getState();
  if (!s.dirty || s.pages.length === 0) return true;
  return askConfirm({
    title: 'Discard unsaved changes?',
    message: `“${s.fileName ?? 'Untitled'}” has changes that are not saved.`,
    confirmLabel: 'Discard changes',
    danger: true,
  });
}

/** Opens PDF bytes, asking for a password as many times as needed. */
/**
 * Opens PDF bytes. With a document already open it goes into a new tab;
 * `replaceCurrent` reuses the current tab (e.g. reopening a just-signed copy).
 */
export async function openPdfBytes(bytes: Uint8Array, name: string, path: string | null = null, replaceCurrent = false): Promise<boolean> {
  const previousTab = useTabs.getState().activeId;
  const createdTab = !replaceCurrent && !activeTabIsEmpty() ? newTab() : null;
  const ok = await openIntoCurrentTab(bytes, name, path);
  if (!ok && createdTab) {
    removeTab(createdTab);
    switchTab(previousTab);
  }
  if (ok && path) {
    addRecent(path, name, usePDFStore.getState().pages.length);
    usePDFStore.setState({ fileStamp: await fileStamp(path) });
  }
  return ok;
}

async function openIntoCurrentTab(bytes: Uint8Array, name: string, path: string | null): Promise<boolean> {
  let password: string | undefined;
  let incorrect = false;
  // Encrypted for certificates: opened with the private key of one of them.
  const { isPubSecEncrypted } = await import('@/lib/crypto/pubsec');
  if (isPubSecEncrypted(bytes)) {
    const { decryptWithCertificate, pubSecRecipients } = await import('@/lib/crypto/pubsec');
    const { askCertificateKey } = await import('@/store/useDialogs');
    const recipients = await pubSecRecipients(bytes).catch(() => []);
    let error: string | null = null;
    for (;;) {
      const key = await askCertificateKey(name, recipients, error);
      if (!key) return false;
      try {
        bytes = await withBusyThrow(`Opening ${name} with your certificate…`, () => decryptWithCertificate(bytes, key));
        break;
      } catch (e) {
        error = errorMessage(e);
      }
    }
    usePDFStore.getState().toast('Opened with your certificate. Saving writes an unprotected copy unless you encrypt it again (Security → Certificate).', 'info');
  }
  // A dynamic XFA form: shown as the regular PDF form pdf.js lays out from it.
  let xfaOriginal: Uint8Array | null = null;
  try {
    const { convertIfDynamicXfa } = await import('./xfaForms');
    const conv = await withBusyThrow(`Laying out the XFA form ${name}…`, () => convertIfDynamicXfa(bytes, name, () => undefined));
    if (conv) {
      xfaOriginal = conv.original;
      bytes = conv.bytes;
    }
  } catch (e) {
    log('warn', `XFA conversion of ${name} failed: ${errorText(e)}`);
    usePDFStore.getState().toast(`This XFA form could not be laid out (${errorMessage(e)}). It is shown as stored in the file.`, 'error');
  }
  for (;;) {
    try {
      await withBusyThrow(`Opening ${name}…`, () => usePDFStore.getState().loadDocument(bytes, name, path, password));
      void refreshSignatureStatus();
      const primary = usePDFStore.getState().pages.find((p) => p.kind === 'source')?.sourceId;
      if (primary) void import('./xfaForms').then((m) => m.noteXfaSource(primary, xfaOriginal));
      if (!xfaOriginal) void import('./portfolio').then((m) => m.noteOpenedPdf(bytes));
      return true;
    } catch (e) {
      if (e instanceof PasswordRequiredError) {
        const pw = await askPassword(name, incorrect || e.incorrect);
        if (pw === null) return false;
        password = pw;
        incorrect = true;
        continue;
      }
      // Damaged file: rebuild it from whatever objects survived (like MuPDF/Foxit repair).
      const { looksLikePdf, repairPdf } = await import('@/lib/pdf/repair');
      if (password === undefined && looksLikePdf(bytes)) {
        try {
          const repaired = await withBusyThrow(`Repairing ${name}…`, () => repairPdf(bytes));
          await withBusyThrow(`Opening ${name}…`, () => usePDFStore.getState().loadDocument(repaired.bytes, name, path));
          // Not saved yet: the file on disk is still the damaged one.
          usePDFStore.setState({ dirty: true });
          usePDFStore.getState().toast(`${name} was damaged and has been repaired. ${repaired.notes.slice(0, 2).join(' ')} Save to keep the repaired copy.`, 'info');
          return true;
        } catch (re) {
          usePDFStore.getState().toast(`Could not open ${name}: ${errorMessage(e)} Repair failed: ${errorMessage(re)}`, 'error');
          return false;
        }
      }
      log('error', `Could not open ${name}: ${errorText(e)}`);
      usePDFStore.getState().toast(`Could not open ${name}: ${errorMessage(e)}`, 'error');
      return false;
    }
  }
}

async function withBusyThrow<T>(message: string, fn: () => Promise<T>): Promise<T> {
  usePDFStore.getState().setBusy({ message, progress: null });
  try {
    return await fn();
  } finally {
    usePDFStore.getState().setBusy(null);
  }
}

export async function openPdfPath(path: string): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    // An e-invoice XML (or the ZIP from ANAF) opens as a readable invoice.
    if (/\.(xml|zip)$/i.test(name)) return (await import('./einvoice')).openEInvoice(bytes, name);
    return openPdfBytes(bytes, name, path);
  } catch (e) {
    usePDFStore.getState().toast(errorMessage(e), 'error');
    return false;
  }
}

export async function openDialog(): Promise<void> {
  const files = await pickFiles([...PDF_FILTER, { name: 'E-invoices (XML, e-Factura ZIP)', extensions: ['xml', 'zip'] }], false);
  const f = files[0];
  if (!f) return;
  if (/\.(xml|zip)$/i.test(f.name)) await (await import('./einvoice')).openEInvoice(f.bytes, f.name);
  else await openPdfBytes(f.bytes, f.name, f.path);
}

export async function mergeDialog(): Promise<void> {
  const s = usePDFStore.getState();
  if (s.pages.length === 0) return openDialog();
  const files = await pickFiles(PDF_FILTER, true);
  if (files.length === 0) return;
  await withBusy('Merging documents…', async () => {
    for (const f of files) {
      // Encrypted pages cannot be re-written into this document.
      if (isPdfEncrypted(f.bytes)) throw new Error(`${f.name} is password-protected and cannot be merged. Use an unprotected copy.`);
      const { pages } = await usePDFStore.getState().addSource(f.bytes, f.name);
      usePDFStore.getState().commit((st) => ({ pages: [...st.pages, ...pages] }));
    }
    usePDFStore.getState().toast(`Merged ${files.length} file${files.length > 1 ? 's' : ''}.`, 'success');
  });
}

/** Burns redaction boxes into a 200 DPI rendering of the page. */
export async function rasterizeWithRedactions(page: PageRef, rects: Array<Rect & { fill: string }>): Promise<RasterResult> {
  const dpi = 200;
  const canvas = await rasterizePage(page, dpi);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  const k = dpi / 72;
  for (const r of rects) {
    ctx.fillStyle = r.fill;
    ctx.fillRect(Math.floor(r.x * k), Math.floor(r.y * k), Math.ceil(r.width * k) + 1, Math.ceil(r.height * k) + 1);
  }
  const bytes = await canvasToBytes(canvas, 'image/jpeg', 0.9);
  canvas.width = canvas.height = 0;
  return { bytes, format: 'jpeg' };
}

/** Builds the current document (all edits applied) as PDF bytes. */
export async function exportCurrentPdf(
  extra: Partial<ExportOptions> = {},
  progress?: (msg: string, f: number | null) => void,
  excludeObjectIds: string[] = [],
): Promise<Uint8Array> {
  const s = usePDFStore.getState();
  if (s.readOnlyReason) throw new ExportError(s.readOnlyReason);
  if (s.editingTextId) usePDFStore.getState().setEditingText(null);
  const doc = currentDoc();
  const input = excludeObjectIds.length ? { ...doc, objects: doc.objects.filter((o) => !excludeObjectIds.includes(o.id)) } : doc;
  return buildPdf(input, {
    meta: usePDFStore.getState().docMeta,
    fieldDisplay: formattedDisplay(input.fieldValues),
    rasterizeRedactedPage: rasterizeWithRedactions,
    onProgress: (m, f) => progress?.(m, f),
    ...extra,
  });
}

export function suggestedName(suffix = ''): string {
  const name = usePDFStore.getState().fileName ?? 'Untitled.pdf';
  const base = name.replace(/\.pdf$/i, '');
  return `${base}${suffix}.pdf`;
}

export async function saveDocument(saveAs = false): Promise<boolean> {
  const s = usePDFStore.getState();
  if (s.pages.length === 0) return false;
  if (s.readOnlyReason) {
    s.toast(s.readOnlyReason, 'error');
    return false;
  }
  const hasRedactions = s.objects.some((o) => o.type === 'redact');
  if (hasRedactions && !saveAs && s.filePath) {
    const ok = await askConfirm({
      title: 'Apply redactions permanently?',
      message:
        'Pages with redaction boxes will be rebuilt as images with the covered content destroyed. Text on those pages will no longer be selectable (run OCR afterwards to restore it). This cannot be undone once saved.',
      confirmLabel: 'Redact and save',
      danger: true,
    });
    if (!ok) return false;
  }
  const result = await withBusy('Saving…', async (progress) => {
    // A converted XFA form that was only filled in stays the original XFA form.
    const xfa = await import('./xfaForms').then((m) => m.xfaSaveBytes());
    const bytes = xfa ?? (await exportCurrentPdf({}, progress));
    const path = await saveBytes(bytes, suggestedName(), PDF_FILTER, saveAs ? null : s.filePath);
    return { path, bytes };
  });
  if (!result?.path) return false;
  const name = result.path === 'downloaded' ? suggestedName() : result.path.split(/[\\/]/).pop();
  usePDFStore.getState().markSaved(result.path === 'downloaded' ? null : result.path, name);
  if (result.path !== 'downloaded') {
    addRecent(result.path, name ?? suggestedName(), usePDFStore.getState().pages.length);
    usePDFStore.setState({ fileStamp: await fileStamp(result.path) });
  }
  usePDFStore.getState().toast(result.path === 'downloaded' ? 'Downloaded.' : `Saved to ${result.path}`, 'success');
  return true;
}

/** Saves bytes produced by an operation (sign, protect, compress…) as a new file. */
export async function saveDerived(bytes: Uint8Array, suffix: string, reopen: boolean): Promise<void> {
  const path = await saveBytes(bytes, suggestedName(suffix), PDF_FILTER);
  if (!path) return;
  const store = usePDFStore.getState();
  if (path === 'downloaded') {
    store.toast('Downloaded.', 'success');
    return;
  }
  store.toast(`Saved to ${path}`, 'success');
  if (reopen) await openPdfBytes(bytes, path.split(/[\\/]/).pop() ?? path, path, true);
}

export async function refreshSignatureStatus(): Promise<void> {
  const s = usePDFStore.getState();
  const id = primarySourceId(s);
  const src = id ? s.sources[id] : undefined;
  if (!src) return usePDFStore.getState().setSignatureStatus([]);
  try {
    const status = await verifyPdfSignatures(src.bytes);
    usePDFStore.getState().setSignatureStatus(status);
  } catch {
    usePDFStore.getState().setSignatureStatus([]);
  }
}

export async function closeDocumentAction(): Promise<void> {
  await closeTabAction(useTabs.getState().activeId);
}

/** Closes a document tab, asking first if it has unsaved changes. */
export async function closeTabAction(tabId: string): Promise<void> {
  const { tabs, activeId } = useTabs.getState();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tabId !== activeId) switchTab(tabId);
  if (!(await confirmDiscard())) {
    if (tabId !== activeId) switchTab(activeId);
    return;
  }
  removeTab(tabId);
  if (tabId !== activeId && useTabs.getState().tabs.some((t) => t.id === activeId)) switchTab(activeId);
}

/** The primary source's bytes (the opened file as loaded). */
export function primarySourceBytes(): Uint8Array | null {
  const s = usePDFStore.getState();
  const id = primarySourceId(s);
  return id ? (s.sources[id]?.bytes ?? null) : null;
}
