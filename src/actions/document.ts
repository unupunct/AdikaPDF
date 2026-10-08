/**
 * Document-level operations wired to the ribbon, keyboard shortcuts and
 * drag-and-drop: open, save, save as, merge, export bytes.
 */
import { currentDoc, primarySourceId, usePDFStore } from '@/store/usePDFStore';
import { askChoice, askConfirm, askPassword } from '@/store/useDialogs';
import { buildPdf, ExportError, type ExportOptions, type RasterResult } from '@/lib/pdf/exportPdf';
import { PasswordRequiredError, canvasToBytes, rasterizePage } from '@/lib/pdf/pdfService';
import { fileStamp, pickFiles, readFile, type FileFilter } from '@/lib/platform';
import { saveFile } from './saveGuard';
import { tellFontFallbacks } from './fontNotes';
import { allowUnprotectedCopy, protectForSave } from './protection';
import { activeTabIsEmpty, newTab, removeTab, switchTab, tabWithPath, useTabs } from '@/store/tabs';
import { addRecent } from '@/lib/recent';
import { errorText, log } from '@/lib/log';
import { verifyPdfSignatures } from '@/lib/crypto/digitalSignature';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import type { PageRef } from '@/types';
import { totalRotation, type Rect } from '@/lib/geometry';
import { formattedDisplay } from '@/store/formView';

export const PDF_FILTER: FileFilter[] = [{ name: 'PDF documents', extensions: ['pdf'] }];

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Unexpected error';
}

/** True for the error an aborted operation throws (`signal.throwIfAborted()`). */
export function isAbortError(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

/**
 * Runs `fn` with the busy overlay and turns failures into an error toast.
 * A callback that takes the `signal` argument can be cancelled: the overlay
 * shows Cancel, and a cancelled run returns undefined (its result is dropped).
 * Once cancelled, `progress` throws too, so any loop that reports progress stops.
 */
export async function withBusy<T>(message: string, fn: (progress: (msg: string, fraction: number | null) => void, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const store = usePDFStore.getState();
  const controller = new AbortController();
  const abort = fn.length >= 2 ? controller : undefined;
  store.setBusy({ message, progress: null, abort });
  try {
    const progress = (msg: string, fraction: number | null) => {
      if (abort) controller.signal.throwIfAborted();
      usePDFStore.getState().setBusy({ message: msg, progress: fraction, abort });
    };
    const result = await fn(progress, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (e) {
    // Whatever a cancelled run threw, the user asked for it to stop.
    if (controller.signal.aborted) {
      log('info', `${message} cancelled`);
      usePDFStore.getState().toast('Cancelled.', 'info');
      return undefined;
    }
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
  // Already open in a tab: go there (two tabs saving the same file would overwrite each other).
  const open = !replaceCurrent && path ? tabWithPath(path) : null;
  if (open) {
    switchTab(open);
    usePDFStore.getState().toast(`Already open in a tab: ${name}`, 'info');
    return true;
  }
  const stampAtRead = path ? await fileStamp(path).catch(() => null) : null;
  const previousTab = useTabs.getState().activeId;
  const createdTab = !replaceCurrent && !activeTabIsEmpty() ? newTab() : null;
  const ok = await openIntoCurrentTab(bytes, name, path);
  if (!ok && createdTab) {
    removeTab(createdTab);
    switchTab(previousTab);
  }
  if (ok && path) {
    addRecent(path, name, usePDFStore.getState().pages.length);
    // The stamp of the bytes read: a change from now on is someone else's.
    usePDFStore.setState({ fileStamp: stampAtRead ?? (await fileStamp(path)) });
  }
  return ok;
}

async function openIntoCurrentTab(bytes: Uint8Array, name: string, path: string | null): Promise<boolean> {
  let password: string | undefined;
  let incorrect = false;
  // The bytes stay the file on disk (not decrypted or converted): incremental saves can append to them.
  let original = !!path;
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
        original = false;
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
      original = false;
    }
  } catch (e) {
    log('warn', `XFA conversion of ${name} failed: ${errorText(e)}`);
    usePDFStore.getState().toast(`This XFA form could not be laid out (${errorMessage(e)}). It is shown as stored in the file.`, 'error');
  }
  for (;;) {
    try {
      await withBusyThrow(`Opening ${name}…`, () => usePDFStore.getState().loadDocument(bytes, name, path, password, original));
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
  // The scale from the bitmap itself: pdf.js also applies /UserUnit, so dpi / 72 alone would miss the boxes.
  const turned = totalRotation(page) % 180 !== 0;
  const kx = canvas.width / (turned ? page.height : page.width);
  const ky = canvas.height / (turned ? page.width : page.height);
  for (const r of rects) {
    ctx.fillStyle = r.fill;
    ctx.fillRect(Math.floor(r.x * kx), Math.floor(r.y * ky), Math.ceil(r.width * kx) + 1, Math.ceil(r.height * ky) + 1);
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
    onFontFallback: tellFontFallbacks,
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
  // Changed on disk since it was opened or saved (another program, or the same file in another window)?
  if (!saveAs && s.filePath && s.fileStamp) {
    const onDisk = await fileStamp(s.filePath);
    if (onDisk && onDisk !== s.fileStamp) {
      const choice = await askChoice({
        title: 'The file changed on disk',
        message: 'Another program changed this file after you opened it. Overwrite it with your version, or save your version as a new file?',
        confirmLabel: 'Overwrite',
        altLabel: 'Save as…',
        danger: true,
      });
      if (!choice) return false;
      if (choice === 'alt') saveAs = true;
    }
  }
  const mode = await chooseSaveMode();
  if (!mode) return false;
  if (mode === 'copy') saveAs = true;
  const result = await withBusy('Saving…', async (progress) => {
    // A converted XFA form that was only filled in stays the original XFA form.
    const xfa = await import('./xfaForms').then((m) => m.xfaSaveBytes());
    // A password-protected file stays protected (same passwords and permissions) unless the protection was removed.
    const bytes = xfa ?? (mode === 'incremental' ? await exportIncrementalPdf(progress) : await protectForSave(await exportCurrentPdf({}, progress)));
    // A failed write offers "Save as…" to another location.
    const path = await saveFile(bytes, suggestedName(), PDF_FILTER, { existingPath: saveAs ? null : s.filePath, retry: () => saveDocument(true), successMessage: false });
    // The file's new stamp before the document counts as saved, so the reload watcher never mistakes our own save for another program's.
    const stamp = path && path !== 'downloaded' ? await fileStamp(path) : null;
    return { path, bytes, stamp };
  });
  if (!result?.path) return false;
  const name = result.path === 'downloaded' ? suggestedName() : result.path.split(/[\\/]/).pop();
  if (result.path !== 'downloaded') usePDFStore.setState({ fileStamp: result.stamp });
  usePDFStore.getState().markSaved(result.path === 'downloaded' ? null : result.path, name);
  if (result.path !== 'downloaded') addRecent(result.path, name ?? suggestedName(), usePDFStore.getState().pages.length);
  usePDFStore.getState().toast(result.path === 'downloaded' ? 'Downloaded.' : `Saved to ${result.path}`, 'success');
  return true;
}

/** True when the opened file carries digital signatures. */
function isSigned(): boolean {
  return usePDFStore.getState().signatureStatus.length > 0;
}

/**
 * Incremental update (signed documents always, others when preferred and the
 * changes allow it), full rewrite, or a copy when a full rewrite would break
 * signatures; null when cancelled.
 */
async function chooseSaveMode(): Promise<'incremental' | 'full' | 'copy' | null> {
  const s = usePDFStore.getState();
  const signed = isSigned();
  const { useSaveSettings } = await import('@/lib/saveSettings');
  const { incrementalBlocker } = await import('@/lib/pdf/exportPdf');
  const blocker = incrementalBlocker(currentDoc(), s.docMeta, !!s.protection && !s.protection.keep);
  if (!blocker && (signed || useSaveSettings.getState().preferIncremental)) return 'incremental';
  if (!signed) return 'full';
  log('info', `Save: full rewrite of a signed document (${blocker})`);
  const choice = await askChoice({
    title: 'Saving will invalidate the signatures',
    message:
      'This PDF is digitally signed. Your changes (pages, page content, redactions or properties) need the whole file to be rewritten, which invalidates its signatures. Comments, form values and bookmarks alone are saved without touching the signed content. Save a copy to keep the signed original as it is.',
    confirmLabel: 'Save anyway',
    altLabel: 'Save a copy',
    danger: true,
  });
  return choice === 'confirm' ? 'full' : choice === 'alt' ? 'copy' : null;
}

/** The current edits as an incremental update of the opened file. */
async function exportIncrementalPdf(progress?: (msg: string, f: number | null) => void): Promise<Uint8Array> {
  const s = usePDFStore.getState();
  if (s.editingTextId) usePDFStore.getState().setEditingText(null);
  const { buildIncrementalPdf } = await import('@/lib/pdf/exportPdf');
  const doc = currentDoc();
  return buildIncrementalPdf(doc, { fieldDisplay: formattedDisplay(doc.fieldValues), onProgress: (m, f) => progress?.(m, f) });
}

/** Saves bytes produced by an operation (sign, protect, compress…) as a new file. */
export async function saveDerived(bytes: Uint8Array, suffix: string, reopen: boolean): Promise<string | null> {
  if (!allowUnprotectedCopy()) return null;
  const path = await saveFile(bytes, suggestedName(suffix), PDF_FILTER, { retry: () => saveDerived(bytes, suffix, reopen) });
  if (reopen && path && path !== 'downloaded') await openPdfBytes(bytes, path.split(/[\\/]/).pop() ?? path, path, true);
  return path;
}

export async function refreshSignatureStatus(): Promise<void> {
  const s = usePDFStore.getState();
  const id = primarySourceId(s);
  const src = id ? s.sources[id] : undefined;
  if (!src) return usePDFStore.getState().setSignatureStatus([]);
  try {
    // Signatures cover the file's own (encrypted) bytes.
    const status = await verifyPdfSignatures(primarySourceFile()!);
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

/** The primary source's bytes (the opened file as loaded; a password-protected one decrypted). */
export function primarySourceBytes(): Uint8Array | null {
  const s = usePDFStore.getState();
  const id = primarySourceId(s);
  return id ? (s.sources[id]?.bytes ?? null) : null;
}

/** The opened file itself, also when it is encrypted (what its signatures cover). */
export function primarySourceFile(): Uint8Array | null {
  const s = usePDFStore.getState();
  const id = primarySourceId(s);
  const src = id ? s.sources[id] : undefined;
  return src ? (src.encryption?.file ?? src.bytes) : null;
}
