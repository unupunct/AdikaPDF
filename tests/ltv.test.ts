import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addValidationData, createSelfSignedIdentity, signPdf, verifyPdfSignatures, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import { incrementalUpdate } from '@/lib/pdf/incremental';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const CRL_URL = 'http://crl.adika.test/root.crl';
let root: forge.pki.Certificate;
let rootKey: forge.pki.rsa.PrivateKey;
let signer: SigningIdentity;
let crl: Uint8Array;
let pdf: Uint8Array;

const bin = (b: Uint8Array) => Buffer.from(b).toString('binary');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'binary'));

/** A CRL (no revoked certificates) signed by the root, as a CA would publish it. */
function makeCrl(): Uint8Array {
  const a = forge.asn1;
  const algo = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer('1.2.840.113549.1.1.11').getBytes()), a.create(a.Class.UNIVERSAL, a.Type.NULL, false, '')]);
  const now = new Date();
  const tbs = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
    a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, String.fromCharCode(1)),
    algo,
    forge.pki.distinguishedNameToAsn1(root.subject),
    a.create(a.Class.UNIVERSAL, a.Type.UTCTIME, false, a.dateToUtcTime(new Date(now.getTime() - 3600e3))),
    a.create(a.Class.UNIVERSAL, a.Type.UTCTIME, false, a.dateToUtcTime(new Date(now.getTime() + 7 * 86400e3))),
  ]);
  const tbsDer = a.toDer(tbs).getBytes();
  const md = forge.md.sha256.create();
  md.update(tbsDer);
  const sig = rootKey.sign(md);
  const algo2 = a.fromDer(a.toDer(algo).getBytes());
  const crlAsn = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.fromDer(tbsDer), algo2, a.create(a.Class.UNIVERSAL, a.Type.BITSTRING, false, String.fromCharCode(0) + sig)]);
  return bytes(a.toDer(crlAsn).getBytes());
}

beforeAll(async () => {
  const rk = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  rootKey = rk.privateKey;
  root = forge.pki.createCertificate();
  root.publicKey = rk.publicKey;
  root.serialNumber = '01';
  root.validity.notBefore = new Date(Date.now() - 86400e3);
  root.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const rootName = [{ name: 'commonName', value: 'Adika Test Root CA' }, { name: 'organizationName', value: 'Adika' }];
  root.setSubject(rootName);
  root.setIssuer(rootName);
  root.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  root.sign(rootKey, forge.md.sha256.create());

  const lk = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = lk.publicKey;
  leaf.serialNumber = '02';
  leaf.validity.notBefore = new Date(Date.now() - 86400e3);
  leaf.validity.notAfter = new Date(Date.now() + 180 * 86400e3);
  leaf.setSubject([{ name: 'commonName', value: 'Maria Ionescu' }]);
  leaf.setIssuer(rootName);
  leaf.setExtensions([{ name: 'keyUsage', digitalSignature: true, nonRepudiation: true }, { name: 'cRLDistributionPoints', altNames: [{ type: 6, value: CRL_URL }] }]);
  leaf.sign(rootKey, forge.md.sha256.create());
  signer = { name: 'Maria Ionescu', email: null, certificate: leaf, privateKey: lk.privateKey, chain: [root], subject: 'CN=Maria Ionescu', issuer: 'CN=Adika Test Root CA', validFrom: leaf.validity.notBefore, validTo: leaf.validity.notAfter, selfSigned: false };
  crl = makeCrl();

  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) d.addPage([595, 842]).drawText(`Contract, page ${i}`, { x: 60, y: 760, size: 18, font });
  const form = d.getForm();
  form.createTextField('Amount').addToPage(d.getPage(0), { x: 60, y: 600, width: 200, height: 22 });
  pdf = await d.save();
}, 60000);

const opts = () => ({ trustedRoots: [root] });
const httpGet = async (url: string) => {
  if (url !== CRL_URL) throw new Error(`unexpected ${url}`);
  return crl;
};

describe('long-term validation and certified documents', () => {
  it('stores chain and CRL in the DSS; offline verification then uses them; the signature stays valid', async () => {
    const signed = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0] });
    const { bytes: ltv, notes, complete } = await addValidationData(signed, { ...opts(), httpGet });
    expect(notes).toEqual([]);
    expect(complete).toBe(true);
    // The signed bytes are untouched (incremental update).
    expect(Buffer.from(ltv.subarray(0, signed.length)).equals(Buffer.from(signed))).toBe(true);
    const doc = await PDFDocument.load(ltv);
    expect(doc.catalog.lookup(PDFName.of('DSS'))?.toString()).toMatch(/\/Certs[\s\S]*\/CRLs[\s\S]*\/VRI/);
    const [r] = await verifyPdfSignatures(ltv, opts()); // no network
    expect(r.integrity).toBe('valid');
    expect(r.chainStatus).toBe('trusted');
    expect(r.revocationStatus).toBe('good');
    expect(r.revocationDetails).toMatch(/saved in the file/);
    expect(r.ltv).toBe(true);
    expect(r.coversWholeFile).toBe(false);
    expect(r.laterChanges).toEqual({ ltv: true, signatures: false, form: false, other: false });
    expect(r.modifiedAfterSigning).toBe(false);
    // Other readers still open it.
    const task = pdfjs.getDocument({ data: ltv.slice(), verbosity: 0 });
    tasks.push(task);
    expect((await task.promise).numPages).toBe(2);
  });

  it('certified (form filling and signing allowed): a second signature keeps the first valid', async () => {
    const certified = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], certify: 2 });
    const twice = await signPdf(certified, { identity: signer, pageIndex: 1, rect: [300, 40, 450, 90] });
    expect(Buffer.from(twice.subarray(0, certified.length)).equals(Buffer.from(certified))).toBe(true);
    const rs = await verifyPdfSignatures(twice, opts());
    const [s1, s2] = [rs.find((x) => x.fieldName === 'Signature1')!, rs.find((x) => x.fieldName === 'Signature2')!];
    expect(s1.integrity).toBe('valid');
    expect(s1.certified).toBe(2);
    expect(s1.laterChanges?.signatures).toBe(true);
    expect(s1.modifiedAfterSigning).toBe(false);
    expect(s2.integrity).toBe('valid');
    expect(s2.coversWholeFile).toBe(true);
  });

  it('certified with no changes allowed: a later signature counts as a modification', async () => {
    const certified = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], certify: 1 });
    await expect(signPdf(certified, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], certify: 2 })).rejects.toThrow(/Only the first signature can certify/);
    const twice = await signPdf(certified, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0] });
    const s1 = (await verifyPdfSignatures(twice, opts())).find((x) => x.fieldName === 'Signature1')!;
    expect(s1.certified).toBe(1);
    expect(s1.modifiedAfterSigning).toBe(true);
  });

  it('filling in a field after signing is allowed; changing page content is not', async () => {
    const signed = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0] });
    const filled = (await incrementalUpdate(signed, (d) => d.getForm().getTextField('Amount').setText('1250'))).bytes;
    const [f] = await verifyPdfSignatures(filled, opts());
    expect(f.laterChanges?.form).toBe(true);
    expect(f.laterChanges?.other).toBe(false);
    expect(f.modifiedAfterSigning).toBe(false);
    const tampered = (
      await incrementalUpdate(signed, async (d) => {
        const font = await d.embedFont(StandardFonts.Helvetica);
        d.getPage(0).drawText('PAID', { x: 300, y: 500, size: 40, font });
      })
    ).bytes;
    const [t] = await verifyPdfSignatures(tampered, opts());
    expect(t.integrity).toBe('valid'); // the signed revision itself is intact…
    expect(t.laterChanges?.other).toBe(true);
    expect(t.modifiedAfterSigning).toBe(true); // …but the page was changed afterwards
  });

  it('self-signed certificates cannot be made fully LTV (explained)', async () => {
    const self = await createSelfSignedIdentity({ name: 'Ion Test', email: 'ion@example.com', organization: 'Adika', country: 'ro' });
    const signed = await signPdf(pdf, { identity: self, pageIndex: 0, rect: [0, 0, 0, 0] });
    const { notes, complete } = await addValidationData(signed, { trustedRoots: [], httpGet });
    expect(complete).toBe(false);
    expect(notes.join(' ')).toMatch(/self-signed/);
  });

  it('incremental updates also work on files with cross-reference streams', async () => {
    const d = await PDFDocument.load(pdf);
    const streamed = await d.save({ useObjectStreams: true });
    const up = (await incrementalUpdate(streamed, (x) => x.setTitle('Updated'))).bytes;
    expect(Buffer.from(up.subarray(0, streamed.length)).equals(Buffer.from(streamed))).toBe(true);
    expect((await PDFDocument.load(up)).getTitle()).toBe('Updated');
    const task = pdfjs.getDocument({ data: up.slice(), verbosity: 0 });
    tasks.push(task);
    expect((await task.promise).numPages).toBe(2);
  });
});
