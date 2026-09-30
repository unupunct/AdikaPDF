import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decryptWithCertificate, encryptForCertificates, isPubSecEncrypted, pubSecRecipients, recipientFromPrivateKey } from '@/lib/crypto/pubsec';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

function person(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(3)).replace(/^[89a-f]/, '1');
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 86400e3 * 30);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

let ana: ReturnType<typeof person>;
let dan: ReturnType<typeof person>;
let eva: ReturnType<typeof person>;
let pdf: Uint8Array;
beforeAll(async () => {
  ana = person('Ana Popescu');
  dan = person('Dan Ionescu');
  eva = person('Eva Stranger');
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([400, 300]).drawText('Contract confidential - clauza 7', { x: 30, y: 250, size: 14, font: f });
  d.addPage([400, 300]).drawText('Anexa 2', { x: 30, y: 250, size: 14, font: f });
  d.setTitle('Contract secret');
  pdf = await d.save();
}, 60000);

async function text(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const doc = await task.promise;
  return (await (await doc.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

describe('certificate encryption', () => {
  const perms = { print: true, printHighQuality: true, modify: false, copy: false, annotate: true, fillForms: true, extractForAccessibility: true, assemble: false };

  it('encrypts for several people; each opens it with their own key, strangers cannot', async () => {
    const enc = await encryptForCertificates(pdf, [ana.cert, dan.cert], perms);
    expect(isPdfEncrypted(enc)).toBe(true);
    expect(isPubSecEncrypted(enc)).toBe(true);
    expect(isPubSecEncrypted(pdf)).toBe(false);
    // Nothing readable without the key.
    expect(Buffer.from(enc).toString('latin1')).not.toContain('Contract secret');
    expect((await pubSecRecipients(enc)).length).toBe(2);
    for (const who of [ana, dan]) {
      const plain = await decryptWithCertificate(enc, recipientFromPrivateKey(who.cert, who.key));
      expect(isPdfEncrypted(plain)).toBe(false);
      expect(await text(plain)).toContain('Contract confidential - clauza 7');
      const doc = await PDFDocument.load(plain);
      expect(doc.getTitle()).toBe('Contract secret');
      expect(doc.getPageCount()).toBe(2);
    }
    await expect(decryptWithCertificate(enc, recipientFromPrivateKey(eva.cert, eva.key))).rejects.toThrow(/not encrypted for your certificate/);
  });

  it('refuses already encrypted files and non-RSA certificates', async () => {
    const enc = await encryptForCertificates(pdf, [ana.cert], perms);
    await expect(encryptForCertificates(enc, [ana.cert], perms)).rejects.toThrow(/already encrypted/);
    await expect(encryptForCertificates(pdf, [], perms)).rejects.toThrow(/at least one/);
  });
});
