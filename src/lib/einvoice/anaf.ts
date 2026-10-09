/**
 * ANAF web services for e-Factura. Every call is started by the user:
 * - company lookup by CUI in ANAF's public VAT register (no account; at most
 *   one request a second and 100 CUIs per request, answers kept for the session);
 * - ANAF's public validation of an invoice XML (no account);
 * - the SPV e-Factura API (upload, status, messages, download) with an OAuth
 *   2.0 sign-in at logincert.anaf.ro, where the browser presents the user's
 *   qualified certificate. The application (client id / secret / callback)
 *   is the one the user registered in ANAF's portal.
 * Network access and the browser hand-off are injected. Pure otherwise.
 */
import { parseXml, attr, descendants, kids, localName, textOf, type XEl } from '@/lib/xml';
import { pkceChallenge, toBase64, toBase64Url } from '@/lib/crypto/csc';
import { cuiValid, normalizeRoCounty, RO_COUNTIES } from './rules';
import type { DraftParty } from './model';

export interface AnafReply {
  status: number;
  body: string;
  bytes?: Uint8Array;
}
export type AnafTransport = (req: { url: string; method: 'GET' | 'POST'; authorization?: string; contentType?: string; body?: string; accept?: string; binary?: boolean }) => Promise<AnafReply>;

export class AnafError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
/** The sign-in is missing or no longer accepted: connect again. */
export class AnafAuthError extends AnafError {}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const yes = (v: unknown): boolean => v === true || v === 'true' || v === 'DA';

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** ANAF writes ş and ţ with a cedilla; Romanian uses the comma below. */
export const commaBelow = (s: string) => s.replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');

/** A web firewall page instead of the service's answer. */
const isFirewallPage = (body: string) => /^\s*<(!doctype|html)/i.test(body) && /request rejected|the requested url was rejected/i.test(body);

// ---------------------------------------------------------------- CUI lookup

export const ANAF_VAT_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
/** ANAF's limits for the public VAT register. */
export const ANAF_VAT_MAX_CUIS = 100;
export const ANAF_VAT_INTERVAL_MS = 1000;

export interface AnafCompany {
  cui: string;
  name: string;
  /** Registration in the trade register (J12/3456/2020). */
  regCom: string;
  street: string;
  city: string;
  /** ISO 3166-2:RO code (RO-CJ, RO-B), empty when unknown. */
  county: string;
  postalCode: string;
  phone: string;
  /** Registered for VAT on the date asked about. */
  vatPayer: boolean;
  /** In the RO e-Factura register. */
  eFactura: boolean;
  inactive: boolean;
  /** Deregistered (radiată). */
  deregistered: boolean;
  /** VAT on cash accounting (TVA la încasare). */
  cashVat: boolean;
  splitVat: boolean;
  /** English warnings with {0} values filled in (the app translates the pattern). */
  warnings: string[];
  /** The date the register was asked about (YYYY-MM-DD). */
  date: string;
}

/** The CUI digits of "RO 123", "ro123", "123" when the check digit is right; null otherwise. */
export function anafCui(s: string): string | null {
  const v = s.replace(/\s+/g, '').toUpperCase().replace(/^RO/, '');
  return /^\d{2,10}$/.test(v) && cuiValid(v) ? v : null;
}

/** "Mun. Cluj-Napoca" -> "Cluj-Napoca"; Bucharest "Sector 3 Mun. Bucureşti" -> "SECTOR3". */
export function anafCity(locality: string, county: string): string {
  const v = commaBelow(locality.trim());
  if (county === 'RO-B') {
    const m = /sector(?:ul)?\s*([1-6])/i.exec(v);
    return m ? `SECTOR${m[1]}` : v;
  }
  return v.replace(/^(mun\.|municipiul|oraș|oras|or\.)\s*/i, '').trim();
}

/** The county of an ANAF address: the car-plate code (CJ, B), else the name. */
export function anafCounty(auto: string, name: string): string {
  const a = auto.trim().toUpperCase();
  if (a && RO_COUNTIES[`RO-${a}`]) return `RO-${a}`;
  const n = commaBelow(name).replace(/^municipiul\s+/i, '');
  return normalizeRoCounty(n);
}

function streetOf(street: string, number: string, details: string): string {
  const parts = [commaBelow(street.trim()), number.trim() ? `nr. ${number.trim()}` : ''].filter(Boolean).join(' ');
  return [parts, commaBelow(details.trim())].filter(Boolean).join(', ').slice(0, 150);
}

/** One company of the VAT register's answer (`found[]`). */
export function parseCompany(found: unknown, date: string): AnafCompany {
  const f = obj(found);
  const g = obj(f.date_generale);
  const scp = obj(f.inregistrare_scop_Tva);
  const inact = obj(f.stare_inactiv);
  const s = obj(f.adresa_sediu_social);
  const d = obj(f.adresa_domiciliu_fiscal);
  const useSeat = !!(text(s.sdenumire_Localitate) || text(s.sdenumire_Strada));
  const auto = useSeat ? text(s.scod_JudetAuto) : text(d.dcod_JudetAuto);
  const countyName = useSeat ? text(s.sdenumire_Judet) : text(d.ddenumire_Judet);
  const county = anafCounty(auto, countyName);
  const locality = useSeat ? text(s.sdenumire_Localitate) : text(d.ddenumire_Localitate);
  const street = useSeat ? streetOf(text(s.sdenumire_Strada), text(s.snumar_Strada), text(s.sdetalii_Adresa)) : streetOf(text(d.ddenumire_Strada), text(d.dnumar_Strada), text(d.ddetalii_Adresa));
  const postal = (useSeat ? text(s.scod_Postal) : text(d.dcod_Postal)) || text(g.codPostal);
  const registration = text(g.stare_inregistrare);
  const deregDate = text(inact.dataRadiere);
  const deregistered = !!deregDate || /radiere|radiat/i.test(registration);
  const inactive = yes(inact.statusInactivi);
  const c: AnafCompany = {
    cui: text(g.cui),
    name: commaBelow(text(g.denumire)),
    regCom: text(g.nrRegCom),
    street: street || commaBelow(text(g.adresa)).slice(0, 150),
    city: anafCity(locality, county),
    county,
    postalCode: postal,
    phone: text(g.telefon),
    vatPayer: yes(scp.scpTVA),
    eFactura: yes(g.statusRO_e_Factura),
    inactive,
    deregistered,
    cashVat: yes(obj(f.inregistrare_RTVAI).statusTvaIncasare),
    splitVat: yes(obj(f.inregistrare_SplitTVA).statusSplitTVA),
    warnings: [],
    date,
  };
  if (deregistered) c.warnings.push(deregDate ? `ANAF lists the company as deregistered (radiată) since ${deregDate}.` : 'ANAF lists the company as deregistered (radiată).');
  if (inactive) c.warnings.push(text(inact.dataInactivare) ? `ANAF lists the company as inactive since ${text(inact.dataInactivare)}.` : 'ANAF lists the company as inactive.');
  if (!c.county && !c.city) c.warnings.push('ANAF gave no usable address; check the address fields.');
  return c;
}

/** The VAT register's answer: companies by CUI, and the CUIs ANAF does not know. */
export function parseVatReply(body: string, date: string): { found: AnafCompany[]; notFound: string[] } {
  if (isFirewallPage(body)) throw new AnafError("ANAF's firewall rejected the request. Try again later.");
  const v = obj(parseJson(body));
  if (!('found' in v) && !('notFound' in v)) throw new AnafError(`ANAF answered: ${text(v.message) || body.slice(0, 200) || 'no data'}`);
  return { found: arr(v.found).map((f) => parseCompany(f, date)), notFound: arr(v.notFound).map((n) => text(obj(n).cui ?? n) || text(n)) };
}

/** The buyer or seller fields from a company in the register (contact details kept). */
export function partyFromCompany(c: AnafCompany, current?: DraftParty): DraftParty {
  return {
    name: c.name,
    vatId: c.vatPayer ? `RO${c.cui}` : '',
    companyId: c.vatPayer ? c.regCom || c.cui : c.cui,
    street: c.street,
    city: c.city,
    postalCode: c.postalCode,
    region: c.county,
    country: 'RO',
    email: current?.email ?? '',
    phone: current?.phone || c.phone,
    endpointId: current?.endpointId ?? '',
    endpointScheme: current?.endpointScheme ?? '',
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Company lookup in ANAF's VAT register: requests go one at a time, at least
 * a second apart, with up to 100 CUIs each; answers are kept for the session.
 */
export class AnafCompanyLookup {
  private cache = new Map<string, AnafCompany | null>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = -Infinity;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly url: string;
  private readonly transport: AnafTransport;

  constructor(transport: AnafTransport, opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; url?: string } = {}) {
    this.transport = transport;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.url = opts.url ?? ANAF_VAT_URL;
  }

  /** Companies by CUI (null: ANAF does not know it). Invalid CUIs are refused before any request. */
  async lookup(cuis: string[], date = today()): Promise<Map<string, AnafCompany | null>> {
    const wanted = [...new Set(cuis.map((c) => {
      const id = anafCui(c);
      if (!id) throw new AnafError(`Not a valid CUI: ${c}`);
      return id;
    }))];
    const missing = wanted.filter((c) => !this.cache.has(`${c}@${date}`));
    for (let i = 0; i < missing.length; i += ANAF_VAT_MAX_CUIS) await this.request(missing.slice(i, i + ANAF_VAT_MAX_CUIS), date);
    return new Map(wanted.map((c) => [c, this.cache.get(`${c}@${date}`) ?? null]));
  }

  async lookupOne(cui: string, date = today()): Promise<AnafCompany | null> {
    const m = await this.lookup([cui], date);
    return [...m.values()][0] ?? null;
  }

  private request(batch: string[], date: string): Promise<void> {
    const run = async () => {
      const wait = this.last + ANAF_VAT_INTERVAL_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      const r = await this.transport({ url: this.url, method: 'POST', contentType: 'application/json', body: JSON.stringify(batch.map((c) => ({ cui: Number(c), data: date }))) });
      if (r.status === 429) throw new AnafError('ANAF limits how often its register can be asked. Wait a moment and try again.', 429);
      if (r.status !== 200) throw new AnafError(`ANAF's register answered HTTP ${r.status}.`, r.status);
      const { found } = parseVatReply(r.body, date);
      for (const c of batch) this.cache.set(`${c}@${date}`, null);
      for (const f of found) if (f.cui) this.cache.set(`${f.cui}@${date}`, f);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- validation

export const ANAF_VALIDATE_URL = 'https://webservicesp.anaf.ro/prod/FCTEL/rest/validare/';

export interface AnafMessage {
  /** The business rule ANAF names (BR-RO-110, BR-CO-15…), empty when none. */
  rule: string;
  message: string;
}

export interface AnafValidation {
  ok: boolean;
  messages: AnafMessage[];
  traceId: string;
}

/** The validation "standard": FCN for a UBL credit note, FACT1 otherwise. */
export function validationStandard(xml: string): 'FACT1' | 'FCN' {
  return /<(?:[\w-]+:)?CreditNote[\s>]/.test(xml.slice(0, 2000)) ? 'FCN' : 'FACT1';
}

/** The upload "standard": UBL invoice, CN credit note, CII. */
export function uploadStandard(xml: string): 'UBL' | 'CN' | 'CII' {
  const head = xml.slice(0, 2000);
  if (/<(?:[\w-]+:)?CrossIndustryInvoice[\s>]/.test(head)) return 'CII';
  return validationStandard(xml) === 'FCN' ? 'CN' : 'UBL';
}

export const ruleOf = (message: string) => /\b(BR-(?:[A-Z]{1,4}-)?[A-Z]?\d{1,4}[A-Z]?|PEPPOL-[A-Z0-9-]+)\b/.exec(message)?.[1] ?? '';

/** ANAF's validation answer: {"stare":"ok"|"nok","Messages":[{"message":…}],"trace_id":…}. */
export function parseValidation(status: number, body: string): AnafValidation {
  if (isFirewallPage(body)) throw new AnafError("ANAF's firewall rejected the XML (it sometimes blocks valid invoices). Try again later.");
  const v = obj(parseJson(body));
  const stare = text(v.stare).toLowerCase();
  if (!stare) {
    const msg = text(v.message) || text(v.eroare) || text(v.error);
    throw new AnafError(msg ? `ANAF answered: ${msg}` : `ANAF's validation answered HTTP ${status}.`, status);
  }
  const messages = arr(v.Messages ?? v.messages).map((m) => text(obj(m).message) || text(m)).filter(Boolean).map((message) => ({ rule: ruleOf(message), message }));
  return { ok: stare === 'ok', messages, traceId: text(v.trace_id) };
}

/** Sends an invoice XML to ANAF's public validation service. */
export async function validateWithAnaf(transport: AnafTransport, xml: string): Promise<AnafValidation> {
  const r = await transport({ url: ANAF_VALIDATE_URL + validationStandard(xml), method: 'POST', contentType: 'text/plain', body: xml });
  return parseValidation(r.status, r.body);
}

// ---------------------------------------------------------------- SPV e-Factura (OAuth)

export const ANAF_AUTHORIZE_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/authorize';
export const ANAF_TOKEN_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/token';
export const ANAF_API = { prod: 'https://api.anaf.ro/prod/FCTEL/rest/', test: 'https://api.anaf.ro/test/FCTEL/rest/' };

export interface AnafApp {
  clientId: string;
  clientSecret: string;
  /** The callback URL registered with the application. */
  redirectUri: string;
  /** ANAF's test environment (api.anaf.ro/test). */
  test: boolean;
}

export interface AnafTokens {
  access: string;
  refresh?: string;
  /** ms since 1970. */
  expiresAt: number;
}

export interface AuthorizationResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** Opens the sign-in page in the browser and returns the redirect it ends with. */
export type AnafAuthorizer = (url: string, redirectUri: string) => Promise<AuthorizationResult>;

/** The code / state / error of a callback address the user pasted. */
export function parseCallback(url: string): AuthorizationResult {
  let q: URLSearchParams;
  try {
    q = new URL(url.trim()).searchParams;
  } catch {
    q = new URLSearchParams(url.trim().replace(/^[^?]*\?/, ''));
  }
  const g = (k: string) => q.get(k) ?? undefined;
  return { code: g('code'), state: g('state'), error: g('error'), errorDescription: g('error_description') };
}

/** A loopback callback (http://localhost:<port>/path) Adika can listen on, or null for any other callback. */
export function loopbackRedirect(uri: string): { port: number; path: string } | null {
  try {
    const u = new URL(uri.trim());
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port) return { port: Number(u.port), path: u.pathname || '/' };
  } catch {
    /* not a URL */
  }
  return null;
}

/** Checks the registered application details. */
export function checkAnafApp(app: AnafApp): string | null {
  if (!app.clientId.trim()) return 'Enter the client ID of the application registered with ANAF.';
  if (!app.clientSecret.trim()) return 'Enter the client secret of the application registered with ANAF.';
  try {
    const u = new URL(app.redirectUri.trim());
    if (u.protocol !== 'https:' && !loopbackRedirect(app.redirectUri)) return 'The callback URL must be https:// or http://localhost:<port>/…, exactly as registered with ANAF.';
  } catch {
    return 'Enter the callback URL registered with ANAF.';
  }
  return null;
}

export type UploadState = 'ok' | 'nok' | 'processing' | 'rejected' | 'unknown';

export interface UploadReceipt {
  index: string;
  date: string;
}

export interface UploadStatus {
  state: UploadState;
  downloadId: string;
  errors: string[];
}

export type MessageKind = 'sent' | 'received' | 'errors' | 'buyer-message' | 'other';

export interface SpvMessage {
  id: string;
  /** The upload index (id_solicitare). */
  uploadIndex: string;
  cif: string;
  /** "202610091230" -> "2026-10-09 12:30". */
  created: string;
  kind: MessageKind;
  type: string;
  details: string;
}

const xmlRoot = (body: string): XEl | null => {
  try {
    return parseXml(body);
  } catch {
    return null;
  }
};

const errorsOf = (root: XEl) => kids(root).filter((k) => localName(k.name) === 'Errors').map((e) => attr(e, 'errorMessage') ?? '').filter(Boolean);

/** Upload answer: <header ExecutionStatus="0" index_incarcare="…"/> or ExecutionStatus="1" with <Errors errorMessage="…"/>. */
export function parseUploadReply(status: number, body: string): UploadReceipt {
  const root = xmlRoot(body);
  if (!root || localName(root.name) !== 'header') {
    const v = obj(parseJson(body));
    throw new AnafError(text(v.message) || text(v.eroare) ? `ANAF answered: ${text(v.message) || text(v.eroare)}` : `ANAF's upload answered HTTP ${status}.`, status);
  }
  const index = attr(root, 'index_incarcare') ?? '';
  if (attr(root, 'ExecutionStatus') !== '0' || !index) {
    const errs = errorsOf(root);
    throw new AnafError(errs.length ? `ANAF refused the upload: ${errs.join(' ')}` : 'ANAF refused the upload.', status);
  }
  return { index, date: attr(root, 'dateResponse') ?? '' };
}

/** Status answer: <header stare="ok|nok|in prelucrare|XML cu erori nepreluat de sistem" id_descarcare="…"/>. */
export function parseStatusReply(status: number, body: string): UploadStatus {
  const root = xmlRoot(body);
  if (!root) throw new AnafError(`ANAF's status answered HTTP ${status}.`, status);
  const stare = (attr(root, 'stare') ?? '').trim().toLowerCase();
  const errors = errorsOf(root);
  if (!stare) {
    if (errors.length) throw new AnafError(`ANAF answered: ${errors.join(' ')}`, status);
    throw new AnafError('ANAF sent no status.', status);
  }
  const state: UploadState = stare === 'ok' ? 'ok' : stare === 'nok' ? 'nok' : stare.includes('prelucrare') ? 'processing' : stare.includes('erori') ? 'rejected' : 'unknown';
  return { state, downloadId: attr(root, 'id_descarcare') ?? '', errors };
}

export function messageKind(type: string): MessageKind {
  const t = type.toUpperCase();
  if (t.includes('ERORI')) return 'errors';
  if (t.includes('TRIMISA')) return 'sent';
  if (t.includes('PRIMITA')) return 'received';
  if (t.includes('MESAJ')) return 'buyer-message';
  return 'other';
}

const stamp = (s: string) => (/^\d{12}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}` : s);

/** The message list (JSON {mesaje:[…]} or {eroare:"Nu exista mesaje…"}). */
export function parseMessageList(status: number, body: string): SpvMessage[] {
  const v = obj(parseJson(body));
  const err = text(v.eroare);
  if (err) {
    if (/nu exista mesaje/i.test(err)) return [];
    throw new AnafError(`ANAF answered: ${err}`, status);
  }
  if (!Array.isArray(v.mesaje)) throw new AnafError(`ANAF's message list answered HTTP ${status}.`, status);
  return v.mesaje
    .map((m) => {
      const o = obj(m);
      const type = text(o.tip);
      return { id: text(o.id), uploadIndex: text(o.id_solicitare), cif: text(o.cif), created: stamp(text(o.data_creare)), kind: messageKind(type), type, details: text(o.detalii) };
    })
    .filter((m) => m.id)
    .sort((a, b) => b.created.localeCompare(a.created));
}

export interface AnafClientDeps {
  transport: AnafTransport;
  authorize: AnafAuthorizer;
  random?: (n: number) => Uint8Array;
  now?: () => number;
  /** Called with new tokens (to remember the refresh token when the user agreed). */
  onTokens?: (t: AnafTokens | null) => void;
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** The SPV e-Factura API of one registered application, with its tokens in memory. */
export class AnafClient {
  tokens: AnafTokens | null = null;
  readonly app: AnafApp;
  private readonly deps: AnafClientDeps;
  private readonly random: (n: number) => Uint8Array;
  private readonly now: () => number;

  constructor(app: AnafApp, deps: AnafClientDeps) {
    this.app = app;
    this.deps = deps;
    this.random = deps.random ?? defaultRandom;
    this.now = deps.now ?? (() => Date.now());
  }

  get base(): string {
    return this.app.test ? ANAF_API.test : ANAF_API.prod;
  }

  get connected(): boolean {
    return !!this.tokens;
  }

  /** Starts from a remembered refresh token (the next call refreshes it). */
  useRefreshToken(refresh: string): void {
    this.tokens = { access: '', refresh, expiresAt: 0 };
  }

  private setTokens(t: AnafTokens | null) {
    this.tokens = t;
    this.deps.onTokens?.(t);
  }

  private async tokenRequest(params: Record<string, string>): Promise<AnafTokens> {
    const basic = toBase64(new TextEncoder().encode(`${this.app.clientId.trim()}:${this.app.clientSecret.trim()}`));
    const r = await this.deps.transport({
      url: ANAF_TOKEN_URL,
      method: 'POST',
      authorization: `Basic ${basic}`,
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({ ...params, token_content_type: 'jwt' }).toString(),
    });
    const d = obj(parseJson(r.body));
    if (r.status < 200 || r.status >= 300 || !text(d.access_token)) {
      const detail = text(d.error_description) || text(d.error) || `HTTP ${r.status}`;
      if (text(d.error) === 'invalid_grant' || text(d.error) === 'invalid_client' || r.status === 401) throw new AnafAuthError(`Connect to ANAF again: ${detail}`, r.status);
      throw new AnafError(`ANAF's sign-in answered: ${detail}`, r.status);
    }
    const expiresIn = Number(d.expires_in) || 90 * 24 * 3600;
    return { access: text(d.access_token), refresh: text(d.refresh_token) || params.refresh_token, expiresAt: this.now() + expiresIn * 1000 };
  }

  /** Authorization code flow (PKCE S256, state checked) in the browser. */
  async signIn(): Promise<void> {
    const verifier = toBase64Url(this.random(32));
    const state = toBase64Url(this.random(16));
    const redirect = this.app.redirectUri.trim();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.app.clientId.trim(),
      redirect_uri: redirect,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      token_content_type: 'jwt',
    });
    const result = await this.deps.authorize(`${ANAF_AUTHORIZE_URL}?${q.toString()}`, redirect);
    if (result.error) throw new AnafAuthError(`ANAF refused the sign-in: ${result.errorDescription || result.error}`);
    if (result.state !== state) throw new AnafError('The sign-in answer did not match this request. Try again.');
    if (!result.code) throw new AnafError('The sign-in answer carried no authorization code.');
    this.setTokens(await this.tokenRequest({ grant_type: 'authorization_code', code: result.code, redirect_uri: redirect, code_verifier: verifier }));
  }

  /** A new access token from the refresh token. */
  async refresh(): Promise<void> {
    const rt = this.tokens?.refresh;
    if (!rt) throw new AnafAuthError('Connect to ANAF first.');
    try {
      this.setTokens(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: rt }));
    } catch (e) {
      if (e instanceof AnafAuthError) this.setTokens(null);
      throw e;
    }
  }

  signOut(): void {
    this.setTokens(null);
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: string; contentType?: string; accept?: string; binary?: boolean }): Promise<AnafReply> {
    if (!this.tokens) throw new AnafAuthError('Connect to ANAF first.');
    if (!this.tokens.access || this.tokens.expiresAt - 60_000 < this.now()) await this.refresh();
    const send = () => this.deps.transport({ url: this.base + path, authorization: `Bearer ${this.tokens!.access}`, ...init });
    let r = await send();
    if (r.status === 401 && this.tokens.refresh) {
      await this.refresh();
      r = await send();
    }
    if (r.status === 401) {
      this.setTokens(null);
      throw new AnafAuthError('ANAF no longer accepts the sign-in. Connect again.', 401);
    }
    if (r.status === 403) throw new AnafError('ANAF refused access: the certificate used to connect needs SPV rights for this CUI, and the application must be registered for e-Factura.', 403);
    if (r.status === 429) throw new AnafError('ANAF limits how often its services can be called. Wait a little and try again.', 429);
    if (r.status >= 500) throw new AnafError(`ANAF's e-Factura service answered HTTP ${r.status}. Try again later.`, r.status);
    return r;
  }

  /** Uploads an invoice XML for a CUI; returns the upload index. */
  async upload(xml: string, cif: string, opts: { extern?: boolean; selfBilled?: boolean } = {}): Promise<UploadReceipt> {
    const id = anafCui(cif);
    if (!id) throw new AnafError(`Not a valid CUI: ${cif}`);
    const q = new URLSearchParams({ standard: uploadStandard(xml), cif: id });
    if (opts.extern) q.set('extern', 'DA');
    if (opts.selfBilled) q.set('autofactura', 'DA');
    const r = await this.call(`upload?${q.toString()}`, { method: 'POST', body: xml, contentType: 'text/plain', accept: 'application/xml, application/json' });
    return parseUploadReply(r.status, r.body);
  }

  async status(index: string): Promise<UploadStatus> {
    const r = await this.call(`stareMesaj?id_incarcare=${encodeURIComponent(index)}`, { method: 'GET', accept: 'application/xml, application/json' });
    return parseStatusReply(r.status, r.body);
  }

  /** Messages of the last 1–60 days for a CUI. */
  async messages(cif: string, days: number, filter?: 'E' | 'T' | 'P' | 'R'): Promise<SpvMessage[]> {
    const id = anafCui(cif);
    if (!id) throw new AnafError(`Not a valid CUI: ${cif}`);
    const q = new URLSearchParams({ zile: String(Math.min(60, Math.max(1, Math.round(days)))), cif: id });
    if (filter) q.set('filtru', filter);
    const r = await this.call(`listaMesajeFactura?${q.toString()}`, { method: 'GET' });
    return parseMessageList(r.status, r.body);
  }

  /** The ZIP of a message (the invoice or the error report, with ANAF's signature). */
  async download(id: string): Promise<Uint8Array> {
    const r = await this.call(`descarcare?id=${encodeURIComponent(id)}`, { method: 'GET', accept: 'application/zip, application/json', binary: true });
    const bytes = r.bytes ?? new TextEncoder().encode(r.body);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;
    const v = obj(parseJson(r.body || new TextDecoder().decode(bytes)));
    throw new AnafError(text(v.eroare) ? `ANAF answered: ${text(v.eroare)}` : `ANAF's download answered HTTP ${r.status}.`, r.status);
  }
}

/**
 * Asks for the status until ANAF has processed the upload (ok / nok /
 * rejected), every `intervalMs` up to `maxMs`; returns the last status.
 */
export async function pollUpload(
  client: Pick<AnafClient, 'status'>,
  index: string,
  opts: { intervalMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal; onStatus?: (s: UploadStatus) => void } = {},
): Promise<UploadStatus> {
  const interval = opts.intervalMs ?? 30_000;
  const max = opts.maxMs ?? 10 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    const s = await client.status(index);
    opts.onStatus?.(s);
    if (s.state !== 'processing' && s.state !== 'unknown') return s;
    if (opts.signal?.aborted || now() - start + interval > max) return s;
    await sleep(interval);
    if (opts.signal?.aborted) return s;
  }
}

// ---------------------------------------------------------------- upload log

export interface UploadRecord {
  /** ISO time of the upload. */
  at: string;
  cif: string;
  number: string;
  standard: string;
  index: string;
  test: boolean;
  state: UploadState | 'sent';
  downloadId: string;
  errors: string[];
}

export function readUploadLog(json: string): UploadRecord[] {
  const v = parseJson(json);
  return arr(obj(v).uploads)
    .map((u) => obj(u))
    .filter((u) => text(u.index))
    .map((u) => ({
      at: text(u.at),
      cif: text(u.cif),
      number: text(u.number),
      standard: text(u.standard),
      index: text(u.index),
      test: u.test === true,
      state: (text(u.state) || 'sent') as UploadRecord['state'],
      downloadId: text(u.downloadId),
      errors: arr(u.errors).map(text).filter(Boolean),
    }));
}

/** Adds or updates an upload (newest first, at most 1000 kept). */
export function upsertUpload(log: UploadRecord[], rec: UploadRecord): UploadRecord[] {
  const same = (u: UploadRecord) => u.index === rec.index && u.test === rec.test;
  const old = log.find(same);
  return [{ ...old, ...rec }, ...log.filter((u) => !same(u))].slice(0, 1000);
}

/** The CUI an invoice is uploaded for: the seller's (the buyer's for a self-billed invoice, 389). */
export function uploadCif(xml: string): string {
  const root = xmlRoot(xml);
  if (!root) return '';
  const cii = localName(root.name) === 'CrossIndustryInvoice';
  const self = (cii ? descendants(root, 'TypeCode').slice(0, 1) : kids(root).filter((k) => /TypeCode$/.test(localName(k.name)))).some((k) => textOf(k).trim() === '389');
  const partyName = cii ? (self ? 'BuyerTradeParty' : 'SellerTradeParty') : self ? 'AccountingCustomerParty' : 'AccountingSupplierParty';
  const party = descendants(root, partyName)[0];
  const ids = cii ? descendants(party, 'SpecifiedTaxRegistration').map((r) => textOf(descendants(r, 'ID')[0])).concat(descendants(party, 'SpecifiedLegalOrganization').map((o) => textOf(descendants(o, 'ID')[0]))) : descendants(party, 'CompanyID').map(textOf);
  for (const id of ids) {
    const c = anafCui(id.trim());
    if (c) return c;
  }
  return '';
}
