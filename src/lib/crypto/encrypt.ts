/**
 * PDF encryption: Standard security handler, V 5 / R 6 (ISO 32000-2, AESV3).
 *
 * pdf-lib has no encryption support, so this module works on pdf-lib's object
 * model directly: after the document is loaded, every string and every stream
 * of every indirect object is replaced by its AES-256-CBC ciphertext, an
 * /Encrypt dictionary is registered and referenced from the trailer, and the
 * file is written with the classic (non object-stream) writer.
 *
 * Only Web Crypto is used (AES-CBC, SHA-256/384/512, getRandomValues), so this
 * runs unchanged in the browser and in Node >= 20.
 *
 * Limitations:
 *  - Passwords are UTF-8 encoded and truncated to 127 bytes. The SASLprep
 *    normalisation step required by ISO 32000-2 (7.6.4.3.3) is skipped, which
 *    only matters for passwords with unusual Unicode (non-NFKC) characters.
 *  - Signing *after* encryption is not supported: the signature /Contents
 *    placeholder is left in clear text as the spec requires, but no code here
 *    reserves or patches ByteRange space.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

export interface PdfPermissions {
  print: boolean;
  printHighQuality: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  extractForAccessibility: boolean;
  assemble: boolean;
}

export interface EncryptOptions {
  userPassword: string;
  ownerPassword: string;
  permissions: PdfPermissions;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  return s;
};

/** Web Crypto wants ArrayBuffer-backed views; copy only when we have to. */
function buf(u: Uint8Array): Bytes {
  return u.buffer instanceof ArrayBuffer ? (u as Bytes) : new Uint8Array(u);
}

function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

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

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function hexString(bytes: Uint8Array): PDFHexString {
  return PDFHexString.of(toHex(bytes));
}

/** UTF-8 password, truncated to 127 bytes (ISO 32000-2 7.6.4.3.3). SASLprep skipped. */
function passwordBytes(pw: string): Bytes {
  return new TextEncoder().encode(pw).slice(0, 127);
}

// ---------------------------------------------------------------------------
// AES primitives on top of Web Crypto
// ---------------------------------------------------------------------------

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(key), { name: 'AES-CBC' }, false, ['encrypt']);
}

/** AES-CBC with PKCS#7 padding (what Web Crypto does natively). */
async function aesCbcPadded(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const ct = await subtle().encrypt({ name: 'AES-CBC', iv: buf(iv) }, key, buf(data));
  return new Uint8Array(ct);
}

/**
 * AES-CBC without padding. Web Crypto always pads, but when the input is
 * block-aligned the padding is one extra whole block at the end whose
 * ciphertext does not affect the preceding blocks, so dropping it yields the
 * exact no-padding ciphertext.
 */
async function aesCbcNoPad(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Bytes> {
  if (data.length % 16 !== 0) throw new Error('aesCbcNoPad: input must be block-aligned');
  const ct = await aesCbcPadded(key, iv, data);
  return ct.subarray(0, data.length);
}

async function sha(alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest(alg, buf(data)));
}

// ---------------------------------------------------------------------------
// ISO 32000-2 Algorithm 2.B: the R6 password hash
// ---------------------------------------------------------------------------

/**
 * K = SHA-256(password ‖ salt ‖ udata); then, round after round:
 *   K1 = (password ‖ K ‖ udata) repeated 64 times
 *   E  = AES-128-CBC-nopad(key = K[0..16], iv = K[16..32], K1)
 *   K  = SHA-256 / 384 / 512 (E), picked by (first 16 bytes of E as a big
 *        integer) mod 3 — equal to the byte sum mod 3 since 256 ≡ 1 (mod 3)
 * for at least 64 rounds and until E's last byte <= round - 32.
 * Result: the first 32 bytes of K. `udata` is the 48-byte U for owner hashes,
 * empty for user hashes.
 */
async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Bytes> {
  let k: Bytes = await sha('SHA-256', concat(password, salt, udata));
  let e: Bytes = new Uint8Array(0);
  let round = 0;
  while (round < 64 || e[e.length - 1] > round - 32) {
    const seq = concat(password, k, udata);
    const k1 = new Uint8Array(seq.length * 64);
    for (let i = 0; i < 64; i++) k1.set(seq, i * seq.length);
    const aesKey = await importAesKey(k.subarray(0, 16));
    e = await aesCbcNoPad(aesKey, k.subarray(16, 32), k1);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const alg = sum % 3 === 0 ? 'SHA-256' : sum % 3 === 1 ? 'SHA-384' : 'SHA-512';
    k = await sha(alg, e);
    round++;
  }
  return k.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Algorithms 8, 9, 10: U/UE, O/OE, Perms
// ---------------------------------------------------------------------------

const ZERO_IV = new Uint8Array(16);

interface KeyEntries {
  hash: Bytes; // 48 bytes: 32-byte hash ‖ 8-byte validation salt ‖ 8-byte key salt
  wrapped: Bytes; // 32 bytes: file key encrypted with the intermediate key
}

/**
 * Algorithm 8 (user, udata empty) and Algorithm 9 (owner, udata = U):
 *   hash    = 2.B(pw, validationSalt, udata) ‖ validationSalt ‖ keySalt
 *   wrapped = AES-256-CBC-nopad(key = 2.B(pw, keySalt, udata), iv = 0, fileKey)
 */
async function makeKeyEntries(pw: Uint8Array, udata: Uint8Array, fileKey: Uint8Array): Promise<KeyEntries> {
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);
  const h = await hash2B(pw, validationSalt, udata);
  const intermediate = await hash2B(pw, keySalt, udata);
  const wrapped = await aesCbcNoPad(await importAesKey(intermediate), ZERO_IV, fileKey);
  return { hash: concat(h, validationSalt, keySalt), wrapped };
}

/**
 * Algorithm 10: Perms = AES-256-ECB(fileKey, block) where block is
 * P (4 bytes little-endian) ‖ FF FF FF FF ‖ 'T'|'F' (EncryptMetadata) ‖ 'adb' ‖ 4 random bytes.
 * ECB of a single block equals CBC with a zero IV.
 */
async function makePerms(p: number, encryptMetadata: boolean, fileKey: CryptoKey): Promise<Bytes> {
  const block = new Uint8Array(16);
  new DataView(block.buffer).setInt32(0, p, true);
  block.set([0xff, 0xff, 0xff, 0xff], 4);
  block[8] = encryptMetadata ? 0x54 : 0x46;
  block.set([0x61, 0x64, 0x62], 9);
  block.set(randomBytes(4), 12);
  return aesCbcNoPad(fileKey, ZERO_IV, block);
}

/**
 * P value (ISO 32000-2 Table 22). Bits are 1-based: 3 print, 4 modify,
 * 5 copy/extract, 6 annotate, 9 fill forms, 10 extract for accessibility,
 * 11 assemble, 12 high-quality print. Bits 1-2 must be 0, bits 7-8 and
 * 13-32 must be 1. Returned as a signed 32-bit integer.
 */
export function permissionsToP(p: PdfPermissions): number {
  let v = 0xfffff0c0; // bits 7, 8, 13..32 set
  const bit = (n: number, on: boolean): void => {
    if (on) v |= 1 << (n - 1);
  };
  bit(3, p.print);
  bit(4, p.modify);
  bit(5, p.copy);
  bit(6, p.annotate);
  bit(9, p.fillForms);
  bit(10, p.extractForAccessibility);
  bit(11, p.assemble);
  bit(12, p.printHighQuality);
  return v | 0;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const ENCRYPT_TOKEN = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"

/**
 * Cheap, synchronous check: scans for an "/Encrypt" key followed by an
 * indirect reference or an inline dictionary (as it appears in a trailer or
 * cross-reference stream dictionary). Does not parse the file.
 */
export function isPdfEncrypted(bytes: Uint8Array): boolean {
  const n = bytes.length;
  const first = ENCRYPT_TOKEN[0];
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= n - ENCRYPT_TOKEN.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < ENCRYPT_TOKEN.length; j++) if (bytes[i + j] !== ENCRYPT_TOKEN[j]) continue outer;
    // Inspect what follows the key (skip "/EncryptMetadata" and similar).
    let k = i + ENCRYPT_TOKEN.length;
    const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
    if (k < n && !isWs(bytes[k]) && bytes[k] !== 0x3c && !(bytes[k] >= 0x30 && bytes[k] <= 0x39)) continue;
    while (k < n && isWs(bytes[k])) k++;
    if (bytes[k] === 0x3c && bytes[k + 1] === 0x3c) return true; // "<<"
    const tail = String.fromCharCode(...bytes.subarray(k, Math.min(n, k + 24)));
    if (/^\d+\s+\d+\s+R/.test(tail)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Object-graph encryption
// ---------------------------------------------------------------------------

const N_TYPE = PDFName.of('Type');
const N_SIG = PDFName.of('Sig');
const N_CONTENTS = PDFName.of('Contents');
const N_XREF = PDFName.of('XRef');

class ObjectEncryptor {
  private readonly visited = new Set<PDFObject>();

  constructor(private readonly key: CryptoKey) {}

  /** AES-256-CBC with a fresh random IV, which is prepended to the ciphertext (7.6.3). */
  async encryptBytes(data: Uint8Array): Promise<Bytes> {
    const iv = randomBytes(16);
    return concat(iv, await aesCbcPadded(this.key, iv, data));
  }

  private async encryptString(s: PDFString | PDFHexString): Promise<PDFHexString> {
    return hexString(await this.encryptBytes(s.asBytes()));
  }

  /**
   * Returns the replacement for `obj` if it is a string, otherwise encrypts
   * inside it in place and returns undefined. Containers are visited once so
   * shared direct objects are not encrypted twice.
   */
  async visit(obj: PDFObject): Promise<PDFHexString | undefined> {
    if (obj instanceof PDFString || obj instanceof PDFHexString) return this.encryptString(obj);
    if (this.visited.has(obj)) return undefined;
    if (obj instanceof PDFDict) {
      this.visited.add(obj);
      const isSig = obj.get(N_TYPE) === N_SIG;
      for (const [key, value] of obj.entries()) {
        if (isSig && key === N_CONTENTS) continue; // signature value stays in clear (7.6.2)
        const rep = await this.visit(value);
        if (rep) obj.set(key, rep);
      }
    } else if (obj instanceof PDFArray) {
      this.visited.add(obj);
      for (let i = 0; i < obj.size(); i++) {
        const rep = await this.visit(obj.get(i));
        if (rep) obj.set(i, rep);
      }
    }
    // Names, numbers, booleans, null and refs are never encrypted.
    return undefined;
  }

  /**
   * Encrypts one stream: strings in its dictionary, then its *encoded*
   * contents (i.e. after Filter, which the reader applies after decrypting).
   * pdf-lib's generated streams (PDFContentStream, PDFFlateStream, ...)
   * compute their bytes lazily in getContents(), so they are materialised
   * here and replaced with a PDFRawStream sharing the same dictionary.
   * PDFStream.updateDict() rewrites /Length from the new contents on save.
   */
  async encryptStream(stream: PDFStream): Promise<PDFRawStream> {
    await this.visit(stream.dict);
    const encrypted = await this.encryptBytes(stream.getContents());
    stream.dict.set(PDFName.Length, PDFNumber.of(encrypted.length));
    return PDFRawStream.of(stream.dict, encrypted);
  }
}

/**
 * Encrypts every string and stream of every indirect object with the file
 * key (AES-256-CBC, no per-object key). Also used by the public-key handler.
 */
export async function encryptAllObjects(doc: PDFDocument, aesFileKey: CryptoKey): Promise<void> {
  const context = doc.context;
  const enc = new ObjectEncryptor(aesFileKey);
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      if (obj.dict.get(N_TYPE) === N_XREF) continue; // xref streams are never encrypted
      context.assign(ref, await enc.encryptStream(obj));
    } else {
      const rep = await enc.visit(obj);
      if (rep) context.assign(ref, rep);
    }
  }
}

export { importAesKey };

/**
 * Encrypts a PDF with AES-256 (V5/R6). Rejects input that is already encrypted.
 */
export async function encryptPdf(bytes: Uint8Array, opts: EncryptOptions): Promise<Uint8Array> {
  if (isPdfEncrypted(bytes)) {
    throw new Error('This PDF is already encrypted; remove its password before encrypting it again.');
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof Error && err.name === 'EncryptedPDFError') {
      throw new Error('This PDF is already encrypted; remove its password before encrypting it again.');
    }
    throw err;
  }

  // Materialise everything save() would otherwise add later, so it gets encrypted too.
  if (doc.getPageCount() === 0) doc.addPage();
  await doc.flush();

  const context = doc.context;
  const fileKey = randomBytes(32);
  const aesFileKey = await importAesKey(fileKey);
  const P = permissionsToP(opts.permissions);
  const encryptMetadata = true;

  // Algorithms 8, 9, 10.
  const user = await makeKeyEntries(passwordBytes(opts.userPassword), new Uint8Array(0), fileKey);
  const owner = await makeKeyEntries(passwordBytes(opts.ownerPassword || opts.userPassword), user.hash, fileKey);
  const perms = await makePerms(P, encryptMetadata, aesFileKey);

  await encryptAllObjects(doc, aesFileKey);

  // The Encrypt dictionary is registered afterwards so it is not itself encrypted.
  const stdCF = context.obj({ AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 });
  const encryptDict = context.obj({
    Filter: 'Standard',
    V: 5,
    R: 6,
    Length: 256,
    CF: context.obj({ StdCF: stdCF }),
    StmF: 'StdCF',
    StrF: 'StdCF',
    P,
  });
  encryptDict.set(PDFName.of('O'), hexString(owner.hash));
  encryptDict.set(PDFName.of('U'), hexString(user.hash));
  encryptDict.set(PDFName.of('OE'), hexString(owner.wrapped));
  encryptDict.set(PDFName.of('UE'), hexString(user.wrapped));
  encryptDict.set(PDFName.of('Perms'), hexString(perms));
  encryptDict.set(PDFName.of('EncryptMetadata'), PDFBool.True);
  const encryptRef: PDFRef = context.register(encryptDict);

  // PDFWriter.createTrailerDict() copies trailerInfo.Encrypt and .ID into the trailer.
  context.trailerInfo.Encrypt = encryptRef;
  if (!context.trailerInfo.ID) {
    const id = toHex(randomBytes(16));
    context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  }

  // Object streams would have to be encrypted as a whole; the classic writer avoids them.
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
