import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  buildOcspRequest,
  buildTimeStampRequest,
  certificateToDer,
  createSelfSignedIdentity,
  exportP12,
  generateRsaKey,
  identityFromCertificateDer,
  insertTimestampToken,
  loadP12,
  signPdf,
  signerSignatureValue,
  verifyPdfSignatures,
  type ExternalSigner,
  type SigningIdentity,
  type VerifyOptions,
} from '../src/lib/crypto/digitalSignature';

// 1x1 red PNG.
const PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'),
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Validation incl. the optional verify-tool fields. */
type V = Awaited<ReturnType<typeof verifyPdfSignatures>>[number] & {
  chainStatus?: string;
  chainDetails?: string[];
  revocationStatus?: string;
  revocationDetails?: string;
  modifiedAfterSigning?: boolean;
  algorithm?: string;
};
const verify = async (b: Uint8Array, o?: VerifyOptions) => (await verifyPdfSignatures(b, o)) as V[];

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([400, 300]);
  p.drawText('Contract to be signed', { x: 40, y: 220, size: 18, font, color: rgb(0, 0, 0) });
  doc.addPage([400, 300]).drawText('Page two', { x: 40, y: 220, size: 18, font });
  return doc.save();
}

const bin = (b: Uint8Array) => Buffer.from(b).toString('binary');
const unbin = (s: string) => new Uint8Array(Buffer.from(s, 'binary'));

/** Tiny DER writer for hand-built test structures. */
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...len]), body]));
}
const oid = (o: string) => der(0x06, unbin(forge.asn1.oidToDer(o).getBytes()));
const NULL = new Uint8Array([5, 0]);
const int = (b: Uint8Array) => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const utc = (d: Date) => der(0x17, unbin(forge.asn1.dateToUtcTime(d)));
const gen = (d: Date) => der(0x18, unbin(forge.asn1.dateToGeneralizedTime(d)));
const toDer = (a: forge.asn1.Asn1) => unbin(forge.asn1.toDer(a).getBytes());
const sha256RsaAlg = der(0x30, oid('1.2.840.113549.1.1.11'), NULL);

function rsaSign(key: forge.pki.rsa.PrivateKey, data: Uint8Array): Uint8Array {
  const md = forge.md.sha256.create();
  md.update(bin(data));
  return unbin(key.sign(md));
}

interface TestCa {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

let serialCounter = 0x1000;

/** Issue a certificate with forge; returns the DER-parsed certificate. */
async function issue(opts: {
  cn: string;
  issuer?: TestCa;
  ca?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  ocspUrl?: string;
  crlUrl?: string;
}): Promise<TestCa> {
  const key = await generateRsaKey();
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  c.serialNumber = (serialCounter++).toString(16).padStart(6, '0');
  c.validity.notBefore = opts.notBefore ?? new Date(Date.now() - 86400_000);
  c.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 86400_000);
  const subject = [{ name: 'commonName', value: opts.cn }, { name: 'organizationName', value: 'Adika Test PKI' }];
  c.setSubject(subject);
  c.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
  const ext: object[] = [
    { name: 'basicConstraints', cA: !!opts.ca, critical: true },
    { name: 'keyUsage', critical: true, ...(opts.ca ? { keyCertSign: true, cRLSign: true } : { digitalSignature: true, nonRepudiation: true }) },
  ];
  if (opts.ocspUrl) {
    ext.push({ id: '1.3.6.1.5.5.7.1.1', value: bin(der(0x30, der(0x30, oid('1.3.6.1.5.5.7.48.1'), der(0x86, unbin(opts.ocspUrl))))) });
  }
  if (opts.crlUrl) {
    ext.push({ id: '2.5.29.31', value: bin(der(0x30, der(0x30, der(0xa0, der(0xa0, der(0x86, unbin(opts.crlUrl))))))) });
  }
  c.setExtensions(ext);
  c.sign(opts.issuer?.key ?? key, forge.md.sha256.create());
  const parsed = identityFromCertificateDer(toDer(forge.pki.certificateToAsn1(c))).certificate;
  return { cert: parsed, key };
}

function identityOf(leaf: TestCa, chain: forge.pki.Certificate[]): SigningIdentity {
  return {
    name: leaf.cert.subject.getField('CN').value,
    email: null,
    certificate: leaf.cert,
    privateKey: leaf.key,
    chain,
    subject: '',
    issuer: '',
    validFrom: leaf.cert.validity.notBefore,
    validTo: leaf.cert.validity.notAfter,
    selfSigned: false,
  };
}

const serialBytes = (c: forge.pki.Certificate) => unbin(forge.util.hexToBytes(c.serialNumber));

// ---------------------------------------------------------------------------

// Whole seconds (UTCTime precision), after the certificate's notBefore.
const SIGN_TIME = new Date(Math.floor(Date.now() / 1000) * 1000 + 5000);
let pdf: Uint8Array;
let identity: SigningIdentity;
let signed: Uint8Array;
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];

beforeAll(async () => {
  pdf = await makePdf();
  const t0 = Date.now();
  identity = await createSelfSignedIdentity({ name: 'Ștefan Pușcaș', email: 'stefan@example.com', organization: 'Adika', country: 'ro' });
  console.log(`self-signed identity generated in ${Date.now() - t0} ms`);
  signed = await signPdf(pdf, {
    identity,
    pageIndex: 0,
    rect: [250, 30, 380, 80],
    appearancePng: PNG,
    reason: 'I approve this document',
    location: 'București',
    contactInfo: 'stefan@example.com',
    signingTime: SIGN_TIME,
  });
});

afterAll(async () => {
  await Promise.all(tasks.map((t) => t.destroy()));
});

describe('self-signed identity + sign/verify round trip', () => {
  it('creates a usable identity', () => {
    expect(identity.name).toBe('Ștefan Pușcaș');
    expect(identity.email).toBe('stefan@example.com');
    expect(identity.selfSigned).toBe(true);
    expect(identity.subject).toContain('C=RO');
    expect(identity.validTo.getTime()).toBeGreaterThan(Date.now() + 4 * 365 * 86400_000);
  });

  it('verifies as valid, whole file, self-signed', async () => {
    const [r, ...rest] = await verify(signed);
    expect(rest).toHaveLength(0);
    expect(r.fieldName).toBe('Signature1');
    expect(r.integrity).toBe('valid');
    expect(r.coversWholeFile).toBe(true);
    expect(r.modifiedAfterSigning).toBe(false);
    expect(r.selfSigned).toBe(true);
    expect(r.signerName).toBe('Ștefan Pușcaș');
    expect(r.reason).toBe('I approve this document');
    expect(r.signedAt).toBe(SIGN_TIME.toISOString());
    expect(r.hasTimestamp).toBe(false);
    expect(r.chainStatus).toBe('untrusted');
    expect(r.revocationStatus).toBe('not-checked');
    expect(r.algorithm).toBe('RSA-2048 / SHA-256');
    expect(r.certSubject).toContain('CN=Ștefan Pușcaș');
    expect(r.message).toMatch(/not been modified/);
    expect(r.message).toMatch(/self-signed/);
  });

  it('has a correct ByteRange and adbe.pkcs7.detached dictionary', () => {
    const s = Buffer.from(signed).toString('latin1');
    const m = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+) *\]/.exec(s)!;
    const [a, b, c, d] = m.slice(1).map(Number);
    expect(a).toBe(0);
    expect(s[b]).toBe('<');
    expect(s[c - 1]).toBe('>');
    expect(c + d).toBe(signed.length);
    expect(s).toContain('/SubFilter /adbe.pkcs7.detached');
    expect(s).toContain('/SigFlags 3');
  });

  it('detects tampering inside the signed range', async () => {
    const t = signed.slice();
    const i = Buffer.from(t).indexOf('Contract');
    const pos = i >= 0 ? i : 200;
    t[pos] ^= 0x01;
    const [r] = await verify(t);
    expect(r.integrity).toBe('invalid');
    expect(r.message).toMatch(/INVALID/);
  });

  it('tampering with an uncompressed content byte also fails', async () => {
    // Flip a byte in the Producer string region (always inside range 1).
    const t = signed.slice();
    t[20] = t[20] === 0x41 ? 0x42 : 0x41;
    expect((await verify(t))[0].integrity).toBe('invalid');
  });

  it('reports appended data as not covering the whole file', async () => {
    const appended = new Uint8Array(Buffer.concat([Buffer.from(signed), Buffer.from('\n% appended\n1 0 obj\n<<>>\nendobj\n%%EOF\n')]));
    const [r] = await verify(appended);
    expect(r.integrity).toBe('valid');
    expect(r.coversWholeFile).toBe(false);
    expect(r.modifiedAfterSigning).toBe(true);
    expect(r.message).toMatch(/incremental update/);
  });

  it('refuses to re-sign a signed PDF unless allowed, then gives a unique field name', async () => {
    await expect(signPdf(signed, { identity, pageIndex: 0, rect: [0, 0, 0, 0] })).rejects.toThrow(/already has 1 digital signature/);
    const twice = await signPdf(signed, { identity, pageIndex: 1, rect: [0, 0, 0, 0], allowInvalidatingExisting: true });
    const rs = await verify(twice);
    expect(rs.map((r) => r.fieldName).sort()).toEqual(['Signature1', 'Signature2']);
    const byName = Object.fromEntries(rs.map((r) => [r.fieldName, r]));
    expect(byName.Signature2.integrity).toBe('valid');
    expect(byName.Signature1.integrity).toBe('invalid'); // rewritten file broke it
  });

  it('unsigned PDF has no signatures; garbage signature is reported, not thrown', async () => {
    expect(await verify(pdf)).toEqual([]);
    const s = Buffer.from(signed).toString('latin1');
    const b = /\/ByteRange \[0 (\d+)/.exec(s)!;
    const t = signed.slice();
    const start = Number(b[1]) + 1;
    t.set(Buffer.from('3003020100'), start); // tiny bogus DER
    const [r] = await verify(t);
    expect(['unknown', 'invalid']).toContain(r.integrity);
    expect(r.message.length).toBeGreaterThan(0);
  });

  it('pdf.js opens the signed file and sees the signature widget', async () => {
    const task = pdfjs.getDocument({ data: signed.slice(), useWorkerFetch: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 } as Parameters<typeof pdfjs.getDocument>[0]);
    tasks.push(task);
    const doc = await task.promise;
    expect(doc.numPages).toBe(2);
    const annots = await (await doc.getPage(1)).getAnnotations();
    const w = annots.find((a) => a.subtype === 'Widget' && a.fieldType === 'Sig');
    expect(w).toBeTruthy();
    expect(w!.fieldName).toBe('Signature1');
    expect(w!.rect.map(Math.round)).toEqual([250, 30, 380, 80]);
  });
});

describe('PKCS#12', () => {
  it('round-trips through exportP12/loadP12', async () => {
    const p12 = exportP12(identity, 'pa55-word');
    const back = loadP12(p12, 'pa55-word');
    expect(back.name).toBe(identity.name);
    expect(back.certificate.serialNumber).toBe(identity.certificate.serialNumber);
    expect(back.privateKey.n.equals(identity.privateKey.n)).toBe(true);
    const out = await signPdf(pdf, { identity: back, pageIndex: 0, rect: [0, 0, 0, 0] });
    expect((await verify(out))[0].integrity).toBe('valid');
  });

  it('wrong password throws a clear error', () => {
    const p12 = exportP12(identity, 'right');
    expect(() => loadP12(p12, 'wrong')).toThrow(/Wrong password/);
    expect(() => loadP12(new Uint8Array([1, 2, 3]), 'x')).toThrow(/Could not read/);
  });
});

describe('RFC 3161 timestamps', () => {
  it('encodes a TimeStampReq', () => {
    const imprint = new Uint8Array(32).fill(7);
    const req = forge.asn1.fromDer(bin(buildTimeStampRequest(imprint, new Uint8Array([0x12, 0x34]))));
    const v = req.value as forge.asn1.Asn1[];
    expect((v[0].value as string).charCodeAt(0)).toBe(1);
    const mi = v[1].value as forge.asn1.Asn1[];
    expect(forge.asn1.derToOid((mi[0].value as forge.asn1.Asn1[])[0].value as string)).toBe('2.16.840.1.101.3.4.2.1');
    expect(unbin(mi[1].value as string)).toEqual(imprint);
    expect(forge.util.bytesToHex(v[2].value as string)).toBe('1234');
    expect(v[3].type).toBe(forge.asn1.Type.BOOLEAN);
    expect((v[3].value as string).charCodeAt(0)).toBe(0xff);
  });

  const genTime = new Date('2026-09-02T12:34:56Z');

  /** A fake TSA answering with a (structurally valid, unsigned) granted token. */
  const fakeTsa = (status = 0): typeof fetch =>
    (async (_url: string, init?: RequestInit) => {
      const req = forge.asn1.fromDer(bin(init!.body as Uint8Array)).value as forge.asn1.Asn1[];
      const imprint = unbin((req[1].value as forge.asn1.Asn1[])[1].value as string);
      const nonce = unbin(req[2].value as string);
      const tst = der(
        0x30,
        der(0x02, new Uint8Array([1])),
        oid('1.2.3.4.5'),
        der(0x30, der(0x30, oid('2.16.840.1.101.3.4.2.1'), NULL), der(0x04, imprint)),
        der(0x02, new Uint8Array([0x42])),
        gen(genTime),
        int(nonce),
      );
      const token = der(
        0x30,
        oid('1.2.840.113549.1.7.2'),
        der(
          0xa0,
          der(
            0x30,
            der(0x02, new Uint8Array([3])),
            der(0x31, der(0x30, oid('2.16.840.1.101.3.4.2.1'))),
            der(0x30, oid('1.2.840.113549.1.9.16.1.4'), der(0xa0, der(0x04, tst))),
            der(0x31),
          ),
        ),
      );
      const body = status === 0 ? der(0x30, der(0x30, der(0x02, new Uint8Array([0]))), token) : der(0x30, der(0x30, der(0x02, new Uint8Array([status]))));
      return new Response(body.slice().buffer as ArrayBuffer, { status: 200, headers: { 'content-type': 'application/timestamp-reply' } });
    }) as unknown as typeof fetch;

  it('adds a granted token as unsigned attribute and still verifies', async () => {
    const out = await signPdf(pdf, { identity, pageIndex: 0, rect: [0, 0, 0, 0], tsaUrl: 'https://tsa.example/', fetchImpl: fakeTsa() });
    const [r] = await verify(out);
    expect(r.integrity).toBe('valid');
    expect(r.hasTimestamp).toBe(true);
    expect(r.signedAt).toBe(genTime.toISOString());
    expect(r.message).not.toMatch(/does not match/);
  });

  it('insertTimestampToken keeps the signature value and appends [1]', async () => {
    const out = await signPdf(pdf, { identity, pageIndex: 0, rect: [0, 0, 0, 0] });
    const hex = /\/Contents <([0-9a-f]+)>/i.exec(Buffer.from(out).toString('latin1'))![1].replace(/(00)+$/, '');
    let cms = new Uint8Array(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'));
    cms = cms.subarray(0, forge.asn1.fromDer(bin(cms), { parseAllBytes: false } as unknown as boolean) ? cms.length : 0);
    const cmsDer = toDer(forge.asn1.fromDer(bin(cms), { parseAllBytes: false, decodeBitStrings: false } as unknown as boolean));
    const token = der(0x30, oid('1.2.840.113549.1.7.2'));
    const withTs = insertTimestampToken(cmsDer, token);
    expect(signerSignatureValue(withTs)).toEqual(signerSignatureValue(cmsDer));
    const si = (((forge.asn1.fromDer(bin(withTs)).value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])
      .at(-1)!.value as forge.asn1.Asn1[];
    const last = (si[0].value as forge.asn1.Asn1[]).at(-1)!;
    expect(last.tagClass).toBe(forge.asn1.Class.CONTEXT_SPECIFIC);
    expect(last.type).toBe(1);
    const attr = (last.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    expect(forge.asn1.derToOid(attr[0].value as string)).toBe('1.2.840.113549.1.9.16.2.14');
  });

  it('rejection and network failure produce clear errors', async () => {
    await expect(
      signPdf(pdf, { identity, pageIndex: 0, rect: [0, 0, 0, 0], tsaUrl: 'https://tsa.example/', fetchImpl: fakeTsa(2) }),
    ).rejects.toThrow(/rejected the request \(PKIStatus 2\)/);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(
      signPdf(pdf, { identity, pageIndex: 0, rect: [0, 0, 0, 0], tsaUrl: 'https://tsa.example/', fetchImpl: offline }),
    ).rejects.toThrow(/Could not reach the timestamp server.*offline/);
  });
});

describe('certificate chain + revocation', () => {
  let root: TestCa;
  let inter: TestCa;
  let leaf: TestCa;
  let signedChain: Uint8Array;
  const OCSP_URL = 'http://ocsp.test/';
  const CRL_URL = 'http://crl.test/inter.crl';

  beforeAll(async () => {
    root = await issue({ cn: 'Adika Test Root', ca: true, notAfter: new Date(Date.now() + 10 * 365 * 86400_000) });
    inter = await issue({ cn: 'Adika Test Intermediate', ca: true, issuer: root });
    leaf = await issue({ cn: 'Leaf Signer', issuer: inter, ocspUrl: OCSP_URL, crlUrl: CRL_URL });
    signedChain = await signPdf(pdf, { identity: identityOf(leaf, [inter.cert, root.cert]), pageIndex: 0, rect: [10, 10, 110, 60], appearancePng: PNG });
  });

  it('trusted with the root as anchor, untrusted without', async () => {
    const [t] = await verify(signedChain, { trustedRoots: [root.cert] });
    expect(t.integrity).toBe('valid');
    expect(t.chainStatus).toBe('trusted');
    expect(t.chainDetails).toHaveLength(3);
    expect(t.chainDetails![0]).toMatch(/^Leaf Signer/);
    expect(t.chainDetails![2]).toMatch(/trusted root/);
    expect(t.selfSigned).toBe(false);
    const [u] = await verify(signedChain);
    expect(u.chainStatus).toBe('untrusted');
  });

  it('incomplete when the intermediate is missing', async () => {
    const out = await signPdf(pdf, { identity: identityOf(leaf, []), pageIndex: 0, rect: [0, 0, 0, 0] });
    const [r] = await verify(out, { trustedRoots: [root.cert] });
    expect(r.integrity).toBe('valid');
    expect(r.chainStatus).toBe('incomplete');
  });

  it('expired leaf -> expired', async () => {
    const old = await issue({
      cn: 'Expired Signer',
      issuer: inter,
      notBefore: new Date('2020-01-01T00:00:00Z'),
      notAfter: new Date('2021-01-01T00:00:00Z'),
    });
    const out = await signPdf(pdf, { identity: identityOf(old, [inter.cert, root.cert]), pageIndex: 0, rect: [0, 0, 0, 0] });
    const [r] = await verify(out, { trustedRoots: [root.cert] });
    expect(r.integrity).toBe('valid');
    expect(r.chainStatus).toBe('expired');
  });

  function buildCrl(revokedSerials: Uint8Array[]): Uint8Array {
    const issuerName = toDer(forge.pki.distinguishedNameToAsn1(inter.cert.subject));
    const entries = revokedSerials.map((s) => der(0x30, int(s), utc(new Date('2026-08-01T00:00:00Z'))));
    const tbs = der(
      0x30,
      der(0x02, new Uint8Array([1])),
      sha256RsaAlg,
      issuerName,
      utc(new Date(Date.now() - 3600_000)),
      utc(new Date(Date.now() + 7 * 86400_000)),
      ...(entries.length ? [der(0x30, ...entries)] : []),
    );
    return der(0x30, tbs, sha256RsaAlg, der(0x03, new Uint8Array([0]), rsaSign(inter.key, tbs)));
  }

  it('CRL listing the leaf serial -> revoked; not listed -> good', async () => {
    const gets: string[] = [];
    const revokedCrl = buildCrl([new Uint8Array([9, 9]), serialBytes(leaf.cert)]);
    const [r] = await verify(signedChain, {
      trustedRoots: [root.cert],
      checkRevocation: true,
      httpGet: async (url) => {
        gets.push(url);
        return revokedCrl;
      },
    });
    expect(gets).toEqual([CRL_URL]);
    expect(r.revocationStatus).toBe('revoked');
    expect(r.message).toMatch(/REVOKED/);

    const [g] = await verify(signedChain, { checkRevocation: true, httpGet: async () => buildCrl([new Uint8Array([9, 9])]) });
    expect(g.revocationStatus).toBe('good');

    // CRL signed by the wrong key is not trusted.
    const forged = buildCrl([]);
    forged[forged.length - 5] ^= 0xff;
    const [f] = await verify(signedChain, { checkRevocation: true, httpGet: async () => forged });
    expect(f.revocationStatus).toBe('unknown');
  });

  it('network failure -> unknown, never throws', async () => {
    const [r] = await verify(signedChain, {
      checkRevocation: true,
      httpPost: async () => {
        throw new Error('ECONNREFUSED');
      },
      httpGet: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(r.integrity).toBe('valid');
    expect(r.revocationStatus).toBe('unknown');
    expect(r.revocationDetails).toMatch(/ECONNREFUSED/);
  });

  it('encodes an OCSP request with the right CertID', () => {
    const req = forge.asn1.fromDer(bin(buildOcspRequest(leaf.cert, inter.cert)));
    const certId = ((((req.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0]
      .value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    expect(forge.asn1.derToOid((certId[0].value as forge.asn1.Asn1[])[0].value as string)).toBe('1.3.14.3.2.26');
    const sha1 = (s: string) => forge.md.sha1.create().update(s).digest().getBytes();
    expect(certId[1].value).toBe(sha1(forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(inter.cert.subject)).getBytes()));
    const rsaPub = forge.pki.publicKeyToRSAPublicKey(inter.cert.publicKey as forge.pki.rsa.PublicKey);
    expect(certId[2].value).toBe(sha1(forge.asn1.toDer(rsaPub).getBytes()));
    expect(forge.util.bytesToHex(certId[3].value as string)).toBe(leaf.cert.serialNumber);
  });

  /** A fake OCSP responder signed by the intermediate. */
  function ocspResponder(state: 'good' | 'revoked', signer = inter.key) {
    return async (url: string, contentType: string, body: Uint8Array) => {
      expect(url).toBe(OCSP_URL);
      expect(contentType).toBe('application/ocsp-request');
      const req = forge.asn1.fromDer(bin(body));
      const certId = toDer(
        ((((req.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0],
      );
      const status = state === 'good' ? new Uint8Array([0x80, 0x00]) : der(0xa1, gen(new Date('2026-08-15T00:00:00Z')));
      const tbs = der(
        0x30,
        der(0xa1, toDer(forge.pki.distinguishedNameToAsn1(inter.cert.subject))),
        gen(new Date()),
        der(0x30, der(0x30, certId, status, gen(new Date()))),
      );
      const basic = der(0x30, tbs, sha256RsaAlg, der(0x03, new Uint8Array([0]), rsaSign(signer, tbs)));
      return der(0x30, der(0x0a, new Uint8Array([0])), der(0xa0, der(0x30, oid('1.3.6.1.5.5.7.48.1.1'), der(0x04, basic))));
    };
  }

  it('OCSP good / revoked, and an unverifiable response is unknown', async () => {
    const [g] = await verify(signedChain, { trustedRoots: [root.cert], checkRevocation: true, httpPost: ocspResponder('good') });
    expect(g.revocationStatus).toBe('good');
    expect(g.revocationDetails).toMatch(/OCSP/);
    const [r] = await verify(signedChain, { checkRevocation: true, httpPost: ocspResponder('revoked') });
    expect(r.revocationStatus).toBe('revoked');
    const [u] = await verify(signedChain, { checkRevocation: true, httpPost: ocspResponder('good', root.key) });
    expect(u.revocationStatus).toBe('unknown');
    expect(u.revocationDetails).toMatch(/could not be verified/);
  });
});

describe('external signer (ECDSA P-256 via Web Crypto)', () => {
  /** Self-signed EC certificate built by hand (forge cannot create EC certificates). */
  async function makeEcCert(kp: CryptoKeyPair): Promise<Uint8Array> {
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    const alg = der(0x30, oid('1.2.840.10045.4.3.2'));
    const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, new Uint8Array(Buffer.from('Token Signer ECC', 'utf8'))))));
    const tbs = der(
      0x30,
      der(0xa0, der(0x02, new Uint8Array([2]))),
      der(0x02, new Uint8Array([0x01, 0x23])),
      alg,
      name,
      der(0x30, utc(new Date(Date.now() - 86400_000)), utc(new Date(Date.now() + 365 * 86400_000))),
      name,
      spki,
    );
    const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, tbs as BufferSource));
    const sigDer = der(0x30, int(rawSig.subarray(0, 32).slice()), int(rawSig.subarray(32).slice()));
    return der(0x30, tbs, alg, der(0x03, new Uint8Array([0]), sigDer));
  }

  it('signs through the ExternalSigner interface and verifies as valid', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const certDer = await makeEcCert(kp);
    const info = identityFromCertificateDer(certDer);
    expect(info.keyAlgorithm).toBe('ecdsa');
    expect(info.name).toBe('Token Signer ECC');
    expect(info.selfSigned).toBe(true);
    expect(certificateToDer(info.certificate)).toEqual(certDer);

    let calls = 0;
    const signer: ExternalSigner = {
      certificate: info.certificate,
      chain: [],
      keyAlgorithm: 'ecdsa',
      async sign(attrs) {
        calls++;
        expect(attrs[0]).toBe(0x31); // DER SET of signed attributes
        // Web Crypto returns raw r||s; signPdf normalises it to DER.
        return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, attrs as BufferSource));
      },
    };
    const out = await signPdf(pdf, { signer, pageIndex: 0, rect: [20, 20, 120, 70], appearancePng: PNG, reason: 'Token' });
    expect(calls).toBe(1);
    const [r] = await verify(out);
    expect(r.integrity).toBe('valid');
    expect(r.signerName).toBe('Token Signer ECC');
    expect(r.algorithm).toBe('ECDSA P-256 / SHA-256');
    expect(r.chainStatus).toBe('untrusted');
    const [t] = await verify(out, { trustedRoots: [info.certificate] });
    expect(t.chainStatus).toBe('trusted');

    const bad = out.slice();
    bad[30] ^= 1;
    expect((await verify(bad))[0].integrity).toBe('invalid');
  });

  it('rejects a key type that does not match the certificate', async () => {
    const signer: ExternalSigner = { ...signerStub(), keyAlgorithm: 'ecdsa' };
    await expect(signPdf(pdf, { signer, pageIndex: 0, rect: [0, 0, 0, 0] })).rejects.toThrow(/does not match/);
  });

  function signerStub(): ExternalSigner {
    return { certificate: identity.certificate, chain: [], keyAlgorithm: 'rsa', sign: async () => new Uint8Array(0) };
  }
});

// Optional external validation: ADIKA_SIG_DUMP=<dir> writes signed samples for
// e.g. pyHanko (`pyhanko sign validate --no-strict-syntax file.pdf`).
describe.runIf(!!process.env.ADIKA_SIG_DUMP)('dump samples', () => {
  it('writes signed PDFs', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = process.env.ADIKA_SIG_DUMP!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rsa-selfsigned.pdf'), signed);
    fs.writeFileSync(path.join(dir, 'rsa-selfsigned.crt'), certificateToDer(identity.certificate));
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    const alg = der(0x30, oid('1.2.840.10045.4.3.2'));
    const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, new Uint8Array(Buffer.from('Token ECC'))))));
    const tbs = der(0x30, der(0xa0, der(0x02, new Uint8Array([2]))), der(0x02, new Uint8Array([7])), alg, name,
      der(0x30, utc(new Date(Date.now() - 86400_000)), utc(new Date(Date.now() + 86400_000 * 30))), name, spki);
    const rs = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, tbs as BufferSource));
    const certDer = der(0x30, tbs, alg, der(0x03, new Uint8Array([0]), der(0x30, int(rs.slice(0, 32)), int(rs.slice(32)))));
    const info = identityFromCertificateDer(certDer);
    const out = await signPdf(pdf, {
      signer: { certificate: info.certificate, chain: [], keyAlgorithm: 'ecdsa',
        sign: async (a) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, a as BufferSource)) },
      pageIndex: 0, rect: [20, 20, 120, 70], appearancePng: PNG,
    });
    fs.writeFileSync(path.join(dir, 'ecdsa.pdf'), out);
    fs.writeFileSync(path.join(dir, 'ecdsa.crt'), certDer);
  });
});
