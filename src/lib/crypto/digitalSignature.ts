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
  PDFRef,
  PDFStream,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import type { SignatureValidation } from '../../types';
import { isRevisionEnd, loadRevision, unreferencedObjects, type RevisionView } from './pdfRevisions';

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
  /** RSA keys: the signature is RSASSA-PSS (SHA-256, MGF1-SHA-256, 32-byte salt) instead of PKCS#1 v1.5. */
  rsaPss?: boolean;
  /**
   * Signs DER(signedAttributes as SET) with SHA-256; returns a PKCS#1 v1.5
   * (or PSS) signature (rsa) or a DER ECDSA-Sig-Value (ecdsa; raw r||s is accepted too).
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
  /**
   * A signed PDF gets the new signature as an incremental update (earlier
   * signatures stay valid). true rewrites the whole file instead, which
   * invalidates them.
   */
  allowInvalidatingExisting?: boolean;
  /**
   * Certify the document (first signature only): which changes stay allowed —
   * 1 none, 2 filling in forms and signing, 3 also comments.
   */
  certify?: 1 | 2 | 3;
  /** Lock form fields once signed (FieldMDP /Lock): all, only the listed ones, or all but the listed ones. */
  lock?: { action: 'All' | 'Include' | 'Exclude'; fields?: string[] };
  /** PAdES baseline (EU eIDAS): ETSI.CAdES.detached without the signing-time attribute. */
  pades?: boolean;
  /** Sign into this existing empty signature field (full name); its widget gives page and rectangle, so pageIndex and rect are ignored. */
  intoField?: string;
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
  /** EU Trusted List services (qualified CAs and timestamp authorities) as extra trust anchors. */
  euTrust?: EuTrustIndex;
}

/** Trusted-list certificates by subject Name (hex of its DER). */
export interface EuTrustIndex {
  /** Services whose status was granted at t (default: now). */
  find(subjectHex: string, kind: 'ca' | 'tsa', at?: Date): Array<{ der: Uint8Array; label: string }>;
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
  rsaPss: '1.2.840.113549.1.1.10',
  mgf1: '1.2.840.113549.1.1.8',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  aia: '1.3.6.1.5.5.7.1.1',
  adOcsp: '1.3.6.1.5.5.7.48.1',
  ocspBasic: '1.3.6.1.5.5.7.48.1.1',
  crlDp: '2.5.29.31',
  md5: '1.2.840.113549.2.5',
  md5WithRsa: '1.2.840.113549.1.1.4',
  signingCertV1: '1.2.840.113549.1.9.16.2.12',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  ekuTimeStamping: '1.3.6.1.5.5.7.3.8',
  ekuOcspSigning: '1.3.6.1.5.5.7.3.9',
} as const;

/** Extended key usages a document signing certificate may carry (any one of them). */
const SIGNING_EKUS = new Set([
  '2.5.29.37.0', // anyExtendedKeyUsage
  '1.3.6.1.5.5.7.3.4', // emailProtection
  '1.3.6.1.5.5.7.3.2', // clientAuth
  '1.3.6.1.5.5.7.3.36', // documentSigning
  '1.2.840.113583.1.1.5', // Adobe Authentic Documents Trust
  '1.3.6.1.4.1.311.10.3.12', // Microsoft document signing
  '1.3.6.1.4.1.311.80.1', // Microsoft document encryption (often paired)
]);

/** Clock skew accepted between this computer, signers and servers. */
const CLOCK_TOLERANCE_MS = 15 * 60_000;

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

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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

/** RSASSA-PSS-params: SHA-256, MGF1 with SHA-256, 32-byte salt (DER). */
export function pssSha256Params(): Uint8Array {
  return der(0x30, der(0xa0, algId(OID.sha256, true)), der(0xa1, der(0x30, derOid(OID.mgf1), algId(OID.sha256, true))), der(0xa2, derInt(32)));
}

interface PssParams {
  hashOid: string;
  saltLength: number;
}

/** Parses RSASSA-PSS-params (RFC 4055 defaults: SHA-1, salt 20); null when MGF1 uses another hash than the message. */
function pssParamsOf(b: Uint8Array, t: Tlv | undefined): PssParams | null {
  let hashOid: string = OID.sha1;
  let mgfHash: string = OID.sha1;
  let saltLength = 20;
  if (t && t.tag === 0x30) {
    for (const k of kids(b, t)) {
      const inner = kids(b, k)[0];
      if (k.tag === 0xa0) hashOid = oidOf(b, kids(b, inner)[0]);
      else if (k.tag === 0xa1) {
        const [mgfOid, mgfParams] = kids(b, inner);
        if (oidOf(b, mgfOid) !== OID.mgf1 || !mgfParams) return null;
        mgfHash = oidOf(b, kids(b, mgfParams)[0]);
      } else if (k.tag === 0xa2) saltLength = Number(BigInt('0x' + (bytesToHex(content(b, inner)) || '0')));
    }
  }
  return hashOid === mgfHash ? { hashOid, saltLength } : null;
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

/** Key size in bits (RSA modulus, EC field), or 0 when unknown. */
function keyBits(cert: forge.pki.Certificate): number {
  const m = metaOf(cert);
  if (m.keyAlgorithm === 'rsa') return (cert.publicKey as forge.pki.rsa.PublicKey | null)?.n?.bitLength() ?? 0;
  return m.curve ? m.curve.size * 8 - (m.curve.size === 66 ? 7 : 0) : 0;
}

/** "RSA-1024 is a weak key" style warning for keys below RSA-2048 / EC-256, or null. */
function weakKeyWarning(cert: forge.pki.Certificate): string | null {
  const m = metaOf(cert);
  const bits = keyBits(cert);
  if (!bits) return null;
  if ((m.keyAlgorithm === 'rsa' && bits < 2048) || (m.keyAlgorithm === 'ecdsa' && bits < 256)) {
    return `The key of “${certCommonName(cert)}” (${keyDescription(cert)}) is too short to be considered secure.`;
  }
  return null;
}

/** basicConstraints, or null when the extension is absent. */
function basicConstraintsOf(cert: forge.pki.Certificate): { ca: boolean; pathLen: number | null } | null {
  const v = metaOf(cert).extensions.get(OID.basicConstraints);
  if (!v) return null;
  try {
    const out = { ca: false, pathLen: null as number | null };
    for (const k of kids(v, readTlv(v, 0))) {
      if (k.tag === 0x01) out.ca = content(v, k)[0] !== 0;
      else if (k.tag === 0x02) out.pathLen = [...content(v, k)].reduce((n, x) => n * 256 + x, 0);
    }
    return out;
  } catch {
    return { ca: false, pathLen: 0 };
  }
}

/** keyUsage bit test (0 digitalSignature, 1 nonRepudiation, 5 keyCertSign, 6 cRLSign), or null when absent. */
function keyUsageOf(cert: forge.pki.Certificate): ((bit: number) => boolean) | null {
  const v = metaOf(cert).extensions.get(OID.keyUsage);
  if (!v) return null;
  try {
    const bits = content(v, readTlv(v, 0)).subarray(1);
    return (bit) => (((bits[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1) === 1;
  } catch {
    return () => false;
  }
}

/** extKeyUsage OIDs, or null when absent. */
function extKeyUsageOf(cert: forge.pki.Certificate): string[] | null {
  const v = metaOf(cert).extensions.get(OID.extKeyUsage);
  if (!v) return null;
  try {
    return kids(v, readTlv(v, 0)).map((t) => oidOf(v, t));
  } catch {
    return [];
  }
}

/** Why a certificate may not be used for `purpose`, or null when it may. */
function usageProblem(cert: forge.pki.Certificate, purpose: 'sign' | 'tsa' | 'ocsp'): string | null {
  const name = certCommonName(cert);
  const ku = keyUsageOf(cert);
  if (ku && !ku(0) && !ku(1)) return `The certificate of “${name}” may not be used for signatures (key usage).`;
  const eku = extKeyUsageOf(cert);
  if (purpose === 'sign') {
    if (eku && !eku.some((o) => SIGNING_EKUS.has(o))) return `The certificate of “${name}” is not meant for signing documents (extended key usage).`;
  } else if (purpose === 'tsa') {
    if (!eku?.includes(OID.ekuTimeStamping)) return `The certificate of “${name}” is not a timestamping certificate.`;
  } else if (!eku?.includes(OID.ekuOcspSigning)) return `The certificate of “${name}” is not an OCSP responder certificate.`;
  return null;
}

/** Why `cert` may not issue certificates with `below` intermediates under it, or null. */
function caProblem(cert: forge.pki.Certificate, below: number, anchor: boolean): string | null {
  const name = certCommonName(cert);
  const bc = basicConstraintsOf(cert);
  // Trust anchors from old root stores may lack the extension; anything else must say it is a CA.
  if (bc ? !bc.ca : !anchor) return `“${name}” is not a certificate authority, so it cannot issue certificates (basic constraints).`;
  if (bc?.pathLen !== null && bc?.pathLen !== undefined && below > bc.pathLen) {
    return `“${name}” allows at most ${bc.pathLen} intermediate certificate(s) below it (path length).`;
  }
  const ku = keyUsageOf(cert);
  if (ku && !ku(5)) return `“${name}” may not sign certificates (key usage).`;
  return null;
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
// Signature verification (one strict verifier: Web Crypto for RSA and ECDSA)
// ---------------------------------------------------------------------------

/** Key family a signature algorithm OID belongs to (null: unknown). */
function sigFamily(sigOid: string): KeyAlgorithm | null {
  if (sigOid.startsWith('1.2.840.113549.1.1.')) return 'rsa';
  if (sigOid.startsWith('1.2.840.10045.')) return 'ecdsa';
  return null;
}

/** MD5 is broken: signatures using it are never accepted. */
const isMd5 = (oid: string | null | undefined) => oid === OID.md5 || oid === OID.md5WithRsa;

/**
 * Verify `sig` over `data` with the key of `keyCert` (RSASSA-PKCS1-v1_5 or
 * ECDSA through Web Crypto, which checks the padding strictly; forge's RSA
 * verify is lenient, GHSA-86w9-cpqp-85rv). Every signature (CMS, chain
 * links, OCSP, CRL, timestamps) goes through here. Returns null when the
 * algorithm is not supported.
 */
async function verifyWithCert(
  keyCert: forge.pki.Certificate,
  sigOid: string,
  data: Uint8Array,
  sig: Uint8Array,
  digestOidHint?: string,
  pss?: PssParams | null,
): Promise<boolean | null> {
  const m = metaOf(keyCert);
  if (isMd5(sigOid) || isMd5(digestOidHint)) return false;
  if (sigOid === OID.rsaPss) {
    const pssHash = pss ? HASH_NAME[pss.hashOid] : undefined;
    if (!pss || !pssHash || !globalThis.crypto?.subtle) return null;
    if (m.keyAlgorithm !== 'rsa') return false;
    try {
      const key = await globalThis.crypto.subtle.importKey('spki', buf(m.spki), { name: 'RSA-PSS', hash: pssHash }, false, ['verify']);
      return await globalThis.crypto.subtle.verify({ name: 'RSA-PSS', saltLength: pss.saltLength }, key, buf(sig), buf(data));
    } catch {
      return false;
    }
  }
  const hashOid = SIG_HASH[sigOid] ?? digestOidHint;
  const hash = hashOid ? HASH_NAME[hashOid] : undefined;
  if (!hash) return null;
  const family = sigFamily(sigOid);
  if (family && family !== m.keyAlgorithm) return false;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    if (m.keyAlgorithm === 'rsa') {
      const key = await subtle.importKey('spki', buf(m.spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      // Some signers drop leading zero bytes of the signature value.
      const k = Math.ceil(keyBits(keyCert) / 8);
      const s = k > sig.length ? concatBytes([new Uint8Array(k - sig.length), sig]) : sig;
      if (await subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, buf(s), buf(data))) return true;
      return rsaVerifyAbsentNull(keyCert, hashOid!, data, s);
    }
    if (m.keyAlgorithm === 'ecdsa' && m.curve) {
      const key = await subtle.importKey('spki', buf(m.spki), { name: 'ECDSA', namedCurve: m.curve.name }, false, ['verify']);
      const rawSig = isDerEcdsaSig(sig) ? ecdsaDerToRaw(sig, m.curve.size) : sig;
      return await subtle.verify({ name: 'ECDSA', hash }, key, buf(rawSig), buf(data));
    }
  } catch {
    return false;
  }
  return null;
}

/**
 * RFC 8017 also allows the DigestInfo without the NULL parameters, which
 * Web Crypto rejects. The whole encoded block is rebuilt in that form and
 * compared byte for byte (no parsing, so no room for forged padding).
 */
function rsaVerifyAbsentNull(keyCert: forge.pki.Certificate, hashOid: string, data: Uint8Array, sig: Uint8Array): boolean {
  const pub = keyCert.publicKey as forge.pki.rsa.PublicKey | null;
  if (!pub?.n || !pub.e) return false;
  const n = BigInt('0x' + pub.n.toString(16));
  const e = BigInt('0x' + pub.e.toString(16));
  const k = Math.ceil(keyBits(keyCert) / 8);
  let x = BigInt('0x' + (bytesToHex(sig) || '0'));
  if (x >= n) return false;
  // s^e mod n
  let m = 1n;
  let b = x % n;
  for (let ex = e; ex > 0n; ex >>= 1n) {
    if (ex & 1n) m = (m * b) % n;
    b = (b * b) % n;
  }
  x = m;
  const em = hexToBytes(x.toString(16).padStart(k * 2, '0'));
  const oid = binaryToBytes(forge.asn1.oidToDer(hashOid).getBytes());
  const h = digest(hashOid, data);
  const algId = [0x30, oid.length + 2, 0x06, oid.length, ...oid];
  const info = new Uint8Array([0x30, algId.length + h.length + 2, ...algId, 0x04, h.length, ...h]);
  const ps = k - info.length - 3;
  if (ps < 8) return false;
  const expected = new Uint8Array(k);
  expected[1] = 0x01;
  expected.fill(0xff, 2, 2 + ps);
  expected.set(info, 3 + ps);
  return bytesEqual(em, expected);
}

/** Does `issuer` sign `child`? */
function verifyCertSignature(child: forge.pki.Certificate, issuer: forge.pki.Certificate): Promise<boolean | null> {
  const m = metaOf(child);
  return verifyWithCert(issuer, m.sigOid, m.tbs, m.sigValue);
}

/** True when `issuer` issued `cert` (name match and a verifying signature; RSA and ECDSA). */
export async function certIssuedBy(cert: forge.pki.Certificate, issuer: forge.pki.Certificate): Promise<boolean> {
  if (!bytesEqual(metaOf(cert).issuerDer, metaOf(issuer).subjectDer)) return false;
  return (await verifyCertSignature(cert, issuer)) === true;
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
export async function parseTimeStampResponse(resp: Uint8Array, imprintSha256: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
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
  // Never embed a token whose signature or authority does not hold up.
  const info = await verifyCms(token, [tst.b]);
  if (info.integrity !== 'valid' || !info.cert) {
    throw new Error(`The timestamp server returned a token whose signature does not verify${info.problems.length ? ` (${info.problems.join(' ')})` : ''}.`);
  }
  const usage = usageProblem(info.cert, 'tsa');
  if (usage) throw new Error(`The timestamp server's token cannot be used: ${usage}`);
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
  return fetchTimestampForImprint(url, digest(OID.sha256, signatureValue), fetchImpl);
}

async function fetchTimestampForImprint(url: string, imprint: Uint8Array, fetchImpl: typeof fetch): Promise<Uint8Array> {
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
  return await parseTimeStampResponse(new Uint8Array(await res.arrayBuffer()), imprint, nonce);
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

/** The certificates and key type of a signer, without its signing function. */
export type SignerCertificates = Omit<ExternalSigner, 'sign'>;

/** DER SET of the signed attributes: what the signer's key signs. */
function signedAttributes(signer: SignerCertificates, contentDigest: Uint8Array, signingTime: Date, pades: boolean): Uint8Array {
  const leaf = metaOf(signer.certificate);
  if (leaf.keyAlgorithm !== signer.keyAlgorithm) {
    throw new Error(`Signer key type (${signer.keyAlgorithm}) does not match its certificate (${leaf.keyAlgorithm}).`);
  }
  const issuerSerial = der(0x30, der(0x30, der(0xa4, leaf.issuerDer)), der(0x02, leaf.serial));
  const signingCertV2 = der(0x30, der(0x30, der(0x30, der(0x04, digest(OID.sha256, leaf.der)), issuerSerial)));
  // DER SET OF must be sorted by encoding.
  // PAdES forbids the signing-time attribute: the claimed time is the dictionary's /M.
  const attrs = [
    attribute(OID.contentType, derOid(OID.data)),
    ...(pades ? [] : [attribute(OID.signingTime, derTime(signingTime))]),
    attribute(OID.messageDigest, der(0x04, contentDigest)),
    attribute(OID.signingCertV2, signingCertV2),
  ].sort(compareBytes);
  return der(0x31, ...attrs);
}

/** CMS SignedData around the signed attributes and the signature value over them. */
function assembleCms(signer: SignerCertificates, signedAttrsSet: Uint8Array, signature: Uint8Array): Uint8Array {
  const leaf = metaOf(signer.certificate);
  let sig = signature;
  if (!(sig instanceof Uint8Array) || sig.length === 0) throw new Error('The signer returned no signature.');
  if (signer.keyAlgorithm === 'ecdsa' && !isDerEcdsaSig(sig)) sig = ecdsaRawToDer(sig);

  const sha256Alg = algId(OID.sha256, true);
  const sigAlg =
    signer.keyAlgorithm === 'rsa'
      ? signer.rsaPss
        ? der(0x30, derOid(OID.rsaPss), pssSha256Params())
        : algId(OID.rsaEncryption, true)
      : algId(OID.ecdsaSha256, false);
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
  /** The indirect object holding the signature value dictionary (its /V reference, or the field itself). */
  container: PDFRef | null;
}

/** Walk AcroForm /Fields (with /FT and name inheritance), returning signature fields. */
function collectFields(catalog: PDFDict): { sigFields: SigFieldRef[]; topNames: Set<string> } {
  const sigFields: SigFieldRef[] = [];
  const topNames = new Set<string>();
  const acro = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return { sigFields, topNames };

  const seen = new Set<PDFDict>();
  const visit = (node: PDFDict, ref: PDFRef | null, parentName: string, inheritedFt: string | null, top: boolean) => {
    if (seen.has(node)) return;
    seen.add(node);
    const t = node.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText() ?? null;
    const fullName = t === null ? parentName : parentName ? `${parentName}.${t}` : t;
    if (top && t !== null) topNames.add(t);
    const ft = node.lookupMaybe(PDFName.of('FT'), PDFName)?.decodeText() ?? inheritedFt;
    const kidArr = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    const fieldKids: Array<[PDFDict, PDFRef | null]> = [];
    if (kidArr) {
      for (let i = 0; i < kidArr.size(); i++) {
        const k = kidArr.lookup(i);
        const r = kidArr.get(i);
        if (k instanceof PDFDict && k.has(PDFName.of('T'))) fieldKids.push([k, r instanceof PDFRef ? r : null]);
      }
    }
    if (fieldKids.length) {
      for (const [k, r] of fieldKids) visit(k, r, fullName, ft, false);
      return;
    }
    if (ft === 'Sig') {
      const vRaw = node.get(PDFName.of('V'));
      const v = node.lookup(PDFName.of('V'));
      sigFields.push({ fullName: fullName || 'Signature', field: node, sig: v instanceof PDFDict ? v : null, container: vRaw instanceof PDFRef ? vRaw : ref });
    }
  };
  for (let i = 0; i < fields.size(); i++) {
    const f = fields.lookup(i);
    const r = fields.get(i);
    if (f instanceof PDFDict) visit(f, r instanceof PDFRef ? r : null, '', null, true);
  }
  return { sigFields, topNames };
}

interface EmptySigField {
  name: string;
  field: PDFDict;
  widget: PDFDict;
  pageIndex: number;
  rect: [number, number, number, number];
}

/** Unsigned signature fields with a widget on a page (where a signature can go). */
function emptySignatureFields(doc: PDFDocument): EmptySigField[] {
  const out: EmptySigField[] = [];
  const pages = doc.getPages();
  for (const f of collectFields(doc.catalog).sigFields) {
    if (f.sig) continue;
    let widget: PDFDict | null = f.field.lookup(PDFName.of('Subtype')) === PDFName.of('Widget') ? f.field : null;
    let widgetRef: PDFRef | null = widget ? f.container : null;
    const kids = f.field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!widget && kids) {
      for (let i = 0; i < kids.size() && !widget; i++) {
        const k = kids.lookup(i);
        const r = kids.get(i);
        if (k instanceof PDFDict) {
          widget = k;
          widgetRef = r instanceof PDFRef ? r : null;
        }
      }
    }
    if (!widget) continue;
    const r = widget.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!r || r.size() < 4) continue;
    const nums = [0, 1, 2, 3].map((i) => (r.lookup(i) instanceof PDFNumber ? (r.lookup(i) as PDFNumber).asNumber() : 0));
    const p = widget.get(PDFName.of('P'));
    let pageIndex = p instanceof PDFRef ? pages.findIndex((pg) => pg.ref === p) : -1;
    if (pageIndex < 0 && widgetRef) {
      pageIndex = pages.findIndex((pg) => {
        const annots = pg.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        return !!annots && annots.asArray().some((a) => a === widgetRef);
      });
    }
    if (pageIndex < 0) continue;
    out.push({
      name: f.fullName,
      field: f.field,
      widget,
      pageIndex,
      rect: [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]), Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])],
    });
  }
  return out;
}

/** What batch signing needs to know before signing a file. */
export interface SigningInspection {
  pageCount: number;
  /** Signatures already in the file (a new one is added as an incremental update). */
  signatureCount: number;
  /** Certification level (DocMDP P) when the document is certified. */
  certification: 1 | 2 | 3 | null;
  emptyFields: Array<{ name: string; pageIndex: number; rect: [number, number, number, number] }>;
}

/** Reads a PDF for signing; throws for encrypted or unreadable files. */
export async function inspectForSigning(pdfBytes: Uint8Array): Promise<SigningInspection> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) throw new Error('Cannot sign an encrypted PDF. Remove its password first.');
    throw e;
  }
  return {
    pageCount: doc.getPageCount(),
    signatureCount: collectFields(doc.catalog).sigFields.filter((f) => f.sig).length,
    certification: docMdpLevel(doc.catalog),
    emptyFields: emptySignatureFields(doc).map(({ name, pageIndex, rect }) => ({ name, pageIndex, rect })),
  };
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
    const prepared = await prepareOnce(pdfBytes, opts, signer, displayName, size);
    const result = await prepared.complete(await signer.sign(prepared.signedAttrs));
    if (result.ok) return result.bytes;
    size = Math.ceil((result.needed + 4096) / 1024) * 1024; // grow once and retry
  }
  throw new Error('The signature does not fit into the reserved space.');
}

type SignResult = { ok: true; bytes: Uint8Array } | { ok: false; needed: number };

/** Signing options without the key: the signature value is supplied later (see prepareSignature). */
export type PrepareOptions = SignOptionsBase & { signer: SignerCertificates; displayName?: string };

/**
 * A PDF ready for its signature: the placeholders are written and the signed
 * attributes computed. Signing the attributes (or their hash) can happen
 * elsewhere, e.g. many at once with one authorization.
 */
export interface PreparedSignature {
  /** DER SET of the signed attributes (what ExternalSigner.sign receives). */
  signedAttributes: Uint8Array;
  /** SHA-256 of signedAttributes (what a hash-signing service signs). */
  hash: Uint8Array;
  /** Embeds the signature value (and a timestamp when tsaUrl is set); returns the signed file. */
  finish(signatureValue: Uint8Array): Promise<Uint8Array>;
}

/**
 * First half of signPdf. The hole for the CMS is sized up front from the
 * certificates (a retry would need a second signature).
 */
export async function prepareSignature(pdfBytes: Uint8Array, opts: PrepareOptions): Promise<PreparedSignature> {
  const certBytes = [opts.signer.certificate, ...opts.signer.chain].reduce((n, c) => n + metaOf(c).der.length, 0);
  const estimate = certBytes + 2048 + (opts.tsaUrl ? 8192 : 0);
  const size = Math.max(SIGNATURE_PLACEHOLDER_BYTES, Math.ceil((estimate + 4096) / 1024) * 1024);
  const prepared = await prepareOnce(pdfBytes, opts, opts.signer, opts.displayName ?? certCommonName(opts.signer.certificate), size);
  return {
    signedAttributes: prepared.signedAttrs,
    hash: digest(OID.sha256, prepared.signedAttrs),
    finish: async (sig) => {
      const r = await prepared.complete(sig);
      if (!r.ok) throw new Error('The signature does not fit into the reserved space.');
      return r.bytes;
    },
  };
}

async function prepareOnce(
  pdfBytes: Uint8Array,
  opts: SignOptionsBase,
  signer: SignerCertificates,
  displayName: string,
  placeholderBytes: number,
): Promise<{ signedAttrs: Uint8Array; complete: (sig: Uint8Array) => Promise<SignResult> }> {
  let probe: PDFDocument;
  try {
    probe = await PDFDocument.load(pdfBytes);
  } catch (e) {
    if (e instanceof EncryptedPDFError) throw new Error('Cannot sign an encrypted PDF. Remove its password first.');
    throw e;
  }
  const signedCount = collectFields(probe.catalog).sigFields.filter((f) => f.sig).length;
  if (opts.certify && signedCount > 0) throw new Error('Only the first signature can certify a document; this PDF is already signed.');
  // Already signed: append the new signature as an incremental update, so the
  // earlier signatures stay valid. Otherwise the whole file is written once.
  let bytes: Uint8Array;
  let searchFrom = 0;
  if (signedCount > 0 && !opts.allowInvalidatingExisting) {
    const { incrementalUpdate } = await import('@/lib/pdf/incremental');
    const res = await incrementalUpdate(pdfBytes, (d) => addSignatureObjects(d, opts, displayName, placeholderBytes));
    bytes = res.bytes;
    searchFrom = res.start;
  } else {
    await addSignatureObjects(probe, opts, displayName, placeholderBytes);
    bytes = await probe.save({ useObjectStreams: false });
  }
  const signingTime = opts.signingTime ?? new Date();
  const { contentsStart, contentsEnd } = fillByteRange(bytes, searchFrom, placeholderBytes);
  const contentDigest = digest(OID.sha256, bytes.subarray(0, contentsStart), bytes.subarray(contentsEnd));
  const signedAttrs = signedAttributes(signer, contentDigest, signingTime, !!opts.pades);
  const complete = async (signature: Uint8Array): Promise<SignResult> => {
    let cms = assembleCms(signer, signedAttrs, signature);
    if (opts.tsaUrl) {
      const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
      if (!fetchImpl) throw new Error('No fetch implementation available for the timestamp request.');
      const token = await fetchTimestampToken(opts.tsaUrl, signerSignatureValue(cms), fetchImpl);
      cms = insertTimestampToken(cms, token);
    }
    if (cms.length > placeholderBytes) return { ok: false, needed: cms.length };
    const out = bytes.slice();
    out.set(asciiBytes(bytesToHex(cms).padEnd(placeholderBytes * 2, '0')), contentsStart + 1);
    return { ok: true, bytes: out };
  };
  return { signedAttrs, complete };
}

/** The signature field, widget, value dictionary (with placeholders) and AcroForm entries. */
async function addSignatureObjects(doc: PDFDocument, opts: SignOptionsBase, displayName: string, placeholderBytes: number): Promise<void> {
  const { topNames } = collectFields(doc.catalog);
  const pages = doc.getPages();
  const target = opts.intoField ? emptySignatureFields(doc).find((f) => f.name === opts.intoField) : undefined;
  if (opts.intoField && !target) throw new Error(`There is no empty signature field named “${opts.intoField}”.`);
  if (!target && (!Number.isInteger(opts.pageIndex) || opts.pageIndex < 0 || opts.pageIndex >= pages.length)) {
    throw new Error(`Page index ${opts.pageIndex} is out of range (document has ${pages.length} pages).`);
  }
  const page = pages[target ? target.pageIndex : opts.pageIndex];
  const ctx = doc.context;
  const signingTime = opts.signingTime ?? new Date();

  // --- signature value dictionary with placeholders
  const sigDict = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: opts.pades ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.detached' }) as PDFDict;
  const ph = PDFName.of(BYTE_RANGE_PLACEHOLDER);
  sigDict.set(PDFName.of('ByteRange'), ctx.obj([PDFNumber.of(0), ph, ph, ph]));
  sigDict.set(PDFName.of('Contents'), PDFHexString.of('0'.repeat(placeholderBytes * 2)));
  sigDict.set(PDFName.of('M'), PDFString.of(pdfDate(signingTime)));
  sigDict.set(PDFName.of('Name'), pdfText(displayName));
  if (opts.reason) sigDict.set(PDFName.of('Reason'), pdfText(opts.reason));
  if (opts.location) sigDict.set(PDFName.of('Location'), pdfText(opts.location));
  if (opts.contactInfo) sigDict.set(PDFName.of('ContactInfo'), pdfText(opts.contactInfo));
  if (opts.certify) {
    // Certification (DocMDP): which changes are allowed after this signature.
    sigDict.set(
      PDFName.of('Reference'),
      ctx.obj([{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: opts.certify, V: PDFName.of('1.2') } }]),
    );
  }
  const sigRef = ctx.register(sigDict);
  if (opts.certify) doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: sigRef }));

  // --- appearance stream (image scaled to fill the widget, or empty)
  const [x1, y1, x2, y2] = target ? target.rect : opts.rect;
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

  if (target) {
    // The prepared field keeps its name, widget and position; it gets the value and the appearance.
    target.field.set(PDFName.of('V'), sigRef);
    target.widget.set(PDFName.of('AP'), ctx.obj({ N: apRef }));
    if (opts.lock && !target.field.has(PDFName.of('Lock'))) {
      const lock = ctx.obj({ Type: 'SigFieldLock', Action: opts.lock.action }) as PDFDict;
      if (opts.lock.action !== 'All') lock.set(PDFName.of('Fields'), ctx.obj((opts.lock.fields ?? []).map((n) => pdfText(n))));
      target.field.set(PDFName.of('Lock'), lock);
    }
    doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('SigFlags'), PDFNumber.of(3));
    return;
  }

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
  if (opts.lock) {
    const lock = ctx.obj({ Type: 'SigFieldLock', Action: opts.lock.action }) as PDFDict;
    if (opts.lock.action !== 'All') lock.set(PDFName.of('Fields'), ctx.obj((opts.lock.fields ?? []).map((n) => pdfText(n))));
    widget.set(PDFName.of('Lock'), lock);
  }
  const widgetRef = ctx.register(widget);
  // Add to /Annots directly: page.node.addAnnot would also "normalise" the page
  // (empty resource dictionaries), which shows up as a change after signing.
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) annots.push(widgetRef);
  else page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

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
}

/** Finds the /Contents and /ByteRange placeholders in the written file and fills /ByteRange. */
function fillByteRange(bytes: Uint8Array, searchFrom: number, placeholderBytes: number): { contentsStart: number; contentsEnd: number } {
  const hexPh = asciiBytes('<' + '0'.repeat(placeholderBytes * 2) + '>');
  let contentsStart = -1;
  for (let from = searchFrom; ; ) {
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

  const brMarker = indexOfBytes(bytes, asciiBytes('/' + BYTE_RANGE_PLACEHOLDER), searchFrom);
  if (brMarker < 0) throw new Error('Internal error: /ByteRange placeholder not found in the saved PDF.');
  let brOpen = brMarker;
  while (brOpen > 0 && bytes[brOpen] !== 0x5b /* [ */) brOpen--;
  let brClose = brMarker;
  while (brClose < bytes.length && bytes[brClose] !== 0x5d /* ] */) brClose++;
  const brText = `[${[0, contentsStart, contentsEnd, bytes.length - contentsEnd].join(' ')}`;
  const brLen = brClose - brOpen; // characters before ']'
  if (brText.length > brLen) throw new Error('Internal error: /ByteRange placeholder too small.');
  bytes.set(asciiBytes(brText.padEnd(brLen, ' ')), brOpen);
  return { contentsStart, contentsEnd };
}

/**
 * Document timestamp (PAdES B-LTA, ETSI.RFC3161): a timestamp over the whole
 * file so far, added as an incremental update. Added after the validation
 * data, it protects signatures and validation data against the later
 * weakening of their algorithms; repeating it every few years extends that.
 */
export async function addDocumentTimestamp(pdfBytes: Uint8Array, opts: { tsaUrl: string; fetchImpl?: typeof fetch; fieldName?: string }): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('No fetch implementation available for the timestamp request.');
  let size = 12288;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { incrementalUpdate } = await import('@/lib/pdf/incremental');
    const res = await incrementalUpdate(pdfBytes, (doc) => {
      const ctx = doc.context;
      const { topNames } = collectFields(doc.catalog);
      const ph = PDFName.of(BYTE_RANGE_PLACEHOLDER);
      const v = ctx.obj({ Type: 'DocTimeStamp', Filter: 'Adobe.PPKLite', SubFilter: 'ETSI.RFC3161' }) as PDFDict;
      v.set(PDFName.of('ByteRange'), ctx.obj([PDFNumber.of(0), ph, ph, ph]));
      v.set(PDFName.of('Contents'), PDFHexString.of('0'.repeat(size * 2)));
      const page = doc.getPages()[0];
      const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], F: 132, P: page.ref }) as PDFDict;
      widget.set(PDFName.of('T'), pdfText(uniqueFieldName(opts.fieldName ?? 'DocTimeStamp1', topNames)));
      widget.set(PDFName.of('V'), ctx.register(v));
      const widgetRef = ctx.register(widget);
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (annots instanceof PDFArray) annots.push(widgetRef);
      else page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
      let acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
      if (!acro) {
        acro = ctx.obj({}) as PDFDict;
        doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
      }
      const fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
      if (fields) fields.push(widgetRef);
      else acro.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
      acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
    });
    const bytes = res.bytes;
    const { contentsStart, contentsEnd } = fillByteRange(bytes, res.start, size);
    const imprint = digest(OID.sha256, bytes.subarray(0, contentsStart), bytes.subarray(contentsEnd));
    const token = await fetchTimestampForImprint(opts.tsaUrl, imprint, fetchImpl);
    if (token.length > size) {
      size = Math.ceil((token.length + 2048) / 1024) * 1024;
      continue;
    }
    bytes.set(asciiBytes(bytesToHex(token).padEnd(size * 2, '0')), contentsStart + 1);
    return bytes;
  }
  throw new Error('The timestamp does not fit into the reserved space.');
}

/** PAdES baseline level (ETSI EN 319 142-1) reached by a signature, or null. B-T needs a verified timestamp. */
function padesLevel(subFilter: string, info: CmsInfo, timestampVerified: boolean, ltv: boolean, laterDocTimestamp: boolean): SignatureValidation['padesLevel'] {
  if (subFilter !== 'ETSI.CAdES.detached' || !info.signingCertV2 || info.signingTime) return null;
  if (!timestampVerified) return 'B-B';
  if (!ltv) return 'B-T';
  return laterDocTimestamp ? 'B-LTA' : 'B-LT';
}

// ---------------------------------------------------------------------------
// Chain building
// ---------------------------------------------------------------------------

interface ChainResult {
  status: NonNullable<ExtendedValidation['chainStatus']>;
  details: string[];
  chain: forge.pki.Certificate[];
  /** Weak algorithms or keys in the chain (SHA-1 signatures, short keys). */
  weak: string[];
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
  const weak: string[] = [];

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
    if (isMd5(cm.sigOid)) {
      broken = `${certCommonName(cur)}: its issuer signed it with MD5, which is broken.`;
      break;
    }
    if (SIG_HASH[cm.sigOid] === OID.sha1) weak.push(`“${certCommonName(cur)}” is signed with SHA-1, which is no longer considered secure.`);
    let next: forge.pki.Certificate | null = null;
    let sawCandidate = false;
    let constraint: string | null = null;
    for (const cand of all) {
      if (chain.includes(cand) || !bytesEqual(metaOf(cand).subjectDer, cm.issuerDer)) continue;
      sawCandidate = true;
      if ((await verifyCertSignature(cur, cand)) === true) {
        // Intermediates between this issuer and the leaf (path length).
        const problem = caProblem(cand, chain.length - 1, isTrusted(cand));
        if (problem) {
          constraint = problem;
          continue;
        }
        next = cand;
        break;
      }
    }
    if (!next) {
      if (constraint) broken = constraint;
      else if (sawCandidate) broken = `${certCommonName(cur)}: signature by its issuer does not verify.`;
      break;
    }
    chain.push(next);
    cur = next;
  }
  for (const c of chain) {
    if (isTrusted(c)) continue;
    const w = weakKeyWarning(c);
    if (w) weak.push(w);
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
    details.push(`Not valid at the validation time (${at.toISOString()}): ${expired.map(certCommonName).join(', ')}.`);
  } else if (anchored) status = 'trusted';
  else if (!complete) {
    status = 'incomplete';
    details.push('The issuer certificate is missing, so the chain cannot be completed.');
  } else {
    status = 'untrusted';
    details.push('The chain ends at a root that is not in the trusted root store.');
  }
  return { status, details, chain, weak };
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

/** The time a signature is validated at: a verified timestamp's time, or now. */
interface ValidationTime {
  at: Date;
  fromTimestamp: boolean;
}

const validationNow = (): ValidationTime => ({ at: new Date(), fromTimestamp: false });

/** Why revocation data issued `thisUpdate` (valid until `nextUpdate`) cannot answer for the validation time, or null. */
function staleness(kind: 'OCSP' | 'CRL', when: ValidationTime, thisUpdate: Date | null, nextUpdate: Date | null): string | null {
  if (!thisUpdate) return `${kind}: the answer has no issue date.`;
  const issued = thisUpdate.getTime();
  if (issued > Date.now() + CLOCK_TOLERANCE_MS) return `${kind}: the answer is dated in the future.`;
  const at = when.at.getTime();
  // Issued after the timestamped signing time: it vouches for the certificate at that time.
  if (when.fromTimestamp && issued >= at - CLOCK_TOLERANCE_MS) return null;
  const until = nextUpdate ? nextUpdate.getTime() : issued + 7 * 86400_000;
  if (issued - CLOCK_TOLERANCE_MS <= at && at <= until + CLOCK_TOLERANCE_MS) return null;
  return `${kind}: the answer (issued ${thisUpdate.toISOString()}${nextUpdate ? `, valid until ${nextUpdate.toISOString()}` : ''}) is not current for ${when.at.toISOString()}.`;
}

async function parseOcspResponse(
  resp: Uint8Array,
  cert: forge.pki.Certificate,
  issuer: forge.pki.Certificate,
  when: ValidationTime = validationNow(),
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
  const producedAt = timeOf(b, rd[i + 1]);
  const responses = kids(b, rd[i + 2]);

  // The signature first: the issuer itself, or a responder certificate the issuer
  // gave the OCSP signing purpose (never the certificate being checked).
  const sigOid = oidOf(b, kids(b, sigAlgT)[0]);
  const tbs = raw(b, tbsT);
  const sig = bitString(b, sigT);
  const leafDer = metaOf(cert).der;
  let signed = (await verifyWithCert(issuer, sigOid, tbs, sig)) === true;
  const notes: string[] = [];
  const certsT = basic.find((t) => t.tag === 0xa0);
  if (!signed && certsT) {
    for (const c of kids(b, kids(b, certsT)[0])) {
      let rc: forge.pki.Certificate;
      try {
        rc = parseCertificate(raw(b, c));
      } catch {
        continue;
      }
      const m = metaOf(rc);
      if (bytesEqual(m.der, leafDer) || !(await certIssuedBy(rc, issuer))) continue;
      const usage = usageProblem(rc, 'ocsp');
      if (usage) {
        notes.push(usage);
        continue;
      }
      const t = (producedAt ?? new Date()).getTime();
      if (t < m.notBefore.getTime() - CLOCK_TOLERANCE_MS || t > m.notAfter.getTime() + CLOCK_TOLERANCE_MS) {
        notes.push(`The OCSP responder certificate “${certCommonName(rc)}” was not valid when the answer was produced.`);
        continue;
      }
      if ((await verifyWithCert(rc, sigOid, tbs, sig)) === true) {
        signed = true;
        break;
      }
    }
  }
  if (!signed) return { status: 'unknown', details: ['The OCSP response signature could not be verified (it must come from the issuer or its OCSP responder).', ...notes].join(' ') };
  if (producedAt && producedAt.getTime() > Date.now() + CLOCK_TOLERANCE_MS) return { status: 'unknown', details: 'OCSP: the answer is dated in the future.' };

  // CertID: issuer name hash, issuer key hash and serial number.
  const iss = metaOf(issuer);
  const serial = stripLeadingZeros(metaOf(cert).serial);
  for (const sr of responses) {
    const srKids = kids(b, sr);
    const [certIdT, statusT, thisUpdT] = srKids;
    const idKids = kids(b, certIdT);
    const alg = oidOf(b, kids(b, idKids[0])[0]);
    if (!createMd(alg) || isMd5(alg)) continue;
    if (
      !bytesEqual(stripLeadingZeros(content(b, idKids[3])), serial) ||
      !bytesEqual(content(b, idKids[1]), digest(alg, iss.subjectDer)) ||
      !bytesEqual(content(b, idKids[2]), digest(alg, iss.publicKeyBits))
    ) {
      continue;
    }
    const nextT = srKids.slice(3).find((t) => t.tag === 0xa0);
    const stale = staleness('OCSP', when, timeOf(b, thisUpdT), nextT ? timeOf(b, kids(b, nextT)[0]) : null);
    if (stale) return { status: 'unknown', details: stale };
    if (statusT.tag === 0x80) return { status: 'good', details: 'OCSP: certificate is good.' };
    if (statusT.tag === 0xa1) {
      const revokedAt = timeOf(b, kids(b, statusT)[0]);
      return { status: 'revoked', details: `OCSP: certificate revoked${revokedAt ? ` on ${revokedAt.toISOString()}` : ''}.` };
    }
    return { status: 'unknown', details: 'OCSP: responder does not know this certificate.' };
  }
  return { status: 'unknown', details: 'OCSP response does not cover this certificate.' };
}

async function checkCrl(crl: Uint8Array, cert: forge.pki.Certificate, issuer: forge.pki.Certificate, when: ValidationTime = validationNow()): Promise<RevocationResult> {
  if (crl[0] === 0x2d /* '-' PEM */) {
    const b64 = bytesToBinary(crl).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    crl = binaryToBytes(forge.util.decode64(b64));
  }
  const [tbsT, sigAlgT, sigT] = kids(crl, readTlv(crl, 0));
  const tk = kids(crl, tbsT);
  let i = tk[0].tag === 0x02 ? 1 : 0; // optional version
  i++; // signature algorithm
  if (!bytesEqual(raw(crl, tk[i++]), metaOf(issuer).subjectDer)) return { status: 'unknown', details: 'The CRL was published by another issuer.' };
  const ok = await verifyWithCert(issuer, oidOf(crl, kids(crl, sigAlgT)[0]), raw(crl, tbsT), bitString(crl, sigT));
  if (ok !== true) return { status: 'unknown', details: 'CRL signature could not be verified against the issuer.' };
  const ku = keyUsageOf(issuer);
  if (ku && !ku(6)) return { status: 'unknown', details: 'The issuer may not sign CRLs (key usage).' };
  const thisUpdate = timeOf(crl, tk[i++]);
  let nextUpdate: Date | null = null;
  if (tk[i] && (tk[i].tag === 0x17 || tk[i].tag === 0x18)) nextUpdate = timeOf(crl, tk[i++]);
  const stale = staleness('CRL', when, thisUpdate, nextUpdate);
  if (stale) return { status: 'unknown', details: stale };
  const serial = stripLeadingZeros(metaOf(cert).serial);
  if (tk[i]?.tag === 0x30) {
    for (const entry of kids(crl, tk[i])) {
      const [s, dateT] = kids(crl, entry);
      if (bytesEqual(stripLeadingZeros(content(crl, s)), serial)) {
        const revokedAt = timeOf(crl, dateT);
        return { status: 'revoked', details: `CRL: certificate revoked${revokedAt ? ` on ${revokedAt.toISOString()}` : ''}.` };
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
  when: ValidationTime = validationNow(),
): Promise<RevocationResult> {
  if (!opts.httpPost && !opts.httpGet) return { status: 'not-checked', details: 'No HTTP transport supplied.' };
  if (!issuer) return { status: 'unknown', details: 'The issuer certificate is not available, so revocation cannot be checked.' };
  const notes: string[] = [];
  const ocspUrls = extensionUris(cert, OID.aia, OID.adOcsp);
  if (opts.httpPost) {
    for (const url of ocspUrls) {
      try {
        const r = await parseOcspResponse(await opts.httpPost(url, 'application/ocsp-request', buildOcspRequest(cert, issuer)), cert, issuer, when);
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
        const r = await checkCrl(await opts.httpGet(url), cert, issuer, when);
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
  /** Signer-claimed signing time (informational: only a verified timestamp proves a time). */
  signingTime: Date | null;
  hasTimestamp: boolean;
  digestOid: string | null;
  /** Signature timestamp tokens (unsigned attributes). */
  tokens: Uint8Array[];
  /** ESS signing-certificate-v2 is signed (required by PAdES / CAdES). */
  signingCertV2: boolean;
  /** The signer's signature value (what a signature timestamp covers). */
  sigValue: Uint8Array | null;
  /** Weak algorithms used (SHA-1). */
  weak: string[];
}

/** Why the signed ESS signing-certificate(-v2) attribute does not name `cert`, or null. */
function essProblem(d: Uint8Array, value: Tlv, v2: boolean, cert: forge.pki.Certificate): string | null {
  const mismatch = 'The signed signing-certificate attribute names a different certificate than the one that signed (certificate substitution).';
  try {
    const ids = kids(d, kids(d, value)[0]);
    if (!ids.length) return mismatch;
    const id = kids(d, ids[0]);
    let k = 0;
    let alg: string = v2 ? OID.sha256 : OID.sha1;
    if (v2 && id[0].tag === 0x30) {
      alg = oidOf(d, kids(d, id[0])[0]);
      k = 1;
    }
    const m = metaOf(cert);
    if (!createMd(alg) || isMd5(alg)) return null; // cannot be checked
    if (!bytesEqual(content(d, id[k]), digest(alg, m.der))) return mismatch;
    const issuerSerial = id[k + 1];
    if (issuerSerial) {
      const serial = kids(d, issuerSerial)[1];
      if (serial && !bytesEqual(stripLeadingZeros(content(d, serial)), stripLeadingZeros(m.serial))) return mismatch;
    }
    return null;
  } catch {
    return 'The signing-certificate attribute is malformed.';
  }
}

/** Verify a detached CMS/PKCS#7 blob against the signed data. */
async function verifyCms(d: Uint8Array, signedData: Uint8Array[]): Promise<CmsInfo> {
  const info: CmsInfo = {
    cert: null,
    certs: [],
    integrity: 'unknown',
    problems: [],
    signingTime: null,
    hasTimestamp: false,
    digestOid: null,
    tokens: [],
    signingCertV2: false,
    sigValue: null,
    weak: [],
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
  const [sigAlgOidT, sigAlgParamsT] = kids(d, si[idx++]);
  const sigAlgOid = oidOf(d, sigAlgOidT);
  const pss = sigAlgOid === OID.rsaPss ? pssParamsOf(d, sigAlgParamsT) : null;
  const sigValue = si[idx]?.tag === 0x04 ? content(d, si[idx]) : null;
  info.sigValue = sigValue ? sigValue.slice() : null;
  const unsigned = si.find((t) => t.tag === 0xa1);

  if (unsigned) {
    for (const attr of kids(d, unsigned)) {
      const [oid, values] = kids(d, attr);
      if (oidOf(d, oid) !== OID.timeStampToken) continue;
      info.hasTimestamp = true;
      try {
        info.tokens.push(raw(d, kids(d, values)[0]).slice());
      } catch {
        info.problems.push('Timestamp token could not be parsed.');
      }
    }
  }

  if (isMd5(digestOid) || isMd5(sigAlgOid)) {
    info.integrity = 'invalid';
    info.problems.push('The signature uses MD5, which is broken, so it cannot be relied on.');
    return info;
  }
  if (!createMd(digestOid)) {
    info.problems.push(`Unsupported digest algorithm ${digestOid}.`);
    return info;
  }
  if (digestOid === OID.sha1 || SIG_HASH[sigAlgOid] === OID.sha1) info.weak.push('The signature uses SHA-1, which is no longer considered secure.');
  const contentDigest = digest(digestOid, ...signedData);

  let toVerify: Uint8Array = concatBytes(signedData);
  let ess: { t: Tlv; v2: boolean } | null = null;
  if (signedAttrs) {
    let messageDigest: Uint8Array | null = null;
    for (const attr of kids(d, signedAttrs)) {
      const [oid, values] = kids(d, attr);
      const type = oidOf(d, oid);
      const first = kids(d, values)[0];
      if (type === OID.messageDigest) messageDigest = octets(d, first);
      else if (type === OID.signingTime) info.signingTime = timeOf(d, first);
      else if (type === OID.signingCertV2) {
        info.signingCertV2 = true;
        ess = { t: first, v2: true };
      } else if (type === OID.signingCertV1 && !ess) ess = { t: first, v2: false };
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
  if (ess) {
    const problem = essProblem(d, ess.t, ess.v2, info.cert);
    if (problem) {
      info.integrity = 'invalid';
      info.problems.push(problem);
      return info;
    }
  }
  const ok = await verifyWithCert(info.cert, sigAlgOid, toVerify, sigValue, digestOid, pss);
  if (ok === null) {
    info.problems.push(`Unsupported signature algorithm (${keyDescription(info.cert)}, ${sigAlgOid}).`);
    return info;
  }
  info.integrity = ok ? 'valid' : 'invalid';
  if (!ok) info.problems.push('The cryptographic signature does not verify against the signer certificate.');
  return info;
}

interface TrustContext {
  trustedRoots: forge.pki.Certificate[];
  euTrust?: EuTrustIndex;
  /** Extra certificates for chain building (validation data in the file). */
  pool: forge.pki.Certificate[];
}

interface TimestampCheck {
  /** Signature, imprint, timestamping certificate and trust all hold. */
  verified: boolean;
  /** Token signature and imprint (whether the stamped data is unchanged). */
  integrity: 'valid' | 'invalid' | 'unknown';
  genTime: Date | null;
  problems: string[];
  info: CmsInfo | null;
}

/**
 * Checks an RFC 3161 timestamp token over `imprinted` (the signature value,
 * or the document's byte ranges): the TSA's CMS signature over the TSTInfo,
 * the message imprint, a timestamping certificate, and a chain to a trusted
 * root or the EU Trusted List at the time of the timestamp.
 */
async function verifyTimestampToken(token: Uint8Array, imprinted: Uint8Array[], trust: TrustContext, imprintMismatch: string): Promise<TimestampCheck> {
  const out: TimestampCheck = { verified: false, integrity: 'unknown', genTime: null, problems: [], info: null };
  let tst: { b: Uint8Array; kids: Tlv[] };
  try {
    tst = tstInfoOf(token);
  } catch {
    out.problems.push('The timestamp token could not be read.');
    return out;
  }
  out.genTime = timeOf(tst.b, tst.kids[4]);
  const mi = kids(tst.b, tst.kids[2]);
  const miAlg = oidOf(tst.b, kids(tst.b, mi[0])[0]);
  const info = await verifyCms(token, [tst.b]);
  out.info = info;
  out.integrity = info.integrity;
  out.problems.push(...info.problems);
  if (!createMd(miAlg) || isMd5(miAlg)) {
    out.integrity = 'unknown';
    out.problems.push(`Unsupported digest algorithm ${miAlg}.`);
  } else if (!bytesEqual(content(tst.b, mi[1]), digest(miAlg, ...imprinted))) {
    out.integrity = 'invalid';
    out.problems.push(imprintMismatch);
  }
  if (out.integrity !== 'valid' || !info.cert) {
    if (out.integrity === 'valid') out.integrity = 'unknown';
    return out;
  }
  if (!out.genTime || out.genTime.getTime() > Date.now() + CLOCK_TOLERANCE_MS) {
    out.problems.push('The timestamp has no valid time.');
    return out;
  }
  const usage = usageProblem(info.cert, 'tsa');
  if (usage) {
    out.problems.push(usage);
    return out;
  }
  const pool = [...info.certs, ...trust.pool];
  const chain = await buildChain(info.cert, pool, trust.trustedRoots, out.genTime);
  const eu = chain.status !== 'trusted' && trust.euTrust ? await euTrustOf(info.cert, pool, 'tsa', out.genTime, trust.euTrust) : null;
  if (chain.status !== 'trusted' && !eu) {
    out.problems.push(`The timestamp authority “${certCommonName(info.cert)}” is not trusted.`);
    return out;
  }
  out.verified = true;
  return out;
}

/** Why the /ByteRange does not describe a proper signature of this dictionary, or null. */
function byteRangeProblem(
  bytes: Uint8Array,
  [a, b, c, d]: number[],
  contents: PDFHexString | PDFString,
  container: PDFRef | null,
  signedRevision: RevisionView | null,
): string | null {
  if (a !== 0) return 'The signature byte range does not start at the beginning of the file.';
  if (!(b > 0 && c > b + 1 && c + d <= bytes.length)) return 'Signature byte range is malformed or points outside the file.';
  // The gap holds exactly "<hex digits>" and nothing else.
  if (bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e || !(contents instanceof PDFHexString)) return 'The unsigned gap of the byte range contains more than the signature value.';
  const hexDigit = (x: number) => (x >= 0x30 && x <= 0x39) || (x >= 0x41 && x <= 0x46) || (x >= 0x61 && x <= 0x66);
  for (let i = b + 1; i < c - 1; i++) if (!hexDigit(bytes[i])) return 'The unsigned gap of the byte range contains more than the signature value.';
  const gap = bytes.subarray(b + 1, c - 1);
  const gapBytes = new Uint8Array(Math.ceil(gap.length / 2));
  for (let i = 0; i < gap.length; i++) {
    const x = gap[i];
    const v = x <= 0x39 ? x - 0x30 : (x | 0x20) - 0x57;
    gapBytes[i >> 1] |= i & 1 ? v : v << 4;
  }
  if (!bytesEqual(gapBytes, contents.asBytes())) return 'The unsigned gap of the byte range is not the /Contents of this signature.';
  if (!isRevisionEnd(bytes, c + d)) return 'The signed byte range does not end at the end of a revision.';
  if (signedRevision && container) {
    const span = signedRevision.spans.get(container.objectNumber);
    if (!span || !(span[0] < b && c <= span[1])) return 'The unsigned gap of the byte range lies outside this signature dictionary.';
  }
  return null;
}

/** Validate every signed signature field. Never throws for a single bad signature. */
export async function verifyPdfSignatures(pdfBytes: Uint8Array, opts: VerifyOptions = {}): Promise<SignatureValidation[]> {
  // Read the file the way viewers do (through the cross-reference chain);
  // pdf-lib, which reconstructs broken files, is the fallback.
  let finalView: RevisionView | null = null;
  try {
    finalView = loadRevision(pdfBytes);
  } catch {
    /* damaged cross-reference data */
  }
  const catalog = finalView?.catalog ?? (await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false })).catalog;
  const { sigFields } = collectFields(catalog);
  const results: ExtendedValidation[] = [];
  const dss = readDss(catalog);
  const signedEnds: Array<{ r: ExtendedValidation; end: number; doc: boolean; subFilter?: string; info?: CmsInfo }> = [];
  const trust: TrustContext = { trustedRoots: opts.trustedRoots ?? [], euTrust: opts.euTrust, pool: dss?.certs ?? [] };

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
      timestampVerified: false,
      message: '',
      chainStatus: 'unknown',
      chainDetails: [],
      revocationStatus: 'not-checked',
      revocationDetails: 'Revocation was not checked.',
      modifiedAfterSigning: true,
      warnings: [],
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
      let signedView: RevisionView | null = c + d === pdfBytes.length ? finalView : null;
      if (!signedView) {
        try {
          signedView = loadRevision(pdfBytes, c + d);
        } catch {
          /* checked below */
        }
      }
      const rangeProblem = byteRangeProblem(pdfBytes, range, contents, f.container, signedView);
      if (rangeProblem) {
        r.integrity = 'invalid';
        r.message = `INVALID signature. ${rangeProblem}`;
        continue;
      }
      r.coversWholeFile = c + d === pdfBytes.length;
      r.modifiedAfterSigning = !r.coversWholeFile;

      if (subFilter && !/^(adbe\.pkcs7\.detached|ETSI\.CAdES\.detached|adbe\.pkcs7\.sha1|ETSI\.RFC3161)$/.test(subFilter)) {
        r.message = `Unsupported signature format /${subFilter}.`;
        continue;
      }
      let blob = contents.asBytes();
      blob = blob.subarray(0, readTlv(blob, 0).end); // strip zero padding after the DER
      const ranges = [pdfBytes.subarray(a, a + b), pdfBytes.subarray(c, c + d)];
      const notes: string[] = [];
      const warnings: string[] = [];
      let info: CmsInfo;
      // A verified timestamp proves when the signature existed; otherwise it is validated now.
      let tsTime: Date | null = null;
      const isDocTs = subFilter === 'ETSI.RFC3161';
      if (isDocTs) {
        const ts = await verifyTimestampToken(blob, ranges, trust, 'The document was modified after the timestamp (digest mismatch).');
        info = ts.info ?? (await verifyCms(blob, ranges));
        info.integrity = ts.integrity;
        info.problems = ts.problems;
        r.documentTimestamp = true;
        r.hasTimestamp = true;
        if (ts.genTime) r.signedAt = ts.genTime.toISOString();
        if (ts.verified) tsTime = ts.genTime;
        signedEnds.push({ r, end: c + d, doc: true });
      } else {
        info = await verifyCms(blob, ranges);
        r.hasTimestamp = info.hasTimestamp;
        if (info.signingTime) r.signedAt = info.signingTime.toISOString();
        if (info.sigValue) {
          const tsProblems: string[] = [];
          for (const t of info.tokens) {
            const ts = await verifyTimestampToken(t, [info.sigValue], { ...trust, pool: [...info.certs, ...trust.pool] }, 'The timestamp does not belong to this signature (message imprint mismatch).');
            if (ts.verified) {
              tsTime = ts.genTime;
              break;
            }
            tsProblems.push(...ts.problems);
          }
          if (info.tokens.length && !tsTime) {
            notes.push(`The timestamp could not be verified, so the signing time is only the signer’s claim: ${[...new Set(tsProblems)].join(' ')}`);
          }
        }
        if (tsTime) r.signedAt = tsTime.toISOString();
        signedEnds.push({ r, end: c + d, doc: false, subFilter, info });
      }
      r.timestampVerified = !!tsTime;
      const when: ValidationTime = tsTime ? { at: tsTime, fromTimestamp: true } : validationNow();
      r.integrity = info.integrity;
      notes.unshift(...info.problems);
      warnings.push(...info.weak);

      if (info.cert) {
        const m = metaOf(info.cert);
        r.signerName = certCommonName(info.cert);
        r.selfSigned = isSelfIssued(info.cert);
        r.certSubject = formatDn(info.cert.subject.attributes);
        r.certIssuer = formatDn(info.cert.issuer.attributes);
        r.certValidFrom = m.notBefore.toISOString();
        r.certValidTo = m.notAfter.toISOString();
        r.algorithm = `${keyDescription(info.cert)} / ${HASH_NAME[info.digestOid ?? ''] ?? info.digestOid}`;

        const pool = [...info.certs, ...trust.pool];
        const chain = await buildChain(info.cert, pool, trust.trustedRoots, when.at);
        r.chainStatus = chain.status;
        r.chainDetails = chain.details;
        warnings.push(...chain.weak);
        const keyWarning = weakKeyWarning(info.cert);
        if (keyWarning) warnings.push(keyWarning);
        const qc = qcStatementsOf(info.cert);
        r.qualified = qc.compliance ? (qc.qscd ? 'qscd' : 'qc') : null;
        if (opts.euTrust) {
          const eu = await euTrustOf(info.cert, pool, isDocTs ? 'tsa' : 'ca', when.at, opts.euTrust);
          r.euTrusted = eu;
          if (eu && r.chainStatus !== 'trusted' && r.chainStatus !== 'expired') {
            r.chainStatus = 'trusted';
            r.chainDetails = [...(r.chainDetails ?? []), `Trusted through the EU Trusted List (${eu}).`];
          }
        }
        const usage = usageProblem(info.cert, isDocTs ? 'tsa' : 'sign');
        if (usage) {
          r.chainStatus = 'untrusted';
          r.chainDetails = [...(r.chainDetails ?? []), usage];
          warnings.push(usage);
        }

        // Validation data saved in the file answers offline, years later; an online
        // check the user asked for takes priority.
        const issuer = chain.chain[1] ?? (r.selfSigned ? info.cert : null);
        let rev: RevocationResult | null = null;
        let online: RevocationResult | null = null;
        if (opts.checkRevocation) {
          online = r.selfSigned ? { status: 'unknown', details: 'Self-signed certificates cannot be revoked.' } : await checkRevocation(info.cert, issuer, opts, when);
          if (online.status === 'good' || online.status === 'revoked') rev = online;
        }
        if (!rev && dss && !r.selfSigned) rev = await revocationFromDss(info.cert, issuer, dss, when);
        rev ??= online;
        if (rev) {
          r.revocationStatus = rev.status;
          r.revocationDetails = rev.details;
        }
        if (dss) {
          const need = chain.chain.filter((x) => !isSelfIssued(x));
          const answers = await Promise.all(need.map((x) => revocationFromDss(x, chain.chain[chain.chain.indexOf(x) + 1] ?? null, dss, when)));
          r.ltv = need.length > 0 && answers.every(Boolean);
        }
      }
      r.certified = certificationOf(catalog, sig);
      if (!r.coversWholeFile) {
        // Adding validation data, signatures and field values after signing is allowed (as in Acrobat).
        const docMdp = signedView ? docMdpLevel(signedView.catalog) : r.certified ?? null;
        const later = await classifyLaterChanges(pdfBytes.subarray(0, c + d), pdfBytes, { locked: fieldLock(f.field) ?? undefined, views: { signed: signedView, final: finalView } });
        r.laterChanges = later;
        r.modifiedAfterSigning =
          later.other ||
          (docMdp === 1 && (later.form || later.signatures || !!later.annotations)) ||
          // Certified documents allow: 1 nothing, 2 form filling and signing, 3 also comments; a plain signature allows comments.
          (docMdp === 2 && !!later.annotations);
        const tail = pdfBytes.subarray(c + d);
        const revisions = (bytesToBinary(tail).match(/%%EOF/g) ?? []).length;
        const allowed = [
          later.ltv ? 'validation data was added' : '',
          later.signatures ? 'more signatures were added' : '',
          later.form ? 'form fields were filled in' : '',
          later.annotations ? 'comments were added or changed' : '',
        ].filter(Boolean);
        if (!r.modifiedAfterSigning && allowed.length) notes.push(`After signing, ${allowed.join(', ')} (allowed changes).`);
        else {
          notes.push(
            revisions
              ? `${tail.length} bytes (${revisions} incremental update${revisions > 1 ? 's' : ''}) were appended after this signature; ` +
                  'the signed revision is intact but later changes are not covered by it.'
              : `${tail.length} bytes were appended after this signature and are not covered by it.`,
          );
          if (later.reasons?.length) notes.push(later.reasons.join(' '));
        }
      }
      r.warnings = [...new Set(warnings)];
      r.message = summarise(r, notes);
    } catch (e) {
      r.integrity = 'unknown';
      r.message = `Signature could not be parsed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  // PAdES level: B-LTA needs a valid, verified document timestamp after the signature.
  for (const s of signedEnds) {
    if (s.doc || !s.info || s.r.integrity !== 'valid') continue;
    const later = signedEnds.some((o) => o.doc && o.end > s.end && o.r.integrity === 'valid' && o.r.timestampVerified);
    s.r.padesLevel = padesLevel(s.subFilter ?? '', s.info, !!s.r.timestampVerified, !!s.r.ltv, later);
    if (s.r.padesLevel) s.r.message += ` PAdES baseline ${s.r.padesLevel}.`;
  }
  return results;
}

/** The EU Trusted List service the certificate chains to at `at`, or null. */
async function euTrustOf(cert: forge.pki.Certificate, pool: forge.pki.Certificate[], kind: 'ca' | 'tsa', at: Date, index: EuTrustIndex): Promise<string | null> {
  const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
  const m = metaOf(cert);
  // A timestamp authority is often listed with its own certificate.
  const own = index.find(hex(m.subjectDer), kind, at).find((s) => bytesEqual(s.der, m.der));
  if (own) return own.label;
  const anchors: forge.pki.Certificate[] = [];
  const labels = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of [cert, ...pool]) {
    const issuer = hex(metaOf(c).issuerDer);
    if (seen.has(issuer)) continue;
    seen.add(issuer);
    for (const s of index.find(issuer, kind, at)) {
      try {
        const a = parseCertificate(s.der);
        anchors.push(a);
        labels.set(hex(s.der), s.label);
      } catch {
        /* unparsable service certificate */
      }
    }
  }
  if (!anchors.length) return null;
  const chain = await buildChain(cert, pool, anchors, at);
  if (chain.status !== 'trusted') return null;
  // The chain may hold the copy embedded in the signature: match by DER.
  for (const c of chain.chain) {
    const label = labels.get(hex(metaOf(c).der));
    if (label) return label;
  }
  return null;
}

/** ETSI EN 319 412-5 QcStatements: EU qualified certificate, key in a qualified device (QSCD). */
export function qcStatementsOf(cert: forge.pki.Certificate): { compliance: boolean; qscd: boolean } {
  const out = { compliance: false, qscd: false };
  const v = metaOf(cert).extensions.get('1.3.6.1.5.5.7.1.3');
  if (!v) return out;
  try {
    for (const st of kids(v, readTlv(v, 0))) {
      const id = oidOf(v, kids(v, st)[0]);
      if (id === '0.4.0.1862.1.1') out.compliance = true;
      else if (id === '0.4.0.1862.1.4') out.qscd = true;
    }
  } catch {
    /* malformed extension: not qualified */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changes after signing, validation data (DSS), certification
// ---------------------------------------------------------------------------

function pdfObjBytes(obj: unknown): string {
  const o = obj as { sizeInBytes?: () => number; copyBytesInto?: (b: Uint8Array, off: number) => number };
  if (!o || typeof o.sizeInBytes !== 'function') return String(obj);
  const out = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto!(out, 0);
  return bytesToBinary(out);
}

export interface LaterChanges {
  /** Validation data (DSS) or document timestamps were added or extended. */
  ltv: boolean;
  /** More signatures were added. */
  signatures: boolean;
  /** Form fields were filled in. */
  form: boolean;
  /** Comments (annotations) were added, changed or removed. */
  annotations?: boolean;
  /** Anything else (pages, content, fields added or removed…). */
  other: boolean;
  /** What the "other" changes were. */
  reasons?: string[];
}

export interface LaterChangeRules {
  /** Fields the signature locked (FieldMDP): changing them is not allowed. */
  locked?: (fullName: string) => boolean;
  /** Already loaded views of the signed revision and of the final file (saves parsing them again). */
  views?: { signed?: RevisionView | null; final?: RevisionView | null };
}

/** LTV structures reachable from /DSS: the dictionaries and arrays ('container') and the data streams in them. */
function ltvRoles(v: RevisionView): Map<string, 'container' | 'data'> {
  const out = new Map<string, 'container' | 'data'>();
  const ctx = v.context;
  const mark = (x: unknown, role: 'container' | 'data'): unknown => {
    if (!(x instanceof PDFRef)) return x;
    const o = ctx.lookup(x);
    if (role === 'data' && !(o instanceof PDFStream)) return o;
    if (!out.has(x.toString())) out.set(x.toString(), role);
    return o;
  };
  const dataArray = (x: unknown) => {
    const arr = mark(x, 'container');
    if (arr instanceof PDFArray) for (const item of arr.asArray()) mark(item, 'data');
  };
  const dss = mark(v.catalog.get(PDFName.of('DSS')), 'container');
  if (!(dss instanceof PDFDict)) return out;
  for (const k of ['Certs', 'OCSPs', 'CRLs']) dataArray(dss.get(PDFName.of(k)));
  const vri = mark(dss.get(PDFName.of('VRI')), 'container');
  if (vri instanceof PDFDict) {
    for (const [, e] of vri.entries()) {
      const entry = mark(e, 'container');
      if (!(entry instanceof PDFDict)) continue;
      for (const k of ['Cert', 'OCSP', 'CRL']) dataArray(entry.get(PDFName.of(k)));
      mark(entry.get(PDFName.of('TS')), 'data');
    }
  }
  return out;
}

/**
 * What the revisions after a signature changed: compares the objects in
 * effect in the signed revision with those of the final file (both found
 * through the cross-reference chain, as viewers do). Adding validation data,
 * signatures and field values are the changes Acrobat allows after signing;
 * comments are reported separately (allowed only by certification level 3).
 */
export async function classifyLaterChanges(signedRevision: Uint8Array, full: Uint8Array, rules: LaterChangeRules = {}): Promise<LaterChanges> {
  const res: LaterChanges = { ltv: false, signatures: false, form: false, other: false };
  const reasons: string[] = [];
  const other = (why: string) => {
    res.other = true;
    if (!reasons.includes(why) && reasons.length < 8) reasons.push(why);
  };
  let a: RevisionView;
  let b: RevisionView;
  try {
    a = rules.views?.signed ?? loadRevision(full, signedRevision.length);
    b = rules.views?.final ?? loadRevision(full);
  } catch {
    return { ...res, other: true, reasons: ['The cross-reference data of the later revisions cannot be read.'] };
  }
  for (const p of b.problems) if (!a.problems.includes(p)) other(p);
  const unref = unreferencedObjects(full, signedRevision.length, b);
  if (unref.length) other('Objects were added after signing without being listed in the cross-reference table (hidden duplicates).');

  const ser = pdfObjBytes;
  const resolve = (v: RevisionView, x: unknown) => (x instanceof PDFRef ? v.context.lookup(x) : x);
  const keyOf = (x: unknown) => (x instanceof PDFRef ? x.toString() : null);
  const ltvA = ltvRoles(a);
  const ltvB = ltvRoles(b);

  // Field tree of the final file: names and parents.
  const fieldNames = new Map<PDFDict, string>();
  const nameOf = (d: PDFDict): string => {
    const parts: string[] = [];
    for (let n: unknown = d, i = 0; n instanceof PDFDict && i < 32; n = n.lookup(PDFName.of('Parent')), i++) {
      const t = n.lookup(PDFName.of('T'));
      if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText());
    }
    return parts.join('.');
  };
  const inherited = (d: PDFDict, key: string): unknown => {
    for (let n: unknown = d, i = 0; n instanceof PDFDict && i < 32; n = n.lookup(PDFName.of('Parent')), i++) {
      const v = n.get(PDFName.of(key));
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const isSigField = (d: PDFDict) => inherited(d, 'FT') === PDFName.of('Sig');
  const isLocked = (d: PDFDict) => !!rules.locked?.(fieldNames.get(d) ?? nameOf(d));
  /** The field (with /T) a widget belongs to: itself when merged, else its parent. */
  const fieldRefOf = (d: PDFDict, ref: PDFRef | null): PDFRef | null => {
    if (d.has(PDFName.of('T')) || !(d.get(PDFName.of('Parent')) instanceof PDFRef)) return ref;
    return d.get(PDFName.of('Parent')) as PDFRef;
  };
  const valueChanged = (fieldRef: PDFRef | null): boolean => {
    if (!fieldRef) return false;
    const fa = a.context.lookup(fieldRef);
    const fb = b.context.lookup(fieldRef);
    if (!(fa instanceof PDFDict) || !(fb instanceof PDFDict)) return false;
    return ser(fa.get(PDFName.of('V'))) !== ser(fb.get(PDFName.of('V')));
  };
  const visible = (d: PDFDict): boolean => {
    const flags = (d.lookup(PDFName.of('F')) as PDFNumber | undefined)?.asNumber?.() ?? 0;
    if (flags & (2 | 32)) return false; // Hidden, NoView
    const rect = d.lookup(PDFName.of('Rect'));
    if (rect instanceof PDFArray && rect.size() === 4) {
      const [x1, y1, x2, y2] = rect.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0));
      if (Math.abs(x2 - x1) < 0.5 || Math.abs(y2 - y1) < 0.5) return false;
    }
    const ap = d.lookup(PDFName.of('AP'));
    const n = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : undefined;
    const streams = n instanceof PDFDict && !(n instanceof PDFStream) ? n.asMap().values() : [n];
    for (const s of streams) {
      const st = resolve(b, s);
      if (!(st instanceof PDFRawStream)) continue;
      try {
        if (bytesToBinary(decodePDFRawStream(st).decode()).trim()) return true;
      } catch {
        return true;
      }
    }
    return false;
  };
  const hasScript = (d: PDFDict) => d.has(PDFName.of('AA')) || /\/JavaScript\b/.test(ser(d.lookup(PDFName.of('A'))));

  /** A signature widget or field that is new after signing. */
  const newSigWidget = (d: PDFDict) => {
    const v = resolve(b, inherited(d, 'V'));
    if (v instanceof PDFDict && v.lookup(PDFName.of('Type')) === PDFName.of('DocTimeStamp')) res.ltv = true;
    else if (v instanceof PDFDict) res.signatures = true;
    else if (visible(d)) other('An unsigned signature field with a visible appearance was added.');
    else res.signatures = true;
  };
  const newAnnot = (x: unknown) => {
    const d = resolve(b, x);
    if (!(d instanceof PDFDict)) return other('A page annotation was changed.');
    if (d.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) {
      if (isSigField(d)) newSigWidget(d);
      else other('A form field was added.');
    } else if (hasScript(d)) other('An annotation with a script was added.');
    else res.annotations = true;
  };
  const newField = (x: unknown) => {
    const d = resolve(b, x);
    if (!(d instanceof PDFDict) || !isSigField(d)) return other('A form field was added.');
    const k = d.lookup(PDFName.of('Kids'));
    if (k instanceof PDFArray && k.size()) for (const w of k.asArray()) newAnnot(w);
    else newSigWidget(d);
  };
  const itemKeys = (arr: unknown) => (arr instanceof PDFArray ? arr.asArray().map((x) => keyOf(x) ?? ser(x)) : []);
  const annotsDiff = (oldArr: unknown, newArr: unknown) => {
    const o = itemKeys(resolve(a, oldArr));
    const n = resolve(b, newArr);
    const nk = itemKeys(n);
    if (!(n instanceof PDFArray) && newArr !== undefined) return other('A page annotation list was replaced.');
    nk.forEach((k, i) => {
      if (!o.includes(k)) newAnnot((n as PDFArray).get(i));
    });
    const oldArray = resolve(a, oldArr);
    o.forEach((k, i) => {
      if (nk.includes(k)) return;
      const d = resolve(a, (oldArray as PDFArray).get(i));
      if (d instanceof PDFDict && d.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) other('A form field or signature was removed from a page.');
      else res.annotations = true;
    });
  };

  // Indirect /Annots arrays and appearance streams of the final file, by owner.
  const annotArrays = new Set<string>();
  const apOwners = new Map<string, { widget: PDFDict; ref: PDFRef | null }>();
  const noteWidget = (x: unknown) => {
    const w = resolve(b, x);
    if (!(w instanceof PDFDict)) return;
    const ap = w.lookup(PDFName.of('AP'));
    if (!(ap instanceof PDFDict)) return;
    for (const [, v] of ap.entries()) {
      const s = resolve(b, v);
      const refs = s instanceof PDFDict && !(s instanceof PDFStream) ? [...s.asMap().values()] : [v];
      for (const r of refs) if (r instanceof PDFRef) apOwners.set(r.toString(), { widget: w, ref: x instanceof PDFRef ? x : null });
    }
  };
  for (const [ref, obj] of b.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.lookup(PDFName.of('Type')) !== PDFName.of('Page')) continue;
    void ref;
    const annots = obj.get(PDFName.of('Annots'));
    if (annots instanceof PDFRef) annotArrays.add(annots.toString());
    const arr = resolve(b, annots);
    if (arr instanceof PDFArray) for (const x of arr.asArray()) noteWidget(x);
  }
  const acroB = resolve(b, b.catalog.get(PDFName.of('AcroForm')));
  const acroA = resolve(a, a.catalog.get(PDFName.of('AcroForm')));
  const walkFields = (x: unknown, depth = 0) => {
    const d = resolve(b, x);
    if (!(d instanceof PDFDict) || depth > 32) return;
    if (x instanceof PDFRef) fieldNames.set(d, nameOf(d));
    noteWidget(x);
    const k = d.lookup(PDFName.of('Kids'));
    if (k instanceof PDFArray) for (const c of k.asArray()) walkFields(c, depth + 1);
  };
  if (acroB instanceof PDFDict) {
    const fields = acroB.lookup(PDFName.of('Fields'));
    if (fields instanceof PDFArray) for (const x of fields.asArray()) walkFields(x);
  }

  // Catalog and AcroForm: compared directly (a later update may point at new copies).
  const skip = new Set<string>([a.rootRef, b.rootRef].filter(Boolean).map(String));
  for (const x of [a.catalog.get(PDFName.of('AcroForm')), b.catalog.get(PDFName.of('AcroForm'))]) if (x instanceof PDFRef) skip.add(x.toString());
  const changedKeys = (oldD: PDFDict, newD: PDFDict) => {
    const keys = new Set<string>([...oldD.keys(), ...newD.keys()].map((k) => k.decodeText()));
    return [...keys].filter((k) => {
      const o = oldD.get(PDFName.of(k));
      const n = newD.get(PDFName.of(k));
      // Flags written out with the same meaning (missing = 0) are not a change.
      if ((k === 'Ff' || k === 'F') && (o instanceof PDFNumber ? o.asNumber() : 0) === (n instanceof PDFNumber ? n.asNumber() : 0)) return false;
      return ser(o) !== ser(n);
    });
  };
  for (const k of changedKeys(a.catalog, b.catalog)) {
    if (k === 'DSS') res.ltv = true;
    else if (k !== 'AcroForm') other(`The document catalog was changed (/${k}).`);
  }
  if (acroB instanceof PDFDict || acroA instanceof PDFDict) {
    const oldAcro = acroA instanceof PDFDict ? acroA : (PDFDict.withContext(a.context) as PDFDict);
    const newAcro = acroB instanceof PDFDict ? acroB : (PDFDict.withContext(b.context) as PDFDict);
    for (const x of [oldAcro.get(PDFName.of('Fields')), newAcro.get(PDFName.of('Fields'))]) if (x instanceof PDFRef) skip.add(x.toString());
    const o = itemKeys(resolve(a, oldAcro.get(PDFName.of('Fields'))));
    const nArr = resolve(b, newAcro.get(PDFName.of('Fields')));
    const n = itemKeys(nArr);
    if (o.some((k) => !n.includes(k))) other('A form field was removed.');
    n.forEach((k, i) => {
      if (!o.includes(k)) newField((nArr as PDFArray).get(i));
    });
    for (const k of changedKeys(oldAcro, newAcro)) {
      if (!['Fields', 'SigFlags', 'NeedAppearances', 'DR', 'DA'].includes(k)) other(`The form settings were changed (/${k}).`);
    }
  }

  for (const [ref, obj] of b.context.enumerateIndirectObjects()) {
    const key = ref.toString();
    if (skip.has(key)) continue;
    const old = a.context.lookup(ref);
    if (old === undefined) continue; // new objects matter only through the changed ones
    if (ser(old) === ser(obj)) continue;
    // LTV structures may grow; the data in them must not change.
    if (ltvB.get(key) === 'container' && ltvA.get(key) === 'container') {
      res.ltv = true;
      continue;
    }
    if (annotArrays.has(key)) {
      annotsDiff(old, obj);
      continue;
    }
    if (obj instanceof PDFStream || old instanceof PDFStream) {
      // An appearance of a field whose value changed is part of filling it in.
      const owner = apOwners.get(key);
      if (owner && valueChanged(fieldRefOf(owner.widget, owner.ref)) && !isLocked(owner.widget)) {
        if (isSigField(owner.widget)) res.signatures = true;
        else res.form = true;
      } else other(owner ? 'The appearance of a form field changed while its value did not.' : 'Page content or another stream was changed.');
      continue;
    }
    if (!(obj instanceof PDFDict) || !(old instanceof PDFDict)) {
      other('Document objects were changed.');
      continue;
    }
    const keys = changedKeys(old, obj);
    if (obj.lookup(PDFName.of('Type')) === PDFName.of('Page')) {
      for (const k of keys) {
        if (k === 'Annots') annotsDiff(old.get(PDFName.of('Annots')), obj.get(PDFName.of('Annots')));
        else other(`A page was changed (/${k}).`);
      }
    } else if (obj.has(PDFName.of('FT')) || obj.has(PDFName.of('Parent')) || obj.has(PDFName.of('T')) || obj.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) {
      const sigField = isSigField(obj);
      const locked = isLocked(obj);
      const name = fieldNames.get(obj) ?? nameOf(obj);
      for (const k of keys) {
        if (k === 'V') {
          if (locked) other(`The locked field “${name}” was changed.`);
          else if (!sigField) res.form = true;
          else if (old.get(PDFName.of('V')) !== undefined) other(`The signature in “${name}” was replaced.`);
          else {
            const v = obj.lookup(PDFName.of('V'));
            if (v instanceof PDFDict && v.lookup(PDFName.of('Type')) === PDFName.of('DocTimeStamp')) res.ltv = true;
            else res.signatures = true;
          }
        } else if (k === 'AP' || k === 'AS') {
          if (!valueChanged(fieldRefOf(obj, ref))) other(`The appearance of “${name}” changed while its value did not.`);
          else if (locked) other(`The locked field “${name}” was changed.`);
          else if (sigField) res.signatures = true;
          else res.form = true;
        } else other(`A form field property was changed (/${k}).`);
      }
    } else if (obj.has(PDFName.of('Subtype')) && old.has(PDFName.of('Subtype')) && !hasScript(obj)) {
      res.annotations = true; // an existing comment was edited
    } else other('Document objects were changed.');
  }
  if (reasons.length) res.reasons = reasons;
  return res;
}

interface Dss {
  certs: forge.pki.Certificate[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

function readDss(catalog: PDFDict): Dss | null {
  const dss = catalog.lookup(PDFName.of('DSS'));
  if (!(dss instanceof PDFDict)) return null;
  const list = (k: string): Uint8Array[] => {
    const arr = dss.lookup(PDFName.of(k));
    if (!(arr instanceof PDFArray)) return [];
    const out: Uint8Array[] = [];
    for (let i = 0; i < arr.size(); i++) {
      const s = arr.lookup(i);
      if (!(s instanceof PDFRawStream)) continue;
      try {
        out.push(decodePDFRawStream(s).decode());
      } catch {
        /* undecodable */
      }
    }
    return out;
  };
  const certs: forge.pki.Certificate[] = [];
  for (const d of list('Certs')) {
    try {
      certs.push(parseCertificate(d));
    } catch {
      /* skip */
    }
  }
  return { certs, ocsps: list('OCSPs'), crls: list('CRLs') };
}

/** Revocation from the validation data stored in the file (no network). */
async function revocationFromDss(
  cert: forge.pki.Certificate,
  issuer: forge.pki.Certificate | null,
  dss: Dss,
  when: ValidationTime = validationNow(),
): Promise<RevocationResult | null> {
  if (!issuer) return null;
  for (const o of dss.ocsps) {
    try {
      const r = await parseOcspResponse(o, cert, issuer, when);
      if (r.status === 'good' || r.status === 'revoked') return { ...r, details: `${r.details} (saved in the file)` };
    } catch {
      /* not for this certificate */
    }
  }
  for (const c of dss.crls) {
    try {
      const r = await checkCrl(c, cert, issuer, when);
      if (r.status === 'good' || r.status === 'revoked') return { ...r, details: `${r.details} (saved in the file)` };
    } catch {
      /* not from this issuer */
    }
  }
  return null;
}

/** DocMDP permission level of a certification signature dictionary. */
function mdpLevel(sig: PDFDict): 1 | 2 | 3 {
  const refs = sig.lookup(PDFName.of('Reference'));
  let n = 2;
  if (refs instanceof PDFArray) {
    for (let i = 0; i < refs.size(); i++) {
      const ref = refs.lookup(i);
      if (!(ref instanceof PDFDict) || ref.lookup(PDFName.of('TransformMethod')) !== PDFName.of('DocMDP')) continue;
      const params = ref.lookup(PDFName.of('TransformParams'));
      const p = params instanceof PDFDict ? params.lookup(PDFName.of('P')) : null;
      if (p instanceof PDFNumber) n = p.asNumber();
    }
  }
  return (n === 1 || n === 3 ? n : 2) as 1 | 2 | 3;
}

/** Certification level when this signature certifies the document (DocMDP). */
function certificationOf(catalog: PDFDict, sig: PDFDict): 1 | 2 | 3 | null {
  const perms = catalog.lookup(PDFName.of('Perms'));
  const mdp = perms instanceof PDFDict ? perms.lookup(PDFName.of('DocMDP')) : null;
  return mdp === sig ? mdpLevel(sig) : null;
}

/** Certification level of the document (as signed), or null when it is not certified. */
function docMdpLevel(catalog: PDFDict): 1 | 2 | 3 | null {
  const perms = catalog.lookup(PDFName.of('Perms'));
  const mdp = perms instanceof PDFDict ? perms.lookup(PDFName.of('DocMDP')) : null;
  return mdp instanceof PDFDict ? mdpLevel(mdp) : null;
}

/** Fields a signature field locks (its /Lock, FieldMDP), or null. */
function fieldLock(field: PDFDict): ((fullName: string) => boolean) | null {
  const lock = field.lookup(PDFName.of('Lock'));
  if (!(lock instanceof PDFDict)) return null;
  const action = lock.lookup(PDFName.of('Action'));
  const list = lock.lookup(PDFName.of('Fields'));
  const names =
    list instanceof PDFArray
      ? list.asArray().map((x) => {
          const s = field.context.lookup(x);
          return s instanceof PDFString || s instanceof PDFHexString ? s.decodeText() : '';
        })
      : [];
  const listed = (n: string) => names.some((x) => x && (n === x || n.startsWith(`${x}.`)));
  if (action === PDFName.of('All')) return () => true;
  if (action === PDFName.of('Include')) return listed;
  if (action === PDFName.of('Exclude')) return (n) => !listed(n);
  return null;
}

export interface LtvOptions {
  trustedRoots?: forge.pki.Certificate[];
  httpPost?: (url: string, contentType: string, body: Uint8Array) => Promise<Uint8Array>;
  httpGet?: (url: string) => Promise<Uint8Array>;
}

/**
 * Long-term validation: stores the certificate chains and OCSP responses /
 * CRLs of every signature in the file's Document Security Store (with a VRI
 * entry per signature), as an incremental update so the signatures stay
 * valid. Later, the signatures can be checked without the internet.
 */
export async function addValidationData(pdfBytes: Uint8Array, opts: LtvOptions): Promise<{ bytes: Uint8Array; notes: string[]; complete: boolean }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const { sigFields } = collectFields(doc.catalog);
  const existing = readDss(doc.catalog);
  const notes: string[] = [];
  let complete = true;
  const certs = new Map<string, Uint8Array>();
  const ocsps: Uint8Array[] = [];
  const crls: Uint8Array[] = [];
  const vri: Array<{ key: string; certs: string[]; ocsps: number[]; crls: number[] }> = [];
  const hexOf = (b: Uint8Array) => bytesToHex(b).toUpperCase();

  for (const f of sigFields) {
    if (!f.sig) continue;
    const contents = f.sig.lookup(PDFName.of('Contents'));
    if (!(contents instanceof PDFHexString || contents instanceof PDFString)) continue;
    const full = contents.asBytes();
    const blob = full.subarray(0, readTlv(full, 0).end);
    const info = await verifyCms(blob, []);
    if (!info.cert) {
      notes.push(`${f.fullName}: the signer certificate is missing.`);
      complete = false;
      continue;
    }
    const entry = { key: hexOf(digest(OID.sha1, full)), certs: [] as string[], ocsps: [] as number[], crls: [] as number[] };
    // The signer, and the timestamp authorities of its timestamps (PAdES B-LT).
    const subjects: Array<{ cert: forge.pki.Certificate; pool: forge.pki.Certificate[]; tsa: boolean }> = [{ cert: info.cert, pool: info.certs, tsa: false }];
    for (const t of info.tokens) {
      const ti = await verifyCms(t, []);
      if (ti.cert) subjects.push({ cert: ti.cert, pool: ti.certs, tsa: true });
    }
    for (const subject of subjects) {
    const chain = await buildChain(subject.cert, [...subject.pool, ...(existing?.certs ?? [])], opts.trustedRoots ?? [], new Date());
    for (const c of chain.chain) {
      const d = metaOf(c).der;
      certs.set(hexOf(d), d);
      entry.certs.push(hexOf(d));
    }
    // Revocation data for each certificate except the root (self-signed) one.
    for (let i = 0; i < chain.chain.length; i++) {
      const cert = chain.chain[i];
      if (isSelfIssued(cert)) {
        if (i === 0 && !subject.tsa) {
          notes.push(`${f.fullName}: the certificate is self-signed; it has no revocation service, so only the certificate itself is stored.`);
          complete = false;
        }
        continue;
      }
      const issuer = chain.chain[i + 1] ?? null;
      if (!issuer) {
        notes.push(`${f.fullName}: the issuer of “${certCommonName(cert)}” is missing, so its revocation data cannot be fetched.`);
        complete = false;
        continue;
      }
      let got = false;
      if (opts.httpPost) {
        for (const url of extensionUris(cert, OID.aia, OID.adOcsp)) {
          try {
            const resp = await opts.httpPost(url, 'application/ocsp-request', buildOcspRequest(cert, issuer));
            const r = await parseOcspResponse(resp, cert, issuer);
            if (r.status === 'good' || r.status === 'revoked') {
              entry.ocsps.push(ocsps.push(resp) - 1);
              if (r.status === 'revoked') notes.push(`${f.fullName}: “${certCommonName(cert)}” is REVOKED.`);
              got = true;
              break;
            }
          } catch {
            /* try the next responder, or the CRL */
          }
        }
      }
      if (!got && opts.httpGet) {
        for (const url of extensionUris(cert, OID.crlDp)) {
          try {
            const crl = await opts.httpGet(url);
            const r = await checkCrl(crl, cert, issuer);
            if (r.status === 'good' || r.status === 'revoked') {
              entry.crls.push(crls.push(crl) - 1);
              got = true;
              break;
            }
          } catch {
            /* next */
          }
        }
      }
      if (!got) {
        notes.push(`${f.fullName}: no OCSP or CRL answer for “${certCommonName(cert)}”.`);
        complete = false;
      }
    }
    }
    vri.push(entry);
  }
  if (!vri.length) throw new Error('This PDF has no digital signatures.');

  const { incrementalUpdate } = await import('@/lib/pdf/incremental');
  const res = await incrementalUpdate(pdfBytes, (d) => {
    const ctx = d.context;
    const old = d.catalog.lookup(PDFName.of('DSS'));
    const oldList = (k: string) => (old instanceof PDFDict && old.lookup(PDFName.of(k)) instanceof PDFArray ? (old.lookup(PDFName.of(k)) as PDFArray).asArray() : []);
    const certRefs = new Map<string, PDFRef>();
    for (const [k, der] of certs) certRefs.set(k, ctx.register(ctx.flateStream(der)));
    const ocspRefs = ocsps.map((b) => ctx.register(ctx.flateStream(b)));
    const crlRefs = crls.map((b) => ctx.register(ctx.flateStream(b)));
    const vriDict = old instanceof PDFDict && old.lookup(PDFName.of('VRI')) instanceof PDFDict ? (old.lookup(PDFName.of('VRI')) as PDFDict) : (ctx.obj({}) as PDFDict);
    for (const e of vri) {
      const entry = ctx.obj({ Type: 'VRI' }) as PDFDict;
      entry.set(PDFName.of('Cert'), ctx.obj(e.certs.map((k) => certRefs.get(k)!)));
      if (e.ocsps.length) entry.set(PDFName.of('OCSP'), ctx.obj(e.ocsps.map((i) => ocspRefs[i])));
      if (e.crls.length) entry.set(PDFName.of('CRL'), ctx.obj(e.crls.map((i) => crlRefs[i])));
      entry.set(PDFName.of('TU'), PDFString.of(pdfDate(new Date())));
      vriDict.set(PDFName.of(e.key), ctx.register(entry));
    }
    const dss = ctx.obj({
      Type: 'DSS',
      Certs: [...oldList('Certs'), ...certRefs.values()],
      OCSPs: [...oldList('OCSPs'), ...ocspRefs],
      CRLs: [...oldList('CRLs'), ...crlRefs],
      VRI: ctx.register(vriDict),
    });
    d.catalog.set(PDFName.of('DSS'), ctx.register(dss));
  });
  return { bytes: res.bytes, notes, complete };
}

function summarise(r: ExtendedValidation, notes: string[]): string {
  const parts: string[] = [];
  if (r.documentTimestamp && r.integrity === 'valid') parts.push(`Document timestamp by ${r.signerName}. The document has not been modified since.`);
  else if (r.integrity === 'valid') parts.push(`Signed by ${r.signerName}. The signed content has not been modified.`);
  else if (r.integrity === 'invalid') parts.push('INVALID signature.');
  else parts.push('Signature validity could not be determined.');
  parts.push(...notes);
  switch (r.chainStatus) {
    case 'trusted':
      parts.push('The certificate chains to a trusted root.');
      break;
    case 'expired':
      parts.push(r.timestampVerified ? 'A certificate in the chain was not valid at the time of the trusted timestamp.' : 'A certificate in the chain is not valid now (there is no verified timestamp proving an earlier signing time).');
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
  if (r.timestampVerified && !r.documentTimestamp) parts.push('Includes a verified RFC 3161 timestamp.');
  else if (r.hasTimestamp && !r.documentTimestamp) parts.push('Includes an RFC 3161 timestamp that could not be verified.');
  else if (!r.documentTimestamp) parts.push('No verified timestamp: the certificates were checked at the current time.');
  for (const w of r.warnings ?? []) parts.push(`Warning: ${w}`);
  if (r.euTrusted && r.documentTimestamp) parts.push(`Qualified timestamp authority on the EU Trusted List (${r.euTrusted}).`);
  else if (r.euTrusted && r.qualified === 'qscd') parts.push(`Qualified electronic signature: EU qualified certificate, key on a qualified device, issuer on the EU Trusted List (${r.euTrusted}).`);
  else if (r.euTrusted && r.qualified === 'qc') parts.push(`Advanced electronic signature with an EU qualified certificate; issuer on the EU Trusted List (${r.euTrusted}).`);
  else if (r.euTrusted) parts.push(`The issuer is a qualified trust service on the EU Trusted List (${r.euTrusted}).`);
  else if (r.qualified) parts.push('The certificate declares itself EU qualified, but its issuer was not confirmed on the EU Trusted List.');
  if (r.euTrusted) parts.push('The EU Trusted Lists were downloaded over HTTPS; their own XML signatures are not verified.');
  if (r.certified) parts.push(['', 'Certified: no changes are allowed.', 'Certified: filling in forms and signing are allowed.', 'Certified: filling in forms, signing and comments are allowed.'][r.certified]);
  if (r.ltv) parts.push('Long-term validation: the validation data of the whole chain is saved in the file.');
  return parts.join(' ');
}
