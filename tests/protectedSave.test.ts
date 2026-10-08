import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decryptPdf, encryptWithSecurity } from '@/lib/crypto/decrypt';
import { permissionsToP } from '@/lib/crypto/encrypt';
import { buildIncrementalPdf, buildPdf, incrementalBlocker } from '@/lib/pdf/exportPdf';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EditorObject, PageRef, SourceDoc } from '@/types';
import type { FontVariant } from '@/lib/fonts';
import { encryptFixture, type Handler } from './helpers/pdfEncryptor';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const exportOpts = {
  loadFont: (v: FontVariant) => Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', v.bold ? '700Bold' : '400Regular', `NotoSans_${v.bold ? '700Bold' : '400Regular'}.ttf`)))),
  measure: (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5,
};
const pageRefs = (src: SourceDoc, indexes: number[]): PageRef[] =>
  indexes.map((i, k) => ({ id: `${src.id}_${k}`, kind: 'source', sourceId: src.id, sourceIndex: i, baseRotation: 0, userRotation: 0, width: 300, height: 400 }));

const P = permissionsToP({ print: true, printHighQuality: true, modify: false, copy: false, annotate: true, fillForms: true, extractForAccessibility: true, assemble: false });

async function formPdf(objectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText('Contract text', { x: 20, y: 360, size: 12, font });
  doc.addPage([300, 400]).drawText('Page two', { x: 20, y: 360, size: 12, font });
  doc.getForm().createTextField('name').addToPage(doc.getPage(1), { x: 20, y: 300, width: 150, height: 20 });
  return doc.save({ useObjectStreams: objectStreams });
}

/** A protected file as the store holds it: decrypted bytes, the file itself and its key. */
async function protectedSource(handler: Handler, userPassword: string, objectStreams = false): Promise<SourceDoc> {
  const f = await encryptFixture(await formPdf(objectStreams), { handler, userPassword, ownerPassword: 'owner456', p: P, objectStreams });
  const { bytes, unlocked } = await decryptPdf(f.bytes, userPassword);
  return { id: 's', name: 's.pdf', bytes, pageCount: 2, original: true, ...(userPassword ? { password: userPassword } : {}), encryption: { file: f.bytes, unlocked } };
}

const note = (pageId: string) =>
  ({ id: 'n1', type: 'note', pageId, x: 40, y: 40, rotation: 0, opacity: 1, width: 20, height: 20, text: 'Looks good', color: '#facc15', author: 'Ana', createdAt: '2026-10-01T10:00:00Z', modifiedAt: '2026-10-01T10:00:00Z' }) as EditorObject;

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function open(data: Uint8Array, password?: string) {
  const task = pdfjs.getDocument({ data: data.slice(), password, useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  await Promise.all(tasks.map((t) => t.destroy()));
});

async function check(out: Uint8Array, password: string | undefined) {
  const doc = await open(out, password);
  const a1 = (await (await doc.getPage(1)).getAnnotations()) as Array<{ subtype: string; contentsObj?: { str: string } }>;
  expect(a1.some((a) => a.subtype === 'Text' && a.contentsObj?.str === 'Looks good')).toBe(true);
  const a2 = (await (await doc.getPage(2)).getAnnotations()) as Array<{ fieldName?: string; fieldValue?: unknown }>;
  expect(a2.find((a) => a.fieldName === 'name')?.fieldValue).toBe('Ana Pop');
  const again = await decryptPdf(out, 'owner456');
  expect(again.unlocked.owner).toBe(true);
  expect(again.unlocked.security.p).toBe(P);
}

describe('saving a password-protected document', () => {
  it('a full save keeps the protection (owner-password-only file)', async () => {
    const src = await protectedSource('aesv2', '');
    const pages = pageRefs(src, [0, 1]);
    const input = { sources: { s: src }, pages, objects: [note(pages[0].id)], fieldValues: { 's::name': 'Ana Pop' }, baseSourceId: 's' };
    const out = await encryptWithSecurity(await buildPdf(input, exportOpts), src.encryption!.unlocked);
    expect(Buffer.from(out).toString('latin1')).not.toContain('Looks good');
    await check(out, undefined);
  });

  for (const [handler, objectStreams] of [['rc4-128', false], ['aesv3-r6', true]] as const) {
    it(`an incremental save appends encrypted objects (${handler}${objectStreams ? ', xref stream' : ''})`, async () => {
      const src = await protectedSource(handler, 'user123', objectStreams);
      const pages = pageRefs(src, [0, 1]);
      const input = { sources: { s: src }, pages, objects: [note(pages[0].id)], fieldValues: { 's::name': 'Ana Pop' }, baseSourceId: 's' };
      expect(incrementalBlocker(input)).toBeNull();
      expect(incrementalBlocker(input, null, true)).not.toBeNull();
      const out = await buildIncrementalPdf(input, exportOpts);
      const file = src.encryption!.file;
      expect(Buffer.from(out.subarray(0, file.length)).equals(Buffer.from(file))).toBe(true);
      const tail = Buffer.from(out.subarray(file.length)).toString('latin1');
      expect(tail).toContain('/Encrypt');
      expect(tail).not.toContain('Looks good');
      expect(tail).not.toContain('Ana Pop');
      await expect(open(out)).rejects.toMatchObject({ name: 'PasswordException' });
      await check(out, 'user123');
    });
  }
});
