import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CscAuthError, CscClient, CscError, checkRedirectUri, checkServiceUrl, chooseSignAlgo, pkceChallenge, sha256, toBase64, type CscProvider } from '@/lib/crypto/csc';
import { signPdf, verifyPdfSignatures } from '@/lib/crypto/digitalSignature';
import { CLIENT_ID, CLIENT_SECRET, MOCK_BASE, MockCsc, PIN, mockPki, type MockPki } from './helpers/cscMock';
import { issue, tsaServer, type TestCa } from './helpers/sigPki';

const provider: CscProvider = { id: 'p1', name: 'Mock QTSP', baseUrl: `${MOCK_BASE}/`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

let pki: MockPki;
let tsa: TestCa;
let pdf: Uint8Array;

beforeAll(async () => {
  pki = await mockPki();
  tsa = await issue({ cn: 'Mock TSA', issuer: pki.root, eku: ['1.3.6.1.5.5.7.3.8'], bits: 1024 });
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText('Contract', { x: 60, y: 760, size: 18, font });
  pdf = await d.save();
}, 120_000);

function setup(o: Partial<CscProvider> = {}) {
  const mock = new MockCsc(pki);
  const client = new CscClient({ ...provider, ...o }, { transport: mock.transport, authorize: mock.authorizer });
  return { mock, client };
}

async function signedIn() {
  const s = setup();
  await s.client.signIn();
  const creds = await s.client.listCredentials();
  return { ...s, creds, cred: (id: string) => creds.find((c) => c.id === id)! };
}

const verify = (b: Uint8Array) => verifyPdfSignatures(b, { trustedRoots: [pki.root.cert] });

describe('CSC client', () => {
  it('PKCE S256 matches RFC 7636 and URLs must be https', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(() => checkServiceUrl('http://qtsp.example/csc/v2')).toThrow(/https/);
    expect(() => checkServiceUrl('http://127.0.0.1:8080/csc/v2')).toThrow(/https/);
    expect(checkServiceUrl('http://127.0.0.1:8080/csc/v2/', true)).toBe('http://127.0.0.1:8080/csc/v2');
    expect(() => new CscClient({ ...provider, baseUrl: 'http://qtsp.mock/csc/v2' }, { transport: async () => ({ status: 200, body: '' }), authorize: async () => ({ redirectUri: '', result: {} }) })).toThrow(CscError);
    expect(checkRedirectUri('http://127.0.0.1:53682/callback')).toEqual({ port: 53682, path: '/callback' });
    expect(() => checkRedirectUri('https://evil.example/callback')).toThrow(/127\.0\.0\.1/);
  });

  it('reads info, signs in with PKCE and lists credentials with chains and QC status', async () => {
    const { client, mock, creds } = await signedIn();
    expect(client.info).toMatchObject({ name: 'Mock QTSP', v1: false, oauth2: 'https://qtsp.mock/oauth' });
    expect(client.signedIn).toBe(true);
    expect(creds.map((c) => c.id)).toEqual(['rsa-qes', 'ec-oauth', 'rsa-pss']);
    const rsa = creds[0];
    expect(rsa).toMatchObject({ name: 'Maria Popescu', keyAlgorithm: 'rsa', authMode: 'explicit', scal: '2', qualified: { compliance: true, qscd: true } });
    expect(rsa.pin).toMatchObject({ label: 'PIN' });
    expect(rsa.otp).toMatchObject({ online: true, label: 'SMS code' });
    expect(rsa.certificates).toHaveLength(3);
    expect(rsa.issuer).toMatch(/Mock QTSP Qualified CA/);
    expect(creds[1]).toMatchObject({ keyAlgorithm: 'ecdsa', authMode: 'oauth2code', pin: null, otp: null, qualified: { compliance: true, qscd: true } });
    expect(creds[2]).toMatchObject({ authMode: 'implicit', qualified: { compliance: false } });
    // The token request was form encoded and carried the PKCE verifier.
    const tokenCall = mock.log.find((l) => l.url.endsWith('/oauth2/token'))!;
    expect(tokenCall.body).toMatch(/grant_type=authorization_code/);
    expect(tokenCall.body).toMatch(/code_verifier=/);
    // Service calls carry the bearer token; nothing else does.
    expect(mock.log.find((l) => l.url.endsWith('/credentials/list'))!.auth).toMatch(/^Bearer at-/);
    expect(mock.log.find((l) => l.url.endsWith('/info'))!.auth).toBeUndefined();
  });

  it('rejects a redirect with a foreign state and maps a refusal', async () => {
    const a = setup();
    a.mock.tamperState = true;
    await expect(a.client.signIn()).rejects.toThrow(/did not match/);
    expect(a.client.signedIn).toBe(false);
    const b = setup();
    b.mock.userAction = 'deny';
    await expect(b.client.signIn()).rejects.toThrow(CscAuthError);
    await expect(b.client.signIn()).rejects.toThrow(/The user cancelled/);
  });

  it('a wrong PKCE verifier is refused by the token endpoint', async () => {
    const mock = new MockCsc(pki);
    const client = new CscClient(provider, {
      authorize: mock.authorizer,
      transport: (req) => mock.transport(req.url.endsWith('/oauth2/token') ? { ...req, body: req.body!.replace(/code_verifier=[^&]+/, 'code_verifier=forged-verifier-forged-verifier-forged-123') } : req),
    });
    const err = await client.signIn().catch((e) => e);
    expect(err).toBeInstanceOf(CscAuthError);
    expect(err.message).toMatch(/PKCE verification failed/);
  });

  it('signs with explicit authorization (PIN + online OTP) and the app verifies the PAdES signature', async () => {
    const { client, mock, cred } = await signedIn();
    const rsa = cred('rsa-qes');
    // Wrong PIN: the provider's message is surfaced.
    await client.sendOtp(rsa);
    const bad = client.signer(rsa, { pin: '9999', otp: mock.otpSent! });
    await expect(signPdf(pdf, { signer: bad, pageIndex: 0, rect: [0, 0, 0, 0], pades: true })).rejects.toThrow('Mock QTSP answered: The PIN is not correct');

    await client.sendOtp(rsa);
    expect(mock.otpSent).toMatch(/^\d{6}$/);
    const signer = client.signer(rsa, { pin: PIN, otp: mock.otpSent! });
    const out = await signPdf(pdf, { signer, pageIndex: 0, rect: [40, 40, 200, 90], pades: true, tsaUrl: 'https://tsa.mock/', fetchImpl: tsaServer(tsa) });
    const [r] = await verify(out);
    expect(r.integrity).toBe('valid');
    expect(r.signerName).toBe('Maria Popescu');
    expect(r.chainStatus).toBe('trusted');
    expect(r.padesLevel).toBe('B-T');
    expect(r.qualified).toBe('qscd');
    // The PIN went only to credentials/authorize, the OTP was used once.
    const pinCalls = mock.log.filter((l) => l.body?.includes(`"PIN":"${PIN}"`)).map((l) => l.url.slice(MOCK_BASE.length));
    expect(pinCalls).toEqual(['/credentials/authorize']);
    expect(mock.otpSent).toBeNull();
  });

  it('signs with OAuth credential authorization bound to the hash (ECDSA, DER and raw r||s)', async () => {
    const { client, mock, cred } = await signedIn();
    const ec = cred('ec-oauth');
    const modes: string[] = [];
    const out = await signPdf(pdf, { signer: client.signer(ec, {}, (m) => modes.push(m)), pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
    expect(modes).toEqual(['oauth2code']);
    const [r] = await verify(out);
    expect(r.integrity).toBe('valid');
    expect(r.signerName).toBe('Elena Ec');
    expect(r.algorithm).toMatch(/ECDSA P-256/);
    expect(r.chainStatus).toBe('trusted');
    expect(r.padesLevel).toBe('B-B');
    // The credential token, not the service token, authorised signHash.
    const sh = mock.log.filter((l) => l.url.endsWith('/signatures/signHash')).at(-1)!;
    const service = mock.log.find((l) => l.url.endsWith('/credentials/list'))!.auth;
    expect(sh.auth).not.toBe(service);
    expect(JSON.parse(sh.body!)).not.toHaveProperty('SAD');

    mock.ecdsaRaw = true;
    const raw = await signPdf(pdf, { signer: client.signer(ec), pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
    expect((await verify(raw))[0].integrity).toBe('valid');
  });

  it('a SAD or credential token only signs the hash it was issued for', async () => {
    const { client, cred } = await signedIn();
    const pss = cred('rsa-pss');
    const h1 = sha256(new Uint8Array([1]));
    const h2 = sha256(new Uint8Array([2]));
    const auth = await client.authorizeHash(pss, h1);
    await expect(client.signHash(pss, h2, auth)).rejects.toThrow(/SAD not valid for this hash/);
    expect((await client.signHash(pss, h1, auth)).length).toBe(128);
    const ec = cred('ec-oauth');
    const t = await client.authorizeHash(ec, h1);
    await expect(client.signHash(ec, h2, t)).rejects.toThrow(/not the authorised one/);
  });

  it('RSASSA-PSS when the key offers only PSS (implicit authorization)', async () => {
    const { client, cred } = await signedIn();
    const pss = cred('rsa-pss');
    expect(chooseSignAlgo(pss)).toMatchObject({ signAlgo: '1.2.840.113549.1.1.10', pss: true });
    const out = await signPdf(pdf, { signer: client.signer(pss), pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
    const [r] = await verify(out);
    expect(r.integrity).toBe('valid');
    expect(r.signerName).toBe('Ion Pss');
    // A tampered file fails.
    const bad = out.slice();
    bad[40] ^= 1;
    expect((await verify(bad))[0].integrity).toBe('invalid');
  });

  it('401: refreshes the token once, then asks to sign in again', async () => {
    const { client, mock } = await signedIn();
    mock.expireAccessTokens();
    expect((await client.listCredentials()).length).toBe(3);
    expect(mock.log.filter((l) => l.body?.includes('grant_type=refresh_token')).length).toBe(1);
    mock.expireAccessTokens();
    mock.revokeRefreshTokens();
    const err = await client.listCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(CscAuthError);
    expect(err.message).toMatch(/^Sign in to Mock QTSP again/);
    expect(client.signedIn).toBe(false);
    await expect(client.listCredentials()).rejects.toThrow(/Sign in to Mock QTSP first/);
  });

  it('no refresh token: a 401 means sign in again; provider errors are surfaced; secrets never in messages', async () => {
    const mock = new MockCsc(pki);
    mock.issueRefreshTokens = false;
    const client = new CscClient(provider, { transport: mock.transport, authorize: mock.authorizer });
    await client.signIn();
    const [rsa] = await client.listCredentials();
    const e1 = await client.authorizeHash(rsa, sha256(new Uint8Array([3])), { pin: PIN, otp: '000000' }).catch((e) => e);
    expect(e1).toBeInstanceOf(CscError);
    expect(e1.message).toBe('Mock QTSP answered: The OTP is not correct');
    expect(e1.message).not.toContain(PIN);
    mock.expireAccessTokens();
    await expect(client.listCredentials()).rejects.toBeInstanceOf(CscAuthError);
    expect(client.signedIn).toBe(false);
  });

  it('wrong client secret: the token endpoint error is shown', async () => {
    const { client } = setup({ clientSecret: 'wrong' });
    await expect(client.signIn()).rejects.toThrow(/Unknown client/);
  });

  it('a fixed redirect URI is used as registered', async () => {
    const mock = new MockCsc(pki);
    let seen = '';
    const client = new CscClient(
      { ...provider, redirectUri: 'http://127.0.0.1:53682/callback' },
      {
        transport: mock.transport,
        authorize: (build, fixed) => {
          seen = fixed ?? '';
          return mock.authorizer(build, fixed);
        },
      },
    );
    await client.signIn();
    expect(seen).toBe('http://127.0.0.1:53682/callback');
    expect(mock.log.find((l) => l.url.endsWith('/oauth2/token'))!.body).toContain(encodeURIComponent('http://127.0.0.1:53682/callback'));
  });

  it('sign out revokes the token', async () => {
    const { client, mock } = await signedIn();
    await client.signOut();
    expect(client.signedIn).toBe(false);
    expect(mock.log.at(-1)!.url).toBe(`${MOCK_BASE}/auth/revoke`);
    expect(toBase64(new Uint8Array([251, 255]))).toBe('+/8=');
  });
});
