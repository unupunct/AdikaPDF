/**
 * A small test PKI for the signature verification tests: certificates with
 * chosen constraints and usages, a timestamp authority that really signs its
 * tokens, hand-made CMS signatures, and file surgery on signed PDFs
 * (rewriting /ByteRange, swapping the /Contents value) to build attacks.
 */
import forge from 'node-forge';
import { generateRsaKey, identityFromCertificateDer, certificateToDer, type SigningIdentity } from '@/lib/crypto/digitalSignature';

export const bin = (b: Uint8Array) => Buffer.from(b).toString('binary');
export const unbin = (s: string) => new Uint8Array(Buffer.from(s, 'binary'));

export function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...len]), body]));
}
export const oid = (o: string) => der(0x06, unbin(forge.asn1.oidToDer(o).getBytes()));
export const NULL = new Uint8Array([5, 0]);
export const int = (b: Uint8Array) => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
export const utc = (d: Date) => der(0x17, unbin(forge.asn1.dateToUtcTime(d)));
export const gen = (d: Date) => der(0x18, unbin(forge.asn1.dateToGeneralizedTime(d)));
export const toDer = (a: forge.asn1.Asn1) => unbin(forge.asn1.toDer(a).getBytes());

export const OIDS = {
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  md5: '1.2.840.113549.2.5',
  rsa: '1.2.840.113549.1.1.1',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertV2: '1.2.840.113549.1.9.16.2.47',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  ocspSigning: '1.3.6.1.5.5.7.3.9',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

type Hash = 'sha256' | 'sha1' | 'md5';
const HASH_OID: Record<Hash, string> = { sha256: OIDS.sha256, sha1: OIDS.sha1, md5: OIDS.md5 };

export function hashOf(h: Hash, ...parts: Uint8Array[]): Uint8Array {
  const md = forge.md[h].create();
  for (const p of parts) md.update(bin(p));
  return unbin(md.digest().getBytes());
}

export function rsaSign(key: forge.pki.rsa.PrivateKey, data: Uint8Array, h: Hash = 'sha256'): Uint8Array {
  const md = forge.md[h].create();
  md.update(bin(data));
  return unbin(key.sign(md));
}

export interface TestCa {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

let serialCounter = 0x5000;

/** Issue a certificate; returns the DER-parsed certificate and its key. */
export async function issue(opts: {
  cn: string;
  issuer?: TestCa;
  ca?: boolean;
  /** Omit basicConstraints entirely. */
  noBasicConstraints?: boolean;
  pathLen?: number;
  /** forge keyUsage flags; null leaves the extension out. */
  keyUsage?: Record<string, boolean> | null;
  eku?: string[];
  notBefore?: Date;
  notAfter?: Date;
  ocspUrl?: string;
  crlUrl?: string;
  bits?: number;
}): Promise<TestCa> {
  const key = opts.bits ? forge.pki.rsa.generateKeyPair({ bits: opts.bits, e: 0x10001 }).privateKey : await generateRsaKey();
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  c.serialNumber = (serialCounter++).toString(16).padStart(6, '0');
  c.validity.notBefore = opts.notBefore ?? new Date(Date.now() - 86400_000);
  c.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 86400_000);
  const subject = [{ name: 'commonName', value: opts.cn }, { name: 'organizationName', value: 'Adika Attack PKI' }];
  c.setSubject(subject);
  c.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
  const ext: object[] = [];
  if (!opts.noBasicConstraints) ext.push({ name: 'basicConstraints', cA: !!opts.ca, critical: true, ...(opts.pathLen !== undefined ? { pathLenConstraint: opts.pathLen } : {}) });
  const ku = opts.keyUsage === undefined ? (opts.ca ? { keyCertSign: true, cRLSign: true } : { digitalSignature: true, nonRepudiation: true }) : opts.keyUsage;
  if (ku) ext.push({ name: 'keyUsage', critical: true, ...ku });
  if (opts.eku) ext.push({ id: '2.5.29.37', value: bin(der(0x30, ...opts.eku.map(oid))) });
  if (opts.ocspUrl) ext.push({ id: '1.3.6.1.5.5.7.1.1', value: bin(der(0x30, der(0x30, oid('1.3.6.1.5.5.7.48.1'), der(0x86, unbin(opts.ocspUrl))))) });
  if (opts.crlUrl) ext.push({ id: '2.5.29.31', value: bin(der(0x30, der(0x30, der(0xa0, der(0xa0, der(0x86, unbin(opts.crlUrl))))))) });
  c.setExtensions(ext);
  c.sign(opts.issuer?.key ?? key, forge.md.sha256.create());
  return { cert: identityFromCertificateDer(toDer(forge.pki.certificateToAsn1(c))).certificate, key };
}

export function identityOf(leaf: TestCa, chain: forge.pki.Certificate[]): SigningIdentity {
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

/** Issuer Name and serial INTEGER of a certificate, exactly as encoded in it. */
export function issuerAndSerial(cert: forge.pki.Certificate): { issuer: Uint8Array; serial: Uint8Array } {
  const tbs = (forge.asn1.fromDer(bin(certificateToDer(cert))).value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const i = tbs[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return { serial: toDer(tbs[i]), issuer: toDer(tbs[i + 2]) };
}

const sortDer = (xs: Uint8Array[]) => [...xs].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

/** CMS SignedData by `signer` over a content of type `eContentType` (detached unless `eContent`). */
function signedData(o: {
  signer: TestCa;
  certs: forge.pki.Certificate[];
  attrs: Uint8Array[];
  hash: Hash;
  eContentType: string;
  eContent?: Uint8Array;
  sigFn?: (signedAttrs: Uint8Array) => Uint8Array;
}): Uint8Array {
  const attrs = sortDer(o.attrs);
  const sig = o.sigFn ? o.sigFn(der(0x31, ...attrs)) : rsaSign(o.signer.key, der(0x31, ...attrs), o.hash);
  const { issuer, serial } = issuerAndSerial(o.signer.cert);
  const digestAlg = der(0x30, oid(HASH_OID[o.hash]), NULL);
  const signerInfo = der(0x30, int(new Uint8Array([1])), der(0x30, issuer, serial), digestAlg, der(0xa0, ...attrs), der(0x30, oid(OIDS.rsa), NULL), der(0x04, sig));
  const encap = o.eContent ? der(0x30, oid(o.eContentType), der(0xa0, der(0x04, o.eContent))) : der(0x30, oid(o.eContentType));
  const sd = der(0x30, int(new Uint8Array([3])), der(0x31, digestAlg), encap, der(0xa0, ...o.certs.map(certificateToDer)), der(0x31, signerInfo));
  return der(0x30, oid(OIDS.signedData), der(0xa0, sd));
}

const attr = (type: string, value: Uint8Array) => der(0x30, oid(type), der(0x31, value));

/** A detached CMS signature over `data` (optionally with an ESS signing-certificate-v2 naming `essCert`). */
export function cmsSign(data: Uint8Array[], o: { signer: TestCa; chain?: forge.pki.Certificate[]; hash?: Hash; essCert?: forge.pki.Certificate; sigFn?: (signedAttrs: Uint8Array) => Uint8Array }): Uint8Array {
  const hash = o.hash ?? 'sha256';
  const attrs = [attr(OIDS.contentType, oid(OIDS.data)), attr(OIDS.messageDigest, der(0x04, hashOf(hash, ...data))), attr(OIDS.signingTime, utc(new Date(Math.floor(Date.now() / 1000) * 1000)))];
  if (o.essCert) attrs.push(attr(OIDS.signingCertV2, der(0x30, der(0x30, der(0x30, der(0x04, hashOf('sha256', certificateToDer(o.essCert))))))));
  return signedData({ signer: o.signer, certs: [o.signer.cert, ...(o.chain ?? [])], attrs, hash, eContentType: OIDS.data, sigFn: o.sigFn });
}

/** An RFC 3161 TimeStampToken by `tsa` for `imprint` (SHA-256). */
export function tsaToken(tsa: TestCa, imprint: Uint8Array, genTime: Date, nonce?: Uint8Array, chain: forge.pki.Certificate[] = []): Uint8Array {
  const tst = der(
    0x30,
    int(new Uint8Array([1])),
    oid('1.2.3.4.5'),
    der(0x30, der(0x30, oid(OIDS.sha256), NULL), der(0x04, imprint)),
    int(new Uint8Array([0x42])),
    gen(genTime),
    ...(nonce ? [int(nonce)] : []),
  );
  const attrs = [attr(OIDS.contentType, oid(OIDS.tstInfo)), attr(OIDS.messageDigest, der(0x04, hashOf('sha256', tst)))];
  return signedData({ signer: tsa, certs: [tsa.cert, ...chain], attrs, hash: 'sha256', eContentType: OIDS.tstInfo, eContent: tst });
}

/** A timestamp server (fetch) answering with tokens signed by `tsa`. */
export function tsaServer(tsa: TestCa, o: { genTime?: () => Date; chain?: forge.pki.Certificate[] } = {}): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const req = forge.asn1.fromDer(bin(init!.body as Uint8Array)).value as forge.asn1.Asn1[];
    const imprint = unbin((req[1].value as forge.asn1.Asn1[])[1].value as string);
    const nonce = unbin(req[2].value as string);
    const token = tsaToken(tsa, imprint, o.genTime?.() ?? new Date(Math.floor(Date.now() / 1000) * 1000), nonce, o.chain);
    const body = der(0x30, der(0x30, der(0x02, new Uint8Array([0]))), token);
    return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------- file surgery

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** /ByteRange of the last signature in the file and the span of its "[ … ]" text. */
export function byteRange(file: Uint8Array, nth = -1): { range: number[]; open: number; close: number } {
  const s = latin1(file);
  const all = [...s.matchAll(/\/ByteRange\s*\[([\d\s]+)\]/g)];
  const m = all.at(nth)!;
  const open = m.index! + m[0].indexOf('[');
  return { range: m[1].trim().split(/\s+/).map(Number), open, close: m.index! + m[0].length - 1 };
}

/** DER length of the CMS at the start of `b`. */
function derLength(b: Uint8Array): number {
  const l = b[1];
  if (l < 0x80) return 2 + l;
  const n = l & 0x7f;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[2 + i];
  return 2 + n + v;
}

/** The CMS value of the last signature (from its /Contents hole). */
export function contentsOf(file: Uint8Array, nth = -1): Uint8Array {
  const [, b, c] = byteRange(file, nth).range;
  const all = Buffer.from(latin1(file.subarray(b + 1, c - 1)), 'hex');
  return new Uint8Array(all.subarray(0, derLength(all)));
}

/** Writes `cms` into the /Contents hole of the signature at [b, c). */
export function writeHole(file: Uint8Array, b: number, c: number, cms: Uint8Array): Uint8Array {
  const out = file.slice();
  const hex = Buffer.from(cms).toString('hex');
  if (hex.length > c - b - 2) throw new Error('CMS too large for the hole');
  out.set(Buffer.from(hex.padEnd(c - b - 2, '0'), 'latin1'), b + 1);
  return out;
}

/** Replaces the CMS of the last signature (the hole is not covered by the signature). */
export function replaceContents(file: Uint8Array, cms: Uint8Array, nth = -1): Uint8Array {
  const [, b, c] = byteRange(file, nth).range;
  return writeHole(file, b, c, cms);
}

/**
 * Rewrites the last signature's /ByteRange to `range` (same text width) and
 * signs that range again with `signer`, writing the CMS into the original hole.
 */
export function resign(file: Uint8Array, range: number[], o: Parameters<typeof cmsSign>[1]): Uint8Array {
  const { range: old, open, close } = byteRange(file);
  const text = `[${range.join(' ')}`;
  if (text.length > close - open) throw new Error('ByteRange text does not fit');
  const out = file.slice();
  out.set(Buffer.from(text.padEnd(close - open, ' '), 'latin1'), open);
  const [a, b, c, d] = range;
  const cms = cmsSign([out.subarray(a, a + b), out.subarray(c, c + d)], o);
  return writeHole(out, old[1], old[2], cms);
}

/** RSA PKCS#1 v1.5 signature (SHA-256) whose DigestInfo omits the NULL parameters: lenient verifiers accept it. */
export function rsaSignWithoutNull(key: forge.pki.rsa.PrivateKey, data: Uint8Array): Uint8Array {
  const digestInfo = der(0x30, der(0x30, oid(OIDS.sha256)), der(0x04, hashOf('sha256', data)));
  const k = Math.ceil(key.n.bitLength() / 8);
  const em = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - 3 - digestInfo.length, 0xff), Buffer.from([0]), Buffer.from(digestInfo)]);
  const s = new forge.jsbn.BigInteger(em.toString('hex'), 16).modPow(key.d, key.n).toString(16).padStart(k * 2, '0');
  return new Uint8Array(Buffer.from(s, 'hex'));
}