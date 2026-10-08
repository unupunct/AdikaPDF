/**
 * Standard security handler: opening, decrypting and re-encrypting
 * password-protected PDFs (ISO 32000-2 7.6.4).
 *
 *  - V1/V2 RC4 40–128 bit (R2–R4), V4 crypt filters (V2 = RC4, AESV2 =
 *    AES-128, Identity; /StmF, /StrF, /EFF, EncryptMetadata false), V5
 *    AES-256 (R5 and R6, Algorithms 2.A / 2.B).
 *  - The user password (empty for files restricted only by an owner password)
 *    or the owner password (Algorithm 7, and its R5/R6 counterpart) unlocks
 *    the file key.
 *  - `decryptPdf` reads every object without trusting the xref (the last copy
 *    of an object number wins, as in repair.ts), decrypts strings and streams
 *    with the object's key, object streams as a whole, never xref streams,
 *    and writes an unencrypted PDF with the same object numbers.
 *  - `encryptWithSecurity` writes a PDF back with the same /Encrypt dictionary,
 *    the same /ID[0] and so the same file key: the passwords and permissions
 *    stay what they were without knowing the owner password.
 *
 * MD5 and RC4 are written out here (Web Crypto has neither); AES uses Web Crypto.
 */
import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFWriter,
} from 'pdf-lib';
import { hash2B, passwordBytes, type PdfPermissions } from './encrypt';
import { expandObjectStreams, gatherObjects, readTrailers, scanFile } from '@/lib/pdf/repair';

type Bytes = Uint8Array<ArrayBuffer>;

/** The password does not open the file (`incorrect`: one was given). */
export class PdfPasswordError extends Error {
  constructor(public readonly incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'This PDF is password protected');
    this.name = 'PdfPasswordError';
  }
}

/** Encryption this module cannot handle (another security handler, an unknown crypt filter). */
export class UnsupportedEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEncryptionError';
  }
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function own(u: Uint8Array): Bytes {
  return u.buffer instanceof ArrayBuffer ? (u as Bytes) : new Uint8Array(u);
}

// ---------------------------------------------------------------------------
// MD5 (RFC 1321) and RC4
// ---------------------------------------------------------------------------

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(msg: Uint8Array): Bytes {
  const len = msg.length;
  const blocks = ((len + 8) >>> 6) + 1;
  const buf = new Uint8Array(blocks * 64);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(blocks * 64 - 8, (len * 8) >>> 0, true);
  dv.setUint32(blocks * 64 - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) m[j] = dv.getUint32(off + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      const s = MD5_S[(i >>> 4) * 4 + (i & 3)];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

/** RC4 (symmetric: the same call encrypts and decrypts). */
export function rc4(key: Uint8Array, data: Uint8Array): Bytes {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// ---------------------------------------------------------------------------
// AES-CBC on Web Crypto
// ---------------------------------------------------------------------------

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  return s;
};

const ZERO_IV = new Uint8Array(16);
const PAD_BLOCK = new Uint8Array(16).fill(16);
const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  const id = toHex(raw);
  let k = keyCache.get(id);
  if (!k) {
    if (keyCache.size > 256) keyCache.clear();
    k = subtle().importKey('raw', own(raw), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    keyCache.set(id, k);
  }
  return k;
}

/**
 * CBC decryption of the whole blocks of `ct`, padding left in place. Web
 * Crypto insists on valid PKCS#7 padding, so a block that decrypts to a full
 * padding block is appended: E(last ⊕ 16×0x10) decrypts to exactly that.
 */
async function aesCbcRaw(raw: Uint8Array, iv: Uint8Array, ct: Uint8Array): Promise<Bytes> {
  const n = ct.length - (ct.length % 16);
  if (n === 0) return new Uint8Array(0);
  const key = await aesKey(raw);
  const data = ct.subarray(0, n);
  const last = data.subarray(n - 16);
  const x = new Uint8Array(16);
  for (let i = 0; i < 16; i++) x[i] = last[i] ^ PAD_BLOCK[i];
  const extra = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, x)).subarray(0, 16);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: own(iv.slice()) }, key, concat(data, extra)));
}

/** IV ‖ ciphertext -> plaintext; broken padding (or a ragged length) is tolerated. */
async function aesDecrypt(raw: Uint8Array, data: Uint8Array): Promise<Bytes> {
  if (data.length <= 16) return new Uint8Array(0);
  const iv = data.slice(0, 16);
  const ct = data.subarray(16);
  if (ct.length % 16 === 0) {
    try {
      return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, await aesKey(raw), own(ct.slice())));
    } catch {
      /* bad padding: below */
    }
  }
  const p = await aesCbcRaw(raw, iv, ct);
  const pad = p[p.length - 1];
  if (pad >= 1 && pad <= 16 && pad <= p.length && p.subarray(p.length - pad).every((b) => b === pad)) return p.slice(0, p.length - pad);
  return p;
}

async function aesEncrypt(raw: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const iv = new Uint8Array(16);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(raw), own(data.slice()));
  return concat(iv, new Uint8Array(ct));
}

async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', own(data.slice())));
}

// ---------------------------------------------------------------------------
// The /Encrypt dictionary
// ---------------------------------------------------------------------------

type Method = 'none' | 'rc4' | 'aes128' | 'aes256';

export interface StandardSecurity {
  v: number;
  r: number;
  /** File key length in bytes. */
  length: number;
  p: number;
  o: Uint8Array;
  u: Uint8Array;
  oe?: Uint8Array;
  ue?: Uint8Array;
  id0: Uint8Array;
  id1: Uint8Array;
  encryptMetadata: boolean;
  stm: Method;
  str: Method;
  eff: Method;
  /** Named crypt filters (for streams with their own /Crypt filter). */
  filters: Record<string, Method | 'unknown'>;
  /** The /Encrypt dictionary as PDF syntax, every value direct (written back on save). */
  dict: string;
}

/** A file opened with a password: what saving needs to encrypt it the same way. */
export interface Unlocked {
  security: StandardSecurity;
  /** The file key (memory only). */
  key: Uint8Array;
  /** Opened with the owner password: no restriction applies. */
  owner: boolean;
  /** Opening needs a (non-empty) password. */
  userPassword: boolean;
}

type Lookup = (o: PDFObject | undefined) => PDFObject | undefined;

function filterMethod(filters: StandardSecurity['filters'], name: string): Method {
  if (name === 'Identity') return 'none';
  const m = filters[name];
  if (!m || m === 'unknown') throw new UnsupportedEncryptionError(`Unsupported crypt filter ${name} in this PDF.`);
  return m;
}

const N = (s: string): PDFName => PDFName.of(s);

function bytesOf(o: PDFObject | undefined): Uint8Array | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : undefined;
}

function num(o: PDFObject | undefined, fallback: number): number {
  return o instanceof PDFNumber ? o.asNumber() : fallback;
}

/** PDF syntax of an object with every reference replaced by its value. */
function directText(o: PDFObject | undefined, lookup: Lookup, depth = 0): string {
  const v = lookup(o);
  if (depth > 16 || v === undefined) return 'null';
  if (v instanceof PDFDict) return `<<${v.entries().map(([k, x]) => `${k.toString()} ${directText(x, lookup, depth + 1)}`).join(' ')}>>`;
  if (v instanceof PDFArray) return `[${v.asArray().map((x) => directText(x, lookup, depth + 1)).join(' ')}]`;
  return v.toString();
}

function readSecurity(dict: PDFDict, id: PDFArray | undefined, lookup: Lookup): StandardSecurity {
  const get = (k: string) => lookup(dict.get(N(k)));
  const filter = get('Filter');
  if (filter !== N('Standard')) throw new UnsupportedEncryptionError(`This PDF uses the ${filter instanceof PDFName ? filter.decodeText() : 'unknown'} security handler, which Adika cannot decrypt.`);
  const v = num(get('V'), 0);
  const r = num(get('R'), 0);
  if (![1, 2, 4, 5].includes(v) || r < 2 || r > 6) throw new UnsupportedEncryptionError(`Unsupported PDF encryption (V ${v}, R ${r}).`);
  let length = num(get('Length'), v === 1 ? 40 : 128);
  length = length <= 16 ? length : length / 8;
  if (v === 1) length = 5;
  if (v >= 5) length = 32;
  if (length < 5 || length > 32) length = 16;
  const o = bytesOf(get('O'));
  const u = bytesOf(get('U'));
  if (!o || !u) throw new UnsupportedEncryptionError('The encryption dictionary of this PDF is damaged.');
  const encryptMetadata = get('EncryptMetadata') !== PDFBool.False;

  const filters: Record<string, Method | 'unknown'> = {};
  const cf = get('CF');
  if (cf instanceof PDFDict) {
    for (const [name, value] of cf.entries()) {
      const f = lookup(value);
      if (!(f instanceof PDFDict)) continue;
      const cfm = lookup(f.get(N('CFM')));
      filters[name.decodeText()] = cfm === N('V2') ? 'rc4' : cfm === N('AESV2') ? 'aes128' : cfm === N('AESV3') ? 'aes256' : cfm === N('None') || cfm === undefined ? 'none' : 'unknown';
    }
  }
  const named = (o2: PDFObject | undefined): Method => filterMethod(filters, o2 instanceof PDFName ? o2.decodeText() : 'Identity');
  let stm: Method = 'rc4';
  let str: Method = 'rc4';
  let eff: Method = 'rc4';
  if (v >= 4) {
    stm = named(get('StmF'));
    str = named(get('StrF'));
    eff = get('EFF') ? named(get('EFF')) : stm;
  }
  const idBytes = (i: number) => (id ? bytesOf(lookup(id.get(i))) : undefined) ?? new Uint8Array(0);
  const id0 = idBytes(0);
  return {
    v,
    r,
    length,
    p: num(get('P'), -4) | 0,
    o,
    u,
    oe: bytesOf(get('OE')),
    ue: bytesOf(get('UE')),
    id0,
    id1: id && id.size() > 1 ? idBytes(1) : id0,
    encryptMetadata,
    stm,
    str,
    eff,
    filters,
    dict: directText(dict, lookup),
  };
}

// ---------------------------------------------------------------------------
// Passwords (Algorithms 2, 2.A, 3, 4, 5, 6, 7)
// ---------------------------------------------------------------------------

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** R2–R4 passwords: PDFDocEncoding (Latin-1 here), padded or cut to 32 bytes. */
function padded(pw: string): Bytes {
  const out = new Uint8Array(32);
  const chars = [...pw].slice(0, 32).map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f));
  out.set(chars);
  out.set(PAD.subarray(0, 32 - chars.length), chars.length);
  return out;
}

/** Algorithm 2: the file key from a padded user password. */
function legacyKey(sec: StandardSecurity, pw: Uint8Array): Bytes {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, sec.p, true);
  const n = sec.r === 2 ? 5 : sec.length;
  let h = md5(concat(pw, sec.o.subarray(0, 32), p, sec.id0, sec.r >= 4 && !sec.encryptMetadata ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
  if (sec.r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.slice(0, n);
}

const xorKey = (key: Uint8Array, i: number): Bytes => key.map((b) => b ^ i);

/** Algorithms 4 / 5 (via 6): does this key produce /U? */
function legacyUserOk(sec: StandardSecurity, key: Uint8Array): boolean {
  if (sec.r === 2) return equal(rc4(key, PAD), sec.u.subarray(0, 32));
  let x = rc4(key, md5(concat(PAD, sec.id0)));
  for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x);
  return equal(x, sec.u.subarray(0, 16));
}

/** Algorithm 7, first half: the padded user password hidden in /O. */
function legacyUserFromOwner(sec: StandardSecurity, ownerPw: Uint8Array): Bytes {
  let h = md5(ownerPw);
  if (sec.r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const key = h.slice(0, sec.r === 2 ? 5 : sec.length);
  if (sec.r === 2) return rc4(key, sec.o.subarray(0, 32));
  let x: Bytes = sec.o.slice(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(xorKey(key, i), x);
  return x;
}

async function modernHash(sec: StandardSecurity, pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Bytes> {
  return sec.r === 6 ? hash2B(pw, salt, udata) : sha256(concat(pw, salt, udata));
}

async function modernOwner(sec: StandardSecurity, pw: Uint8Array): Promise<Bytes | null> {
  const o = sec.o.subarray(0, 48);
  const u = sec.u.subarray(0, 48);
  if (o.length < 48 || u.length < 48 || !sec.oe) return null;
  if (!equal(await modernHash(sec, pw, o.subarray(32, 40), u), o.subarray(0, 32))) return null;
  return aesCbcRaw(await modernHash(sec, pw, o.subarray(40, 48), u), ZERO_IV, sec.oe.subarray(0, 32));
}

async function modernUser(sec: StandardSecurity, pw: Uint8Array): Promise<Bytes | null> {
  const u = sec.u.subarray(0, 48);
  if (u.length < 48 || !sec.ue) return null;
  const none = new Uint8Array(0);
  if (!equal(await modernHash(sec, pw, u.subarray(32, 40), none), u.subarray(0, 32))) return null;
  return aesCbcRaw(await modernHash(sec, pw, u.subarray(40, 48), none), ZERO_IV, sec.ue.subarray(0, 32));
}

/** The file key for `password`, tried as the owner password first; null when it opens nothing. */
async function unlock(sec: StandardSecurity, password: string, ownerOnly = false): Promise<{ key: Bytes; owner: boolean } | null> {
  if (sec.r <= 4) {
    const pw = padded(password);
    const viaOwner = legacyKey(sec, legacyUserFromOwner(sec, pw));
    if (legacyUserOk(sec, viaOwner)) return { key: viaOwner, owner: true };
    if (ownerOnly) return null;
    const key = legacyKey(sec, pw);
    return legacyUserOk(sec, key) ? { key, owner: false } : null;
  }
  const pw = passwordBytes(password);
  const ownerKey = await modernOwner(sec, pw);
  if (ownerKey) return { key: ownerKey, owner: true };
  if (ownerOnly) return null;
  const userKey = await modernUser(sec, pw);
  return userKey ? { key: userKey, owner: false } : null;
}

/** Whether `password` is the document's owner password. */
export async function isOwnerPassword(sec: StandardSecurity, password: string): Promise<boolean> {
  return (await unlock(sec, password, true)) !== null;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** The permissions in /P (Table 22); R2 files only know bits 3–6. */
export function permissionsFromP(p: number, r: number): PdfPermissions {
  const bit = (n: number) => (p & (1 << (n - 1))) !== 0;
  const legacy = r < 3;
  return {
    print: bit(3),
    modify: bit(4),
    copy: bit(5),
    annotate: bit(6),
    fillForms: legacy ? bit(6) : bit(9),
    extractForAccessibility: legacy ? bit(5) : bit(10),
    assemble: legacy ? bit(4) : bit(11),
    printHighQuality: legacy ? bit(3) : bit(12),
  };
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

function objectKey(fileKey: Uint8Array, method: Method, ref: { num: number; gen: number }): Bytes {
  if (method === 'aes256') return own(fileKey);
  const { num: n, gen: g } = ref;
  const tail = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, g & 255, (g >>> 8) & 255];
  const salt = method === 'aes128' ? [0x73, 0x41, 0x6c, 0x54] : [];
  return md5(concat(fileKey, new Uint8Array(tail), new Uint8Array(salt))).slice(0, Math.min(fileKey.length + 5, 16));
}

type Dir = 'decrypt' | 'encrypt';

function cipher(dir: Dir, method: Method, key: Uint8Array): (data: Uint8Array) => Promise<Uint8Array> {
  if (method === 'none') return async (d) => d;
  if (method === 'rc4') return async (d) => rc4(key, d);
  return dir === 'decrypt' ? (d) => aesDecrypt(key, d) : (d) => aesEncrypt(key, d);
}

const N_TYPE = N('Type');
const N_FILTER = N('Filter');
const N_PARMS = N('DecodeParms');

function isSignatureDict(d: PDFDict): boolean {
  const t = d.get(N_TYPE);
  return t === N('Sig') || t === N('DocTimeStamp') || (d.has(N('ByteRange')) && d.has(N('Contents')) && d.has(N_FILTER));
}

/** Replaces every string inside `obj` (returns the replacement when `obj` is itself a string). */
async function mapStrings(obj: PDFObject, fn: (b: Uint8Array) => Promise<Uint8Array>, depth = 0): Promise<PDFObject | undefined> {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return PDFHexString.of(toHex(await fn(obj.asBytes())));
  if (depth > 64) return undefined;
  if (obj instanceof PDFDict) {
    const sig = isSignatureDict(obj);
    for (const [k, v] of obj.entries()) {
      if (sig && k === N('Contents')) continue; // signature values are never encrypted
      const rep = await mapStrings(v, fn, depth + 1);
      if (rep) obj.set(k, rep);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const rep = await mapStrings(obj.get(i), fn, depth + 1);
      if (rep) obj.set(i, rep);
    }
  }
  return undefined;
}

function streamMethod(sec: StandardSecurity, dict: PDFDict, dir: Dir): Method {
  const type = dict.get(N_TYPE);
  if (type === N('Metadata') && !sec.encryptMetadata) return 'none';
  const filter = dict.get(N_FILTER);
  const first = filter instanceof PDFArray ? filter.get(0) : filter;
  if (dir === 'decrypt' && first === N('Crypt')) {
    const parms = dict.get(N_PARMS);
    const p0 = parms instanceof PDFArray ? parms.get(0) : parms;
    const name = p0 instanceof PDFDict ? p0.get(N('Name')) : undefined;
    const n = name instanceof PDFName ? name.decodeText() : 'Identity';
    // The Crypt filter is applied here; what is left is a regular filter chain.
    if (filter instanceof PDFArray) {
      filter.remove(0);
      if (parms instanceof PDFArray) parms.remove(0);
      if (filter.size() === 0) dict.delete(N_FILTER);
    } else {
      dict.delete(N_FILTER);
      dict.delete(N_PARMS);
    }
    return filterMethod(sec.filters, n);
  }
  return type === N('EmbeddedFile') ? sec.eff : sec.stm;
}

/** Decrypts or encrypts one indirect object; returns its replacement when it is a string or a stream. */
async function cryptObject(dir: Dir, sec: StandardSecurity, fileKey: Uint8Array, ref: { num: number; gen: number }, obj: PDFObject): Promise<PDFObject | undefined> {
  const strKey = objectKey(fileKey, sec.str, ref);
  const strFn = cipher(dir, sec.str, strKey);
  if (obj instanceof PDFStream) {
    if (obj.dict.get(N_TYPE) === N('XRef')) return undefined; // xref streams are never encrypted
    await mapStrings(obj.dict, strFn);
    const method = streamMethod(sec, obj.dict, dir);
    const data = await cipher(dir, method, objectKey(fileKey, method, ref))(obj.getContents());
    obj.dict.set(PDFName.Length, PDFNumber.of(data.length));
    return PDFRawStream.of(obj.dict, data);
  }
  return mapStrings(obj, strFn);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** The /Encrypt dictionary and /ID of a file (without decrypting anything). */
function readFile(bytes: Uint8Array) {
  const context = PDFContext.create();
  const scan = scanFile(bytes);
  const collected = gatherObjects(bytes, scan.headers, context);
  const trailer = readTrailers(bytes, scan, collected, context);
  const lookup: Lookup = (o) => (o instanceof PDFRef ? collected.entries.get(o.objectNumber)?.obj : o);
  const enc = lookup(trailer.encrypt);
  if (!(enc instanceof PDFDict)) throw new UnsupportedEncryptionError('This PDF is not encrypted, or its encryption dictionary is missing.');
  return { context, collected, trailer, security: readSecurity(enc, trailer.id, lookup) };
}

/** Reads the security settings and unlocks the file key with `password` (throws PdfPasswordError). */
export async function unlockPdf(bytes: Uint8Array, password = ''): Promise<Unlocked> {
  return (await open(bytes, password)).unlocked;
}

async function open(bytes: Uint8Array, password: string) {
  const file = readFile(bytes);
  const { security } = file;
  const got = await unlock(security, password);
  if (!got) throw new PdfPasswordError(password !== '');
  const userPassword = password === '' ? false : got.owner ? !(await unlock(security, '')) : true;
  return { file, unlocked: { security, key: got.key, owner: got.owner, userPassword } satisfies Unlocked };
}

/**
 * Decrypts a password-protected PDF (Standard security handler). The result
 * has no /Encrypt and keeps every object number; `unlocked` re-encrypts it.
 */
export async function decryptPdf(bytes: Uint8Array, password = ''): Promise<{ bytes: Uint8Array; unlocked: Unlocked }> {
  const { file, unlocked } = await open(bytes, password);
  const { context, collected, trailer, security } = file;
  const encNum = trailer.encrypt instanceof PDFRef ? trailer.encrypt.objectNumber : -1;
  const isXref = (o: PDFObject) => o instanceof PDFRawStream && o.dict.get(N_TYPE) === N('XRef');
  for (const [n, e] of collected.entries) {
    if (n === encNum || isXref(e.obj)) continue;
    const rep = await cryptObject('decrypt', security, unlocked.key, { num: n, gen: e.gen }, e.obj);
    if (rep) e.obj = rep;
  }
  for (const s of collected.objStms) {
    const rep = await cryptObject('decrypt', security, unlocked.key, { num: s.num, gen: s.gen }, s.stream);
    if (rep instanceof PDFRawStream) s.stream = rep;
  }
  expandObjectStreams(collected, context);
  for (const [n, e] of collected.entries) {
    if (n === encNum || isXref(e.obj)) continue;
    context.assign(PDFRef.of(n, e.gen), e.obj);
  }
  if (!trailer.root) throw new Error('This PDF has no document catalog.');
  context.trailerInfo = { Root: trailer.root, ...(trailer.info ? { Info: trailer.info } : {}), ...(trailer.id ? { ID: trailer.id } : {}) };
  const out = await PDFWriter.forContext(context, 500).serializeToBuffer();
  return { bytes: out, unlocked };
}

function trailerId(context: PDFContext, sec: StandardSecurity): PDFArray {
  return context.obj([PDFHexString.of(toHex(sec.id0)), PDFHexString.of(toHex(sec.id1))]);
}

/** The original /Encrypt dictionary, parsed into `context`. */
export function encryptDictFor(context: PDFContext, sec: StandardSecurity): PDFDict {
  const text = sec.dict;
  const raw = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) raw[i] = text.charCodeAt(i) & 255;
  const d = PDFObjectParser.forBytes(raw, context).parseObject();
  if (!(d instanceof PDFDict)) throw new Error('Damaged encryption dictionary.');
  return d;
}

/** Encrypts the given indirect objects of `context` in place with the file key. */
export async function encryptObjects(context: PDFContext, unlocked: Pick<Unlocked, 'security' | 'key'>, refs: PDFRef[]): Promise<void> {
  for (const ref of refs) {
    const obj = context.lookup(ref);
    if (!obj) continue;
    const rep = await cryptObject('encrypt', unlocked.security, unlocked.key, { num: ref.objectNumber, gen: ref.generationNumber }, obj);
    if (rep) context.assign(ref, rep);
  }
}

/** The trailer entries an encrypted file needs: /Encrypt (registered in `context`) and the original /ID. */
export function registerEncryption(context: PDFContext, sec: StandardSecurity): { encrypt: PDFRef; id: PDFArray } {
  return { encrypt: context.register(encryptDictFor(context, sec)), id: trailerId(context, sec) };
}

/**
 * Writes an unencrypted PDF back encrypted the way the original was: the same
 * /Encrypt dictionary and /ID[0], so the same passwords and permissions.
 */
export async function encryptWithSecurity(plain: Uint8Array, unlocked: Pick<Unlocked, 'security' | 'key'>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const context = doc.context;
  delete context.trailerInfo.Encrypt;
  const refs = context.enumerateIndirectObjects().map(([r]) => r);
  await encryptObjects(context, unlocked, refs);
  const { encrypt, id } = registerEncryption(context, unlocked.security);
  context.trailerInfo.Encrypt = encrypt;
  context.trailerInfo.ID = id;
  // Object streams would have to be encrypted as a whole; the classic writer avoids them.
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
