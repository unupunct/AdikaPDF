/**
 * Certificate (public-key) encryption, ISO 32000-2 7.6.5 (Adobe.PubSec,
 * adbe.pkcs7.s5, AES-256): the document opens only for the chosen people,
 * with the private key of their certificate — no shared password.
 *
 * Each recipient gets a CMS EnvelopedData (RSA key transport, AES-256-CBC)
 * holding a 20-byte seed and the permissions; the file key is
 * SHA-256(seed ‖ every recipient blob). The objects are then encrypted as
 * with a password (AESV3).
 *
 * Opening: the recipient's private key decrypts their envelope (a .pfx key
 * here, or the Windows certificate store through a callback), then every
 * string and stream is decrypted. Documents that keep objects in encrypted
 * object streams (common with other producers) are not supported.
 */
import forge from 'node-forge';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from 'pdf-lib';
import { encryptAllObjects, importAesKey, isPdfEncrypted, permissionsToP, type PdfPermissions } from './encrypt';

const bin = (b: Uint8Array) => forge.util.binary.raw.encode(b);
const bytes = (s: string) => forge.util.binary.raw.decode(s);
const subtle = () => globalThis.crypto.subtle;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await subtle().digest('SHA-256', all));
}

/** Is this a PDF encrypted for certificates (rather than with a password)? */
export function isPubSecEncrypted(pdf: Uint8Array): boolean {
  if (!isPdfEncrypted(pdf)) return false;
  // The Encrypt dictionary is never encrypted: its /Filter is readable.
  const tail = new TextDecoder('latin1').decode(pdf.length > 4_000_000 ? pdf.subarray(0, 2_000_000) : pdf);
  const tailEnd = pdf.length > 4_000_000 ? new TextDecoder('latin1').decode(pdf.subarray(pdf.length - 2_000_000)) : '';
  return /\/Filter\s*\/Adobe\.PubSec/.test(tail) || /\/Filter\s*\/Adobe\.PubSec/.test(tailEnd);
}

export async function encryptForCertificates(pdf: Uint8Array, recipients: forge.pki.Certificate[], permissions: PdfPermissions): Promise<Uint8Array> {
  if (!recipients.length) throw new Error('Choose at least one recipient.');
  if (isPdfEncrypted(pdf)) throw new Error('This PDF is already encrypted; remove its protection first.');
  for (const c of recipients) {
    if (!(c.publicKey as forge.pki.rsa.PublicKey | undefined)?.n) throw new Error(`${c.subject.getField('CN')?.value ?? 'A certificate'} does not have an RSA key; only RSA certificates can receive encrypted documents.`);
  }
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  if (doc.getPageCount() === 0) doc.addPage();
  await doc.flush();
  const P = permissionsToP(permissions);
  const seed = crypto.getRandomValues(new Uint8Array(20));
  // 24 bytes: the seed and the permissions, most significant byte first.
  const content = new Uint8Array(24);
  content.set(seed, 0);
  content[20] = (P >>> 24) & 0xff;
  content[21] = (P >>> 16) & 0xff;
  content[22] = (P >>> 8) & 0xff;
  content[23] = P & 0xff;
  const blobs: Uint8Array[] = recipients.map((cert) => {
    const env = forge.pkcs7.createEnvelopedData();
    env.addRecipient(cert);
    env.content = forge.util.createBuffer(bin(content));
    env.encrypt(undefined, forge.pki.oids['aes256-CBC']);
    return bytes(forge.asn1.toDer(env.toAsn1()).getBytes());
  });
  const fileKey = await sha256(seed, ...blobs);
  await encryptAllObjects(doc, await importAesKey(fileKey));
  const ctx = doc.context;
  const cf = ctx.obj({
    DefaultCryptFilter: {
      Type: 'CryptFilter',
      CFM: 'AESV3',
      Length: 256,
      Recipients: ctx.obj(blobs.map((b) => PDFHexString.of(hex(b)))),
      EncryptMetadata: true,
    },
  });
  const enc = ctx.obj({ Filter: 'Adobe.PubSec', SubFilter: 'adbe.pkcs7.s5', V: 5, Length: 256, CF: cf, StmF: 'DefaultCryptFilter', StrF: 'DefaultCryptFilter' }) as PDFDict;
  ctx.trailerInfo.Encrypt = ctx.register(enc);
  if (!ctx.trailerInfo.ID) {
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  }
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

export interface RecipientKey {
  certificate: forge.pki.Certificate;
  /** Decrypts the RSA-encrypted content key (PKCS#1 v1.5): a .pfx key, or the Windows store. */
  decryptKey: (encrypted: Uint8Array) => Promise<Uint8Array>;
}

export function recipientFromPrivateKey(certificate: forge.pki.Certificate, key: forge.pki.rsa.PrivateKey): RecipientKey {
  return { certificate, decryptKey: async (e) => bytes(key.decrypt(bin(e), 'RSAES-PKCS1-V1_5')) };
}

/** Certificates a document is encrypted for (subject names), for "not for you" messages. */
export async function pubSecRecipients(pdf: Uint8Array): Promise<string[]> {
  const { blobs } = await readEncrypt(pdf);
  const out: string[] = [];
  for (const b of blobs) {
    try {
      const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(bin(b))) as unknown as { recipients: Array<{ issuer: forge.pki.CertificateField[]; serialNumber: string }> };
      for (const r of msg.recipients) out.push(`${r.issuer.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ')} #${r.serialNumber}`);
    } catch {
      /* unreadable recipient */
    }
  }
  return out;
}

async function readEncrypt(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  const encRef = doc.context.trailerInfo.Encrypt;
  const enc = encRef instanceof PDFRef ? doc.context.lookup(encRef) : encRef;
  if (!(enc instanceof PDFDict) || (enc.lookup(PDFName.of('Filter')) as PDFName | undefined)?.decodeText() !== 'Adobe.PubSec') throw new Error('This PDF is not encrypted for certificates.');
  const cf = enc.lookup(PDFName.of('CF'));
  const def = cf instanceof PDFDict ? cf.lookup(PDFName.of('DefaultCryptFilter')) : null;
  const rec = (def instanceof PDFDict ? def.lookup(PDFName.of('Recipients')) : null) ?? enc.lookup(PDFName.of('Recipients'));
  const blobs = rec instanceof PDFArray ? rec.asArray().map((x) => (x instanceof PDFHexString || x instanceof PDFString ? x.asBytes() : new Uint8Array(0))) : rec instanceof PDFHexString || rec instanceof PDFString ? [rec.asBytes()] : [];
  const cfm = def instanceof PDFDict ? (def.lookup(PDFName.of('CFM')) as PDFName | undefined)?.decodeText() : null;
  const encryptMetadata = def instanceof PDFDict ? def.lookup(PDFName.of('EncryptMetadata')) !== PDFBool.False : true;
  return { doc, enc, encRef, blobs, cfm, encryptMetadata };
}

/** Decrypts a certificate-encrypted PDF with one recipient's key; returns the plain PDF. */
export async function decryptWithCertificate(pdf: Uint8Array, key: RecipientKey): Promise<Uint8Array> {
  const { doc, encRef, blobs, cfm, encryptMetadata } = await readEncrypt(pdf);
  if (cfm !== 'AESV3') throw new Error(`Only AES-256 certificate encryption is supported (this file uses ${cfm ?? 'an older method'}).`);
  // Find our envelope and open it.
  let seed: Uint8Array | null = null;
  for (const b of blobs) {
    let msg: forge.pkcs7.PkcsEnvelopedData;
    try {
      msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(bin(b))) as forge.pkcs7.PkcsEnvelopedData;
    } catch {
      continue;
    }
    const r = (msg as unknown as { findRecipient(c: forge.pki.Certificate): { encryptedContent: { content: string } } | null }).findRecipient(key.certificate);
    if (!r) continue;
    const cek = await key.decryptKey(bytes(r.encryptedContent.content));
    // forge opens the content with the key we pass back.
    (msg as unknown as { decrypt(r: unknown, k: unknown): void }).decrypt(r, { decrypt: () => bin(cek) });
    const content = bytes((msg as unknown as { content: forge.util.ByteStringBuffer }).content.getBytes());
    if (content.length < 20) throw new Error('The certificate envelope is damaged.');
    seed = content.subarray(0, 20);
    break;
  }
  if (!seed) throw new Error('This document is not encrypted for your certificate.');
  const fileKey = await sha256(seed, ...blobs, ...(encryptMetadata ? [] : [new Uint8Array([0xff, 0xff, 0xff, 0xff])]));
  const aes = await subtle().importKey('raw', fileKey.slice().buffer as ArrayBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
  const dec = async (data: Uint8Array): Promise<Uint8Array> => {
    if (data.length < 32) return new Uint8Array(0);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: data.slice(0, 16) }, aes, data.slice(16)));
  };
  const ctx = doc.context;
  const seen = new Set<unknown>();
  const visit = async (o: PDFObject, isSig = false): Promise<PDFObject | undefined> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of(hex(await dec(o.asBytes())));
    if (seen.has(o)) return undefined;
    if (o instanceof PDFDict) {
      seen.add(o);
      const sig = o.get(PDFName.of('Type')) === PDFName.of('Sig');
      for (const [k, v] of o.entries()) {
        if ((sig || isSig) && k.decodeText() === 'Contents') continue;
        const rep = await visit(v);
        if (rep) o.set(k, rep);
      }
    } else if (o instanceof PDFArray) {
      seen.add(o);
      for (let i = 0; i < o.size(); i++) {
        const rep = await visit(o.get(i));
        if (rep) o.set(i, rep);
      }
    }
    return undefined;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (encRef instanceof PDFRef && ref === encRef) continue;
    if (obj instanceof PDFStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type === PDFName.of('XRef')) continue;
      await visit(obj.dict);
      if (!encryptMetadata && type === PDFName.of('Metadata')) continue;
      const plain = await dec(obj instanceof PDFRawStream ? obj.contents : obj.getContents());
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(plain.length));
      ctx.assign(ref, PDFRawStream.of(obj.dict, plain));
    } else {
      const rep = await visit(obj);
      if (rep) ctx.assign(ref, rep);
    }
  }
  delete ctx.trailerInfo.Encrypt;
  if (encRef instanceof PDFRef) ctx.delete(encRef);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
