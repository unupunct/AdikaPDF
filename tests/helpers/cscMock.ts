/**
 * A mock Cloud Signature Consortium (CSC v2) service for the remote signing
 * tests: info, OAuth 2.0 (authorize page simulated, token endpoint with PKCE
 * and refresh tokens), credentials/list|info|authorize|sendOTP and
 * signatures/signHash, backed by test keys under a test CA chain:
 *   rsa-qes: RSA, explicit authorization (PIN + online OTP), QcStatements
 *   ec-oauth: ECDSA P-256 (hand-made certificate), OAuth credential authorization
 *   rsa-pss: RSA offering only RSASSA-PSS, implicit authorization
 * Everything is in memory; the transport never touches the network.
 */
import forge from 'node-forge';
import type { AuthorizationRedirect, CscAuthorizer, CscTransport, HttpReply } from '@/lib/crypto/csc';
import { pkceChallenge } from '@/lib/crypto/csc';
import { certificateToDer, identityFromCertificateDer } from '@/lib/crypto/digitalSignature';
import { bin, der, int, issue, oid, toDer, unbin, utc, rsaSign, type TestCa } from './sigPki';

export const MOCK_BASE = 'https://qtsp.mock/csc/v2';
export const MOCK_OAUTH = 'https://qtsp.mock/oauth';
export const CLIENT_ID = 'adika-test-client';
export const CLIENT_SECRET = 'not-a-real-secret';
export const PIN = '1234';

// ---------------------------------------------------------------- P-256 (hash signing for the mock HSM)

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: [bigint, bigint] = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function pow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}
const inv = (a: bigint, m: bigint) => pow(a, m - 2n, m);
type Pt = [bigint, bigint] | null;
function add(p: Pt, q: Pt): Pt {
  if (!p) return q;
  if (!q) return p;
  if (p[0] === q[0] && mod(p[1] + q[1], P) === 0n) return null;
  const l = p[0] === q[0] ? mod(3n * p[0] * p[0] - 3n, P) * inv(2n * p[1], P) : mod(q[1] - p[1], P) * inv(mod(q[0] - p[0], P), P);
  const x = mod(l * l - p[0] - q[0], P);
  return [x, mod(l * (p[0] - x) - p[1], P)];
}
function mul(k: bigint, p: Pt): Pt {
  let r: Pt = null;
  for (let a = p; k > 0n; k >>= 1n, a = add(a, a)) if (k & 1n) r = add(r, a);
  return r;
}
const big = (b: Uint8Array) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const be = (v: bigint, n: number) => new Uint8Array(Buffer.from(v.toString(16).padStart(n * 2, '0'), 'hex'));
const randScalar = () => mod(big(new Uint8Array(Buffer.from(forge.random.getBytesSync(40), 'binary'))), N - 1n) + 1n;

export interface EcKey {
  d: bigint;
  spki: Uint8Array;
}
export function ecKey(): EcKey {
  const d = randScalar();
  const q = mul(d, G)!;
  const point = new Uint8Array([0, 4, ...be(q[0], 32), ...be(q[1], 32)]);
  return { d, spki: der(0x30, der(0x30, oid('1.2.840.10045.2.1'), oid('1.2.840.10045.3.1.7')), der(0x03, point)) };
}
/** ECDSA over a precomputed SHA-256 hash; DER (as CSC returns it) or raw r||s. */
export function ecSignHash(key: EcKey, hash: Uint8Array, raw = false): Uint8Array {
  const e = big(hash);
  for (;;) {
    const k = randScalar();
    const r = mod(mul(k, G)![0], N);
    const s = mod(inv(k, N) * (e + r * key.d), N);
    if (r === 0n || s === 0n) continue;
    return raw ? new Uint8Array([...be(r, 32), ...be(s, 32)]) : der(0x30, int(stripZeros(be(r, 32))), int(stripZeros(be(s, 32))));
  }
}
const stripZeros = (b: Uint8Array) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

// ---------------------------------------------------------------- RSA over a hash

function sha256(...parts: Uint8Array[]): Uint8Array {
  const md = forge.md.sha256.create();
  for (const p of parts) md.update(bin(p));
  return unbin(md.digest().getBytes());
}

function rsaPkcs1Hash(key: forge.pki.rsa.PrivateKey, hash: Uint8Array): Uint8Array {
  const fakeMd = { algorithm: 'sha256', digest: () => forge.util.createBuffer(bin(hash)) } as unknown as forge.md.MessageDigest;
  return unbin(key.sign(fakeMd));
}

/** RSASSA-PSS (SHA-256, MGF1-SHA-256, 32-byte salt) over a hash. */
function rsaPssHash(key: forge.pki.rsa.PrivateKey, hash: Uint8Array): Uint8Array {
  const modBits = key.n.bitLength();
  const emBits = modBits - 1;
  const emLen = Math.ceil(emBits / 8);
  const salt = unbin(forge.random.getBytesSync(32));
  const h = sha256(new Uint8Array(8), hash, salt);
  const db = new Uint8Array(emLen - 32 - 1);
  db[db.length - 32 - 1] = 1;
  db.set(salt, db.length - 32);
  const mask = new Uint8Array(db.length);
  for (let c = 0, off = 0; off < mask.length; c++, off += 32) {
    const block = sha256(h, new Uint8Array([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]));
    mask.set(block.subarray(0, Math.min(32, mask.length - off)), off);
  }
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >>> (8 * emLen - emBits);
  const em = new Uint8Array([...db, ...h, 0xbc]);
  const m = new forge.jsbn.BigInteger(Buffer.from(em).toString('hex'), 16);
  const k = Math.ceil(modBits / 8);
  return new Uint8Array(Buffer.from(m.modPow(key.d, key.n).toString(16).padStart(k * 2, '0'), 'hex'));
}

// ---------------------------------------------------------------- PKI

export interface MockPki {
  root: TestCa;
  inter: TestCa;
  rsaLeaf: TestCa;
  pssLeaf: TestCa;
  ecCertDer: Uint8Array;
  ec: EcKey;
}

const QC = { id: '1.3.6.1.5.5.7.1.3', value: bin(der(0x30, der(0x30, oid('0.4.0.1862.1.1')), der(0x30, oid('0.4.0.1862.1.4')))) };

export async function mockPki(): Promise<MockPki> {
  const root = await issue({ cn: 'Mock QTSP Root CA', ca: true, bits: 1024 });
  const inter = await issue({ cn: 'Mock QTSP Qualified CA', ca: true, issuer: root, bits: 1024 });
  const rsaLeaf = await issue({ cn: 'Maria Popescu', issuer: inter, extensions: [QC] });
  const pssLeaf = await issue({ cn: 'Ion Pss', issuer: inter, bits: 1024 });
  const ec = ecKey();
  // ECDSA end-entity certificate signed by the RSA intermediate (forge cannot create EC certificates).
  const sigAlg = der(0x30, oid('1.2.840.113549.1.1.11'), new Uint8Array([5, 0]));
  const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, new Uint8Array(Buffer.from('Elena Ec', 'utf8'))))));
  const issuerName = toDer(forge.pki.distinguishedNameToAsn1(inter.cert.subject));
  const ku = der(0x30, oid('2.5.29.15'), der(0x01, new Uint8Array([0xff])), der(0x04, der(0x03, new Uint8Array([6, 0xc0]))));
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, new Uint8Array([2]))),
    der(0x02, new Uint8Array([0x0e, 0xc1])),
    sigAlg,
    issuerName,
    der(0x30, utc(new Date(Date.now() - 86400_000)), utc(new Date(Date.now() + 365 * 86400_000))),
    name,
    ec.spki,
    der(0xa3, der(0x30, ku, der(0x30, oid(QC.id), der(0x04, unbin(QC.value))))),
  );
  const ecCertDer = der(0x30, tbs, sigAlg, der(0x03, new Uint8Array([0]), rsaSign(inter.key, tbs)));
  identityFromCertificateDer(ecCertDer); // must parse
  return { root, inter, rsaLeaf, pssLeaf, ecCertDer, ec };
}

// ---------------------------------------------------------------- service

interface Grant {
  scope: 'service' | 'credential';
  credentialID?: string;
  hashes?: string[];
  challenge: string;
  redirectUri: string;
  clientId: string;
}

interface AccessToken {
  scope: 'service' | 'credential';
  credentialID?: string;
  hashes?: string[];
  expires: number;
  used?: boolean;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64url = (s: string) => Buffer.from(s, 'base64').toString('base64url');

export class MockCsc {
  readonly log: { url: string; auth?: string; body?: string }[] = [];
  /** Authorize page: approve (default) or deny; tamper the state. */
  userAction: 'approve' | 'deny' = 'approve';
  tamperState = false;
  /** Return ECDSA signatures as raw r||s instead of DER. */
  ecdsaRaw = false;
  /** Version announced by info. */
  specs = '2.0.0.2';
  otpSent: string | null = null;
  issueRefreshTokens = true;
  private codes = new Map<string, Grant>();
  private tokens = new Map<string, AccessToken>();
  private refresh = new Map<string, true>();
  private sads = new Map<string, { credentialID: string; hashes: string[]; left: number }>();
  private seq = 0;

  constructor(private readonly pki: MockPki) {}

  private id(prefix: string) {
    return `${prefix}-${++this.seq}-${Buffer.from(forge.random.getBytesSync(8), 'binary').toString('hex')}`;
  }

  /** Every access token expires now (refresh tokens stay). */
  expireAccessTokens() {
    for (const t of this.tokens.values()) t.expires = 0;
  }
  revokeRefreshTokens() {
    this.refresh.clear();
  }

  private credentialInfo(id: string): Record<string, unknown> {
    const { pki } = this;
    const chain = [b64(certDer(pki.inter.cert)), b64(certDer(pki.root.cert))];
    const cert = (leaf: Uint8Array) => ({ status: 'valid', certificates: [b64(leaf), ...chain], issuerDN: 'CN=Mock QTSP Qualified CA', subjectDN: 'x', validFrom: '20250101000000Z', validTo: '20300101000000Z' });
    if (id === 'rsa-qes')
      return {
        credentialID: id,
        description: 'Qualified signature',
        key: { status: 'enabled', algo: ['1.2.840.113549.1.1.11', '1.2.840.113549.1.1.1'], len: 2048 },
        cert: cert(certDer(pki.rsaLeaf.cert)),
        auth: { mode: 'explicit', expression: 'PIN AND OTP', objects: [{ type: 'Password', id: 'PIN', format: 'N', label: 'PIN' }, { type: 'OTP', id: 'OTP', format: 'N', label: 'SMS code', generator: 'online' }] },
        SCAL: '2',
        multisign: 1,
      };
    if (id === 'ec-oauth')
      return { credentialID: id, key: { status: 'enabled', algo: ['1.2.840.10045.4.3.2'], len: 256, curve: '1.2.840.10045.3.1.7' }, cert: cert(pki.ecCertDer), auth: { mode: 'oauth2code' }, SCAL: '2', multisign: 1 };
    if (id === 'rsa-pss') return { credentialID: id, key: { status: 'enabled', algo: ['1.2.840.113549.1.1.10'], len: 1024 }, cert: cert(certDer(pki.pssLeaf.cert)), auth: { mode: 'implicit' }, SCAL: '1', multisign: 1 };
    throw new Error('unknown credential');
  }

  /** The user's browser: shows the authorize page and follows the redirect. */
  authorizer: CscAuthorizer = async (buildUrl, fixed) => {
    const redirectUri = fixed ?? 'http://127.0.0.1:49152/callback';
    const url = new URL(buildUrl(redirectUri));
    const q = url.searchParams;
    const result: AuthorizationRedirect = { state: this.tamperState ? 'forged-state' : (q.get('state') ?? undefined) };
    if (url.origin + url.pathname !== `${MOCK_OAUTH}/oauth2/authorize`) return { redirectUri, result: { ...result, error: 'invalid_request', errorDescription: 'wrong endpoint' } };
    if (q.get('client_id') !== CLIENT_ID || q.get('redirect_uri') !== redirectUri || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || q.get('response_type') !== 'code') {
      return { redirectUri, result: { ...result, error: 'invalid_request', errorDescription: 'bad authorization request' } };
    }
    if (this.userAction === 'deny') return { redirectUri, result: { ...result, error: 'access_denied', errorDescription: 'The user cancelled' } };
    const scope = q.get('scope') as Grant['scope'];
    const code = this.id('code');
    const hashes = q.get('hashes')?.split(',');
    if (scope === 'credential' && (!q.get('credentialID') || !hashes?.length || q.get('numSignatures') !== String(hashes.length))) {
      return { redirectUri, result: { ...result, error: 'invalid_request', errorDescription: 'credential scope needs credentialID, numSignatures and hashes' } };
    }
    this.codes.set(code, { scope, credentialID: q.get('credentialID') ?? undefined, hashes, challenge: q.get('code_challenge')!, redirectUri, clientId: CLIENT_ID });
    return { redirectUri, result: { ...result, code } };
  };

  transport: CscTransport = async (req) => {
    this.log.push({ url: req.url, auth: req.authorization, body: req.body });
    try {
      if (req.url === `${MOCK_OAUTH}/oauth2/token`) return this.token(req.contentType, req.body ?? '');
      if (!req.url.startsWith(MOCK_BASE + '/')) return reply(404, { error: 'not_found' });
      const method = req.url.slice(MOCK_BASE.length + 1);
      const body = JSON.parse(req.body || '{}') as Record<string, unknown>;
      if (method === 'info') return reply(200, { specs: this.specs, name: 'Mock QTSP', description: 'Test service', authType: ['oauth2code'], oauth2: MOCK_OAUTH, methods: ['credentials/list', 'credentials/info', 'credentials/authorize', 'credentials/sendOTP', 'signatures/signHash', 'auth/revoke'] });
      const bearer = /^Bearer (.+)$/.exec(req.authorization ?? '')?.[1];
      const tok = bearer ? this.tokens.get(bearer) : undefined;
      if (!tok || tok.expires < Date.now()) return reply(401, { error: 'invalid_token', error_description: 'The access token is not valid' });
      switch (method) {
        case 'auth/revoke':
          this.tokens.delete(bearer!);
          return reply(204, null);
        case 'credentials/list': {
          if (tok.scope !== 'service') return reply(401, { error: 'invalid_token' });
          const ids = ['rsa-qes', 'ec-oauth', 'rsa-pss'];
          return reply(200, body.credentialInfo ? { credentialIDs: ids, credentialInfos: ids.map((i) => this.credentialInfo(i)) } : { credentialIDs: ids });
        }
        case 'credentials/info':
          return reply(200, this.credentialInfo(String(body.credentialID)));
        case 'credentials/sendOTP':
          this.otpSent = String(100000 + Math.floor(Math.random() * 899999));
          return reply(204, null);
        case 'credentials/authorize': {
          const id = String(body.credentialID);
          const hashes = body.hashes as string[] | undefined;
          if (!hashes?.length || body.numSignatures !== hashes.length || body.hashAlgorithmOID !== '2.16.840.1.101.3.4.2.1') return reply(400, { error: 'invalid_request', error_description: 'Missing hashes' });
          if (id === 'rsa-qes') {
            if (body.PIN !== PIN) return reply(400, { error: 'invalid_pin', error_description: 'The PIN is not correct' });
            if (!this.otpSent || body.OTP !== this.otpSent) return reply(400, { error: 'invalid_otp', error_description: 'The OTP is not correct' });
            this.otpSent = null;
          } else if (id !== 'rsa-pss') return reply(400, { error: 'invalid_request', error_description: 'This credential is authorised with OAuth' });
          const sad = this.id('sad');
          this.sads.set(sad, { credentialID: id, hashes, left: hashes.length });
          return reply(200, { SAD: sad, expiresIn: 300 });
        }
        case 'signatures/signHash':
          return this.signHash(tok, body);
        default:
          return reply(404, { error: 'invalid_request', error_description: `Unknown method ${method}` });
      }
    } catch (e) {
      return reply(400, { error: 'invalid_request', error_description: String(e) });
    }
  };

  private token(contentType: string | undefined, raw: string): HttpReply {
    const f = contentType?.startsWith('application/json') ? new URLSearchParams(JSON.parse(raw) as Record<string, string>) : new URLSearchParams(raw);
    if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return reply(401, { error: 'invalid_client', error_description: 'Unknown client' });
    let grant: Pick<Grant, 'scope' | 'credentialID' | 'hashes'>;
    if (f.get('grant_type') === 'authorization_code') {
      const code = f.get('code')!;
      const g = this.codes.get(code);
      this.codes.delete(code);
      if (!g) return reply(400, { error: 'invalid_grant', error_description: 'Unknown or used code' });
      if (g.redirectUri !== f.get('redirect_uri')) return reply(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (pkceChallenge(f.get('code_verifier') ?? '') !== g.challenge) return reply(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      grant = g;
    } else if (f.get('grant_type') === 'refresh_token') {
      if (!this.refresh.has(f.get('refresh_token') ?? '')) return reply(400, { error: 'invalid_grant', error_description: 'Refresh token expired' });
      grant = { scope: 'service' };
    } else return reply(400, { error: 'unsupported_grant_type' });
    const access = this.id('at');
    this.tokens.set(access, { scope: grant.scope, credentialID: grant.credentialID, hashes: grant.hashes, expires: Date.now() + 3600_000 });
    const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: 3600 };
    if (grant.scope === 'service' && this.issueRefreshTokens) {
      const r = this.id('rt');
      this.refresh.set(r, true);
      out.refresh_token = r;
    }
    return reply(200, out);
  }

  private signHash(tok: AccessToken, body: Record<string, unknown>): HttpReply {
    const id = String(body.credentialID);
    const hashes = body.hashes as string[];
    if (!hashes?.length || body.hashAlgorithmOID !== '2.16.840.1.101.3.4.2.1') return reply(400, { error: 'invalid_request', error_description: 'Missing hashes' });
    // Authorization must cover exactly these hashes (SAD or credential-scoped token).
    if (tok.scope === 'credential') {
      if (tok.used || tok.credentialID !== id || hashes.some((h) => !tok.hashes!.includes(b64url(h)))) return reply(400, { error: 'invalid_request', error_description: 'The hash is not the authorised one' });
      tok.used = true;
    } else {
      const sad = this.sads.get(String(body.SAD));
      if (!sad || sad.credentialID !== id || hashes.some((h) => !sad.hashes.includes(h)) || sad.left < hashes.length) return reply(400, { error: 'invalid_request', error_description: 'SAD not valid for this hash' });
      sad.left -= hashes.length;
    }
    const algo = String(body.signAlgo);
    const sigs = hashes.map((h) => {
      const hash = new Uint8Array(Buffer.from(h, 'base64'));
      if (id === 'rsa-qes' && (algo === '1.2.840.113549.1.1.11' || algo === '1.2.840.113549.1.1.1')) return rsaPkcs1Hash(this.pki.rsaLeaf.key, hash);
      if (id === 'rsa-pss' && algo === '1.2.840.113549.1.1.10' && body.signAlgoParams) return rsaPssHash(this.pki.pssLeaf.key, hash);
      if (id === 'ec-oauth' && algo === '1.2.840.10045.4.3.2') return ecSignHash(this.pki.ec, hash, this.ecdsaRaw);
      throw new Error(`Algorithm ${algo} not supported by ${id}`);
    });
    return reply(200, { signatures: sigs.map(b64) });
  }
}

const certDer = (c: forge.pki.Certificate) => certificateToDer(c);

function reply(status: number, body: unknown): HttpReply {
  return { status, body: body === null ? '' : JSON.stringify(body) };
}
