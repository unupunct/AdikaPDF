/**
 * OCR languages: ten are bundled (public/tesseract/lang), the others can be
 * downloaded on the user's click into app data (`ocr-langs`). A download
 * comes only from the pinned jsDelivr URL, must have the pinned size and
 * SHA-256 (ocrLangCatalog.ts) and is refused under the DisableOnlineFeatures
 * policy. Bundled languages win over downloaded copies of the same code.
 */
import { OCR_LANG_CATALOG, ocrLangUrl, type OcrLangInfo } from './ocrLangCatalog';
import { assertOnline } from './policy';

/** Languages whose traineddata is bundled under public/tesseract/lang. */
export const BUNDLED_OCR_LANGS: Array<{ code: string; label: string }> = [
  { code: 'eng', label: 'English' },
  { code: 'ron', label: 'Română' },
  { code: 'deu', label: 'Deutsch' },
  { code: 'fra', label: 'Français' },
  { code: 'spa', label: 'Español' },
  { code: 'ita', label: 'Italiano' },
  { code: 'hun', label: 'Magyar' },
  { code: 'por', label: 'Português' },
  { code: 'nld', label: 'Nederlands' },
  { code: 'pol', label: 'Polski' },
];

const BUNDLED = new Set(BUNDLED_OCR_LANGS.map((l) => l.code));

export function isBundledOcrLang(code: string): boolean {
  return BUNDLED.has(code);
}

export function catalogEntry(code: string): OcrLangInfo | undefined {
  return OCR_LANG_CATALOG.find((l) => l.code === code);
}

/** Display name: the bundled label, else the catalogue's English name. */
export function ocrLangLabel(code: string): string {
  return BUNDLED_OCR_LANGS.find((l) => l.code === code)?.label ?? catalogEntry(code)?.name ?? code;
}

/** Native storage (platform.ts); injectable for tests. */
export interface OcrLangIo {
  list(): Promise<Array<{ code: string; size: number }>>;
  read(code: string): Promise<Uint8Array>;
  write(code: string, bytes: Uint8Array): Promise<void>;
  remove(code: string): Promise<void>;
  get(url: string): Promise<Uint8Array>;
}

async function platformIo(): Promise<OcrLangIo> {
  const p = await import('./platform');
  return { list: p.ocrLangList, read: p.ocrLangRead, write: p.ocrLangWrite, remove: p.ocrLangDelete, get: p.httpGet };
}

/** Codes downloaded into app data (only those of the catalogue). */
export async function downloadedOcrLangs(io?: OcrLangIo): Promise<string[]> {
  const files = await (io ?? (await platformIo())).list();
  return files.map((f) => f.code).filter((c) => !!catalogEntry(c));
}

/** Every usable language: bundled first, then downloaded. */
export async function installedOcrLangs(io?: OcrLangIo): Promise<string[]> {
  let downloaded: string[] = [];
  try {
    downloaded = await downloadedOcrLangs(io);
  } catch {
    downloaded = [];
  }
  return [...BUNDLED_OCR_LANGS.map((l) => l.code), ...downloaded.filter((c) => !BUNDLED.has(c))];
}

export interface OcrLangPlan {
  /** Loaded from the bundled assets (langPath). */
  bundled: string[];
  /** Loaded from app data. */
  downloaded: string[];
  /** Known languages that are not installed. */
  missing: string[];
}

/**
 * Where each requested language comes from: bundled assets first, then app
 * data; known but not installed ones are listed as missing; unknown codes are
 * dropped. Pure.
 */
export function planOcrLangs(requested: string[], downloaded: Iterable<string>): OcrLangPlan {
  const have = new Set(downloaded);
  const plan: OcrLangPlan = { bundled: [], downloaded: [], missing: [] };
  for (const raw of requested) {
    const c = raw.trim().toLowerCase();
    if (!c || plan.bundled.includes(c) || plan.downloaded.includes(c) || plan.missing.includes(c)) continue;
    if (BUNDLED.has(c)) plan.bundled.push(c);
    else if (have.has(c) && catalogEntry(c)) plan.downloaded.push(c);
    else if (catalogEntry(c)) plan.missing.push(c);
  }
  return plan;
}

export class OcrLangMissingError extends Error {
  constructor(codes: string[]) {
    super(`OCR language not installed: ${codes.join(', ')}. Download it in Optimise → OCR → Languages.`);
    this.name = 'OcrLangMissingError';
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks downloaded bytes against the pinned size and SHA-256; throws when they differ. */
export async function verifyOcrLang(code: string, bytes: Uint8Array): Promise<void> {
  const info = catalogEntry(code);
  if (!info) throw new Error(`Unknown OCR language: ${code}`);
  if (bytes.length !== info.size) throw new Error(`The ${info.name} language data has the wrong size (${bytes.length} bytes, expected ${info.size}). Nothing was installed.`);
  if ((await sha256Hex(bytes)) !== info.sha256) throw new Error(`The ${info.name} language data does not match its checksum. Nothing was installed.`);
}

/** Downloads one language (on the user's click), checks it and stores it in app data. */
export async function downloadOcrLang(code: string, io?: OcrLangIo): Promise<void> {
  assertOnline('ocrLanguages');
  const info = catalogEntry(code);
  if (!info) throw new Error(`Unknown OCR language: ${code}`);
  if (BUNDLED.has(code)) return;
  const x = io ?? (await platformIo());
  const bytes = await x.get(ocrLangUrl(code));
  await verifyOcrLang(code, bytes);
  await x.write(code, bytes);
}

export async function removeOcrLang(code: string, io?: OcrLangIo): Promise<void> {
  if (BUNDLED.has(code)) throw new Error('Languages that come with Adika cannot be removed.');
  await (io ?? (await platformIo())).remove(code);
}

/** The gzipped data of downloaded languages, checked again before use (a damaged file is reported, not used). */
export async function readDownloadedLangs(codes: string[], io?: OcrLangIo): Promise<Array<{ code: string; data: Uint8Array }>> {
  const x = io ?? (await platformIo());
  const out: Array<{ code: string; data: Uint8Array }> = [];
  for (const code of codes) {
    const data = await x.read(code);
    if (!data.length) throw new OcrLangMissingError([code]);
    await verifyOcrLang(code, data);
    out.push({ code, data });
  }
  return out;
}

// tesseract.js (browser worker) looks for `${cachePath}/${lang}.traineddata` in
// idb-keyval's default store before fetching from langPath; downloaded
// languages are handed over that way for one run and removed afterwards.
const IDB_NAME = 'keyval-store';
const IDB_STORE = 'keyval';

export function cacheKey(cachePath: string, code: string): string {
  return `${cachePath}/${code}.traineddata`;
}

function idbRun(fn: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('IndexedDB write failed'));
      };
    };
  });
}

/** Puts the languages where the OCR worker reads them; returns the cleanup. */
export async function stageForWorker(cachePath: string, langs: Array<{ code: string; data: Uint8Array }>): Promise<() => Promise<void>> {
  if (!langs.length) return async () => undefined;
  await idbRun((store) => {
    for (const l of langs) store.put(l.data, cacheKey(cachePath, l.code));
  });
  return () => idbRun((store) => {
    for (const l of langs) store.delete(cacheKey(cachePath, l.code));
  }).catch(() => undefined);
}
