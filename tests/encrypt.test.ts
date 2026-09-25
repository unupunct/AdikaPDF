import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { encryptPdf, isPdfEncrypted, permissionsToP, type PdfPermissions } from '../src/lib/crypto/encrypt';

// 1x1 red PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

const SECRET = 'Adika secret text 42';
const TITLE = 'Adika Confidential Title';

const PERMS: PdfPermissions = {
  print: true,
  printHighQuality: false,
  modify: false,
  copy: true,
  annotate: false,
  fillForms: true,
  extractForAccessibility: true,
  assemble: false,
};

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(TITLE);
  doc.setAuthor('Adika Tester');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 300]);
  p1.drawText(SECRET, { x: 40, y: 200, size: 18, font, color: rgb(0, 0, 0) });
  const img = await doc.embedPng(Buffer.from(PNG_B64, 'base64'));
  p1.drawImage(img, { x: 40, y: 40, width: 50, height: 50 });
  const p2 = doc.addPage([400, 300]);
  p2.drawText('Second page', { x: 40, y: 200, size: 18, font });
  // No object streams, so the Info strings are visible in the plain file.
  return doc.save({ useObjectStreams: false });
}

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];

function open(data: Uint8Array, password?: string) {
  const task = pdfjs.getDocument({
    data: data.slice(),
    password,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });
  tasks.push(task);
  return task.promise;
}

/** How pdf-lib's setTitle() stores text: UTF-16BE hex with a BOM. */
const utf16Hex = (s: string): string =>
  'FEFF' + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();

async function pageText(doc: pdfjs.PDFDocumentProxy, n: number): Promise<string> {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.map((i) => ('str' in i ? i.str : '')).join('');
}

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

describe('encryptPdf (AES-256, V5/R6)', () => {
  let plain: Uint8Array;
  let encrypted: Uint8Array;

  beforeAll(async () => {
    plain = await makePdf();
    encrypted = await encryptPdf(plain, { userPassword: 'user123', ownerPassword: 'owner456', permissions: PERMS });
  });

  it('computes P per Table 22', () => {
    const none: PdfPermissions = {
      print: false, printHighQuality: false, modify: false, copy: false,
      annotate: false, fillForms: false, extractForAccessibility: false, assemble: false,
    };
    expect(permissionsToP(none)).toBe(-3904); // 0xFFFFF0C0
    const all: PdfPermissions = {
      print: true, printHighQuality: true, modify: true, copy: true,
      annotate: true, fillForms: true, extractForAccessibility: true, assemble: true,
    };
    expect(permissionsToP(all)).toBe(-4); // 0xFFFFFFFC
  });

  it('detects encryption', () => {
    expect(isPdfEncrypted(plain)).toBe(false);
    expect(isPdfEncrypted(encrypted)).toBe(true);
  });

  it('writes a V5/R6 AESV3 Encrypt dictionary and hides plaintext', () => {
    const raw = latin1(encrypted);
    expect(raw).toMatch(/\/Encrypt \d+ 0 R/);
    expect(raw).toMatch(/\/V 5/);
    expect(raw).toMatch(/\/R 6/);
    expect(raw).toMatch(/\/CFM \/AESV3/);
    expect(raw).toMatch(/\/ID \[/);
    // The title is visible in the unencrypted file but must not be in the encrypted one.
    expect(latin1(plain).toUpperCase()).toContain(utf16Hex(TITLE));
    expect(raw.toUpperCase()).not.toContain(utf16Hex(TITLE));
    expect(raw).not.toContain(TITLE);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('Adika Tester');
  });

  it('requires a password', async () => {
    await expect(open(encrypted)).rejects.toMatchObject({ name: 'PasswordException', code: 1 });
  });

  it('rejects a wrong password', async () => {
    await expect(open(encrypted, 'nope')).rejects.toMatchObject({ name: 'PasswordException', code: 2 });
  });

  it('opens with the user password, decrypting text, metadata and permissions', async () => {
    const doc = await open(encrypted, 'user123');
    expect(doc.numPages).toBe(2);
    expect(await pageText(doc, 1)).toContain(SECRET);
    expect(await pageText(doc, 2)).toContain('Second page');
    const meta = await doc.getMetadata();
    expect((meta.info as { Title?: string }).Title).toBe(TITLE);
    expect((meta.info as { Author?: string }).Author).toBe('Adika Tester');
    const perms = (await doc.getPermissions()) ?? [];
    const F = pdfjs.PermissionFlag;
    expect(perms).toContain(F.PRINT);
    expect(perms).toContain(F.COPY);
    expect(perms).toContain(F.FILL_INTERACTIVE_FORMS);
    expect(perms).toContain(F.COPY_FOR_ACCESSIBILITY);
    expect(perms).not.toContain(F.MODIFY_CONTENTS);
    expect(perms).not.toContain(F.MODIFY_ANNOTATIONS);
    expect(perms).not.toContain(F.ASSEMBLE);
    expect(perms).not.toContain(F.PRINT_HIGH_QUALITY);
    // The image page renders its operator list without decrypt errors.
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject);
  });

  it('opens with the owner password', async () => {
    const doc = await open(encrypted, 'owner456');
    expect(await pageText(doc, 1)).toContain(SECRET);
    expect((await doc.getMetadata()).info).toMatchObject({ Title: TITLE });
  });

  afterAll(async () => {
    await Promise.all(tasks.map((t) => t.destroy()));
  });

  it('refuses to re-encrypt an encrypted PDF', async () => {
    await expect(
      encryptPdf(encrypted, { userPassword: 'a', ownerPassword: 'b', permissions: PERMS }),
    ).rejects.toThrow(/already encrypted/);
  });
});

describe('encryptPdf input variants', () => {
  it('encrypts a PDF that uses object streams and an xref stream', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle(TITLE);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText(SECRET, { x: 50, y: 700, size: 12, font });
    const input = await doc.save(); // default: object streams + xref stream
    const out = await encryptPdf(input, { userPassword: '', ownerPassword: 'owner456', permissions: PERMS });
    expect(latin1(out)).not.toContain('/ObjStm');
    // Empty user password: opens without prompting, content still decrypts.
    const task = pdfjs.getDocument({ data: out.slice(), useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
    const pdf = await task.promise;
    expect(await pageText(pdf, 1)).toContain(SECRET);
    expect((await pdf.getMetadata()).info).toMatchObject({ Title: TITLE });
    await task.destroy();
  });
});
