/**
 * Certificate-based PDF digital signatures (ISO 32000-1 12.8):
 * /Filter /Adobe.PPKLite, /SubFilter /adbe.pkcs7.detached, SHA-256 with RSA or
 * ECDSA keys.
 *
 * Signing (one code path for software keys and PKCS#11 hardware tokens):
 *  1. A signature value dictionary is added with a /ByteRange placeholder and a
 *     zero-filled /Contents hex string of fixed size, together with a merged
 *     signature field/widget annotation. The document is saved with the classic
 *     writer (no object streams) so both placeholders appear verbatim.
 *  2. The placeholders are located in the saved bytes, the real /ByteRange is
 *     written (space padded to the same width) and a SHA-256 digest of
 *     everything except the /Contents hex string is taken.
 *  3. The CMS SignedData is assembled by hand as DER (signed attributes:
 *     contentType, signingTime, messageDigest, ESS signing-certificate-v2).
 *     The DER of the signed attributes is handed to an `ExternalSigner`
 *     (software RSA key via forge, or the native side for a token). An
 *     optional RFC 3161 timestamp is added as unsigned attribute. The DER is
 *     written into the /Contents hole (zero padded).
 *
 * Verification is done by hand on the DER (forge cannot verify PKCS#7 and
 * knows no ECDSA): signer certificate by issuer + serial, messageDigest vs.
 * digest of the ByteRange data, RSA (forge) or ECDSA (Web Crypto) signature
 * over the signed attributes re-tagged as SET. Optionally the certificate
 * chain is built against caller-supplied trust anchors and revocation is
 * checked via OCSP / CRL using caller-supplied HTTP functions.
 *
 * Only node-forge, pdf-lib and Web Crypto are used, so this runs in the
 * browser (Tauri webview) and in Node for tests.
 */
import forge from 'node-forge';
import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import type { SignatureValidation } from '../../types';

// ---------------------------------------------------------------------------
// Public types & constants
// ---------------------------------------------------------------------------

export type KeyAlgorithm = 'rsa' | 'ecdsa';

export interface SigningIdentity {
  /** Common name of the certificate subject (falls back to the full subject). */
  name: string;
  email: string | null;
  certificate: forge.pki.Certificate;
  privateKey: forge.pki.rsa.PrivateKey;
  /** Additional (intermediate / root) certificates, without `certificate`. */
  chain: forge.pki.Certificate[];
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
}

/** A signer whose private key lives elsewhere (PKCS#11 token via the native side). */
export interface ExternalSigner {
  /** Signer certificate (from the token). Use identityFromCertificateDer to parse it. */
  certificate: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
  keyAlgorithm: KeyAlgorithm;
  /**
   * Signs DER(signedAttributes as SET) with SHA-256; returns a PKCS#1 v1.5
   * signature (rsa) or a DER ECDSA-Sig-Value (ecdsa; raw r||s is accepted too).
   */
  sign(signedAttrsDer: Uint8Array): Promise<Uint8Array>;
}

export interface CertificateInfo {
  certificate: forge.pki.Certificate;
  subject: string;
  issuer: string;
  name: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
  keyAlgorithm: KeyAlgorithm;
}

interface SignOptionsBase {
  pageIndex: number;
  /** Widget rect in PDF user space [x1,y1,x2,y2]; use [0,0,0,0] for invisible */
  rect: [number, number, number, number];
  /** Optional PNG bytes drawn as the widget's visible appearance (the signature badge) */
  appearancePng?: Uint8Array;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Default "Signature1" (a numeric suffix is added if the name is taken). */
  fieldName?: string;
  signingTime?: Date;
  /** Optional RFC 3161 timestamp authority URL. */
  tsaUrl?: string | null;
  fetchImpl?: typeof fetch;
  /** Re-saving a signed PDF breaks its existing signatures; opt in explicitly. */
  allowInvalidatingExisting?: boolean;
}

/** Sign either with a software identity (.p12 / self-signed) or an external signer (token). */
export type SignOptions = SignOptionsBase &
  ({ identity: SigningIdentity; signer?: undefined } | { signer: ExternalSigner; identity?: undefined });

export interface VerifyOptions {
  /** Trust anchors (e.g. the Windows root store, supplied by the app). */
  trustedRoots?: forge.pki.Certificate[];
  /** Check OCSP / CRL for the signer certificate (needs httpPost and/or httpGet). */
  checkRevocation?: boolean;
  httpPost?: (url: string, contentType: string, body: Uint8Array) => Promise<Uint8Array>;
  httpGet?: (url: string) => Promise<Uint8Array>;
}

/** Fields added to SignatureValidation for the verify tool (optional in types.ts). */
type ExtendedValidation = SignatureValidation & {
  chainStatus?: 'trusted' | 'untrusted' | 'incomplete' | 'expired' | 'unknown';
  chainDetails?: string[];
  revocationStatus?: 'good' | 'revoked' | 'unknown' | 'not-checked';
  revocationDetails?: string;
  modifiedAfterSigning?: boolean;
  algorithm?: string;
};

/**
 * Bytes reserved for the DER CMS blob in /Contents (written as twice as many
 * hex digits). Enough for a signer cert, a 3-cert chain and a timestamp token;
 * signPdf retries once with a larger hole if the blob does not fit.
 */
export const SIGNATURE_PLACEHOLDER_BYTES = 16384;

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  aia: '1.3.6.1.5.5.7.1.1',
  adOcsp: '1.3.6.1.5.5.7.48.1',
  ocspBasic: '1.3.6.1.5.5.7.48.1.1',
  crlDp: '2.5.29.31',
} as const;

/** Signature algorithm OID -> digest OID. */
const SIG_HASH: Record<string, string> = {
  '1.2.840.113549.1.1.5': OID.sha1,
  '1.2.840.113549.1.1.11': OID.sha256,
  '1.2.840.113549.1.1.12': OID.sha384,
  '1.2.840.113549.1.1.13': OID.sha512,
  '1.2.840.10045.4.1': OID.sha1,
  '1.2.840.10045.4.3.2': OID.sha256,
  '1.2.840.10045.4.3.3': OID.sha384,
  '1.2.840.10045.4.3.4': OID.sha512,
};
const HASH_NAME: Record<string, string> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512',
};
const CURVES: Record<string, { name: 'P-256' | 'P-384' | 'P-521'; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 },
};

const BYTE_RANGE_PLACEHOLDER = '**********';

// ---------------------------------------------------------------------------
// Byte / string helpers
// ---------------------------------------------------------------------------

/** Uint8Array -> forge "binary string" (one char per byte). */
function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

function binaryToBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

const asciiBytes = binaryToBytes;

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** First index of `needle` in `hay` at or after `from`, or -1. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = hay.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Strip leading zero bytes (INTEGER comparison). */
function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

/** Web Crypto wants a plain ArrayBuffer-backed view. */
function buf(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}

/** PDF date string "D:YYYYMMDDHHmmSSZ" in UTC. */
function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Parse a PDF date string ("D:YYYYMMDDHHmmSS+HH'mm'") into a Date. */
function parsePdfDate(s: string): Date | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz, th = '00', tm = '00'] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz === '+' || tz === '-') {
    const off = (+th * 60 + +tm) * 60000;
    t += tz === '+' ? -off : off;
  }
  return Number.isNaN(t) ? null : new Date(t);
}

/** Text string for a PDF dictionary: literal if printable ASCII, else UTF-16BE hex. */
function pdfText(s: string): PDFString | PDFHexString {
  // pdf-lib writes PDFString contents verbatim, so escape delimiters ourselves.
  return /^[\x20-\x7e]*$/.test(s) ? PDFString.of(s.replace(/[\\()]/g, (c) => '\\' + c)) : PDFHexString.fromText(s);
}

// ---------------------------------------------------------------------------
// Minimal DER reader / writer (exact bytes; forge's asn1 re-encodes)
// ---------------------------------------------------------------------------

interface Tlv {
  /** First identifier byte (class | constructed | tag number). */
  tag: number;
  start: number;
  /** Offset of the content. */
  cStart: number;
  /** End of the content (exclusive, before an EOC for indefinite lengths). */
  cEnd: number;
  /** End of the whole element (exclusive). */
  end: number;
}

function readTlv(b: Uint8Array, pos: number, limit = b.length): Tlv {
  const start = pos;
  if (pos >= limit) throw new Error('DER: unexpected end of data');
  const tag = b[pos++];
  if ((tag & 0x1f) === 0x1f) {
    while (pos < limit && b[pos] & 0x80) pos++; // high tag number form
    pos++;
  }
  if (pos >= limit) throw new Error('DER: truncated length');
  const lb = b[pos++];
  if (lb === 0x80) {
    // BER indefinite length: children until an end-of-contents marker
    if (!(tag & 0x20)) throw new Error('DER: indefinite length on primitive');
    let p = pos;
    while (!(b[p] === 0 && b[p + 1] === 0)) {
      p = readTlv(b, p, limit).end;
      if (p >= limit) throw new Error('DER: missing end-of-contents');
    }
    return { tag, start, cStart: pos, cEnd: p, end: p + 2 };
  }
  let len = lb;
  if (lb & 0x80) {
    const n = lb & 0x7f;
    if (n > 4) throw new Error('DER: length too large');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[pos++];
  }
  const cEnd = pos + len;
  if (cEnd > limit) throw new Error('DER: element exceeds data');
  return { tag, start, cStart: pos, cEnd, end: cEnd };
}

function kids(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.cStart;
  while (p < t.cEnd) {
    const c = readTlv(b, p, t.cEnd);
    out.push(c);
    p = c.end;
  }
  return out;
}

const content = (b: Uint8Array, t: Tlv) => b.subarray(t.cStart, t.cEnd);
const raw = (b: Uint8Array, t: Tlv) => b.subarray(t.start, t.end);

/** Octet string content, concatenating BER constructed segments. */
function octets(b: Uint8Array, t: Tlv): Uint8Array {
  if (!(t.tag & 0x20)) return content(b, t);
  return concatBytes(kids(b, t).map((c) => octets(b, c)));
}

function oidOf(b: Uint8Array, t: Tlv): string {
  if (t.tag !== 0x06) throw new Error('DER: expected OID');
  return forge.asn1.derToOid(bytesToBinary(content(b, t)));
}

function timeOf(b: Uint8Array, t: Tlv): Date | null {
  const s = bytesToBinary(content(b, t));
  try {
    if (t.tag === 0x17) return forge.asn1.utcTimeToDate(s);
    if (t.tag === 0x18) return forge.asn1.generalizedTimeToDate(s);
  } catch {
    /* ignore */
  }
  return null;
}

/** BIT STRING content without the unused-bits byte. */
const bitString = (b: Uint8Array, t: Tlv) => b.subarray(t.cStart + 1, t.cEnd);

/** Encode one DER element. */
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concatBytes(parts);
  const n = body.length;
  let len: number[];
  if (n < 0x80) len = [n];
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    len = [0x80 | bytes.length, ...bytes];
  }
  return concatBytes([new Uint8Array([tag, ...len]), body]);
}

const derOid = (o: string) => der(0x06, binaryToBytes(forge.asn1.oidToDer(o).getBytes()));
const DER_NULL = new Uint8Array([0x05, 0x00]);
const derInt = (v: number) => der(0x02, new Uint8Array([v]));

/** Unsigned big-endian bytes -> DER INTEGER (minimal, positive). */
function derUInt(b: Uint8Array): Uint8Array {
  let v = stripLeadingZeros(b);
  if (v[0] & 0x80) v = concatBytes([new Uint8Array([0]), v]);
  return der(0x02, v);
}

function derTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear();
  return y >= 1950 && y < 2050
    ? der(0x17, asciiBytes(forge.asn1.dateToUtcTime(d)))
    : der(0x18, asciiBytes(forge.asn1.dateToGeneralizedTime(d)));
}

function algId(oid: string, withNull: boolean): Uint8Array {
  return withNull ? der(0x30, derOid(oid), DER_NULL) : der(0x30, derOid(oid));
}

// ---------------------------------------------------------------------------
// Hashing (forge md so browser and Node produce identical results)
// ---------------------------------------------------------------------------

function createMd(oid: string): forge.md.MessageDigest | null {
  switch (oid) {
    case OID.sha1:
      return forge.md.sha1.create();
    case OID.sha256:
      return forge.md.sha256.create();
    case OID.sha384:
      return forge.md.sha384.create();
    case OID.sha512:
      return forge.md.sha512.create();
    default:
      return null;
  }
}

function mdUpdate(md: forge.md.MessageDigest, bytes: Uint8Array): void {
  const CHUNK = 1 << 16;
  for (let i = 0; i < bytes.length; i += CHUNK) md.update(bytesToBinary(bytes.subarray(i, i + CHUNK)));
}

function digest(oid: string, ...parts: Uint8Array[]): Uint8Array {
  const md = createMd(oid);
  if (!md) throw new Error(`Unsupported digest algorithm ${oid}`);
  for (const p of parts) mdUpdate(md, p);
  return binaryToBytes(md.digest().getBytes());
}

// ---------------------------------------------------------------------------
// Certificates: raw metadata (works for RSA and EC keys)
// ---------------------------------------------------------------------------

interface CertMeta {
  der: Uint8Array;
  tbs: Uint8Array;
  serial: Uint8Array;
  issuerDer: Uint8Array;
  subjectDer: Uint8Array;
  spki: Uint8Array;
  /** subjectPublicKey BIT STRING content (for OCSP issuerKeyHash). */
  publicKeyBits: Uint8Array;
  keyAlgorithm: KeyAlgorithm | 'other';
  curve: (typeof CURVES)[string] | null;
  sigOid: string;
  sigValue: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** Extension OID -> extnValue content. */
  extensions: Map<string, Uint8Array>;
}

const certMetaCache = new WeakMap<forge.pki.Certificate, CertMeta>();

function computeMeta(d: Uint8Array): CertMeta {
  const top = readTlv(d, 0);
  const [tbsT, sigAlgT, sigT] = kids(d, top);
  const tk = kids(d, tbsT);
  const i = tk[0].tag === 0xa0 ? 1 : 0;
  const [serialT, , issuerT, validityT, subjectT, spkiT] = tk.slice(i);
  const [nb, na] = kids(d, validityT);
  const [spkiAlg, spkiBits] = kids(d, spkiT);
  const spkiAlgKids = kids(d, spkiAlg);
  const keyOid = oidOf(d, spkiAlgKids[0]);
  let keyAlgorithm: CertMeta['keyAlgorithm'] = 'other';
  let curve: CertMeta['curve'] = null;
  if (keyOid === OID.rsaEncryption) keyAlgorithm = 'rsa';
  else if (keyOid === OID.ecPublicKey) {
    keyAlgorithm = 'ecdsa';
    if (spkiAlgKids[1]?.tag === 0x06) curve = CURVES[oidOf(d, spkiAlgKids[1])] ?? null;
  }
  const extensions = new Map<string, Uint8Array>();
  const extT = tk.find((t) => t.tag === 0xa3);
  if (extT) {
    for (const e of kids(d, kids(d, extT)[0])) {
      const ek = kids(d, e);
      extensions.set(oidOf(d, ek[0]), content(d, ek[ek.length - 1]));
    }
  }
  return {
    der: d,
    tbs: raw(d, tbsT),
    serial: content(d, serialT),
    issuerDer: raw(d, issuerT),
    subjectDer: raw(d, subjectT),
    spki: raw(d, spkiT),
    publicKeyBits: bitString(d, spkiBits),
    keyAlgorithm,
    curve,
    sigOid: oidOf(d, kids(d, sigAlgT)[0]),
    sigValue: bitString(d, sigT),
    notBefore: timeOf(d, nb) ?? new Date(0),
    notAfter: timeOf(d, na) ?? new Date(0),
    extensions,
  };
}

function metaOf(cert: forge.pki.Certificate): CertMeta {
  let m = certMetaCache.get(cert);
  if (!m) {
    // forge keeps the original TBSCertificate of parsed certs, so this is byte exact.
    m = computeMeta(binaryToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()));
    certMetaCache.set(cert, m);
  }
  return m;
}

let dummyRsaSpki: Uint8Array | null = null;

/**
 * Parse a DER certificate into a forge Certificate. forge only reads RSA keys,
 * so for EC (or other) keys a copy with a dummy RSA key is parsed for the
 * names/extensions, and the real bytes are kept in the metadata cache.
 * `publicKey` is then null.
 */
function parseCertificate(d: Uint8Array): forge.pki.Certificate {
  const bytes = d.slice();
  const meta = computeMeta(bytes);
  let cert: forge.pki.Certificate;
  if (meta.keyAlgorithm === 'rsa') {
    cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(bytesToBinary(bytes)));
  } else {
    dummyRsaSpki ??= binaryToBytes(
      forge.asn1
        .toDer(forge.pki.publicKeyToAsn1(forge.pki.setRsaPublicKey(new forge.jsbn.BigInteger('3'), new forge.jsbn.BigInteger('65537'))))
        .getBytes(),
    );
    const top = readTlv(bytes, 0);
    const [tbsT, sigAlgT, sigT] = kids(bytes, top);
    const tk = kids(bytes, tbsT);
    const spkiIndex = (tk[0].tag === 0xa0 ? 1 : 0) + 5;
    const tbs = der(0x30, ...tk.map((t, i) => (i === spkiIndex ? dummyRsaSpki! : raw(bytes, t))));
    const patched = der(0x30, tbs, raw(bytes, sigAlgT), raw(bytes, sigT));
    cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(bytesToBinary(patched)));
    // Restore the genuine TBSCertificate so certificateToAsn1 stays faithful.
    cert.tbsCertificate = forge.asn1.fromDer(bytesToBinary(meta.tbs), { decodeBitStrings: false } as unknown as boolean);
    (cert as unknown as { publicKey: unknown }).publicKey = null;
  }
  certMetaCache.set(cert, meta);
  return cert;
}

// ---------------------------------------------------------------------------
// Certificate display helpers
// ---------------------------------------------------------------------------

/** Decode an X.509 name attribute value (forge keeps UTF8/BMP as raw bytes). */
function attrValue(attr: forge.pki.CertificateField): string {
  const v = String(attr.value ?? '');
  const tag = (attr as { valueTagClass?: number }).valueTagClass;
  try {
    if (tag === forge.asn1.Type.UTF8) return forge.util.decodeUtf8(v);
    if (tag === forge.asn1.Type.BMPSTRING) {
      let s = '';
      for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v.charCodeAt(i) << 8) | v.charCodeAt(i + 1));
      return s;
    }
  } catch {
    /* fall through to raw */
  }
  return v;
}

function formatDn(attrs: forge.pki.CertificateField[]): string {
  return attrs.map((a) => `${a.shortName ?? a.name ?? a.type}=${attrValue(a)}`).join(', ');
}

function dnField(attrs: forge.pki.CertificateField[], shortName: string, name: string): string | null {
  const a = attrs.find((x) => x.shortName === shortName || x.name === name);
  return a ? attrValue(a) : null;
}

function certCommonName(cert: forge.pki.Certificate): string {
  return dnField(cert.subject.attributes, 'CN', 'commonName') ?? formatDn(cert.subject.attributes);
}

function certEmail(cert: forge.pki.Certificate): string | null {
  const e = dnField(cert.subject.attributes, 'E', 'emailAddress');
  if (e) return e;
  // forge's extension object is untyped; altNames type 1 = rfc822Name
  const san = cert.getExtension('subjectAltName') as { altNames?: { type: number; value: string }[] } | null;
  return san?.altNames?.find((n) => n.type === 1)?.value ?? null;
}

function isSelfIssued(cert: forge.pki.Certificate): boolean {
  const m = metaOf(cert);
  return bytesEqual(m.subjectDer, m.issuerDer);
}

function keyDescription(cert: forge.pki.Certificate): string {
  const m = metaOf(cert);
  if (m.keyAlgorithm === 'rsa') {
    const n = (cert.publicKey as forge.pki.rsa.PublicKey | null)?.n;
    return n ? `RSA-${n.bitLength()}` : 'RSA';
  }
  if (m.keyAlgorithm === 'ecdsa') return `ECDSA ${m.curve?.name ?? '(unknown curve)'}`;
  return 'unsupported key type';
}

function identityFrom(
  certificate: forge.pki.Certificate,
  privateKey: forge.pki.rsa.PrivateKey,
  chain: forge.pki.Certificate[],
): SigningIdentity {
  return {
    name: certCommonName(certificate),
    email: certEmail(certificate),
    certificate,
    privateKey,
    chain,
    subject: formatDn(certificate.subject.attributes),
    issuer: formatDn(certificate.issuer.attributes),
    validFrom: certificate.validity.notBefore,
    validTo: certificate.validity.notAfter,
    selfSigned: isSelfIssued(certificate),
  };
}

/** Parse a DER certificate (e.g. read from a PKCS#11 token); RSA and EC keys. */
export function identityFromCertificateDer(d: Uint8Array): CertificateInfo {
  let cert: forge.pki.Certificate;
  try {
    cert = parseCertificate(d);
  } catch (e) {
    throw new Error(`Not a valid X.509 certificate: ${e instanceof Error ? e.message : String(e)}`);
  }
  const m = metaOf(cert);
  if (m.keyAlgorithm === 'other') throw new Error('Only RSA and ECDSA certificates are supported.');
  return {
    certificate: cert,
    subject: formatDn(cert.subject.attributes),
    issuer: formatDn(cert.issuer.attributes),
    name: certCommonName(cert),
    validFrom: m.notBefore,
    validTo: m.notAfter,
    selfSigned: isSelfIssued(cert),
    keyAlgorithm: m.keyAlgorithm,
  };
}

/** DER bytes of a certificate (byte exact for parsed certificates). */
export function certificateToDer(cert: forge.pki.Certificate): Uint8Array {
  return metaOf(cert).der.slice();
}

// ---------------------------------------------------------------------------
// Identity: load / create / export
// ---------------------------------------------------------------------------

/** Load a .pfx / .p12 file (RSA keys). Throws a readable Error on a wrong password or missing key. */
export function loadP12(p12Bytes: Uint8Array, password: string): SigningIdentity {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(bytesToBinary(p12Bytes), { strict: false } as unknown as boolean);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/mac could not be verified|invalid password/i.test(msg)) throw new Error('Wrong password for this certificate file.');
    if (/not rsa/i.test(msg)) {
      throw new Error('Only RSA keys are supported in .p12 files (for EC keys use a hardware token).');
    }
    throw new Error(`Could not read the certificate file (.pfx/.p12): ${msg}. Check the password and the file.`);
  }

  const keys: forge.pki.rsa.PrivateKey[] = [];
  for (const type of [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag]) {
    for (const bag of p12.getBags({ bagType: type })[type] ?? []) {
      if (bag.key) keys.push(bag.key as forge.pki.rsa.PrivateKey);
    }
  }
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);

  if (keys.length === 0) throw new Error('The certificate file contains no private key, so it cannot be used for signing.');
  if (certs.length === 0) throw new Error('The certificate file contains no certificate.');

  // Pair key and certificate by RSA modulus.
  for (const key of keys) {
    const cert = certs.find((c) => {
      const pub = c.publicKey as forge.pki.rsa.PublicKey | null;
      return !!pub?.n && pub.n.equals(key.n);
    });
    if (cert) return identityFrom(cert, key, certs.filter((c) => c !== cert));
  }
  throw new Error('No certificate in the file matches its private key.');
}

/** RSA-2048 key: Web Crypto when available (fast), forge otherwise (slow, seconds). */
export async function generateRsaKey(): Promise<forge.pki.rsa.PrivateKey> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const kp = await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
    return forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(bytesToBinary(pkcs8))) as forge.pki.rsa.PrivateKey;
  }
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }, (err, kp) => (err ? reject(err) : resolve(kp.privateKey)));
  });
}

/** Create a self-signed RSA-2048 signing certificate (not trusted by others, but verifiable). */
export async function createSelfSignedIdentity(opts: {
  name: string;
  email?: string;
  organization?: string;
  country?: string;
  years?: number;
}): Promise<SigningIdentity> {
  const name = opts.name.trim();
  if (!name) throw new Error('A name is required for the certificate.');
  const privateKey = await generateRsaKey();

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const serial = binaryToBytes(forge.random.getBytesSync(16));
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive, 16 bytes
  cert.serialNumber = bytesToHex(serial);
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  const to = new Date(now);
  to.setFullYear(to.getFullYear() + Math.max(1, Math.min(50, Math.round(opts.years ?? 5))));
  cert.validity.notAfter = to;

  // forge accepts valueTagClass on name attributes, but its typings do not declare it.
  type NameAttr = { name: string; value: string; valueTagClass?: number };
  const utf8 = forge.asn1.Type.UTF8;
  const attrs: NameAttr[] = [{ name: 'commonName', value: name, valueTagClass: utf8 }];
  const email = opts.email?.trim();
  if (email) attrs.push({ name: 'emailAddress', value: email, valueTagClass: forge.asn1.Type.IA5STRING });
  if (opts.organization?.trim()) {
    attrs.push({ name: 'organizationName', value: opts.organization.trim(), valueTagClass: utf8 });
  }
  if (opts.country && /^[A-Za-z]{2}$/.test(opts.country.trim())) {
    attrs.push({ name: 'countryName', value: opts.country.trim().toUpperCase() });
  }
  cert.setSubject(attrs as unknown as forge.pki.CertificateField[]);
  cert.setIssuer(attrs as unknown as forge.pki.CertificateField[]);

  const extensions: object[] = [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
  ];
  if (email) extensions.push({ name: 'subjectAltName', altNames: [{ type: 1, value: email }] });
  cert.setExtensions(extensions);
  cert.sign(privateKey, forge.md.sha256.create());

  // Round-trip through DER so attribute values/hashes look exactly like parsed ones.
  const parsed = parseCertificate(binaryToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()));
  return identityFrom(parsed, privateKey, []);
}

/** Export as a password-protected .p12 (3DES, SHA-1 MAC: importable by Windows and Acrobat). */
export function exportP12(identity: SigningIdentity, password: string): Uint8Array {
  const asn1 = forge.pkcs12.toPkcs12Asn1(identity.privateKey, [identity.certificate, ...identity.chain], password, {
    algorithm: '3des',
    friendlyName: identity.name,
    generateLocalKeyId: true,
  });
  return binaryToBytes(forge.asn1.toDer(asn1).getBytes());
}

/** Wrap a software identity as an ExternalSigner (the single signing path). */
export function signerFromIdentity(identity: SigningIdentity): ExternalSigner {
  return {
    certificate: identity.certificate,
    chain: identity.chain,
    keyAlgorithm: 'rsa',
    async sign(data: Uint8Array) {
      const md = forge.md.sha256.create();
      mdUpdate(md, data);
      return binaryToBytes(identity.privateKey.sign(md));
    },
  };
}

// ---------------------------------------------------------------------------
// ECDSA signature format conversion
// ---------------------------------------------------------------------------

function isDerEcdsaSig(s: Uint8Array): boolean {
  try {
    const t = readTlv(s, 0);
    if (t.tag !== 0x30 || t.end !== s.length) return false;
    const k = kids(s, t);
    return k.length === 2 && k[0].tag === 0x02 && k[1].tag === 0x02;
  } catch {
    return false;
  }
}

function ecdsaRawToDer(rawSig: Uint8Array): Uint8Array {
  const h = rawSig.length / 2;
  return der(0x30, derUInt(rawSig.subarray(0, h)), derUInt(rawSig.subarray(h)));
}

function ecdsaDerToRaw(sig: Uint8Array, size: number): Uint8Array {
  const [r, s] = kids(sig, readTlv(sig, 0));
  const out = new Uint8Array(size * 2);
  const put = (v: Uint8Array, off: number) => {
    const x = stripLeadingZeros(v);
    if (x.length > size) throw new Error('ECDSA signature component too large');
    out.set(x, off + size - x.length);
  };
  put(content(sig, r), 0);
  put(content(sig, s), size);
  return out;
}

// ---------------------------------------------------------------------------
// Generic signature verification (RSA via forge, ECDSA via Web Crypto)
// ---------------------------------------------------------------------------

/**
 * Verify `sig` over `data` with the key of `keyCert`.
 * Returns null when the algorithm is not supported.
 */
async function verifyWithCert(
  keyCert: forge.pki.Certificate,
  sigOid: string,
  data: Uint8Array,
  sig: Uint8Array,
  digestOidHint?: string,
): Promise<boolean | null> {
  const m = metaOf(keyCert);
  const hashOid = SIG_HASH[sigOid] ?? digestOidHint;
  if (!hashOid || !createMd(hashOid)) return null;
  if (m.keyAlgorithm === 'rsa') {
    const pub = keyCert.publicKey as forge.pki.rsa.PublicKey | null;
    if (!pub) return null;
    try {
      return pub.verify(bytesToBinary(digest(hashOid, data)), bytesToBinary(sig));
    } catch {
      return false;
    }
  }
  if (m.keyAlgorithm === 'ecdsa' && m.curve) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    try {
      const key = await subtle.importKey('spki', buf(m.spki), { name: 'ECDSA', namedCurve: m.curve.name }, false, ['verify']);
      const rawSig = isDerEcdsaSig(sig) ? ecdsaDerToRaw(sig, m.curve.size) : sig;
      return await subtle.verify({ name: 'ECDSA', hash: HASH_NAME[hashOid] }, key, buf(rawSig), buf(data));
    } catch {
      return false;
    }
  }
  return null;
}

/** Does `issuer` sign `child`? */
function verifyCertSignature(child: forge.pki.Certificate, issuer: forge.pki.Certificate): Promise<boolean | null> {
  const m = metaOf(child);
  return verifyWithCert(issuer, m.sigOid, m.tbs, m.sigValue);
}

// ---------------------------------------------------------------------------
// RFC 3161 timestamps
// ---------------------------------------------------------------------------

/** DER TimeStampReq for a SHA-256 message imprint (exported for tests). */
export function buildTimeStampRequest(imprintSha256: Uint8Array, nonce: Uint8Array): Uint8Array {
  return der(
    0x30,
    derInt(1),
    der(0x30, algId(OID.sha256, true), der(0x04, imprintSha256)),
    derUInt(nonce),
    new Uint8Array([0x01, 0x01, 0xff]), // certReq TRUE
  );
}

/**
 * Parse a TimeStampResp, require status granted and check that the token's
 * TSTInfo carries our imprint and nonce. Returns the TimeStampToken DER.
 * (Exported for tests.)
 */
export function parseTimeStampResponse(resp: Uint8Array, imprintSha256: Uint8Array, nonce: Uint8Array): Uint8Array {
  let k: Tlv[];
  let code = -1;
  try {
    k = kids(resp, readTlv(resp, 0));
    const status = content(resp, kids(resp, k[0])[0]);
    code = status.length === 1 ? status[0] : -1;
  } catch {
    throw new Error('The timestamp server returned an invalid response.');
  }
  if (!(code === 0 || code === 1) || k.length < 2) {
    throw new Error(`The timestamp server rejected the request (PKIStatus ${code}).`);
  }
  const token = raw(resp, k[1]).slice();
  const tst = tstInfoOf(token);
  const mi = kids(tst.b, tst.kids[2]);
  if (!bytesEqual(content(tst.b, mi[1]), imprintSha256)) {
    throw new Error('Timestamp token does not match the signature (message imprint mismatch).');
  }
  const nonceTlv = tst.kids.slice(5).find((t) => t.tag === 0x02);
  if (!nonceTlv || !bytesEqual(stripLeadingZeros(content(tst.b, nonceTlv)), stripLeadingZeros(nonce))) {
    throw new Error('Timestamp token nonce mismatch (possible replay).');
  }
  return token;
}

/** ContentInfo -> SignedData -> encapContentInfo -> TSTInfo children. */
function tstInfoOf(token: Uint8Array): { b: Uint8Array; kids: Tlv[] } {
  const ci = kids(token, readTlv(token, 0));
  if (oidOf(token, ci[0]) !== OID.signedData) throw new Error('Timestamp token is not a SignedData structure.');
  const sd = kids(token, kids(token, ci[1])[0]);
  const encap = kids(token, sd[2]);
  if (oidOf(token, encap[0]) !== OID.tstInfo) throw new Error('Timestamp token does not contain TSTInfo.');
  const b = octets(token, kids(token, encap[1])[0]);
  return { b, kids: kids(b, readTlv(b, 0)) };
}

async function fetchTimestampToken(url: string, signatureValue: Uint8Array, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const imprint = digest(OID.sha256, signatureValue);
  const nonce = binaryToBytes(forge.random.getBytesSync(8));
  nonce[0] = (nonce[0] & 0x7f) | 0x01;
  const body = buildTimeStampRequest(imprint, nonce);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
      body: body as unknown as BodyInit,
    });
  } catch (e) {
    throw new Error(
      `Could not reach the timestamp server ${url} (offline, blocked or CORS): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) throw new Error(`The timestamp server ${url} answered HTTP ${res.status}.`);
  return parseTimeStampResponse(new Uint8Array(await res.arrayBuffer()), imprint, nonce);
}

/** Locate the first SignerInfo of a CMS ContentInfo. */
function firstSignerInfo(cms: Uint8Array) {
  const ciT = readTlv(cms, 0);
  const ci = kids(cms, ciT);
  const wrap = ci[1];
  const sdT = kids(cms, wrap)[0];
  const sd = kids(cms, sdT);
  const setT = sd[sd.length - 1];
  const signers = kids(cms, setT);
  if (setT.tag !== 0x31 || !signers.length) throw new Error('CMS has no SignerInfo.');
  return { ci, sd, signers, si: signers[0], siKids: kids(cms, signers[0]) };
}

/** Signature value (OCTET STRING) of the first SignerInfo. (Exported for tests.) */
export function signerSignatureValue(cms: Uint8Array): Uint8Array {
  const { siKids } = firstSignerInfo(cms);
  const s = siKids.find((t, i) => i > 2 && t.tag === 0x04);
  if (!s) throw new Error('SignerInfo has no signature value.');
  return content(cms, s).slice();
}

/**
 * Return a copy of the CMS ContentInfo with `tokenDer` added as unsigned
 * attribute id-aa-timeStampToken ([1] IMPLICIT SET OF Attribute) of the first
 * SignerInfo. (Exported for tests.)
 */
export function insertTimestampToken(cms: Uint8Array, tokenDer: Uint8Array): Uint8Array {
  const { ci, sd, signers, siKids } = firstSignerInfo(cms);
  const attr = der(0x30, derOid(OID.timeStampToken), der(0x31, tokenDer));
  const existing = siKids.find((t) => t.tag === 0xa1);
  const newSi = der(
    0x30,
    ...siKids.filter((t) => t !== existing).map((t) => raw(cms, t)),
    der(0xa1, ...(existing ? kids(cms, existing).map((t) => raw(cms, t)) : []), attr),
  );
  const newSet = der(0x31, newSi, ...signers.slice(1).map((t) => raw(cms, t)));
  const newSd = der(0x30, ...sd.slice(0, -1).map((t) => raw(cms, t)), newSet);
  return der(0x30, raw(cms, ci[0]), der(0xa0, newSd));
}

// ---------------------------------------------------------------------------
// CMS SignedData construction
// ---------------------------------------------------------------------------

function attribute(oid: string, value: Uint8Array): Uint8Array {
  return der(0x30, derOid(oid), der(0x31, value));
}

async function buildCms(signer: ExternalSigner, contentDigest: Uint8Array, signingTime: Date): Promise<Uint8Array> {
  const leaf = metaOf(signer.certificate);
  if (leaf.keyAlgorithm !== signer.keyAlgorithm) {
    throw new Error(`Signer key type (${signer.keyAlgorithm}) does not match its certificate (${leaf.keyAlgorithm}).`);
  }
  const issuerSerial = der(0x30, der(0x30, der(0xa4, leaf.issuerDer)), der(0x02, leaf.serial));
  const signingCertV2 = der(0x30, der(0x30, der(0x30, der(0x04, digest(OID.sha256, leaf.der)), issuerSerial)));
  // DER SET OF must be sorted by encoding.
  const attrs = [
    attribute(OID.contentType, derOid(OID.data)),
    attribute(OID.signingTime, derTime(signingTime)),
    attribute(OID.messageDigest, der(0x04, contentDigest)),
    attribute(OID.signingCertV2, signingCertV2),
  ].sort(compareBytes);
  const signedAttrsSet = der(0x31, ...attrs);

  let sig = await signer.sign(signedAttrsSet);
  if (!(sig instanceof Uint8Array) || sig.length === 0) throw new Error('The signer returned no signature.');
  if (signer.keyAlgorithm === 'ecdsa' && !isDerEcdsaSig(sig)) sig = ecdsaRawToDer(sig);

  const sha256Alg = algId(OID.sha256, true);
  const sigAlg = signer.keyAlgorithm === 'rsa' ? algId(OID.rsaEncryption, true) : algId(OID.ecdsaSha256, false);
  const signedAttrsImplicit = signedAttrsSet.slice();
  signedAttrsImplicit[0] = 0xa0; // [0] IMPLICIT
  const signerInfo = der(
    0x30,
    derInt(1),
    der(0x30, leaf.issuerDer, der(0x02, leaf.serial)),
    sha256Alg,
    signedAttrsImplicit,
    sigAlg,
    der(0x04, sig),
  );

  const certs: Uint8Array[] = [];
  for (const c of [signer.certificate, ...signer.chain]) {
    const d = metaOf(c).der;
    if (!certs.some((x) => bytesEqual(x, d))) certs.push(d);
  }
  const signedData = der(
    0x30,
    derInt(1),
    der(0x31, sha256Alg),
    der(0x30, derOid(OID.data)), // detached: no eContent
    der(0xa0, ...certs),
    der(0x31, signerInfo),
  );
  return der(0x30, derOid(OID.signedData), der(0xa0, signedData));
}

// ---------------------------------------------------------------------------
// PDF structure helpers
// ---------------------------------------------------------------------------

interface SigFieldRef {
  fullName: string;
  field: PDFDict;
  sig: PDFDict | null;
}

/** Walk AcroForm /Fields (with /FT and name inheritance), returning signature fields. */
function collectFields(doc: PDFDocument): { sigFields: SigFieldRef[]; topNames: Set<string> } {
  const sigFields: SigFieldRef[] = [];
  const topNames = new Set<string>();
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return { sigFields, topNames };

  const seen = new Set<PDFDict>();
  const visit = (node: PDFDict, parentName: string, inheritedFt: string | null, top: boolean) => {
    if (seen.has(node)) return;
    seen.add(node);
    const t = node.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText() ?? null;
    const fullName = t === null ? parentName : parentName ? `${parentName}.${t}` : t;
    if (top && t !== null) topNames.add(t);
    const ft = node.lookupMaybe(PDFName.of('FT'), PDFName)?.decodeText() ?? inheritedFt;
    const kidArr = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    const fieldKids: PDFDict[] = [];
    if (kidArr) {
      for (let i = 0; i < kidArr.size(); i++) {
        const k = kidArr.lookup(i);
        if (k instanceof PDFDict && k.has(PDFName.of('T'))) fieldKids.push(k);
      }
    }
    if (fieldKids.length) {
      for (const k of fieldKids) visit(k, fullName, ft, false);
      return;
    }
    if (ft === 'Sig') {
      const v = node.lookup(PDFName.of('V'));
      sigFields.push({ fullName: fullName || 'Signature', field: node, sig: v instanceof PDFDict ? v : null });
    }
  };
  for (let i = 0; i < fields.size(); i++) {
    const f = fields.lookup(i);
    if (f instanceof PDFDict) visit(f, '', null, true);
  }
  return { sigFields, topNames };
}

function textOf(dict: PDFDict, key: string): string | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
}

function uniqueFieldName(wanted: string, taken: Set<string>): string {
  const base = wanted.replace(/\./g, '_').trim() || 'Signature1';
  if (!taken.has(base)) return base;
  const stem = base.replace(/\d+$/, '') || 'Signature';
  for (let i = 1; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Sign a PDF (full rewrite + signature). Returns the signed file bytes. */
export async function signPdf(pdfBytes: Uint8Array, opts: SignOptions): Promise<Uint8Array> {
  const signer = opts.signer ?? (opts.identity ? signerFromIdentity(opts.identity) : null);
  if (!signer) throw new Error('No signing identity or external signer given.');
  const displayName = opts.identity?.name ?? certCommonName(signer.certificate);
  let size = SIGNATURE_PLACEHOLDER_BYTES;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await signOnce(pdfBytes, opts, signer, displayName, size);
    if (result.ok) return result.bytes;
    size = Math.ceil((result.needed + 4096) / 1024) * 1024; // grow once and retry
  }
  throw new Error('The signature does not fit into the reserved space.');
}

type SignResult = { ok: true; bytes: Uint8Array } | { ok: false; needed: number };

async function signOnce(
  pdfBytes: Uint8Array,
  opts: SignOptions,
  signer: ExternalSigner,
  displayName: string,
  placeholderBytes: number,
): Promise<SignResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes);
  } catch (e) {
    if (e instanceof EncryptedPDFError) throw new Error('Cannot sign an encrypted PDF. Remove its password first.');
    throw e;
  }
  const { sigFields, topNames } = collectFields(doc);
  const signedCount = sigFields.filter((f) => f.sig).length;
  if (signedCount > 0 && !opts.allowInvalidatingExisting) {
    throw new Error(
      `This PDF already has ${signedCount} digital signature(s). Signing again rewrites the file and would invalidate them.`,
    );
  }
  const pages = doc.getPages();
  if (!Number.isInteger(opts.pageIndex) || opts.pageIndex < 0 || opts.pageIndex >= pages.length) {
    throw new Error(`Page index ${opts.pageIndex} is out of range (document has ${pages.length} pages).`);
  }
  const page = pages[opts.pageIndex];
  const ctx = doc.context;
  const signingTime = opts.signingTime ?? new Date();

  // --- signature value dictionary with placeholders
  const sigDict = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached' }) as PDFDict;
  const ph = PDFName.of(BYTE_RANGE_PLACEHOLDER);
  sigDict.set(PDFName.of('ByteRange'), ctx.obj([PDFNumber.of(0), ph, ph, ph]));
  sigDict.set(PDFName.of('Contents'), PDFHexString.of('0'.repeat(placeholderBytes * 2)));
  sigDict.set(PDFName.of('M'), PDFString.of(pdfDate(signingTime)));
  sigDict.set(PDFName.of('Name'), pdfText(displayName));
  if (opts.reason) sigDict.set(PDFName.of('Reason'), pdfText(opts.reason));
  if (opts.location) sigDict.set(PDFName.of('Location'), pdfText(opts.location));
  if (opts.contactInfo) sigDict.set(PDFName.of('ContactInfo'), pdfText(opts.contactInfo));
  const sigRef = ctx.register(sigDict);

  // --- appearance stream (image scaled to fill the widget, or empty)
  const [x1, y1, x2, y2] = opts.rect;
  const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  let apStream;
  if (opts.appearancePng && w > 0 && h > 0) {
    const img = await doc.embedPng(opts.appearancePng);
    apStream = ctx.stream(`q ${w} 0 0 ${h} 0 0 cm /Img Do Q`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, w, h],
      Resources: { XObject: { Img: img.ref } },
    });
  } else {
    apStream = ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, Math.max(w, 0), Math.max(h, 0)] });
  }
  const apRef = ctx.register(apStream);

  // --- merged field + widget
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: rect,
    F: 132, // Print + Locked
    P: page.ref,
    AP: { N: apRef },
  }) as PDFDict;
  widget.set(PDFName.of('T'), pdfText(uniqueFieldName(opts.fieldName ?? 'Signature1', topNames)));
  widget.set(PDFName.of('V'), sigRef);
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);

  // --- AcroForm
  let acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) {
    acro = ctx.obj({}) as PDFDict;
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
  }
  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = ctx.obj([]) as PDFArray;
    acro.set(PDFName.of('Fields'), fields);
  }
  fields.push(widgetRef);
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3)); // SignaturesExist | AppendOnly

  const bytes = await doc.save({ useObjectStreams: false });

  // --- locate placeholders
  const hexPh = asciiBytes('<' + '0'.repeat(placeholderBytes * 2) + '>');
  let contentsStart = -1;
  for (let from = 0; ; ) {
    const i = indexOfBytes(bytes, hexPh.subarray(0, 64), from);
    if (i < 0) break;
    if (bytesEqual(bytes.subarray(i, i + hexPh.length), hexPh)) {
      contentsStart = i;
      break;
    }
    from = i + 1;
  }
  if (contentsStart < 0) throw new Error('Internal error: signature /Contents placeholder not found in the saved PDF.');
  const contentsEnd = contentsStart + hexPh.length;

  const brMarker = indexOfBytes(bytes, asciiBytes('/' + BYTE_RANGE_PLACEHOLDER));
  if (brMarker < 0) throw new Error('Internal error: /ByteRange placeholder not found in the saved PDF.');
  let brOpen = brMarker;
  while (brOpen > 0 && bytes[brOpen] !== 0x5b /* [ */) brOpen--;
  let brClose = brMarker;
  while (brClose < bytes.length && bytes[brClose] !== 0x5d /* ] */) brClose++;
  const brText = `[${[0, contentsStart, contentsEnd, bytes.length - contentsEnd].join(' ')}`;
  const brLen = brClose - brOpen; // characters before ']'
  if (brText.length > brLen) throw new Error('Internal error: /ByteRange placeholder too small.');
  bytes.set(asciiBytes(brText.padEnd(brLen, ' ')), brOpen);

  // --- CMS over the two ranges
  const contentDigest = digest(OID.sha256, bytes.subarray(0, contentsStart), bytes.subarray(contentsEnd));
  let cms = await buildCms(signer, contentDigest, signingTime);
  if (opts.tsaUrl) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new Error('No fetch implementation available for the timestamp request.');
    const token = await fetchTimestampToken(opts.tsaUrl, signerSignatureValue(cms), fetchImpl);
    cms = insertTimestampToken(cms, token);
  }

  if (cms.length > placeholderBytes) return { ok: false, needed: cms.length };
  bytes.set(asciiBytes(bytesToHex(cms).padEnd(placeholderBytes * 2, '0')), contentsStart + 1);
  return { ok: true, bytes };
}

// ---------------------------------------------------------------------------
// Chain building
// ---------------------------------------------------------------------------

interface ChainResult {
  status: NonNullable<ExtendedValidation['chainStatus']>;
  details: string[];
  chain: forge.pki.Certificate[];
}

function describeCert(c: forge.pki.Certificate, trusted: boolean): string {
  const m = metaOf(c);
  const self = isSelfIssued(c) ? ', self-signed' : '';
  return (
    `${certCommonName(c)} (${keyDescription(c)}${self}${trusted ? ', trusted root' : ''}) - issued by ` +
    `${dnField(c.issuer.attributes, 'CN', 'commonName') ?? formatDn(c.issuer.attributes)}, ` +
    `valid ${m.notBefore.toISOString().slice(0, 10)} to ${m.notAfter.toISOString().slice(0, 10)}`
  );
}

async function buildChain(
  leaf: forge.pki.Certificate,
  pool: forge.pki.Certificate[],
  trustedRoots: forge.pki.Certificate[],
  at: Date,
): Promise<ChainResult> {
  const isTrusted = (c: forge.pki.Certificate) => trustedRoots.some((r) => bytesEqual(metaOf(r).der, metaOf(c).der));
  const all = [...pool, ...trustedRoots];
  const chain: forge.pki.Certificate[] = [leaf];
  const details: string[] = [];
  let broken: string | null = null;
  let complete = false;

  for (let cur = leaf; chain.length < 10; ) {
    if (isTrusted(cur)) {
      complete = true;
      break;
    }
    const cm = metaOf(cur);
    if (bytesEqual(cm.subjectDer, cm.issuerDer)) {
      const ok = await verifyCertSignature(cur, cur);
      if (ok === false) broken = `${certCommonName(cur)}: self-signature does not verify.`;
      complete = true;
      break;
    }
    let next: forge.pki.Certificate | null = null;
    let sawCandidate = false;
    for (const cand of all) {
      if (chain.includes(cand) || !bytesEqual(metaOf(cand).subjectDer, cm.issuerDer)) continue;
      sawCandidate = true;
      if ((await verifyCertSignature(cur, cand)) === true) {
        next = cand;
        break;
      }
    }
    if (!next) {
      if (sawCandidate) broken = `${certCommonName(cur)}: signature by its issuer does not verify.`;
      break;
    }
    chain.push(next);
    cur = next;
  }

  for (const c of chain) details.push(describeCert(c, isTrusted(c)));
  const anchored = chain.some(isTrusted);
  const expired = chain.filter((c) => {
    const m = metaOf(c);
    return at < m.notBefore || at > m.notAfter;
  });

  let status: ChainResult['status'];
  if (broken) {
    status = 'untrusted';
    details.push(broken);
  } else if (expired.length) {
    status = 'expired';
    details.push(`Not valid at signing time (${at.toISOString()}): ${expired.map(certCommonName).join(', ')}.`);
  } else if (anchored) status = 'trusted';
  else if (!complete) {
    status = 'incomplete';
    details.push('The issuer certificate is missing, so the chain cannot be completed.');
  } else {
    status = 'untrusted';
    details.push('The chain ends at a root that is not in the trusted root store.');
  }
  return { status, details, chain };
}

// ---------------------------------------------------------------------------
// Revocation: OCSP and CRL
// ---------------------------------------------------------------------------

function extensionUris(cert: forge.pki.Certificate, extOid: string, accessMethod?: string): string[] {
  const v = metaOf(cert).extensions.get(extOid);
  if (!v) return [];
  const out: string[] = [];
  const scan = (b: Uint8Array, t: Tlv) => {
    if (t.tag === 0x86) out.push(bytesToBinary(content(b, t)));
    else if (t.tag & 0x20) for (const k of kids(b, t)) scan(b, k);
  };
  try {
    const top = readTlv(v, 0);
    if (accessMethod) {
      // AuthorityInfoAccess: SEQ OF { accessMethod OID, accessLocation GeneralName }
      for (const ad of kids(v, top)) {
        const [m, loc] = kids(v, ad);
        if (oidOf(v, m) === accessMethod) scan(v, loc);
      }
    } else scan(v, top);
  } catch {
    /* malformed extension */
  }
  return out.filter((u) => /^https?:\/\//i.test(u));
}

/** DER OCSPRequest for one certificate (SHA-1 CertID). (Exported for tests.) */
export function buildOcspRequest(cert: forge.pki.Certificate, issuer: forge.pki.Certificate): Uint8Array {
  const leaf = metaOf(cert);
  const iss = metaOf(issuer);
  const certId = der(
    0x30,
    algId(OID.sha1, true),
    der(0x04, digest(OID.sha1, iss.subjectDer)),
    der(0x04, digest(OID.sha1, iss.publicKeyBits)),
    der(0x02, leaf.serial),
  );
  return der(0x30, der(0x30, der(0x30, der(0x30, certId))));
}

interface RevocationResult {
  status: NonNullable<ExtendedValidation['revocationStatus']>;
  details: string;
}

async function parseOcspResponse(
  resp: Uint8Array,
  cert: forge.pki.Certificate,
  issuer: forge.pki.Certificate,
): Promise<RevocationResult> {
  const top = kids(resp, readTlv(resp, 0));
  const code = content(resp, top[0])[0];
  if (code !== 0 || !top[1]) {
    const names = ['successful', 'malformedRequest', 'internalError', 'tryLater', '', 'sigRequired', 'unauthorized'];
    return { status: 'unknown', details: `OCSP responder error: ${names[code] ?? code}.` };
  }
  const [typeT, bytesT] = kids(resp, kids(resp, top[1])[0]);
  if (oidOf(resp, typeT) !== OID.ocspBasic) return { status: 'unknown', details: 'Unsupported OCSP response type.' };
  const b = octets(resp, bytesT);
  const basic = kids(b, readTlv(b, 0));
  const [tbsT, sigAlgT, sigT] = basic;
  const rd = kids(b, tbsT);
  const i = rd[0].tag === 0xa0 ? 1 : 0;
  const responses = kids(b, rd[i + 2]);
  const serial = stripLeadingZeros(metaOf(cert).serial);

  let result: RevocationResult | null = null;
  for (const sr of responses) {
    const [certIdT, statusT] = kids(b, sr);
    const idKids = kids(b, certIdT);
    if (!bytesEqual(stripLeadingZeros(content(b, idKids[3])), serial)) continue;
    if (statusT.tag === 0x80) result = { status: 'good', details: 'OCSP: certificate is good.' };
    else if (statusT.tag === 0xa1) {
      const when = timeOf(b, kids(b, statusT)[0]);
      result = { status: 'revoked', details: `OCSP: certificate revoked${when ? ` on ${when.toISOString()}` : ''}.` };
    } else result = { status: 'unknown', details: 'OCSP: responder does not know this certificate.' };
    break;
  }
  if (!result) return { status: 'unknown', details: 'OCSP response does not cover this certificate.' };

  // Responder signature: issuer itself, or an included responder cert issued by the issuer.
  const sigOid = oidOf(b, kids(b, sigAlgT)[0]);
  const tbs = raw(b, tbsT);
  const sig = bitString(b, sigT);
  const candidates: forge.pki.Certificate[] = [issuer];
  const certsT = basic.find((t) => t.tag === 0xa0);
  if (certsT) {
    for (const c of kids(b, kids(b, certsT)[0])) {
      try {
        const rc = parseCertificate(raw(b, c));
        if ((await verifyCertSignature(rc, issuer)) === true) candidates.push(rc);
      } catch {
        /* skip */
      }
    }
  }
  for (const c of candidates) {
    if ((await verifyWithCert(c, sigOid, tbs, sig)) === true) return result;
  }
  return { status: 'unknown', details: `${result.details} But the OCSP response signature could not be verified.` };
}

async function checkCrl(crl: Uint8Array, cert: forge.pki.Certificate, issuer: forge.pki.Certificate): Promise<RevocationResult> {
  if (crl[0] === 0x2d /* '-' PEM */) {
    const b64 = bytesToBinary(crl).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    crl = binaryToBytes(forge.util.decode64(b64));
  }
  const [tbsT, sigAlgT, sigT] = kids(crl, readTlv(crl, 0));
  const ok = await verifyWithCert(issuer, oidOf(crl, kids(crl, sigAlgT)[0]), raw(crl, tbsT), bitString(crl, sigT));
  if (ok !== true) return { status: 'unknown', details: 'CRL signature could not be verified against the issuer.' };
  const tk = kids(crl, tbsT);
  let i = tk[0].tag === 0x02 ? 1 : 0; // optional version
  i += 2; // signature, issuer
  const thisUpdate = timeOf(crl, tk[i++]);
  if (tk[i] && (tk[i].tag === 0x17 || tk[i].tag === 0x18)) i++; // nextUpdate
  const serial = stripLeadingZeros(metaOf(cert).serial);
  if (tk[i]?.tag === 0x30) {
    for (const entry of kids(crl, tk[i])) {
      const [s, dateT] = kids(crl, entry);
      if (bytesEqual(stripLeadingZeros(content(crl, s)), serial)) {
        const when = timeOf(crl, dateT);
        return { status: 'revoked', details: `CRL: certificate revoked${when ? ` on ${when.toISOString()}` : ''}.` };
      }
    }
  }
  return {
    status: 'good',
    details: `CRL: certificate not revoked${thisUpdate ? ` (CRL issued ${thisUpdate.toISOString()})` : ''}.`,
  };
}

async function checkRevocation(
  cert: forge.pki.Certificate,
  issuer: forge.pki.Certificate | null,
  opts: VerifyOptions,
): Promise<RevocationResult> {
  if (!opts.httpPost && !opts.httpGet) return { status: 'not-checked', details: 'No HTTP transport supplied.' };
  if (!issuer) return { status: 'unknown', details: 'The issuer certificate is not available, so revocation cannot be checked.' };
  const notes: string[] = [];
  const ocspUrls = extensionUris(cert, OID.aia, OID.adOcsp);
  if (opts.httpPost) {
    for (const url of ocspUrls) {
      try {
        const r = await parseOcspResponse(await opts.httpPost(url, 'application/ocsp-request', buildOcspRequest(cert, issuer)), cert, issuer);
        if (r.status === 'good' || r.status === 'revoked') return r;
        notes.push(r.details);
      } catch (e) {
        notes.push(`OCSP ${url} failed: ${e instanceof Error ? e.message : String(e)}.`);
      }
    }
  }
  const crlUrls = extensionUris(cert, OID.crlDp);
  if (opts.httpGet) {
    for (const url of crlUrls) {
      try {
        const r = await checkCrl(await opts.httpGet(url), cert, issuer);
        if (r.status === 'good' || r.status === 'revoked') return r;
        notes.push(r.details);
      } catch (e) {
        notes.push(`CRL ${url} failed: ${e instanceof Error ? e.message : String(e)}.`);
      }
    }
  }
  if (!ocspUrls.length && !crlUrls.length) notes.push('The certificate has no OCSP or CRL location.');
  return { status: 'unknown', details: notes.join(' ') };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface CmsInfo {
  cert: forge.pki.Certificate | null;
  certs: forge.pki.Certificate[];
  integrity: 'valid' | 'invalid' | 'unknown';
  problems: string[];
  signingTime: Date | null;
  timestampTime: Date | null;
  hasTimestamp: boolean;
  digestOid: string | null;
}

/** Verify a detached CMS/PKCS#7 blob against the signed data. */
async function verifyCms(d: Uint8Array, signedData: Uint8Array[]): Promise<CmsInfo> {
  const info: CmsInfo = {
    cert: null,
    certs: [],
    integrity: 'unknown',
    problems: [],
    signingTime: null,
    timestampTime: null,
    hasTimestamp: false,
    digestOid: null,
  };
  const ci = kids(d, readTlv(d, 0));
  if (oidOf(d, ci[0]) !== OID.signedData) {
    info.problems.push('Signature is not a PKCS#7 SignedData structure.');
    return info;
  }
  const sd = kids(d, kids(d, ci[1])[0]);

  const certSet = sd.find((t) => t.tag === 0xa0);
  if (certSet) {
    for (const c of kids(d, certSet)) {
      if (c.tag !== 0x30) continue;
      try {
        info.certs.push(parseCertificate(raw(d, c)));
      } catch {
        /* unsupported certificate: skip */
      }
    }
  }
  const setT = sd[sd.length - 1];
  const signers = setT.tag === 0x31 ? kids(d, setT) : [];
  if (!signers.length) {
    info.problems.push('Signature contains no signer.');
    return info;
  }
  if (signers.length > 1) info.problems.push('Only the first of several signers was checked.');
  const si = kids(d, signers[0]);

  const sid = si[1];
  if (sid.tag === 0x30) {
    const [issuer, serial] = kids(d, sid);
    const want = stripLeadingZeros(content(d, serial));
    info.cert =
      info.certs.find((c) => {
        const m = metaOf(c);
        return bytesEqual(m.issuerDer, raw(d, issuer)) && bytesEqual(stripLeadingZeros(m.serial), want);
      }) ?? null;
  } else if (sid.tag === 0x80) {
    const ski = content(d, sid);
    info.cert =
      info.certs.find((c) => {
        const v = metaOf(c).extensions.get('2.5.29.14');
        return !!v && bytesEqual(content(v, readTlv(v, 0)), ski);
      }) ?? null;
  }

  const digestOid = oidOf(d, kids(d, si[2])[0]);
  info.digestOid = digestOid;
  let idx = 3;
  const signedAttrs = si[idx]?.tag === 0xa0 ? si[idx++] : null;
  const sigAlgOid = oidOf(d, kids(d, si[idx++])[0]);
  const sigValue = si[idx]?.tag === 0x04 ? content(d, si[idx]) : null;
  const unsigned = si.find((t) => t.tag === 0xa1);

  if (unsigned) {
    for (const attr of kids(d, unsigned)) {
      const [oid, values] = kids(d, attr);
      if (oidOf(d, oid) !== OID.timeStampToken) continue;
      info.hasTimestamp = true;
      try {
        const tst = tstInfoOf(raw(d, kids(d, values)[0]).slice());
        info.timestampTime = timeOf(tst.b, tst.kids[4]);
        const mi = kids(tst.b, tst.kids[2]);
        const miAlg = oidOf(tst.b, kids(tst.b, mi[0])[0]);
        if (sigValue && createMd(miAlg) && !bytesEqual(content(tst.b, mi[1]), digest(miAlg, sigValue))) {
          info.problems.push('Timestamp does not match this signature.');
        }
      } catch {
        info.problems.push('Timestamp token could not be parsed.');
      }
    }
  }

  if (!createMd(digestOid)) {
    info.problems.push(`Unsupported digest algorithm ${digestOid}.`);
    return info;
  }
  const contentDigest = digest(digestOid, ...signedData);

  let toVerify: Uint8Array = concatBytes(signedData);
  if (signedAttrs) {
    let messageDigest: Uint8Array | null = null;
    for (const attr of kids(d, signedAttrs)) {
      const [oid, values] = kids(d, attr);
      const type = oidOf(d, oid);
      const first = kids(d, values)[0];
      if (type === OID.messageDigest) messageDigest = octets(d, first);
      else if (type === OID.signingTime) info.signingTime = timeOf(d, first);
    }
    if (!messageDigest || !bytesEqual(messageDigest, contentDigest)) {
      info.integrity = 'invalid';
      info.problems.push('The document was modified after it was signed (digest mismatch).');
      return info;
    }
    // Signed attributes are signed as a SET (0x31), not as the [0] IMPLICIT tag.
    toVerify = raw(d, signedAttrs).slice();
    toVerify[0] = 0x31;
  }

  if (!info.cert) {
    info.problems.push('The signer certificate is not included in the signature.');
    return info;
  }
  if (!sigValue) {
    info.problems.push('Signature value missing.');
    return info;
  }
  const ok = await verifyWithCert(info.cert, sigAlgOid, toVerify, sigValue, digestOid);
  if (ok === null) {
    info.problems.push(`Unsupported signature algorithm (${keyDescription(info.cert)}, ${sigAlgOid}).`);
    return info;
  }
  info.integrity = ok ? 'valid' : 'invalid';
  if (!ok) info.problems.push('The cryptographic signature does not verify against the signer certificate.');
  return info;
}

/** Validate every signed signature field. Never throws for a single bad signature. */
export async function verifyPdfSignatures(pdfBytes: Uint8Array, opts: VerifyOptions = {}): Promise<SignatureValidation[]> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const { sigFields } = collectFields(doc);
  const results: ExtendedValidation[] = [];

  for (const f of sigFields) {
    if (!f.sig) continue;
    const sig = f.sig;
    const r: ExtendedValidation = {
      fieldName: f.fullName,
      signerName: textOf(sig, 'Name') ?? 'Unknown signer',
      signedAt: null,
      reason: textOf(sig, 'Reason'),
      integrity: 'unknown',
      coversWholeFile: false,
      selfSigned: false,
      certSubject: '',
      certIssuer: '',
      certValidFrom: '',
      certValidTo: '',
      hasTimestamp: false,
      message: '',
      chainStatus: 'unknown',
      chainDetails: [],
      revocationStatus: 'not-checked',
      revocationDetails: 'Revocation was not checked.',
      modifiedAfterSigning: true,
    };
    const mDate = textOf(sig, 'M');
    if (mDate) r.signedAt = parsePdfDate(mDate)?.toISOString() ?? null;
    results.push(r);

    try {
      const subFilter = sig.lookupMaybe(PDFName.of('SubFilter'), PDFName)?.decodeText() ?? '';
      const br = sig.lookupMaybe(PDFName.of('ByteRange'), PDFArray);
      const contents = sig.lookup(PDFName.of('Contents'));
      if (!br || br.size() !== 4 || !(contents instanceof PDFHexString || contents instanceof PDFString)) {
        r.message = 'Signature dictionary is missing /ByteRange or /Contents.';
        continue;
      }
      const range = [0, 1, 2, 3].map((i) => {
        const n = br.lookup(i);
        return n instanceof PDFNumber ? n.asNumber() : NaN;
      });
      const [a, b, c, d] = range;
      if (range.some((n) => !Number.isInteger(n) || n < 0) || a + b > c || c + d > pdfBytes.length) {
        r.integrity = 'invalid';
        r.message = 'Signature byte range is malformed or points outside the file.';
        continue;
      }
      r.coversWholeFile = a === 0 && c + d === pdfBytes.length;
      r.modifiedAfterSigning = !r.coversWholeFile;

      if (subFilter && !/^(adbe\.pkcs7\.detached|ETSI\.CAdES\.detached|adbe\.pkcs7\.sha1)$/.test(subFilter)) {
        r.message = `Unsupported signature format /${subFilter}.`;
        continue;
      }
      let blob = contents.asBytes();
      blob = blob.subarray(0, readTlv(blob, 0).end); // strip zero padding after the DER
      const info = await verifyCms(blob, [pdfBytes.subarray(a, a + b), pdfBytes.subarray(c, c + d)]);
      r.integrity = info.integrity;
      r.hasTimestamp = info.hasTimestamp;
      const when = info.timestampTime ?? info.signingTime;
      if (when) r.signedAt = when.toISOString();
      const notes = [...info.problems];

      if (info.cert) {
        const m = metaOf(info.cert);
        r.signerName = certCommonName(info.cert);
        r.selfSigned = isSelfIssued(info.cert);
        r.certSubject = formatDn(info.cert.subject.attributes);
        r.certIssuer = formatDn(info.cert.issuer.attributes);
        r.certValidFrom = m.notBefore.toISOString();
        r.certValidTo = m.notAfter.toISOString();
        r.algorithm = `${keyDescription(info.cert)} / ${HASH_NAME[info.digestOid ?? ''] ?? info.digestOid}`;

        const chain = await buildChain(info.cert, info.certs, opts.trustedRoots ?? [], when ?? new Date());
        r.chainStatus = chain.status;
        r.chainDetails = chain.details;
        if (opts.checkRevocation) {
          const issuer = chain.chain[1] ?? (r.selfSigned ? info.cert : null);
          const rev = r.selfSigned
            ? { status: 'unknown' as const, details: 'Self-signed certificates cannot be revoked.' }
            : await checkRevocation(info.cert, issuer, opts);
          r.revocationStatus = rev.status;
          r.revocationDetails = rev.details;
        }
      }
      if (!r.coversWholeFile) {
        const tail = pdfBytes.subarray(c + d);
        const revisions = (bytesToBinary(tail).match(/%%EOF/g) ?? []).length;
        notes.push(
          revisions
            ? `${tail.length} bytes (${revisions} incremental update${revisions > 1 ? 's' : ''}) were appended after this signature; ` +
                'the signed revision is intact but later changes are not covered by it.'
            : `${tail.length} bytes were appended after this signature and are not covered by it.`,
        );
      }
      r.message = summarise(r, notes);
    } catch (e) {
      r.integrity = 'unknown';
      r.message = `Signature could not be parsed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return results;
}

function summarise(r: ExtendedValidation, notes: string[]): string {
  const parts: string[] = [];
  if (r.integrity === 'valid') parts.push(`Signed by ${r.signerName}. The signed content has not been modified.`);
  else if (r.integrity === 'invalid') parts.push('INVALID signature.');
  else parts.push('Signature validity could not be determined.');
  parts.push(...notes);
  switch (r.chainStatus) {
    case 'trusted':
      parts.push('The certificate chains to a trusted root.');
      break;
    case 'expired':
      parts.push('A certificate in the chain was not valid at signing time.');
      break;
    case 'incomplete':
      parts.push('The certificate chain is incomplete.');
      break;
    case 'untrusted':
      parts.push(
        r.selfSigned
          ? 'The certificate is self-signed, so the signer identity is not vouched for by a trusted authority.'
          : 'The certificate does not chain to a trusted root.',
      );
      break;
  }
  if (r.revocationStatus === 'revoked') parts.push('The signer certificate has been REVOKED.');
  else if (r.revocationStatus === 'good') parts.push('The signer certificate is not revoked.');
  if (r.hasTimestamp) parts.push('Includes an RFC 3161 timestamp (the timestamp authority itself is not validated).');
  return parts.join(' ');
}
