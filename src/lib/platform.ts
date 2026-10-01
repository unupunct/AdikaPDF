/**
 * Platform bridge. Inside the Tauri desktop shell, file I/O, Office/HTML
 * conversion, scanning, HTTP (OCSP/CRL/TSA) and PKCS#11 tokens go through
 * native commands. In a plain browser the file functions fall back to
 * <input type=file> and downloads, and the native-only features report that
 * they need the desktop app.
 */
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { translate } from './i18n';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface PickedFile {
  name: string;
  /** Absolute path (desktop only). */
  path: string | null;
  bytes: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export class DesktopOnlyError extends Error {
  constructor(feature: string) {
    super(`${feature} needs the Adika desktop app (it uses native Windows components).`);
  }
}

/**
 * End-to-end test mode only (reachable through the ADIKA_E2E hooks): file
 * dialogs are replaced by a queue of paths and a fixed output folder so the
 * suite can click real buttons without native dialogs blocking it.
 */
const e2e: { pickQueue: string[][]; saveDir: string | null; saved: string[] } = { pickQueue: [], saveDir: null, saved: [] };

export function e2eQueuePicks(paths: string[]): void {
  e2e.pickQueue.push(paths);
}

export function e2eSetSaveDir(dir: string | null): void {
  e2e.saveDir = dir;
}

export function e2eSavedFiles(): string[] {
  return [...e2e.saved];
}

function e2ePick(): string[] | null {
  return e2e.pickQueue.length ? (e2e.pickQueue.shift() ?? []) : null;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function readFile(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return new Uint8Array(buf);
}

export async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  await invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}

/** File-type names in the interface language for the Windows dialogs. */
const localFilters = (filters: FileFilter[]) => filters.map((f) => ({ ...f, name: translate(f.name) }));

function browserPick(filters: FileFilter[], multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(
        await Promise.all(
          files.map(async (f) => ({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) })),
        ),
      );
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Asks the user for files; returns [] when cancelled. */
export async function pickFiles(filters: FileFilter[], multiple = false): Promise<PickedFile[]> {
  if (!isDesktop) return browserPick(filters, multiple);
  const queued = e2ePick();
  if (queued) return Promise.all(queued.map(async (p) => ({ name: baseName(p), path: p, bytes: await readFile(p) })));
  const result = await openDialog({ multiple, filters: localFilters(filters), directory: false });
  if (!result) return [];
  const paths = Array.isArray(result) ? result : [result];
  return Promise.all(paths.map(async (p) => ({ name: baseName(p), path: p, bytes: await readFile(p) })));
}

/** Asks only for paths (desktop), used when native code reads the file itself. */
export async function pickPaths(filters: FileFilter[], multiple = false): Promise<string[]> {
  if (!isDesktop) throw new DesktopOnlyError('Choosing files for native conversion');
  const queued = e2ePick();
  if (queued) return queued;
  const result = await openDialog({ multiple, filters: localFilters(filters), directory: false });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/** Asks for a folder (desktop); null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!isDesktop) throw new DesktopOnlyError('Choosing a folder');
  const queued = e2ePick();
  if (queued) return queued[0] ?? null;
  const result = await openDialog({ multiple: false, directory: true });
  return typeof result === 'string' ? result : null;
}

/**
 * Saves bytes. On desktop, shows a Save dialog (or writes straight to
 * `existingPath` when given). Returns the saved path, 'downloaded' in a
 * browser, or null if cancelled.
 */
export async function saveBytes(
  bytes: Uint8Array | Blob,
  suggestedName: string,
  filters: FileFilter[],
  existingPath?: string | null,
): Promise<string | null> {
  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  if (!isDesktop) {
    const blob = new Blob([data.slice().buffer], { type: mimeFor(suggestedName) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
  }
  const path = existingPath ?? (e2e.saveDir ? `${e2e.saveDir}/${suggestedName}` : await saveDialog({ defaultPath: suggestedName, filters: localFilters(filters) }));
  if (!path) return null;
  await writeFile(path, data);
  if (e2e.saveDir) e2e.saved.push(path);
  return path;
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    svg: 'image/svg+xml',
    p12: 'application/x-pkcs12',
    tif: 'image/tiff',
    tiff: 'image/tiff',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}

/** Opens an http(s)/mailto URL in the default browser / mail app. */
export async function openExternal(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) throw new Error('Only web and e-mail links can be opened.');
  if (!isDesktop) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** "size:mtime" of a file on disk (desktop only), or null. */
export async function fileStamp(path: string): Promise<string | null> {
  if (!isDesktop) return null;
  return invoke<string>('file_stamp', { path }).catch(() => null);
}

export async function setFullscreen(on: boolean): Promise<void> {
  if (!isDesktop) {
    if (on) await document.documentElement.requestFullscreen().catch(() => undefined);
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setFullscreen(on);
}

/** PDFs handed over by a second launch of the app (single instance). */
export async function onForwardedFiles(handler: (paths: string[]) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string[]>('adika://open-files', (e) => handler(e.payload));
}

/** Starts the virtual-printer helper when the printer is installed. */
export async function ensurePrintWatcher(): Promise<boolean> {
  if (!isDesktop) return false;
  return invoke<boolean>('ensure_print_watcher').catch(() => false);
}

export async function initialFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  return invoke<string[]>('initial_files');
}

// ---------------------------------------------------------------- conversion

export interface ConverterAvailability {
  word: boolean;
  excel: boolean;
  powerpoint: boolean;
  libreoffice: boolean;
  edge: boolean;
}

export async function converterAvailability(): Promise<ConverterAvailability> {
  if (!isDesktop) return { word: false, excel: false, powerpoint: false, libreoffice: false, edge: false };
  return invoke<ConverterAvailability>('converter_availability');
}

export async function officeToPdf(path: string): Promise<Uint8Array> {
  if (!isDesktop) throw new DesktopOnlyError('Office → PDF conversion');
  return new Uint8Array(await invoke<ArrayBuffer>('office_to_pdf', { path }));
}

export async function htmlToPdf(input: { html: string } | { url: string }): Promise<Uint8Array> {
  if (!isDesktop) throw new DesktopOnlyError('HTML → PDF conversion');
  const args = 'html' in input ? { html: input.html, url: null } : { html: null, url: input.url };
  return new Uint8Array(await invoke<ArrayBuffer>('html_to_pdf', args));
}

/** One scanned page as image bytes; empty array when the user cancelled. */
export async function scanPage(): Promise<Uint8Array> {
  if (!isDesktop) throw new DesktopOnlyError('Scanning');
  return new Uint8Array(await invoke<ArrayBuffer>('scan_wia'));
}

export interface ScannerInfo {
  id: string;
  name: string;
  /** Has a document feeder. */
  feeder: boolean;
}

/** WIA scanners connected to this computer. */
export async function wiaDevices(): Promise<ScannerInfo[]> {
  if (!isDesktop) return [];
  return invoke<ScannerInfo[]>('wia_devices');
}

/** Scans with the given settings, without the driver dialog: one page from the flatbed, every page from the feeder. */
export async function wiaScan(opts: { device: string; dpi: number; mode: 'color' | 'gray' | 'bw'; source: 'flatbed' | 'feeder' | 'duplex'; widthMm: number; heightMm: number }): Promise<Uint8Array[]> {
  if (!isDesktop) throw new DesktopOnlyError('Scanning');
  const buf = new Uint8Array(await invoke<ArrayBuffer>('wia_scan', { device: opts.device, dpi: opts.dpi, mode: opts.mode, source: opts.source, widthMm: opts.widthMm, heightMm: opts.heightMm }));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(0, true);
  const pages: Uint8Array[] = [];
  let o = 4;
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(o, true);
    pages.push(buf.slice(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return pages;
}

// ---------------------------------------------------------------- folders and command line

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** Milliseconds since 1970. */
  modified: number;
}

export async function listDir(path: string): Promise<DirEntry[]> {
  if (!isDesktop) throw new DesktopOnlyError('Reading folders');
  return invoke<DirEntry[]>('list_dir', { path });
}

/** Moves a file (never overwriting); returns where it went. */
export async function moveFile(from: string, to: string): Promise<string> {
  return invoke<string>('move_file', { from, to });
}

export async function makeDir(path: string): Promise<void> {
  await invoke('make_dir', { path });
}

export async function cliArgs(): Promise<string[]> {
  if (!isDesktop) return [];
  return invoke<string[]>('cli_args');
}

export async function cliCwd(): Promise<string> {
  return invoke<string>('cli_cwd');
}

export async function cliPrint(line: string, error = false): Promise<void> {
  await invoke('cli_print', { line, error });
}

export async function cliExit(code: number): Promise<void> {
  await invoke('cli_exit', { code });
}

// ---------------------------------------------------------------- network

export async function httpGet(url: string): Promise<Uint8Array> {
  if (!isDesktop) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const buf = await invoke<ArrayBuffer>('http_request', new Uint8Array(0), {
    headers: { 'x-url': encodeURIComponent(url), 'x-method': 'GET' },
  });
  return new Uint8Array(buf);
}

export async function httpPost(url: string, contentType: string, body: Uint8Array): Promise<Uint8Array> {
  if (!isDesktop) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: body.slice().buffer });
    if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const buf = await invoke<ArrayBuffer>('http_request', body, {
    headers: { 'x-url': encodeURIComponent(url), 'x-method': 'POST', 'x-content-type': contentType },
  });
  return new Uint8Array(buf);
}

export interface SystemCertificates {
  roots: string[];
  intermediates: string[];
}

export async function systemCertificates(): Promise<SystemCertificates> {
  if (!isDesktop) return { roots: [], intermediates: [] };
  return invoke<SystemCertificates>('system_certificates');
}

// ---------------------------------------------------------------- app data

const memoryData = new Map<string, Uint8Array>();

/** A cache file of the app (empty when missing). */
export async function appDataRead(name: string): Promise<Uint8Array> {
  if (!isDesktop) return memoryData.get(name) ?? new Uint8Array(0);
  return new Uint8Array(await invoke<ArrayBuffer>('appdata_read', { name }));
}

export async function appDataWrite(name: string, bytes: Uint8Array): Promise<void> {
  if (!isDesktop) {
    memoryData.set(name, bytes);
    return;
  }
  await invoke('appdata_write', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
}

// ---------------------------------------------------------------- Windows certificate store

export interface StoreCertificate {
  thumbprint: string;
  derBase64: string;
  hasPrivateKey: boolean;
}

/** Certificates of the current user's "Personal" store. */
export async function winstoreList(): Promise<StoreCertificate[]> {
  if (!isDesktop) return [];
  return invoke<StoreCertificate[]>('winstore_list');
}

/** Decrypts an RSA-encrypted content key with the certificate's private key (opening documents encrypted for it). */
export async function winstoreDecrypt(thumbprint: string, data: Uint8Array): Promise<Uint8Array> {
  if (!isDesktop) throw new DesktopOnlyError('The Windows certificate store');
  return base64ToBytes(await invoke<string>('winstore_decrypt', { thumbprint, dataBase64: bytesToBase64(data) }));
}

/** Signs SHA-256(data) with the certificate's key; Windows asks for a PIN if needed. */
export async function winstoreSign(thumbprint: string, data: Uint8Array): Promise<Uint8Array> {
  if (!isDesktop) throw new DesktopOnlyError('Signing with the Windows certificate store');
  const res = await invoke<{ signatureBase64: string }>('winstore_sign', { thumbprint, dataBase64: bytesToBase64(data) });
  return base64ToBytes(res.signatureBase64);
}

// ---------------------------------------------------------------- PKCS#11

export interface Pkcs11Module {
  path: string;
  vendor: string;
}

export interface TokenCertificate {
  idHex: string;
  label: string;
  derBase64: string;
  hasPrivateKey: boolean;
  keyType: 'rsa' | 'ecdsa' | 'unsupported' | 'unknown';
}

export interface TokenInfo {
  slotId: number;
  slotDescription: string;
  label: string;
  manufacturer: string;
  model: string;
  serial: string;
  loginRequired: boolean;
  protectedAuthPath: boolean;
  certificates: TokenCertificate[];
}

export interface TokenSignature {
  signatureBase64: string;
  keyType: 'rsa' | 'ecdsa';
  mechanism: string;
}

export async function pkcs11DetectModules(): Promise<Pkcs11Module[]> {
  if (!isDesktop) return [];
  return invoke<Pkcs11Module[]>('pkcs11_detect_modules');
}

export async function pkcs11ListTokens(module: string): Promise<TokenInfo[]> {
  if (!isDesktop) throw new DesktopOnlyError('Hardware token signing');
  return invoke<TokenInfo[]>('pkcs11_list_tokens', { module });
}

export async function pkcs11Sign(args: {
  module: string;
  slotId: number;
  certIdHex: string;
  pin: string | null;
  data: Uint8Array;
}): Promise<TokenSignature> {
  if (!isDesktop) throw new DesktopOnlyError('Hardware token signing');
  return invoke<TokenSignature>('pkcs11_sign', {
    module: args.module,
    slotId: args.slotId,
    certIdHex: args.certIdHex,
    pin: args.pin,
    dataBase64: bytesToBase64(args.data),
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
