import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readCustomInfo, readXmpFields, readXmpPacket } from '@/lib/pdf/xmp';
import { buildPdfAXmp } from '@/lib/pdf/pdfa';
import { buildPdf } from '@/lib/pdf/exportPdf';
import type { PageRef } from '@/types';

describe('XMP metadata', () => {
  it('writes edited properties, copyright and custom properties, keeping the rest of the packet', async () => {
    const d = await PDFDocument.create();
    d.addPage([300, 300]);
    d.setTitle('Old title');
    (d as unknown as { getInfoDict(): { set(k: PDFName, v: unknown): void } }).getInfoDict().set(PDFName.of('Project'), d.context.obj('ignored'));
    const xmp = buildPdfAXmp({ title: 'Old title', author: 'Someone', producer: 'X', createDate: new Date(Date.UTC(2026, 0, 1)), modifyDate: new Date(Date.UTC(2026, 0, 1)), part: 2 });
    d.catalog.set(PDFName.of('Metadata'), d.context.register(d.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
    const src = { id: 's', name: 'm.pdf', bytes: await d.save(), pageCount: 1 };
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 300, height: 300 };
    const out = await buildPdf(
      { sources: { s: src }, pages: [ref], objects: [], fieldValues: {} },
      { meta: { title: 'Contract 12/2026', author: 'Ana Pop; Ion Ionescu', subject: 'Service contract', keywords: 'contract, 2026', rightsStatus: 'copyrighted', copyright: '© 2026 Adika SRL', copyrightUrl: 'https://adika.example/terms', custom: { Department: 'Legal', CaseNo: 'C-17' } } },
    );
    const doc = await PDFDocument.load(out);
    const f = readXmpFields(doc)!;
    expect(f).toEqual({ title: 'Contract 12/2026', authors: ['Ana Pop', 'Ion Ionescu'], description: 'Service contract', keywords: 'contract, 2026', rightsStatus: 'copyrighted', copyright: '© 2026 Adika SRL', copyrightUrl: 'https://adika.example/terms' });
    const packet = readXmpPacket(doc)!;
    expect(packet).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(packet.match(/<dc:title>/g)).toHaveLength(1);
    expect(doc.getTitle()).toBe('Contract 12/2026');
    expect(doc.getAuthor()).toBe('Ana Pop; Ion Ionescu');
    expect(readCustomInfo(doc)).toEqual({ Department: 'Legal', CaseNo: 'C-17' });
  });
});
