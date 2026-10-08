import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decryptPdf, encryptWithSecurity, isOwnerPassword, md5, permissionsFromP, PdfPasswordError, rc4 } from '../src/lib/crypto/decrypt';
import { encryptPdf, isPdfEncrypted, permissionsToP, type PdfPermissions } from '../src/lib/crypto/encrypt';
import { appendUpdate, encryptFixture, type Handler } from './helpers/pdfEncryptor';

const SECRET = 'Adika secret text 42';
const TITLE = 'Confidential report';
const XMP_MARK = 'AdikaXmpMarker';

const RESTRICTED: PdfPermissions = {
  print: true,
  printHighQuality: false,
  modify: false,
  copy: false,
  annotate: true,
  fillForms: true,
  extractForAccessibility: true,
  assemble: false,
};
const P = permissionsToP(RESTRICTED);

async function makePdf(objectStreams = true): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(TITLE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText(SECRET, { x: 40, y: 200, size: 18, font, color: rgb(0, 0, 0) });
  doc.addPage([400, 300]).drawText('Second page', { x: 40, y: 200, size: 18, font });
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${XMP_MARK}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const meta = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta));
  return doc.save({ useObjectStreams: objectStreams });
}

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function open(data: Uint8Array, password?: string) {
  const task = pdfjs.getDocument({ data: data.slice(), password, useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  await Promise.all(tasks.map((t) => t.destroy()));
});

async function allText(doc: pdfjs.PDFDocumentProxy): Promise<string> {
  let s = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    s += tc.items.map((it) => ('str' in it ? it.str : '')).join('') + '\n';
  }
  return s;
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Decrypt → edit (a new line of text and a new page) → encrypt again with the same security. */
async function roundTrip(bytes: Uint8Array, password: string) {
  const { bytes: plain, unlocked } = await decryptPdf(bytes, password);
  expect(isPdfEncrypted(plain)).toBe(false);
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText('EDITED LINE', { x: 40, y: 120, size: 14, font });
  doc.addPage([400, 300]).drawText('Added page', { x: 40, y: 200, size: 14, font });
  const edited = await doc.save({ useObjectStreams: true });
  const out = await encryptWithSecurity(edited, unlocked);
  return { out, unlocked };
}

const handlers: Handler[] = ['rc4-40', 'rc4-128', 'aesv2', 'aesv3-r5', 'aesv3-r6'];

describe('primitives', () => {
  it('MD5 and RC4 match published vectors', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(md5(new Uint8Array(0)))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(Buffer.from('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex(md5(Buffer.from('a'.repeat(1000))))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
    expect(hex(rc4(Buffer.from('Key'), Buffer.from('Plaintext')))).toBe('bbf316e8d940af0ad3');
  });

  it('reads permissions from P', () => {
    expect(permissionsFromP(P, 4)).toEqual(RESTRICTED);
    // R2 knows only bits 3-6: form filling follows commenting.
    expect(permissionsFromP(-64 + 32, 2)).toMatchObject({ annotate: true, fillForms: true, modify: false });
  });
});

describe.each(handlers)('%s', (handler) => {
  it('decrypts, takes an edit and is encrypted again with the same passwords and permissions', async () => {
    const f = await encryptFixture(await makePdf(), { handler, userPassword: 'user123', ownerPassword: 'owner456', p: P });
    expect(latin1(f.bytes)).not.toContain(SECRET);
    // The fixture itself is valid.
    expect(await allText(await open(f.bytes, 'user123'))).toContain(SECRET);

    const { out, unlocked } = await roundTrip(f.bytes, 'user123');
    expect(unlocked.owner).toBe(false);
    expect(unlocked.userPassword).toBe(true);
    expect(unlocked.security.p).toBe(P);
    expect(latin1(out)).not.toContain('EDITED LINE');
    expect(latin1(out)).not.toContain(SECRET);

    await expect(open(out)).rejects.toMatchObject({ name: 'PasswordException' });
    for (const pw of ['user123', 'owner456']) {
      const doc = await open(out, pw);
      expect(doc.numPages).toBe(3);
      const text = await allText(doc);
      expect(text).toContain(SECRET);
      expect(text).toContain('EDITED LINE');
      expect(text).toContain('Added page');
      expect((await doc.getMetadata()).info).toMatchObject({ Title: TITLE });
    }
    const perms = (await (await open(out, 'user123')).getPermissions()) ?? [];
    const before = (await (await open(f.bytes, 'user123')).getPermissions()) ?? [];
    expect([...perms].sort()).toEqual([...before].sort());

    // Decrypting the re-encrypted file with the owner password gives full rights.
    const again = await decryptPdf(out, 'owner456');
    expect(again.unlocked.owner).toBe(true);
    expect(again.unlocked.security.p).toBe(P);
    expect(await isOwnerPassword(again.unlocked.security, 'owner456')).toBe(true);
    expect(await isOwnerPassword(again.unlocked.security, 'user123')).toBe(false);
  });

  it('refuses a wrong or missing password', async () => {
    const f = await encryptFixture(await makePdf(), { handler, userPassword: 'user123', ownerPassword: 'owner456', p: P });
    await expect(decryptPdf(f.bytes, 'wrong')).rejects.toMatchObject({ incorrect: true });
    await expect(decryptPdf(f.bytes)).rejects.toBeInstanceOf(PdfPasswordError);
    await expect(decryptPdf(f.bytes)).rejects.toMatchObject({ incorrect: false });
  });
});

describe('special cases', () => {
  it('opens an owner-password-only file without a password, with its restrictions', async () => {
    const f = await encryptFixture(await makePdf(), { handler: 'aesv2', userPassword: '', ownerPassword: 'owner456', p: P });
    const { bytes, unlocked } = await decryptPdf(f.bytes);
    expect(unlocked.owner).toBe(false);
    expect(unlocked.userPassword).toBe(false);
    const rights = permissionsFromP(unlocked.security.p, unlocked.security.r);
    expect(rights.modify).toBe(false);
    expect(rights.annotate).toBe(true);
    expect(await allText(await open(bytes))).toContain(SECRET);
    // Re-encrypted: still opens without a password, the owner password still unlocks everything.
    const { out } = await roundTrip(f.bytes, '');
    expect(await allText(await open(out))).toContain('EDITED LINE');
    expect((await decryptPdf(out, 'owner456')).unlocked.owner).toBe(true);
  });

  it('keeps XMP metadata in clear with EncryptMetadata false', async () => {
    for (const handler of ['aesv2', 'aesv3-r6'] as const) {
      const f = await encryptFixture(await makePdf(), { handler, userPassword: 'u', ownerPassword: 'o', p: P, encryptMetadata: false });
      expect(latin1(f.bytes)).toContain(XMP_MARK);
      const { bytes } = await decryptPdf(f.bytes, 'u');
      expect(latin1(bytes)).toContain(XMP_MARK);
      const { out } = await roundTrip(f.bytes, 'u');
      expect(latin1(out)).toContain(XMP_MARK);
      expect(latin1(out)).toContain('/EncryptMetadata false');
      const doc = await open(out, 'u');
      expect(await allText(doc)).toContain('EDITED LINE');
      expect((await doc.getMetadata()).metadata?.get('dc:title')).toBe(XMP_MARK);
    }
  });

  it('decrypts object streams as a whole (xref stream left alone)', async () => {
    for (const handler of ['rc4-128', 'aesv2', 'aesv3-r6'] as const) {
      const f = await encryptFixture(await makePdf(), { handler, userPassword: 'user123', ownerPassword: 'owner456', p: P, objectStreams: true });
      expect(latin1(f.bytes)).toContain('/ObjStm');
      expect(await allText(await open(f.bytes, 'user123'))).toContain(SECRET);
      const { bytes } = await decryptPdf(f.bytes, 'user123');
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(2);
      expect(doc.getTitle()).toBe(TITLE);
      const { out } = await roundTrip(f.bytes, 'owner456');
      expect(await allText(await open(out, 'user123'))).toContain('EDITED LINE');
    }
  });

  it('takes the latest version of objects after an incremental update', async () => {
    const plain = await makePdf(false);
    const f = await encryptFixture(plain, { handler: 'rc4-128', userPassword: 'user123', ownerPassword: 'owner456', p: P });
    const doc = await PDFDocument.load(plain);
    const infoRef = doc.context.trailerInfo.Info as import('pdf-lib').PDFRef;
    const info = doc.context.lookup(infoRef) as import('pdf-lib').PDFDict;
    info.set(PDFName.of('Title'), PDFString.of('Updated title'));
    const updated = appendUpdate(f, [[infoRef, info]]);
    expect((await (await open(updated.bytes, 'user123')).getMetadata()).info).toMatchObject({ Title: 'Updated title' });
    const { bytes } = await decryptPdf(updated.bytes, 'user123');
    expect((await PDFDocument.load(bytes)).getTitle()).toBe('Updated title');
    const { out } = await roundTrip(updated.bytes, 'user123');
    expect((await (await open(out, 'owner456')).getMetadata()).info).toMatchObject({ Title: 'Updated title' });
  });

  it("decrypts Adika's own AES-256 files with either password", async () => {
    const enc = await encryptPdf(await makePdf(), { userPassword: 'user123', ownerPassword: 'owner456', permissions: RESTRICTED });
    const user = await decryptPdf(enc, 'user123');
    expect(user.unlocked.owner).toBe(false);
    expect(user.unlocked.security.r).toBe(6);
    expect(await allText(await open(user.bytes))).toContain(SECRET);
    const owner = await decryptPdf(enc, 'owner456');
    expect(owner.unlocked.owner).toBe(true);
    const { out } = await roundTrip(enc, 'user123');
    expect(await allText(await open(out, 'owner456'))).toContain('EDITED LINE');
  });
});
