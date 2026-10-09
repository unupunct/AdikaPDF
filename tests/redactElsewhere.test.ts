import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { BLOCK, blockOut, findElsewhere, redactElsewhere, richToPlain, type ElsewhereKind, type ElsewhereOptions } from '@/lib/pdf/redactElsewhere';
import { queryFinder } from '@/lib/pdf/textSearch';
import { findPattern } from '@/lib/patterns';
import { dropUnreachableObjects } from '@/lib/pdf/prune';
import { contains, everything } from './helpers/redaction';

const SECRET = 'Popescu';
const N = (s: string) => PDFName.of(s);
const finder = queryFinder(SECRET);

type Place = ElsewhereKind | 'fieldNameOnly' | 'xmp' | 'xfa' | 'reply' | 'freeText' | 'tooltip';

/** A one-page file carrying the secret only in the chosen places (never in the page text). */
async function build(places: Place[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Nothing to see here', { x: 20, y: 250, size: 12, font });
  const ctx = doc.context;
  const has = (p: Place) => places.includes(p);
  const annots: PDFRef[] = [];

  if (has('comment') || has('reply')) {
    const note = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        Contents: PDFHexString.fromText(has('comment') ? `Call ${SECRET} tomorrow` : 'Call tomorrow'),
        RC: PDFString.of(has('comment') ? `<body><p>Call <b>${SECRET}</b></p></body>` : '<body><p>Call</p></body>'),
        T: PDFHexString.fromText(has('comment') ? `Ion ${SECRET}` : 'Ana'),
      }),
    );
    const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [40, 40, 140, 100], Parent: note }));
    (ctx.lookup(note) as PDFDict).set(N('Popup'), popup);
    annots.push(note, popup);
    const reply = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], IRT: note, Contents: PDFHexString.fromText(has('reply') ? `Agreed, ${SECRET}` : 'Agreed') }));
    annots.push(reply);
  }
  if (has('freeText')) {
    const ap = ctx.register(ctx.stream(`BT /Helv 10 Tf 2 2 Td (${SECRET} lives here) Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20] }));
    annots.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [50, 150, 150, 170], DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFHexString.fromText(`${SECRET} lives here`), AP: { N: ap } })));
  }
  if (has('link')) {
    annots.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 240, 120, 262], A: { S: 'URI', URI: PDFString.of(`mailto:${SECRET}@firma.ro`) } })));
  }
  if (annots.length) page.node.set(N('Annots'), ctx.obj(annots));

  if (has('fieldValue') || has('fieldNameOnly') || has('tooltip')) {
    const form = doc.getForm();
    const f = form.createTextField(has('fieldNameOnly') ? `${SECRET}_name` : 'client');
    f.setText(has('fieldValue') ? `Ion ${SECRET}` : 'Ion');
    f.addToPage(page, { x: 20, y: 100, width: 150, height: 20, font });
    if (has('tooltip')) f.acroField.dict.set(N('TU'), PDFHexString.fromText(`Name of ${SECRET}`));
  }
  if (has('bookmark')) {
    const outlines = ctx.nextRef();
    const a = ctx.nextRef();
    const b = ctx.nextRef();
    const child = ctx.nextRef();
    const dest = ctx.obj([page.ref, N('Fit')]);
    ctx.assign(a, ctx.obj({ Title: PDFHexString.fromText(`Chapter ${SECRET}`), Parent: outlines, Next: b, First: child, Last: child, Count: 1, Dest: dest }));
    ctx.assign(child, ctx.obj({ Title: PDFHexString.fromText('Section'), Parent: a, Dest: dest }));
    ctx.assign(b, ctx.obj({ Title: PDFHexString.fromText('Intro'), Parent: outlines, Prev: a, Dest: dest }));
    ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: a, Last: b, Count: 3 }));
    doc.catalog.set(N('Outlines'), outlines);
  }
  if (has('metadata')) {
    doc.setAuthor(`Ion ${SECRET}`);
    doc.setTitle('Quarterly report');
  }
  if (has('xmp')) {
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Ion ${SECRET}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    doc.catalog.set(N('Metadata'), ctx.register(ctx.flateStream(xml, { Type: 'Metadata', Subtype: 'XML' })));
  }
  if (has('xfa')) {
    const acro = doc.getForm().acroForm.dict;
    const data = ctx.register(ctx.flateStream(`<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><client>${SECRET}</client></xfa:data></xfa:datasets>`));
    acro.set(N('XFA'), ctx.obj([PDFString.of('datasets'), data]));
  }
  if (has('attachment')) {
    await doc.attach(new TextEncoder().encode('harmless'), `${SECRET}.txt`, { mimeType: 'text/plain', description: 'List' });
  }
  if (has('altText')) {
    const root = ctx.nextRef();
    const fig = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Figure', P: root, Alt: PDFHexString.fromText(`Photo of ${SECRET}`), Pg: page.ref }));
    const doc_ = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Document', P: root, K: [fig] }));
    ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: doc_ }));
    doc.catalog.set(N('StructTreeRoot'), root);
  }
  // Attachments are written on save: the test file is the saved one.
  return doc.save({ useObjectStreams: false });
}

async function redact(bytes: Uint8Array, opts: ElsewhereOptions = {}): Promise<{ out: Uint8Array; changed: number; doc: PDFDocument }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const { changed } = redactElsewhere(doc, finder, opts);
  dropUnreachableObjects(doc);
  const out = await doc.save({ useObjectStreams: false });
  return { out, changed, doc: await PDFDocument.load(out, { updateMetadata: false }) };
}

async function gone(bytes: Uint8Array): Promise<boolean> {
  return !contains(await everything(bytes), SECRET);
}

describe('Find & redact outside the page text', () => {
  const cases: Array<[Place, string, ElsewhereKind]> = [
    ['comment', 'Comment', 'comment'],
    ['reply', 'Comment', 'comment'],
    ['freeText', 'Comment', 'comment'],
    ['link', 'Link', 'link'],
    ['fieldValue', 'Field value', 'fieldValue'],
    ['fieldNameOnly', 'Field name', 'fieldName'],
    ['tooltip', 'Field tooltip', 'fieldName'],
    ['bookmark', 'Bookmark', 'bookmark'],
    ['metadata', 'Metadata: Author', 'metadata'],
    ['xmp', 'Metadata: XMP', 'metadata'],
    ['xfa', 'Form data (XFA)', 'fieldValue'],
    ['attachment', 'Attachment', 'attachment'],
    ['altText', 'Alternate text', 'altText'],
  ];

  for (const [place, where, kind] of cases) {
    it(`finds and removes the secret in: ${place}`, async () => {
      const bytes = await build([place]);
      expect(await gone(bytes)).toBe(false);
      const hits = findElsewhere(await PDFDocument.load(bytes), finder);
      expect(hits.map((h) => [h.where, h.kind])).toContainEqual([where, kind]);
      expect(hits.every((h) => h.text.toLowerCase() === SECRET.toLowerCase())).toBe(true);
      const { out, changed } = await redact(bytes, { fieldNames: true });
      expect(changed).toBeGreaterThan(0);
      expect(await gone(out)).toBe(true);
      expect(findElsewhere(await PDFDocument.load(out), finder)).toEqual([]);
    });
  }

  it('everything at once, in one pass', async () => {
    const bytes = await build(cases.map((c) => c[0]).filter((p) => p !== 'fieldNameOnly'));
    const { out } = await redact(bytes, { fieldNames: true });
    expect(await gone(out)).toBe(true);
  });

  it('reports comments and links by page', async () => {
    const hits = findElsewhere(await PDFDocument.load(await build(['comment', 'link'])), finder);
    expect(hits.filter((h) => h.kind === 'comment').every((h) => h.pageIndex === 0)).toBe(true);
    expect(hits.find((h) => h.kind === 'link')?.pageIndex).toBe(0);
  });

  it('removes a comment with its popup and replies by default', async () => {
    const { doc } = await redact(await build(['comment']));
    expect(doc.getPage(0).node.lookup(N('Annots'))).toBeUndefined();
  });

  it('can redact the comment text instead of removing the comment', async () => {
    const { out, doc } = await redact(await build(['comment']), { comments: 'redact' });
    expect(await gone(out)).toBe(true);
    const annots = doc.getPage(0).node.lookup(N('Annots'), PDFArray);
    const note = doc.context.lookup(annots.get(0), PDFDict);
    expect((note.lookup(N('Contents')) as PDFHexString).decodeText()).toBe(`Call ${BLOCK} tomorrow`);
    expect(note.get(N('RC'))).toBeUndefined();
    expect(annots.size()).toBe(3);
  });

  it('clears field values (appearance drawn empty) and leaves field names unless asked', async () => {
    const { out, doc } = await redact(await build(['fieldValue', 'fieldNameOnly']));
    const form = doc.getForm();
    expect(form.getTextField(`${SECRET}_name`).getText() ?? '').toBe('');
    const text = await everything(out);
    // The name stays (only the name), the value is gone.
    expect(text).not.toContain(`Ion ${SECRET}`);
    expect(text).toContain(`${SECRET}_name`);
    const renamed = await redact(await build(['fieldNameOnly']), { fieldNames: true });
    expect(renamed.doc.getForm().getFields().map((f) => f.getName())).toEqual([`${BLOCK}_name`]);
  });

  it('bookmarks: the match replaced by default, or the bookmark removed with its children', async () => {
    const a = await redact(await build(['bookmark']));
    const outlines = a.doc.catalog.lookup(N('Outlines'), PDFDict);
    const first = outlines.lookup(N('First'), PDFDict);
    expect((first.lookup(N('Title')) as PDFHexString).decodeText()).toBe(`Chapter ${BLOCK}`);
    const b = await redact(await build(['bookmark']), { bookmarks: 'remove' });
    const ol = b.doc.catalog.lookup(N('Outlines'), PDFDict);
    const only = ol.lookup(N('First'), PDFDict);
    expect((only.lookup(N('Title')) as PDFHexString).decodeText()).toBe('Intro');
    expect(only.get(N('Prev'))).toBeUndefined();
    expect(ol.lookup(N('Count'), PDFNumber).asNumber()).toBe(1);
    expect(await gone(b.out)).toBe(true);
    expect(await everything(b.out)).not.toContain('Section');
  });

  it('metadata fields are cleared, other properties stay', async () => {
    const { doc } = await redact(await build(['metadata']));
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getTitle()).toBe('Quarterly report');
  });

  it('only the chosen kinds are redacted', async () => {
    const { out } = await redact(await build(['bookmark', 'metadata']), { kinds: ['metadata'] });
    expect(await everything(out)).toContain(`Chapter ${SECRET}`);
    expect(findElsewhere(await PDFDocument.load(out), finder).map((h) => h.kind)).toEqual(['bookmark']);
  });

  it('patterns work outside the page text too (e-mail in a link)', async () => {
    const hits = findElsewhere(await PDFDocument.load(await build(['link'])), (t) => findPattern('email', t));
    expect(hits[0].text).toBe(`${SECRET}@firma.ro`);
  });

  it('helpers', () => {
    expect(blockOut('a Popescu b Popescu', [[2, 9], [12, 19]])).toBe(`a ${BLOCK} b ${BLOCK}`);
    expect(richToPlain('<p>A &amp; <b>B</b>&#x219;</p>').replace(/\s+/g, ' ').trim()).toBe('A & B ș');
  });
});
