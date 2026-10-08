/**
 * Remote ("cloud") signing through the Cloud Signature Consortium API
 * (CSC v2; v1 where it differs little). The signing key stays in the
 * provider's HSM: Adika builds the PAdES signed attributes, sends their
 * SHA-256 hash to `signatures/signHash` and assembles the CMS itself, so the
 * B-T / B-LT / B-LTA steps work as for any other signer.
 *
 * Service sign-in: OAuth 2.0 authorization code with PKCE (S256) in the
 * system browser, redirected to a one-shot loopback listener. Credential
 * authorization is bound to the hash(es) being signed (several documents
 * share one authorization up to the credential's `multisign`): OAuth with scope
 * "credential" (`hashes` in the request) or `credentials/authorize` with a
 * PIN / OTP. Tokens, SAD, PIN and OTP live only in memory and never appear in
 * error messages.
 *
 * Network access and the browser hand-off are injected (`transport`,
 * `authorize`), so the whole client runs against a mock service in tests.
 */
import forge from 'node-forge';
import { identityFromCertificateDer, pssSha256Params, qcStatementsOf, type ExternalSigner, type KeyAlgorithm } from './digitalSignature';

export interface CscProvider {
  id: string;
  name: string;
  /** Service base URL, e.g. https://host/csc/v2 (https only). */
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  /** OAuth 2.0 server base URL; empty: the one the service announces in `info`. */
  oauthUrl?: string;
  /** Fixed redirect URI registered with the provider (http://127.0.0.1:<port>/<path>); empty: any free port. */
  redirectUri?: string;
}

export interface HttpReply {
  status: number;
  body: string;
}

export type CscTransport = (req: { url: string; method: 'GET' | 'POST'; authorization?: string; contentType?: string; body?: string }) => Promise<HttpReply>;

export interface AuthorizationRedirect {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Starts the loopback listener (on the port of `fixedRedirect` when given),
 * opens the URL `buildUrl(redirectUri)` in the browser and resolves with the
 * redirect's query parameters.
 */
export type CscAuthorizer = (buildUrl: (redirectUri: string) => string, fixedRedirect?: string) => Promise<{ redirectUri: string; result: AuthorizationRedirect }>;

export interface CscInfo {
  specs: string;
  name: string;
  description: string;
  authType: string[];
  oauth2?: string;
  oauth2Issuer?: string;
  methods: string[];
  v1: boolean;
}

export interface CscCredential {
  id: string;
  /** Signer certificate first, then the rest of the chain the provider returned. */
  certificates: forge.pki.Certificate[];
  keyAlgorithm: KeyAlgorithm | 'other';
  /** Signature algorithm OIDs the key supports. */
  keyAlgos: string[];
  keyEnabled: boolean;
  certStatus: string;
  authMode: 'implicit' | 'explicit' | 'oauth2code';
  pin: { label?: string; format?: string; optional: boolean } | null;
  otp: { label?: string; format?: string; online: boolean; optional: boolean } | null;
  scal: string | null;
  /** Signatures one authorization may cover (credentials/info `multisign`; 1 when not announced). */
  multisign: number;
  description: string;
  name: string;
  subject: string;
  issuer: string;
  validFrom: Date | null;
  validTo: Date | null;
  qualified: { compliance: boolean; qscd: boolean };
}

export interface CscSecrets {
  pin?: string;
  otp?: string;
}

export class CscError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CscError';
  }
}

/** The sign-in expired or was refused (HTTP 401): sign in again. */
export class CscAuthError extends CscError {
  constructor(message: string, status?: number, code?: string) {
    super(message, status, code);
    this.name = 'CscAuthError';
  }
}

export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const SIG = {
  sha256WithRsa: '1.2.840.113549.1.1.11',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecPublicKey: '1.2.840.10045.2.1',
};

// ---------------------------------------------------------------- helpers

const bin = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const unbin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
export const toBase64 = (b: Uint8Array) => btoa(bin(b));
export const fromBase64 = (s: string) => unbin(atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')));
export const toBase64Url = (b: Uint8Array) => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function sha256(data: Uint8Array): Uint8Array {
  const md = forge.md.sha256.create();
  md.update(bin(data));
  return unbin(md.digest().getBytes());
}

/** PKCE S256 code challenge of a verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return toBase64Url(sha256(new TextEncoder().encode(verifier)));
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Normalises a provider URL: trimmed, without trailing slashes; https only (http only on the loopback host when allowed). */
export function checkServiceUrl(url: string, allowLoopbackHttp = false): string {
  const u = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new CscError(`Not a valid address: ${url}`);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && loopback && parsed.protocol === 'http:')) {
    throw new CscError('Signing service addresses must start with https://');
  }
  return u;
}

/** A redirect URI must point at this computer (http://127.0.0.1:<port>/<path>). */
export function checkRedirectUri(uri: string): { port: number; path: string } {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw new CscError(`Not a valid address: ${uri}`);
  }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') || !u.port) {
    throw new CscError('The redirect URI must look like http://127.0.0.1:<port>/callback');
  }
  return { port: Number(u.port), path: u.pathname || '/' };
}

function parseJson(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function cnOf(dn: string): string {
  const m = /CN=([^,/]+)/.exec(dn);
  return m ? m[1].trim() : dn;
}

function dnString(cert: forge.pki.Certificate, which: 'subject' | 'issuer'): string {
  return cert[which].attributes.map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value)}`).join(', ');
}

// ---------------------------------------------------------------- credentials

/** Reads a credentials/info answer (v1 or v2 layout). */
export function parseCredential(id: string, info: Record<string, unknown>): CscCredential {
  const key = obj(info.key);
  const cert = obj(info.cert);
  const certs: forge.pki.Certificate[] = [];
  let leafAlg: KeyAlgorithm | 'other' = 'other';
  arr(cert.certificates).forEach((c, i) => {
    if (typeof c !== 'string') return;
    try {
      const parsed = identityFromCertificateDer(fromBase64(c));
      certs.push(parsed.certificate);
      if (i === 0) leafAlg = parsed.keyAlgorithm;
    } catch {
      if (i === 0) leafAlg = 'other';
    }
  });
  const auth = obj(info.auth);
  const objects = arr(auth.objects).map(obj);
  const mode = (str(info.authMode) ?? str(auth.mode) ?? 'explicit').toLowerCase();
  const authMode: CscCredential['authMode'] = mode === 'oauth2code' ? 'oauth2code' : mode === 'implicit' ? 'implicit' : 'explicit';
  // v1: PIN / OTP objects with presence "true" | "false" | "optional"; v2: auth.objects.
  const v1Pin = obj(info.PIN);
  const v1Otp = obj(info.OTP);
  const v2Pin = objects.find((o) => /password|pin/i.test(str(o.type) ?? ''));
  const v2Otp = objects.find((o) => /otp/i.test(str(o.type) ?? ''));
  const presence = (p: Record<string, unknown>) => str(p.presence) ?? (typeof p.presence === 'boolean' ? String(p.presence) : undefined);
  const pin =
    authMode !== 'explicit'
      ? null
      : v2Pin
        ? { label: str(v2Pin.label), format: str(v2Pin.format), optional: false }
        : presence(v1Pin) && presence(v1Pin) !== 'false'
          ? { label: str(v1Pin.label), format: str(v1Pin.format), optional: presence(v1Pin) === 'optional' }
          : null;
  const otpSrc = v2Otp ?? (presence(v1Otp) && presence(v1Otp) !== 'false' ? v1Otp : null);
  const otp =
    authMode !== 'explicit' || !otpSrc
      ? null
      : {
          label: str(otpSrc.label),
          format: str(otpSrc.format),
          online: (str(otpSrc.type) ?? str(otpSrc.generator) ?? '').toLowerCase() === 'online' || (str(otpSrc.generator) ?? '').toLowerCase() === 'online',
          optional: presence(otpSrc) === 'optional',
        };
  const leaf = certs[0];
  const subject = leaf ? dnString(leaf, 'subject') : (str(cert.subjectDN) ?? '');
  const issuer = leaf ? dnString(leaf, 'issuer') : (str(cert.issuerDN) ?? '');
  return {
    id,
    certificates: certs,
    keyAlgorithm: leafAlg,
    keyAlgos: arr(key.algo).filter((a): a is string => typeof a === 'string'),
    keyEnabled: (str(key.status) ?? 'enabled') === 'enabled',
    certStatus: str(cert.status) ?? 'valid',
    authMode,
    pin,
    otp,
    scal: str(info.SCAL) ?? null,
    multisign: Math.max(1, Math.floor(Number(info.multisign) || 1)),
    description: str(info.description) ?? '',
    name: leaf ? cnOf(subject) : id,
    subject,
    issuer,
    validFrom: leaf ? leaf.validity.notBefore : null,
    validTo: leaf ? leaf.validity.notAfter : null,
    qualified: leaf ? qcStatementsOf(leaf) : { compliance: false, qscd: false },
  };
}

/** The signature algorithm to ask for: PKCS#1 v1.5 or ECDSA with SHA-256; RSASSA-PSS when only that is offered. */
export function chooseSignAlgo(cred: Pick<CscCredential, 'keyAlgorithm' | 'keyAlgos'>): { signAlgo: string; signAlgoParams?: string; pss: boolean } {
  const has = (o: string) => cred.keyAlgos.includes(o);
  if (cred.keyAlgorithm === 'rsa') {
    if (has(SIG.sha256WithRsa) || !cred.keyAlgos.length) return { signAlgo: SIG.sha256WithRsa, pss: false };
    if (has(SIG.rsaEncryption)) return { signAlgo: SIG.rsaEncryption, pss: false };
    if (has(SIG.rsaPss)) return { signAlgo: SIG.rsaPss, signAlgoParams: toBase64(pssSha256Params()), pss: true };
    throw new CscError('The signing key offers no supported algorithm (RSA with SHA-256).');
  }
  if (cred.keyAlgorithm === 'ecdsa') {
    if (has(SIG.ecdsaSha256) || !cred.keyAlgos.length) return { signAlgo: SIG.ecdsaSha256, pss: false };
    if (has(SIG.ecPublicKey)) return { signAlgo: SIG.ecPublicKey, pss: false };
    throw new CscError('The signing key offers no supported algorithm (ECDSA with SHA-256).');
  }
  throw new CscError('The certificate of this credential uses an unsupported key type.');
}

// ---------------------------------------------------------------- client

interface Token {
  access: string;
  refresh?: string;
  expiresAt: number;
}

export interface CscClientDeps {
  transport: CscTransport;
  authorize: CscAuthorizer;
  random?: (n: number) => Uint8Array;
  now?: () => number;
  /** Tests only: accept http:// on the loopback host. */
  allowLoopbackHttp?: boolean;
}

export class CscClient {
  info: CscInfo | null = null;
  private service: Token | null = null;
  private endpoints: { authorize: string; token: string } | null = null;
  private readonly base: string;

  constructor(
    readonly provider: CscProvider,
    private readonly deps: CscClientDeps,
  ) {
    this.base = checkServiceUrl(provider.baseUrl, deps.allowLoopbackHttp);
  }

  get signedIn(): boolean {
    return !!this.service && (this.service.expiresAt > this.now() || !!this.service.refresh);
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private random(n: number) {
    return (this.deps.random ?? defaultRandom)(n);
  }

  /** Error message of a failed answer (never includes the request). */
  private failure(r: HttpReply): CscError {
    const data = parseJson(r.body);
    const code = str(data.error);
    const detail = str(data.error_description) ?? str(data.message) ?? code;
    if (r.status === 401) {
      return new CscAuthError(detail ? `Sign in to ${this.provider.name} again: ${detail}` : `Sign in to ${this.provider.name} again: the sign-in has expired.`, r.status, code);
    }
    return new CscError(`${this.provider.name} answered: ${detail ?? `HTTP ${r.status}`}`, r.status, code);
  }

  private async post(url: string, body: unknown, bearer?: string): Promise<Record<string, unknown>> {
    const r = await this.deps.transport({ url, method: 'POST', authorization: bearer ? `Bearer ${bearer}` : undefined, contentType: 'application/json', body: JSON.stringify(body) });
    if (r.status < 200 || r.status >= 300) throw this.failure(r);
    return parseJson(r.body);
  }

  /** POST {base}/info: name, supported methods and the OAuth server. */
  async loadInfo(): Promise<CscInfo> {
    const d = await this.post(`${this.base}/info`, { lang: 'en-US' });
    const specs = str(d.specs) ?? '';
    this.info = {
      specs,
      name: str(d.name) ?? this.provider.name,
      description: str(d.description) ?? '',
      authType: arr(d.authType).filter((a): a is string => typeof a === 'string'),
      oauth2: str(d.oauth2) || undefined,
      oauth2Issuer: str(d.oauth2Issuer) || undefined,
      methods: arr(d.methods).filter((a): a is string => typeof a === 'string'),
      v1: specs.startsWith('1.'),
    };
    return this.info;
  }

  private async ensureInfo(): Promise<CscInfo> {
    return this.info ?? (await this.loadInfo());
  }

  private async oauthEndpoints(): Promise<{ authorize: string; token: string }> {
    if (this.endpoints) return this.endpoints;
    const info = await this.ensureInfo();
    const allow = this.deps.allowLoopbackHttp;
    const base = (this.provider.oauthUrl?.trim() || info.oauth2 || '').replace(/\/+$/, '').replace(/\/oauth2(\/authorize)?$/, '');
    if (base) {
      const b = checkServiceUrl(base, allow);
      this.endpoints = { authorize: `${b}/oauth2/authorize`, token: `${b}/oauth2/token` };
    } else if (info.oauth2Issuer) {
      // RFC 8414 metadata of the announced issuer.
      const issuer = checkServiceUrl(info.oauth2Issuer, allow);
      const r = await this.deps.transport({ url: `${issuer}/.well-known/oauth-authorization-server`, method: 'GET' });
      if (r.status !== 200) throw this.failure(r);
      const m = parseJson(r.body);
      const authorize = str(m.authorization_endpoint);
      const token = str(m.token_endpoint);
      if (!authorize || !token) throw new CscError(`${this.provider.name} does not describe its sign-in server.`);
      this.endpoints = { authorize: checkServiceUrl(authorize, allow), token: checkServiceUrl(token, allow) };
    } else {
      throw new CscError(`${this.provider.name} does not offer sign-in through the browser (OAuth 2.0).`);
    }
    return this.endpoints;
  }

  private async tokenRequest(params: Record<string, string>): Promise<Token> {
    const { token } = await this.oauthEndpoints();
    const info = await this.ensureInfo();
    const all: Record<string, string> = { ...params, client_id: this.provider.clientId };
    if (this.provider.clientSecret) all.client_secret = this.provider.clientSecret;
    // v1 token endpoints take JSON; v2 follows RFC 6749 (form encoded).
    const r = info.v1
      ? await this.deps.transport({ url: token, method: 'POST', contentType: 'application/json', body: JSON.stringify(all) })
      : await this.deps.transport({ url: token, method: 'POST', contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(all).toString() });
    if (r.status < 200 || r.status >= 300) {
      const e = this.failure(r);
      // invalid_grant from the token endpoint: the code or refresh token is no longer usable.
      if (e.code === 'invalid_grant') throw new CscAuthError(`Sign in to ${this.provider.name} again: ${e.message.replace(/^.*?answered: /, '')}`, r.status, e.code);
      throw e;
    }
    const d = parseJson(r.body);
    const access = str(d.access_token);
    if (!access) throw new CscError(`${this.provider.name} sent no access token.`);
    const expiresIn = typeof d.expires_in === 'number' ? d.expires_in : Number(d.expires_in) || 3600;
    return { access, refresh: str(d.refresh_token), expiresAt: this.now() + expiresIn * 1000 };
  }

  /** Authorization code flow with PKCE in the browser; returns the token. */
  private async browserAuthorize(extra: Record<string, string>): Promise<Token> {
    const { authorize } = await this.oauthEndpoints();
    const verifier = toBase64Url(this.random(32));
    const state = toBase64Url(this.random(16));
    const { redirectUri, result } = await this.deps.authorize((redirect) => {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: this.provider.clientId,
        redirect_uri: redirect,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        lang: 'en-US',
        ...extra,
      });
      return `${authorize}?${q.toString()}`;
    }, this.provider.redirectUri?.trim() || undefined);
    if (result.state !== state) throw new CscError('The sign-in answer did not match this request. Try again.');
    if (result.error) {
      const detail = result.errorDescription || result.error;
      if (result.error === 'access_denied') throw new CscAuthError(`Sign-in refused: ${detail}`, undefined, result.error);
      throw new CscError(`${this.provider.name} answered: ${detail}`, undefined, result.error);
    }
    if (!result.code) throw new CscError('The sign-in answer carried no authorization code.');
    return this.tokenRequest({ grant_type: 'authorization_code', code: result.code, redirect_uri: redirectUri, code_verifier: verifier });
  }

  /** Signs in to the service (scope "service"). */
  async signIn(): Promise<void> {
    const info = await this.ensureInfo();
    if (!info.authType.length || info.authType.includes('oauth2code')) {
      this.service = await this.browserAuthorize({ scope: 'service' });
    } else if (info.authType.includes('oauth2client')) {
      this.service = await this.tokenRequest({ grant_type: 'client_credentials', scope: 'service' });
    } else {
      throw new CscError(`${this.provider.name} offers no sign-in method Adika supports (${info.authType.join(', ')}).`);
    }
  }

  /** Forgets the tokens (and revokes them when the service allows it). */
  async signOut(): Promise<void> {
    const t = this.service;
    this.service = null;
    if (t && this.info?.methods.includes('auth/revoke')) {
      try {
        await this.post(`${this.base}/auth/revoke`, { token: t.refresh ?? t.access, token_type_hint: t.refresh ? 'refresh_token' : 'access_token' }, t.access);
      } catch {
        /* the tokens are forgotten anyway */
      }
    }
  }

  private async serviceToken(): Promise<string> {
    const t = this.service;
    if (!t) throw new CscAuthError(`Sign in to ${this.provider.name} first.`);
    if (t.expiresAt - 30_000 > this.now()) return t.access;
    if (t.refresh) {
      try {
        this.service = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
        return this.service.access;
      } catch (e) {
        this.service = null;
        throw e instanceof CscAuthError ? e : new CscAuthError(`Sign in to ${this.provider.name} again: the sign-in has expired.`);
      }
    }
    this.service = null;
    throw new CscAuthError(`Sign in to ${this.provider.name} again: the sign-in has expired.`);
  }

  /** A service call; a 401 refreshes the token once, then asks for a new sign-in. */
  private async serviceCall(method: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await this.serviceToken();
    try {
      return await this.post(`${this.base}/${method}`, body, token);
    } catch (e) {
      if (!(e instanceof CscAuthError)) throw e;
      if (this.service?.refresh) {
        try {
          this.service = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.service.refresh });
          return await this.post(`${this.base}/${method}`, body, this.service.access);
        } catch (e2) {
          this.service = null;
          throw e2;
        }
      }
      this.service = null;
      throw e;
    }
  }

  async credentialInfo(id: string): Promise<CscCredential> {
    const d = await this.serviceCall('credentials/info', { credentialID: id, certificates: 'chain', certInfo: true, authInfo: true, lang: 'en-US' });
    return parseCredential(id, d);
  }

  /** The user's signing credentials with their certificate chains. */
  async listCredentials(): Promise<CscCredential[]> {
    const info = await this.ensureInfo();
    const d = await this.serviceCall('credentials/list', info.v1 ? {} : { credentialInfo: true, certificates: 'chain', certInfo: true, authInfo: true });
    const ids = arr(d.credentialIDs).filter((x): x is string => typeof x === 'string');
    const infos = arr(d.credentialInfos).map(obj);
    const out: CscCredential[] = [];
    for (const id of ids) {
      const known = infos.find((i) => i.credentialID === id);
      out.push(known && obj(known.cert).certificates ? parseCredential(id, known) : await this.credentialInfo(id));
    }
    return out;
  }

  /** Asks the service to send the one-time password (SMS, e-mail, app). */
  async sendOtp(cred: CscCredential): Promise<void> {
    await this.serviceCall('credentials/sendOTP', { credentialID: cred.id });
  }

  /**
   * Authorises signing exactly `hash` (SHA-256): returns the bearer token and
   * the SAD to send with signatures/signHash.
   */
  async authorizeHash(cred: CscCredential, hash: Uint8Array, secrets: CscSecrets = {}): Promise<{ bearer: string; sad?: string }> {
    return this.authorizeHashes(cred, [hash], secrets);
  }

  /**
   * One authorization for exactly these hashes (numSignatures = their count,
   * at most the credential's `multisign`): one PIN / OTP or browser confirmation.
   */
  async authorizeHashes(cred: CscCredential, hashes: Uint8Array[], secrets: CscSecrets = {}): Promise<{ bearer: string; sad?: string }> {
    if (!hashes.length) throw new CscError('Nothing to sign.');
    if (hashes.length > cred.multisign) throw new CscError(`${this.provider.name} allows ${cred.multisign} signature(s) per authorization.`);
    const info = await this.ensureInfo();
    if (cred.authMode === 'oauth2code') {
      const extra: Record<string, string> = {
        scope: 'credential',
        credentialID: cred.id,
        numSignatures: String(hashes.length),
        hashAlgorithmOID: OID_SHA256,
        description: 'Adika PDF Editor',
      };
      const list = hashes.map(toBase64Url).join(',');
      if (info.v1) extra.hash = list;
      else extra.hashes = list;
      const t = await this.browserAuthorize(extra);
      return info.v1 ? { bearer: await this.serviceToken(), sad: t.access } : { bearer: t.access };
    }
    const body: Record<string, unknown> = { credentialID: cred.id, numSignatures: hashes.length };
    if (info.v1) body.hash = hashes.map(toBase64);
    else {
      body.hashes = hashes.map(toBase64);
      body.hashAlgorithmOID = OID_SHA256;
    }
    if (secrets.pin) body.PIN = secrets.pin;
    if (secrets.otp) body.OTP = secrets.otp;
    const d = await this.serviceCall('credentials/authorize', body);
    const sad = str(d.SAD);
    if (!sad) throw new CscError(`${this.provider.name} did not authorise the signature.`);
    return { bearer: await this.serviceToken(), sad };
  }

  /** signatures/signHash for one SHA-256 hash; returns the raw signature value. */
  async signHash(cred: CscCredential, hash: Uint8Array, auth: { bearer: string; sad?: string }): Promise<Uint8Array> {
    return (await this.signHashes(cred, [hash], auth))[0];
  }

  /** signatures/signHash for several authorised hashes in one call; the signatures in the same order. */
  async signHashes(cred: CscCredential, hashes: Uint8Array[], auth: { bearer: string; sad?: string }): Promise<Uint8Array[]> {
    const info = await this.ensureInfo();
    const algo = chooseSignAlgo(cred);
    const list = hashes.map(toBase64);
    const body: Record<string, unknown> = info.v1
      ? { credentialID: cred.id, SAD: auth.sad, hash: list, hashAlgo: OID_SHA256, signAlgo: algo.signAlgo }
      : { credentialID: cred.id, hashes: list, hashAlgorithmOID: OID_SHA256, signAlgo: algo.signAlgo, ...(auth.sad ? { SAD: auth.sad } : {}) };
    if (algo.signAlgoParams) body.signAlgoParams = algo.signAlgoParams;
    let d: Record<string, unknown>;
    try {
      d = await this.post(`${this.base}/signatures/signHash`, body, auth.bearer);
    } catch (e) {
      if (e instanceof CscAuthError && auth.bearer === this.service?.access) this.service = null;
      throw e;
    }
    const sigs = arr(d.signatures).map(str);
    if (sigs.length !== hashes.length || sigs.some((x) => !x)) throw new CscError(`${this.provider.name} returned no signature.`);
    return sigs.map((x) => fromBase64(x!));
  }

  /**
   * Signing many documents: up to `multisign` hashes share one authorization
   * (one PIN / OTP or browser confirmation). Round 0 uses `secrets`; a later
   * round asks `moreSecrets` (a one-time code is used up by each authorization).
   */
  batchSigner(
    cred: CscCredential,
    secrets: CscSecrets,
    moreSecrets?: (round: number) => Promise<CscSecrets | null>,
    onAuthorize?: (mode: CscCredential['authMode'], count: number) => void,
  ): Omit<ExternalSigner, 'sign'> & { groupSize: number; signAll(signedAttrs: Uint8Array[]): Promise<Uint8Array[]> } {
    const base = this.signer(cred, secrets);
    let round = 0;
    return {
      certificate: base.certificate,
      chain: base.chain,
      keyAlgorithm: base.keyAlgorithm,
      rsaPss: base.rsaPss,
      groupSize: Math.min(cred.multisign, 50),
      signAll: async (signedAttrs) => {
        const hashes = signedAttrs.map(sha256);
        let s = secrets;
        if (round > 0 && cred.otp && !cred.otp.optional) {
          const more = await moreSecrets?.(round);
          if (!more) throw new CscError('Signing stopped: no one-time code for the next files.');
          s = { pin: more.pin ?? secrets.pin, otp: more.otp };
        }
        round++;
        onAuthorize?.(cred.authMode, hashes.length);
        const auth = await this.authorizeHashes(cred, hashes, s);
        return this.signHashes(cred, hashes, auth);
      },
    };
  }

  /**
   * An ExternalSigner for `signPdf`: hashes the signed attributes, authorises
   * that hash (browser or PIN / OTP) and has the service sign it.
   */
  signer(cred: CscCredential, secrets: CscSecrets = {}, onAuthorize?: (mode: CscCredential['authMode']) => void): ExternalSigner {
    if (cred.keyAlgorithm === 'other' || !cred.certificates.length) throw new CscError('The certificate of this credential uses an unsupported key type.');
    if (!cred.keyEnabled) throw new CscError('This signing key is disabled at the provider.');
    const { pss } = chooseSignAlgo(cred);
    return {
      certificate: cred.certificates[0],
      chain: cred.certificates.slice(1),
      keyAlgorithm: cred.keyAlgorithm,
      rsaPss: pss,
      sign: async (signedAttrs) => {
        const hash = sha256(signedAttrs);
        onAuthorize?.(cred.authMode);
        const auth = await this.authorizeHash(cred, hash, secrets);
        return this.signHash(cred, hash, auth);
      },
    };
  }
}
