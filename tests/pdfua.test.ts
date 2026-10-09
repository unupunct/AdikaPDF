import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { checkPdfUa, groupIssues, numberingOf, safeFixes, type UaIssue } from '@/lib/pdf/pdfua';
import { fixPdfUa } from '@/lib/pdf/pdfuaFix';
import { readStructure, readParentTree } from '@/lib/pdf/structEdit';
import { DEFAULT_CONTENT, uaDoc, type UaDocSpec } from './helpers/uaDoc';

const conds = (issues: UaIssue[]) => [...new Set(issues.map((i) => i.condition))].sort();
const check = async (spec: UaDocSpec) => (await checkPdfUa(await uaDoc(spec))).issues;
const has = async (spec: UaDocSpec, condition: string) => (await check(spec)).filter((i) => i.condition === condition);
/** The failure appears, the safe fixes (plus `extra`) remove it. */
async function failsThenFixed(spec: UaDocSpec, condition: string, extra: Parameters<typeof fixPdfUa>[1]['fixes'] = []) {
  const bytes = await uaDoc(spec);
  const before = (await checkPdfUa(bytes)).issues;
  expect(conds(before)).toContain(condition);
  const fixed = await fixPdfUa(bytes, { fixes: [...safeFixes(before), ...extra], lang: 'en-US', title: 'Fixed' });
  const after = (await checkPdfUa(fixed.bytes)).issues;
  expect(conds(after)).not.toContain(condition);
  return { before, after, bytes: fixed.bytes };
}

const content = (body: string[]) => () => [body.join('\n')];
const TEXT = (T: (s: string) => string, mcid: number, tag = 'P', y = 700) => `/${tag} <</MCID ${mcid}>> BDC BT /F1 11 Tf 60 ${y} Td ${T(`Line ${mcid}`)} Tj ET EMC`;

describe('PDF/UA checker: passing document', () => {
  it('a conforming document has no failures, and the human checks are listed', async () => {
    const r = await checkPdfUa(await uaDoc());
    expect(r.issues).toEqual([]);
    expect(r.manual.some((m) => m.checkpoint === '04')).toBe(true);
    expect(r.checkpoints.find((c) => c.id === '01')?.status).toBe('pass');
    expect(r.checkpoints.find((c) => c.id === '04')?.status).toBe('manual');
  });
});

describe('01 real content tagged', () => {
  it('01-005: an untagged document is tagged by the fix', async () => {
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    p.drawText('A heading', { x: 60, y: 760, size: 24, font });
    p.drawText('Body text of the page.', { x: 60, y: 720, size: 11, font });
    const bytes = await d.save();
    const before = (await checkPdfUa(bytes)).issues;
    expect(before.find((i) => i.condition === '01-005')?.fix).toBe('tagDocument');
    const fixed = await fixPdfUa(bytes, { fixes: safeFixes(before), lang: 'en-US', title: 'Tagged' });
    expect(fixed.applied).toContain('tagDocument');
    const after = (await checkPdfUa(fixed.bytes)).issues;
    // Only what needs a person (the standard font is not embedded) remains.
    expect(after.every((i) => i.fix === null)).toBe(true);
    expect(conds(after)).toEqual(['31-009']);
  });

  it('01-005: untagged content in a tagged document — page numbers and rules become artifacts, text a paragraph', async () => {
    const spec: UaDocSpec = {
      content: (T) => [
        [
          ...DEFAULT_CONTENT(T),
          `q 0.5 g 60 600 200 20 re f Q`,
          `BT /F1 11 Tf 60 640 Td ${T('Stray paragraph')} Tj ET`,
          `BT /F1 9 Tf 290 30 Td ${T('Page 1')} Tj ET`,
        ],
      ].map((a) => a.join('\n')),
    };
    const issues = await has(spec, '01-005');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ page: 0, fix: 'untagged' });
    expect(issues[0].box!.y0).toBeLessThan(40);
    const { bytes } = await failsThenFixed(spec, '01-005');
    const doc = await PDFDocument.load(bytes);
    const st = readStructure(doc)!;
    expect(st.nodes.map((n) => n.type)).toEqual(['Document', 'H1', 'P', 'P']);
    const src = new TextDecoder('latin1').decode(decodePDFRawStream(doc.getPage(0).node.lookup(PDFName.of('Contents')) as PDFRawStream).decode());
    expect(src.match(/\/Artifact BMC/g)).toHaveLength(3);
    expect(src).toMatch(/\/P <<\/MCID 2>> BDC\nBT \/F1 11 Tf 60 640 Td/);
    // The ParentTree knows the new paragraph; pdf.js reads it.
    const arr = readParentTree(doc).get(0) as PDFArray;
    expect(arr.size()).toBe(3);
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const tree = await (await pdf.getPage(1)).getStructTree();
    const roles = (tree as { children: Array<{ role: string; children: Array<{ role: string }> }> }).children[0].children.map((c) => c.role);
    expect(roles).toEqual(['H1', 'P', 'P']);
    await pdf.loadingTask.destroy();
  });

  it('01-003 / 01-004: artifacts inside tagged content and tagged content inside artifacts', async () => {
    const spec: UaDocSpec = {
      content: (T) => [[`/P <</MCID 0>> BDC /Artifact BMC 0 0 m 10 10 l S EMC BT /F1 11 Tf 60 700 Td ${T('x')} Tj ET EMC`, `/Artifact BMC /P <</MCID 1>> BDC BT /F1 11 Tf 60 680 Td ${T('y')} Tj ET EMC EMC`].join('\n')],
      tree: [{ S: 'P', mcid: 0 }, { S: 'P', mcid: 1 }],
    };
    const c = conds(await check(spec));
    expect(c).toContain('01-003');
    expect(c).toContain('01-004');
  });

  it('01-005: marked content the ParentTree does not reach', async () => {
    const spec: UaDocSpec = { content: (T) => [[TEXT(T, 0), TEXT(T, 5, 'P', 680)].join('\n')], tree: [{ S: 'P', mcid: 0 }] };
    expect((await has(spec, '01-005'))[0].message).toMatch(/not referenced/);
  });

  it('01-007 Suspects and §7.1 Marked are fixed', async () => {
    await failsThenFixed({ mutate: (d) => d.catalog.set(PDFName.of('MarkInfo'), d.context.obj({ Marked: true, Suspects: true })) }, '01-007');
    await failsThenFixed({ marked: false }, '§7.1');
  });
});

describe('02 role mapping', () => {
  it('02-001 unmapped non-standard type, 02-003 circular mapping, 02-004 remapped standard type', async () => {
    await failsThenFixed({ tree: [{ S: 'Heading1', mcid: 0 }, { S: 'P', mcid: 1 }] }, '02-001');
    const { bytes } = await failsThenFixed({ tree: [{ S: 'Foo', mcid: 0 }, { S: 'P', mcid: 1 }], roleMap: { Foo: 'Bar', Bar: 'Foo' } }, '02-003');
    expect(readStructure(await PDFDocument.load(bytes))!.roleMap.get('Foo')).toBe('P');
    await failsThenFixed({ roleMap: { P: 'Span' } }, '02-004');
    expect(await has({ tree: [{ S: 'Para', mcid: 0 }, { S: 'P', mcid: 1 }], roleMap: { Para: 'P' } }, '02-001')).toEqual([]);
  });
});

describe('06 metadata, 07 dictionary', () => {
  it('06-001 / 06-002 / 06-003 are fixed by writing the metadata', async () => {
    await failsThenFixed({ xmp: null }, '06-001');
    await failsThenFixed({ xmp: 'noUa' }, '06-002');
    const { bytes } = await failsThenFixed({ xmp: 'noTitle' }, '06-003');
    expect(new TextDecoder().decode(decodePDFRawStream((await PDFDocument.load(bytes)).catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).decode())).toMatch(/<pdfuaid:part>1<\/pdfuaid:part>/);
  });

  it('07-001 / 07-002 DisplayDocTitle', async () => {
    await failsThenFixed({ displayDocTitle: null }, '07-001');
    await failsThenFixed({ displayDocTitle: false }, '07-002');
  });
});

describe('09 appropriate tags', () => {
  it('09-004 table structure', async () => {
    expect(await has({ tree: [{ S: 'Table', kids: [{ S: 'TD', mcid: 0 }] }, { S: 'P', mcid: 1 }] }, '09-004')).not.toEqual([]);
    expect(await has({ tree: [{ S: 'Table', kids: [{ S: 'TR', kids: [{ S: 'TD', mcid: 0 }] }] }, { S: 'P', mcid: 1 }] }, '09-004')).toEqual([]);
  });

  it('09-005 list structure: content straight in LI or L is wrapped (LBody), the ParentTree follows', async () => {
    const spec: UaDocSpec = { tree: [{ S: 'L', kids: [{ S: 'LI', mcid: 0 }, { S: 'P', mcid: 1 }] }] };
    const { bytes } = await failsThenFixed(spec, '09-005');
    const doc = await PDFDocument.load(bytes);
    const st = readStructure(doc)!;
    const shape = (n: { type: string; children: Array<{ type: string; children: never[] }> }): unknown => (n.children.length ? { [n.type]: n.children.map(shape as never) } : n.type);
    expect(shape(st.top[0] as never)).toEqual({ Document: [{ L: [{ LI: ['LBody'] }, { LI: [{ LBody: ['P'] }] }] }] });
    // MCID 0 now belongs to the LBody.
    const arr = readParentTree(doc).get(0) as PDFArray;
    const lbody = st.nodes.find((n) => n.type === 'LBody' && n.mcids.length)!;
    expect(arr.lookup(0)).toBe(lbody.dict);
    expect(await has({ tree: [{ S: 'L', kids: [{ S: 'LI', kids: [{ S: 'Lbl', mcid: 0 }, { S: 'LBody', mcid: 1 }] }] }] }, '09-005')).toEqual([]);
  });

  it('09-006 TOC items outside a TOC', async () => {
    expect(await has({ tree: [{ S: 'TOCI', mcid: 0 }, { S: 'P', mcid: 1 }] }, '09-006')).toHaveLength(1);
    expect(await has({ tree: [{ S: 'TOC', kids: [{ S: 'TOCI', mcid: 0 }] }, { S: 'P', mcid: 1 }] }, '09-006')).toEqual([]);
  });
});

describe('10 character mappings, 31 fonts', () => {
  const withFontEdit = (edit: (font: PDFDict, desc: PDFDict, doc: PDFDocument) => void) => async () => {
    const d = await PDFDocument.load(await uaDoc());
    const font = d.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
    const desc = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    edit(font, desc, d);
    return (await checkPdfUa(await d.save())).issues;
  };

  it('10-001 text without Unicode mapping', async () => {
    expect(conds(await withFontEdit((f) => f.delete(PDFName.of('ToUnicode')))())).toContain('10-001');
  });

  it('31-009 font not embedded; passes when embedded', async () => {
    const spec: UaDocSpec = {
      mutate: (d) => {
        const helv = d.context.register(d.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
        d.getPage(0).node.setFontDictionary(PDFName.of('F2'), helv);
        const c = d.getPage(0).node.lookup(PDFName.of('Contents'), PDFRawStream);
        const src = new TextDecoder('latin1').decode(decodePDFRawStream(c).decode()) + '\n/P <</MCID 2>> BDC BT /F2 11 Tf 60 600 Td (Helvetica) Tj ET EMC';
        d.getPage(0).node.set(PDFName.of('Contents'), d.context.register(d.context.flateStream(src)));
      },
    };
    expect(conds(await check(spec))).toContain('31-009');
  });

  it('31-004 TrueType CID font without CIDToGIDMap', async () => {
    expect(conds(await withFontEdit((_f, desc) => desc.delete(PDFName.of('CIDToGIDMap')))())).toContain('31-004');
  });

  it('§7.21.5 widths that differ from the font program', async () => {
    const issues = await withFontEdit((_f, desc, d) => desc.set(PDFName.of('W'), d.context.obj([36, [900, 900, 900]])))();
    expect(conds(issues)).toContain('§7.21.5');
  });

  it('§7.21.4.2 a CIDSet that leaves glyphs out is removed by the fix', async () => {
    const d = await PDFDocument.load(await uaDoc());
    const font = d.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
    const fd = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('FontDescriptor'), PDFDict);
    fd.set(PDFName.of('CIDSet'), d.context.register(d.context.flateStream(new Uint8Array(4))));
    const bytes = await d.save();
    const before = (await checkPdfUa(bytes)).issues;
    expect(conds(before)).toContain('§7.21.4.2');
    const after = (await checkPdfUa((await fixPdfUa(bytes, { fixes: safeFixes(before) })).bytes)).issues;
    expect(after).toEqual([]);
  });
});

describe('11 language', () => {
  it('11-001 / 11-002 no language; the fix sets it', async () => {
    const { before } = await failsThenFixed({ lang: null, tree: [{ S: 'H1', mcid: 0 }, { S: 'P', mcid: 1, alt: 'x' }] }, '11-001');
    expect(conds(before)).toContain('11-002');
    expect(await has({ lang: 'en_US!' }, '11-001')).toHaveLength(1);
  });
});

describe('13 graphics, 17 formulas', () => {
  it('13-004 figure without alternate text, 17-002 formula without alternate text', async () => {
    expect(await has({ tree: [{ S: 'H1', mcid: 0 }, { S: 'Figure', mcid: 1 }] }, '13-004')).toHaveLength(1);
    expect(await has({ tree: [{ S: 'H1', mcid: 0 }, { S: 'Figure', mcid: 1, alt: 'A map' }] }, '13-004')).toEqual([]);
    const f = await has({ tree: [{ S: 'H1', mcid: 0 }, { S: 'Formula', mcid: 1 }] }, '17-002');
    expect(f[0]).toMatchObject({ page: 0, tag: 'Formula', fix: null });
    expect(f[0].box).not.toBeNull();
  });
});

describe('14 headings', () => {
  it('14-002 first heading not H1, 14-003 skipped level, 14-007 H and Hn mixed', async () => {
    expect(await has({ tree: [{ S: 'H2', mcid: 0 }, { S: 'P', mcid: 1 }] }, '14-002')).toHaveLength(1);
    expect(await has({ content: (T) => [[TEXT(T, 0, 'H1'), TEXT(T, 1, 'H3', 680)].join('\n')], tree: [{ S: 'H1', mcid: 0 }, { S: 'H3', mcid: 1 }] }, '14-003')).toHaveLength(1);
    expect(await has({ content: (T) => [[TEXT(T, 0, 'H1'), TEXT(T, 1, 'H2', 680)].join('\n')], tree: [{ S: 'H1', mcid: 0 }, { S: 'H2', mcid: 1 }] }, '14-003')).toEqual([]);
    expect(await has({ tree: [{ S: 'H1', mcid: 0 }, { S: 'Sect', kids: [{ S: 'H', mcid: 1 }] }] }, '14-007')).toHaveLength(1);
    expect(await has({ tree: [{ S: 'Sect', kids: [{ S: 'H', mcid: 0 }, { S: 'H', mcid: 1 }] }] }, '14-006')).toHaveLength(1);
  });
});

describe('15 tables, 16 lists, 19 notes', () => {
  const table = (thExtra?: Record<string, unknown>, tdExtra?: Record<string, unknown>) => ({
    content: (T: (s: string) => string) => [[TEXT(T, 0, 'TH'), TEXT(T, 1, 'TD', 680)].join('\n')],
    tree: [{ S: 'Table', kids: [{ S: 'TR', kids: [{ S: 'TH', mcid: 0, extra: thExtra }] }, { S: 'TR', kids: [{ S: 'TD', mcid: 1, extra: tdExtra }] }] }],
  });

  it('15-003 TH without Scope: fixed only when the user confirms (Column for the first row)', async () => {
    const bytes = await uaDoc(table());
    const before = (await checkPdfUa(bytes)).issues;
    const th = before.find((i) => i.condition === '15-003')!;
    expect(th).toMatchObject({ fix: 'thScope', confirm: true });
    expect(safeFixes(before)).not.toContain('thScope');
    const fixed = await fixPdfUa(bytes, { fixes: ['thScope'] });
    expect((await checkPdfUa(fixed.bytes)).issues).toEqual([]);
    const st = readStructure(await PDFDocument.load(fixed.bytes))!;
    const a = st.nodes.find((n) => n.type === 'TH')!.dict.lookup(PDFName.of('A'), PDFDict);
    expect(a.lookup(PDFName.of('Scope'))).toBe(PDFName.of('Column'));
    expect(await has(table({ A: { O: PDFName.of('Table'), Scope: PDFName.of('Column') } }), '15-003')).toEqual([]);
  });

  it('15-005 Headers that point at missing IDs', async () => {
    const ok = table({ ID: PDFString.of('h1') }, { A: { O: PDFName.of('Table'), Headers: [PDFString.of('h1')] } });
    expect(await has(ok, '15-005')).toEqual([]);
    const bad = table({ ID: PDFString.of('h1') }, { A: { O: PDFName.of('Table'), Headers: [PDFString.of('nope')] } });
    expect(await has(bad, '15-005')).toHaveLength(1);
  });

  it('16-002 numbered list without ListNumbering', async () => {
    const spec: UaDocSpec = {
      content: (T) => [[`/Lbl <</MCID 0>> BDC BT /F1 11 Tf 60 700 Td ${T('1.')} Tj ET EMC`, TEXT(T, 1, 'LBody', 700), `/Lbl <</MCID 2>> BDC BT /F1 11 Tf 60 680 Td ${T('2.')} Tj ET EMC`, TEXT(T, 3, 'LBody', 680)].join('\n')],
      tree: [{ S: 'L', kids: [{ S: 'LI', kids: [{ S: 'Lbl', mcid: 0 }, { S: 'LBody', mcid: 1 }] }, { S: 'LI', kids: [{ S: 'Lbl', mcid: 2 }, { S: 'LBody', mcid: 3 }] }] }],
    };
    const { bytes } = await failsThenFixed(spec, '16-002');
    const l = readStructure(await PDFDocument.load(bytes))!.nodes.find((n) => n.type === 'L')!;
    expect(l.dict.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('ListNumbering'))).toBe(PDFName.of('Decimal'));
    expect(numberingOf(['a)', 'b)'])).toBe('LowerAlpha');
    expect(numberingOf(['•', '•'])).toBeNull();
  });

  it('19-003 / 19-004 note IDs', async () => {
    await failsThenFixed({ tree: [{ S: 'H1', mcid: 0 }, { S: 'Note', mcid: 1 }] }, '19-003');
    const dup = { content: (T: (s: string) => string) => [[TEXT(T, 0, 'Note'), TEXT(T, 1, 'Note', 680)].join('\n')], tree: [{ S: 'Note', mcid: 0, extra: { ID: PDFString.of('n') } }, { S: 'Note', mcid: 1, extra: { ID: PDFString.of('n') } }] };
    await failsThenFixed(dup, '19-004');
  });
});

describe('20 optional content, 21 embedded files, 25 XFA, 26 security', () => {
  it('20-001 / 20-002 / 20-003 layer configurations', async () => {
    const spec: UaDocSpec = {
      mutate: (d) => {
        const oc = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFHexString.fromText('Layer') }));
        d.catalog.set(PDFName.of('OCProperties'), d.context.obj({ OCGs: [oc], D: { Order: [oc], AS: [] }, Configs: [{ Order: [oc] }] }));
      },
    };
    const { before, after } = await failsThenFixed(spec, '20-002');
    expect(conds(before)).toEqual(expect.arrayContaining(['20-001', '20-003']));
    expect(after).toEqual([]);
  });

  it('21-001 file specification without UF', async () => {
    const spec: UaDocSpec = {
      mutate: async (d) => {
        await d.attach(new TextEncoder().encode('hello'), 'notes.txt', { mimeType: 'text/plain' });
      },
    };
    expect(await has(spec, '21-001')).toEqual([]);
    const d = await PDFDocument.load(await uaDoc(spec));
    for (const [, o] of d.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.lookup(PDFName.of('Type')) === PDFName.of('Filespec')) o.delete(PDFName.of('UF'));
    const bytes = await d.save();
    const before = (await checkPdfUa(bytes)).issues;
    expect(conds(before)).toContain('21-001');
    expect((await checkPdfUa((await fixPdfUa(bytes, { fixes: safeFixes(before) })).bytes)).issues).toEqual([]);
  });

  it('25-001 dynamic XFA', async () => {
    const spec: UaDocSpec = {
      mutate: (d) => {
        const cfg = d.context.register(d.context.stream('<config><acrobat><acrobat7><dynamicRender>required</dynamicRender></acrobat7></acrobat></config>'));
        d.catalog.set(PDFName.of('AcroForm'), d.context.obj({ Fields: [], XFA: [PDFString.of('config'), cfg] }));
      },
    };
    expect(await has(spec, '25-001')).toHaveLength(1);
  });

  it('26-001 / 26-002 encryption without the accessibility permission', async () => {
    const enc = async (P: number | null) => {
      const d = await PDFDocument.load(await uaDoc());
      d.context.trailerInfo.Encrypt = d.context.register(d.context.obj(P === null ? { Filter: 'Standard' } : { Filter: 'Standard', P }));
      return (await import('@/lib/pdf/pdfua')).checkPdfUaDoc(d).issues;
    };
    expect(conds(await enc(null))).toContain('26-001');
    expect(conds(await enc(-1 & ~512))).toContain('26-002');
    expect(conds(await enc(-1))).not.toContain('26-002');
  });
});

describe('28 annotations', () => {
  it('links and fields get tags (OBJR), descriptions and tab order; comments need a description', async () => {
    const spec: UaDocSpec = {
      mutate: (d) => {
        const page = d.getPage(0);
        const link = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [60, 715, 200, 730], A: { S: 'URI', URI: PDFString.of('https://example.org') } }));
        const field = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('first_name'), Rect: [60, 500, 200, 520] }));
        const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [300, 500, 400, 600] }));
        page.node.set(PDFName.of('Annots'), d.context.obj([link, field, note]));
        d.catalog.set(PDFName.of('AcroForm'), d.context.obj({ Fields: [field] }));
      },
    };
    const { before, after, bytes } = await failsThenFixed(spec, '28-011');
    expect(conds(before)).toEqual(expect.arrayContaining(['28-002', '28-004', '28-005', '28-008', '28-010', '28-012']));
    expect(conds(after)).toEqual(['28-004']);
    const doc = await PDFDocument.load(bytes);
    const st = readStructure(doc)!;
    expect(st.nodes.map((n) => n.type)).toEqual(['Document', 'H1', 'P', 'Link', 'Form', 'Annot']);
    const link = st.nodes.find((n) => n.type === 'Link')!;
    expect(link.objrs).toHaveLength(1);
    // The annotation's StructParent leads back to its tag.
    const annot = doc.context.lookup(link.objrs[0].obj, PDFDict);
    const key = annot.lookup(PDFName.of('StructParent'), PDFNumber).asNumber();
    expect(doc.context.lookup(readParentTree(doc).get(key) as never)).toBe(link.dict);
    expect(doc.getPage(0).node.lookup(PDFName.of('Tabs'))).toBe(PDFName.of('S'));
  });

  it('28-009 a tab order other than the structure', async () => {
    const spec: UaDocSpec = {
      mutate: (d) => {
        const n = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 10, 10], Contents: PDFString.of('Note') }));
        d.getPage(0).node.set(PDFName.of('Annots'), d.context.obj([n]));
        d.getPage(0).node.set(PDFName.of('Tabs'), PDFName.of('R'));
      },
    };
    await failsThenFixed(spec, '28-009');
  });
});

describe('30 XObjects', () => {
  it('30-001 reference XObject, 30-002 tagged form drawn twice', async () => {
    const spec = (ref: boolean, twice: boolean): UaDocSpec => ({
      content: (T) => [[`/P <</MCID 0>> BDC BT /F1 11 Tf 60 700 Td ${T('x')} Tj ET EMC`, twice ? '/Fm1 Do /Fm1 Do' : '/Artifact BMC /Fm1 Do EMC'].join('\n')],
      tree: [{ S: 'P', mcid: 0 }],
      mutate: (d) => {
        const form = d.context.register(
          d.context.flateStream(twice ? '/P <</MCID 0>> BDC 0 0 10 10 re f EMC' : '0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], ...(twice ? { StructParents: 5 } : {}), ...(ref ? { Ref: { F: PDFString.of('other.pdf'), Page: 0 } } : {}) }),
        );
        d.getPage(0).node.setXObject(PDFName.of('Fm1'), form);
      },
    });
    expect(await has(spec(true, false), '30-001')).toHaveLength(1);
    expect(await has(spec(false, false), '30-001')).toEqual([]);
    expect(await has(spec(false, true), '30-002')).toHaveLength(1);
  });
});

describe('report grouping', () => {
  it('groups by checkpoint in order', async () => {
    const issues = await check({ lang: null, displayDocTitle: null, xmp: null });
    expect(groupIssues(issues).map((g) => g.checkpoint)).toEqual(['06', '07', '11']);
  });

  it('a document drawn by pdf-lib with a coloured rule keeps reading after the fixes', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage();
    p.drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: rgb(1, 0, 0) });
    const r = await checkPdfUa(await d.save());
    expect(r.tagged).toBe(false);
  });
});
