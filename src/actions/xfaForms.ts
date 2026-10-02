/**
 * XFA forms in the app: a dynamic XFA form opens as a regular fillable PDF
 * made from pdf.js' layout of it, while Adika keeps the original. Saving a
 * form that was only filled in writes the values into the original, so it
 * stays the same XFA form (scripts, validation, submission) for Acrobat;
 * other changes (pages, comments, signatures) save the regular PDF.
 */
import { create } from 'zustand';
import { usePDFStore } from '@/store/usePDFStore';
import { onSourceRelease, pdfjs } from '@/lib/pdf/pdfService';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import { saveBytes } from '@/lib/platform';

const originals = new Map<string, Uint8Array>();

/** XFA kind of each open source ('dynamic' = shown converted). */
export const useXfa = create<{ kinds: Record<string, 'dynamic' | 'static'> }>()(() => ({ kinds: {} }));

onSourceRelease((id) => {
  originals.delete(id);
  if (useXfa.getState().kinds[id]) useXfa.setState((s) => ({ kinds: Object.fromEntries(Object.entries(s.kinds).filter(([k]) => k !== id)) }));
});

/** Before opening: a dynamic XFA form becomes a regular fillable PDF (null for every other file). */
export async function convertIfDynamicXfa(bytes: Uint8Array, name: string, progress: (msg: string) => void): Promise<{ bytes: Uint8Array; original: Uint8Array } | null> {
  if (isPdfEncrypted(bytes)) return null;
  const { xfaKind } = await import('@/lib/pdf/xfa');
  if ((await xfaKind(bytes)) !== 'dynamic') return null;
  const { convertDynamicXfa } = await import('@/lib/pdf/xfaMeasure');
  const title = name.replace(/\.pdf$/i, '');
  const r = await convertDynamicXfa(bytes, title, (i, n) => progress(`Laying out the XFA form, page ${i} of ${n}…`));
  return { bytes: r.bytes, original: bytes };
}

/** After opening: remember the original of a converted form, or note a static XFA form. */
export async function noteXfaSource(sourceId: string, original: Uint8Array | null): Promise<void> {
  if (original) {
    originals.set(sourceId, original);
    useXfa.setState((s) => ({ kinds: { ...s.kinds, [sourceId]: 'dynamic' } }));
    usePDFStore.getState().toast('This is a dynamic XFA form. Adika shows it as a regular PDF form: fill it in and save, and it stays an XFA form.', 'info');
    return;
  }
  const src = usePDFStore.getState().sources[sourceId];
  if (!src) return;
  const { xfaKind } = await import('@/lib/pdf/xfa');
  if ((await xfaKind(src.bytes)) === 'static') useXfa.setState((s) => ({ kinds: { ...s.kinds, [sourceId]: 'static' } }));
}

/** The primary source when it is a converted dynamic XFA form. */
function convertedPrimary(): { sourceId: string; original: Uint8Array } | null {
  const s = usePDFStore.getState();
  const id = s.pages.find((p) => p.kind === 'source')?.sourceId;
  const original = id ? originals.get(id) : undefined;
  return id && original ? { sourceId: id, original } : null;
}

/** True when the converted form was only filled in (nothing else that the XFA form could not keep). */
function onlyFilled(sourceId: string): boolean {
  const s = usePDFStore.getState();
  const src = s.sources[sourceId];
  if (!src || s.objects.length || s.outline || s.docMeta) return false;
  if (s.pages.length !== src.pageCount) return false;
  return s.pages.every((p, i) => p.kind === 'source' && p.sourceId === sourceId && p.sourceIndex === i && !p.userRotation);
}

function filledValues(sourceId: string): Record<string, string | boolean | string[]> {
  const prefix = `${sourceId}::`;
  const out: Record<string, string | boolean | string[]> = {};
  for (const [k, v] of Object.entries(usePDFStore.getState().fieldValues)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

async function filledOriginal(sourceId: string, original: Uint8Array): Promise<Uint8Array> {
  const { fillXfaData } = await import('@/lib/pdf/xfa');
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;
  return fillXfaData(pdfjs as never, original, filledValues(sourceId), { cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/` });
}

/** What Save writes for a converted XFA form: the filled original, or null to save the regular PDF. */
export async function xfaSaveBytes(): Promise<Uint8Array | null> {
  const c = convertedPrimary();
  if (!c) return null;
  if (!onlyFilled(c.sourceId)) {
    usePDFStore.getState().toast('Saved as a regular PDF form: an XFA form cannot keep page edits, comments or other changes.', 'info');
    return null;
  }
  return filledOriginal(c.sourceId, c.original);
}

/** Saves the data of an XFA form (the XML it submits). */
export async function exportXfaData(): Promise<void> {
  const s = usePDFStore.getState();
  const id = s.pages.find((p) => p.kind === 'source')?.sourceId;
  if (!id) return;
  const { readXfaPackets, xfaDataXml } = await import('@/lib/pdf/xfa');
  const { PDFDocument } = await import('pdf-lib');
  const c = convertedPrimary();
  const { exportCurrentPdf, withBusy } = await import('./document');
  const xml = await withBusy('Collecting form data…', async (progress) => {
    const bytes = c ? await filledOriginal(c.sourceId, c.original) : s.readOnlyReason ? s.sources[id].bytes : await exportCurrentPdf({}, progress);
    const packets = readXfaPackets(await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }));
    return packets ? xfaDataXml(packets) : null;
  });
  if (!xml) {
    s.toast('This document has no XFA form data.', 'error');
    return;
  }
  const name = `${(s.fileName ?? 'form').replace(/\.pdf$/i, '')}-data.xml`;
  const path = await saveBytes(new TextEncoder().encode(xml), name, [{ name: 'XML data', extensions: ['xml'] }]);
  if (path) s.toast(path === 'downloaded' ? 'Downloaded.' : `Saved to ${path}`, 'success');
}
