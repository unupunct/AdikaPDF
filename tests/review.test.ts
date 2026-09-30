import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mergeCommentCopies, setReviewStateAt } from '@/lib/pdf/review';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
async function annots(bytes: Uint8Array, n = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  return (await (await task.promise).getPage(n)).getAnnotations() as Promise<Array<{ id: string; subtype: string; inReplyTo?: string; state?: string; stateModel?: string; titleObj?: { str: string }; contentsObj?: { str: string } }>>;
}

async function base(pages = 2): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([400, 300]).drawText(`Pagina ${i + 1}`, { x: 30, y: 250, size: 14, font: f });
  return d.save();
}

/** A reviewer's copy: a note by `author` on page 1. */
async function copyWithNote(src: Uint8Array, author: string, text: string, x = 50): Promise<Uint8Array> {
  const d = await PDFDocument.load(src);
  const page = d.getPage(0);
  const note = d.context.register(
    d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [x, 200, x + 20, 220], Contents: PDFHexString.fromText(text), T: PDFHexString.fromText(author), NM: PDFString.of(`nm-${author}-${x}`), F: 4 }),
  );
  const a = page.node.lookup(PDFName.of('Annots'));
  if (a instanceof PDFArray) a.push(note);
  else page.node.set(PDFName.of('Annots'), d.context.obj([note]));
  return d.save();
}

describe('review', () => {
  it('stores a status as a review-state reply that pdf.js reads back', async () => {
    const doc = await copyWithNote(await base(), 'Ana', 'Mută paragraful');
    const out = await setReviewStateAt(doc, 0, { subtype: 'Text', rect: [50, 200, 70, 220], contents: 'Mută paragraful' }, 'Accepted', 'Bogdan');
    const list = await annots(out);
    const note = list.find((a) => !a.inReplyTo)!;
    const reply = list.find((a) => a.inReplyTo)!;
    expect(reply.inReplyTo).toBe(note.id);
    expect(reply.stateModel).toBe('Review');
    expect(reply.state).toBe('Accepted');
    expect(reply.titleObj?.str).toBe('Bogdan');
    await expect(setReviewStateAt(doc, 0, { subtype: 'Text', rect: [0, 0, 1, 1], contents: 'x' }, 'Rejected', 'B')).rejects.toThrow(/no longer on this page/);
  });

  it("merges reviewers' copies, skipping duplicates and copies of another document", async () => {
    const original = await base();
    const ana = await copyWithNote(original, 'Ana', 'Titlul e prea lung', 40);
    const dan = await copyWithNote(await copyWithNote(original, 'Ana', 'Titlul e prea lung', 40), 'Dan', 'Lipsește data', 120);
    const other = await copyWithNote(await base(5), 'Eva', 'Alt document');
    const { bytes, report } = await mergeCommentCopies(original, [
      { name: 'ana.pdf', bytes: ana },
      { name: 'dan.pdf', bytes: dan },
      { name: 'eva.pdf', bytes: other },
    ]);
    expect(report.added).toBe(2);
    expect(report.skipped).toBe(1); // Ana's note is also in Dan's copy
    expect(report.files.find((f) => f.name === 'eva.pdf')?.error).toMatch(/5 pages/);
    const texts = (await annots(bytes)).filter((a) => a.subtype === 'Text').map((a) => `${a.titleObj?.str}: ${a.contentsObj?.str}`).sort();
    expect(texts).toEqual(['Ana: Titlul e prea lung', 'Dan: Lipsește data']);
  });
});
