/**
 * ANAF e-Factura in the app. Every network call follows a button the user
 * pressed; nothing contacts ANAF in the background.
 * - Company lookup (public VAT register) and validation (public service).
 * - SPV upload / status / messages / download with the user's own
 *   application registered with ANAF: client id, callback and the test
 *   environment switch in app storage; the client secret in Windows
 *   Credential Manager; tokens in memory, the refresh token remembered in
 *   Credential Manager only when the user agrees.
 * - A log of uploads in the app data folder (anaf-uploads.json).
 */
import { create } from 'zustand';
import { usePDFStore } from '@/store/usePDFStore';
import { translate } from '@/lib/i18n';
import { apiRequest, appDataRead, appDataWrite, isDesktop, oauthLoopbackCancel, oauthLoopbackStart, oauthLoopbackWait, openExternal, secretDelete, secretRead, secretStore } from '@/lib/platform';
import {
  AnafAuthError,
  AnafClient,
  AnafCompanyLookup,
  loopbackRedirect,
  parseCallback,
  pollUpload,
  readUploadLog,
  uploadCif,
  uploadStandard,
  upsertUpload,
  validateWithAnaf,
  type AnafApp,
  type AnafAuthorizer,
  type AnafCompany,
  type AnafValidation,
  type AuthorizationResult,
  type SpvMessage,
  type UploadRecord,
  type UploadStatus,
} from '@/lib/einvoice/anaf';
import { errorMessage } from './document';
import { saveFile } from './saveGuard';

// ---------------------------------------------------------------- public services

let lookup: AnafCompanyLookup | null = null;

/** The company with this CUI in ANAF's VAT register (null: unknown to ANAF). */
export async function lookupCompany(cui: string): Promise<AnafCompany | null> {
  lookup ??= new AnafCompanyLookup(apiRequest);
  return lookup.lookupOne(cui);
}

/** ANAF's own validation of an invoice XML. */
export function checkXmlWithAnaf(xml: string): Promise<AnafValidation> {
  return validateWithAnaf(apiRequest, xml);
}

// ---------------------------------------------------------------- settings

export interface AnafSettings {
  clientId: string;
  redirectUri: string;
  test: boolean;
  /** Keep the refresh token in Windows Credential Manager (the user agreed). */
  rememberSignIn: boolean;
  /** Last CUI used in the dialog. */
  cif: string;
  days: number;
}

const KEY = 'adika.anaf';
const SECRET = 'anaf.clientSecret';
const refreshName = (test: boolean) => (test ? 'anaf.refresh.test' : 'anaf.refresh.prod');
/** Outside the desktop app the secret can only stay in this browser's storage. */
const BROWSER_SECRET = 'adika.anaf.secret';

function loadSettings(): AnafSettings {
  const d: AnafSettings = { clientId: '', redirectUri: '', test: false, rememberSignIn: false, cif: '', days: 30 };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AnafSettings>;
    return {
      clientId: typeof v.clientId === 'string' ? v.clientId : d.clientId,
      redirectUri: typeof v.redirectUri === 'string' ? v.redirectUri : d.redirectUri,
      test: v.test === true,
      rememberSignIn: v.rememberSignIn === true,
      cif: typeof v.cif === 'string' ? v.cif : d.cif,
      days: typeof v.days === 'number' ? v.days : d.days,
    };
  } catch {
    return d;
  }
}

export const useAnafSettings = create<AnafSettings & { update: (p: Partial<AnafSettings>) => void }>()((set, get) => ({
  ...loadSettings(),
  update: (p) => {
    set(p);
    const { update: _u, ...s } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: kept for this session */
    }
  },
}));

export async function readClientSecret(): Promise<string> {
  if (!isDesktop) return localStorage.getItem(BROWSER_SECRET) ?? '';
  return (await secretRead(SECRET).catch(() => null)) ?? '';
}

export async function saveClientSecret(secret: string): Promise<void> {
  if (!isDesktop) {
    localStorage.setItem(BROWSER_SECRET, secret);
    return;
  }
  if (secret) await secretStore(SECRET, secret);
  else await secretDelete(SECRET);
}

// ---------------------------------------------------------------- sign-in

/** The callback address the user pastes when the registered callback is not on this computer. */
export const useAnafPaste = create<{ waiting: boolean; resolve: ((r: AuthorizationResult | null) => void) | null }>()(() => ({ waiting: false, resolve: null }));

export function submitCallback(url: string | null): void {
  const { resolve } = useAnafPaste.getState();
  useAnafPaste.setState({ waiting: false, resolve: null });
  resolve?.(url ? parseCallback(url) : null);
}

let loopbackId: number | null = null;

const browserAuthorizer: AnafAuthorizer = async (url, redirectUri) => {
  const loop = loopbackRedirect(redirectUri);
  if (loop) {
    const { id } = await oauthLoopbackStart(loop.port, loop.path);
    loopbackId = id;
    try {
      await openExternal(url);
      const r = await oauthLoopbackWait(id, 300);
      return { code: r.code ?? undefined, state: r.state ?? undefined, error: r.error ?? undefined, errorDescription: r.errorDescription ?? undefined };
    } finally {
      if (loopbackId === id) loopbackId = null;
    }
  }
  // Any other callback: the browser ends on that page; the user copies its address back.
  const answer = new Promise<AuthorizationResult | null>((resolve) => useAnafPaste.setState({ waiting: true, resolve }));
  await openExternal(url);
  const r = await answer;
  if (!r) throw new Error(translate('Sign-in cancelled.'));
  return r;
};

/** Stops waiting for the browser. */
export function cancelAnafSignIn(): void {
  if (loopbackId !== null) void oauthLoopbackCancel(loopbackId);
  if (useAnafPaste.getState().waiting) submitCallback(null);
}

export const useAnafSession = create<{ connected: boolean; expiresAt: number | null }>()(() => ({ connected: false, expiresAt: null }));

let client: AnafClient | null = null;

async function appConfig(): Promise<AnafApp> {
  const s = useAnafSettings.getState();
  return { clientId: s.clientId, clientSecret: await readClientSecret(), redirectUri: s.redirectUri, test: s.test };
}

function onTokens(test: boolean) {
  return (t: { refresh?: string; expiresAt: number } | null) => {
    useAnafSession.setState({ connected: !!t, expiresAt: t?.expiresAt ?? null });
    if (!isDesktop) return;
    const name = refreshName(test);
    if (t?.refresh && useAnafSettings.getState().rememberSignIn) void secretStore(name, t.refresh).catch(() => undefined);
    else if (!t) void secretDelete(name).catch(() => undefined);
  };
}

/** The session's client for the current settings (a remembered sign-in is picked up). */
export async function anafClient(): Promise<AnafClient> {
  const app = await appConfig();
  if (client && JSON.stringify(client.app) === JSON.stringify(app)) return client;
  client = new AnafClient(app, { transport: apiRequest, authorize: browserAuthorizer, onTokens: onTokens(app.test) });
  useAnafSession.setState({ connected: false, expiresAt: null });
  if (useAnafSettings.getState().rememberSignIn) {
    const rt = await secretRead(refreshName(app.test)).catch(() => null);
    if (rt) {
      client.useRefreshToken(rt);
      useAnafSession.setState({ connected: true, expiresAt: null });
    }
  }
  return client;
}

export async function connectAnaf(): Promise<void> {
  const c = await anafClient();
  await c.signIn();
}

export async function disconnectAnaf(): Promise<void> {
  const test = useAnafSettings.getState().test;
  client?.signOut();
  client = null;
  useAnafSession.setState({ connected: false, expiresAt: null });
  await secretDelete(refreshName(test)).catch(() => undefined);
}

/** Turning "remember" off forgets the stored refresh tokens. */
export async function setRememberSignIn(on: boolean): Promise<void> {
  useAnafSettings.getState().update({ rememberSignIn: on });
  if (!on) {
    await secretDelete(refreshName(false)).catch(() => undefined);
    await secretDelete(refreshName(true)).catch(() => undefined);
  } else if (client?.tokens?.refresh && isDesktop) {
    await secretStore(refreshName(client.app.test), client.tokens.refresh).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- uploads

const LOG = 'anaf-uploads.json';

export async function readUploads(): Promise<UploadRecord[]> {
  try {
    return readUploadLog(new TextDecoder().decode(await appDataRead(LOG)) || '{}');
  } catch {
    return [];
  }
}

async function logUpload(rec: UploadRecord): Promise<UploadRecord[]> {
  const log = upsertUpload(await readUploads(), rec);
  try {
    await appDataWrite(LOG, new TextEncoder().encode(JSON.stringify({ uploads: log })));
  } catch (e) {
    usePDFStore.getState().toast(errorMessage(e), 'error');
  }
  return log;
}

/** An invoice waiting in the ANAF dialog (from New e-invoice, or a chosen XML file). */
export const useAnafOutbox = create<{ xml: string | null; number: string; name: string }>()(() => ({ xml: null, number: '', name: '' }));

export function openAnafDialog(invoice?: { xml: string; number: string; name?: string }): void {
  if (invoice) useAnafOutbox.setState({ xml: invoice.xml, number: invoice.number, name: invoice.name ?? `${invoice.number}.xml` });
  usePDFStore.getState().openModal('anaf');
}

export const cifOfInvoice = uploadCif;

/** Uploads to SPV and logs it; returns the log entry. */
export async function uploadToAnaf(xml: string, number: string, cif: string): Promise<UploadRecord> {
  const c = await anafClient();
  const receipt = await c.upload(xml, cif, { selfBilled: /<(?:[\w-]+:)?(?:InvoiceTypeCode|TypeCode)>389</.test(xml) });
  const rec: UploadRecord = { at: new Date().toISOString(), cif: cif.replace(/\D/g, ''), number, standard: uploadStandard(xml), index: receipt.index, test: c.app.test, state: 'sent', downloadId: '', errors: [] };
  await logUpload(rec);
  return rec;
}

function withStatus(rec: UploadRecord, s: UploadStatus): UploadRecord {
  return { ...rec, state: s.state, downloadId: s.downloadId || rec.downloadId, errors: s.errors };
}

/** One status question; the log keeps the answer. */
export async function checkUpload(rec: UploadRecord): Promise<UploadRecord> {
  const c = await anafClient();
  const next = withStatus(rec, await c.status(rec.index));
  await logUpload(next);
  return next;
}

/** Asks every 30 s (at most 10 minutes) until ANAF has processed the upload or the signal stops it. */
export async function watchUpload(rec: UploadRecord, signal: AbortSignal, onChange: (r: UploadRecord) => void): Promise<UploadRecord> {
  const c = await anafClient();
  let cur = rec;
  await pollUpload(c, rec.index, {
    signal,
    onStatus: (s) => {
      cur = withStatus(cur, s);
      void logUpload(cur);
      onChange(cur);
    },
  });
  return cur;
}

export async function listAnafMessages(cif: string, days: number): Promise<SpvMessage[]> {
  const c = await anafClient();
  return c.messages(cif, days);
}

/** Downloads a message: opens the invoice as a readable PDF, or saves the ZIP. */
export async function downloadAnafMessage(id: string, action: 'open' | 'save', name = `anaf-${id}.zip`): Promise<void> {
  const c = await anafClient();
  const zip = await c.download(id);
  if (action === 'save') {
    await saveFile(zip, name, [{ name: 'ZIP archive', extensions: ['zip'] }]);
    return;
  }
  const { openEInvoice, isEInvoiceFile } = await import('./einvoice');
  if (await isEInvoiceFile(zip, name)) {
    if (await openEInvoice(zip, name)) usePDFStore.getState().openModal(null);
    return;
  }
  // An error report: ANAF's messages instead of an invoice.
  const JSZip = (await import('jszip')).default;
  const files = await JSZip.loadAsync(zip);
  const entry = Object.keys(files.files).find((n) => /\.xml$/i.test(n) && !/semnatura/i.test(n));
  const xml = entry ? await files.files[entry].async('string') : '';
  const errors = [...xml.matchAll(/errorMessage="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  throw new Error(errors.length ? errors.join('\n') : translate('The download holds no invoice.'));
}

export function anafErrorText(e: unknown): string {
  if (e instanceof AnafAuthError) void disconnectAnaf();
  return errorMessage(e);
}
