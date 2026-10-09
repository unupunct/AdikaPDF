import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
});
vi.mock('@/lib/pdf/pdfService', () => ({
  openPdf: async (bytes: Uint8Array) => {
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    return { numPages: d.getPageCount(), getPage: async () => ({ view: [0, 0, 300, 300], rotate: 0 }) };
  },
  registerSource: () => undefined,
  releaseSource: async () => undefined,
}));

import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import { findSensitiveElsewhere, redactSensitiveElsewhere } from '@/actions/findReplace';
import type { EditorObject } from '@/types';
import { contains, everything } from './helpers/redaction';

const S = () => usePDFStore.getState();
const SECRET = 'Popescu';

async function file(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setAuthor(`Ion ${SECRET}`);
  const ctx = doc.context;
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [1, 1, 20, 20], Contents: PDFHexString.fromText(`Ask ${SECRET}`) }))]));
  const f = doc.getForm().createTextField('client');
  f.setText(`Ion ${SECRET}`);
  f.addToPage(page, { x: 20, y: 100, width: 150, height: 20, font });
  return doc.save();
}

beforeEach(async () => {
  await S().closeDocument();
  await S().loadDocument(await file(), 'a.pdf', null);
});

describe('Find & redact outside the page text (open document)', () => {
  it('lists file and unsaved hits with their place, once each', async () => {
    const pageId = S().pages[0].id;
    S().addObject({ id: 'n1', type: 'note', pageId, x: 0, y: 0, rotation: 0, opacity: 1, width: 20, height: 20, text: `Call ${SECRET}`, color: '#ff0', author: '', createdAt: '', modifiedAt: '' } as EditorObject);
    S().setFieldValue(`${S().pages[0].sourceId}::client`, `Ion ${SECRET}`);
    S().setDocMeta({ author: `Ion ${SECRET}`, title: 'Report' });
    const hits = await findSensitiveElsewhere({ patterns: [], terms: [SECRET] });
    const where = hits.map((h) => `${h.where}${h.page ? `@${h.page}` : ''}`).sort();
    expect(where).toEqual(['Comment@1', 'Comment@1', 'Field value', 'Metadata: Author']);
  });

  it('redacts the file and the unsaved edits; undo brings them back', async () => {
    const before = S().pages[0].sourceId!;
    const pageId = S().pages[0].id;
    S().addObject({ id: 'n1', type: 'note', pageId, x: 0, y: 0, rotation: 0, opacity: 1, width: 20, height: 20, text: `Call ${SECRET}`, color: '#ff0', author: '', createdAt: '', modifiedAt: '' } as EditorObject);
    S().setFieldValue(`${before}::client`, `Ion ${SECRET}`);
    const n = await redactSensitiveElsewhere({ patterns: [], terms: [SECRET] }, {});
    expect(n).toBeGreaterThanOrEqual(4);
    const after = S().pages[0].sourceId!;
    expect(after).not.toBe(before);
    expect(contains(await everything(S().sources[after].bytes), SECRET)).toBe(false);
    expect(S().objects.some((o) => o.id === 'n1')).toBe(false);
    expect(S().fieldValues[`${after}::client`]).toBe('');
    expect(await findSensitiveElsewhere({ patterns: [], terms: [SECRET] })).toEqual([]);
    S().undo();
    expect(S().pages[0].sourceId).toBe(before);
    expect(S().objects.some((o) => o.id === 'n1')).toBe(true);
  });

  it('can keep comments and black out the match', async () => {
    const pageId = S().pages[0].id;
    S().addObject({ id: 'n1', type: 'note', pageId, x: 0, y: 0, rotation: 0, opacity: 1, width: 20, height: 20, text: `Call ${SECRET}`, color: '#ff0', author: '', createdAt: '', modifiedAt: '' } as EditorObject);
    await redactSensitiveElsewhere({ patterns: [], terms: [SECRET] }, { comments: 'redact' });
    expect((S().objects.find((o) => o.id === 'n1') as { text: string }).text).toBe('Call ████');
  });
});
