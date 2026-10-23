import { describe, expect, it } from 'vitest';
import { fileKind, kindFromMime } from '../src/lib/fileKinds';
import { dropLabel, insertText, NOT_IN_DIALOG, NOTHING_SUPPORTED, planDrop, planPageDrop, reorderedIds, type DropDoc, type DropEntry, type DropTarget } from '../src/lib/dnd';

const open: DropDoc = { hasDoc: true, pagesBlocked: null, contentBlocked: null };
const none: DropDoc = { hasDoc: false, pagesBlocked: null, contentBlocked: null };
const kinds = (...names: string[]): DropEntry[] => names.map((n) => ({ kind: n.endsWith('/') ? 'folder' : fileKind(n) }));
const page = (pageIndex: number, onPage = true): DropTarget => ({ kind: 'page', pageIndex, pageId: `p${pageIndex}`, x: 100, y: 200, onPage });

describe('file kinds', () => {
  it('by extension', () => {
    expect(['a.PDF', 'b.png', 'c.HEIC', 'd.docx', 'e.csv', 'f.eml', 'g.dxf', 'h.md', 'i.xml', 'j.zip', 'k.exe', 'noext'].map(fileKind)).toEqual([
      'pdf', 'image', 'image', 'office', 'office', 'convert', 'convert', 'convert', 'einvoice', 'einvoice', 'unsupported', 'unsupported',
    ]);
  });
  it('by MIME type while dragging (unknown stays unknown)', () => {
    expect(kindFromMime('application/pdf')).toBe('pdf');
    expect(kindFromMime('image/jpeg')).toBe('image');
    expect(kindFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('office');
    expect(kindFromMime('application/x-msdownload')).toBe('unsupported');
    expect(kindFromMime('')).toBeNull();
    expect(kindFromMime('application/octet-stream')).toBeNull();
  });
});

describe('file drops', () => {
  it('without a document everything opens', () => {
    const p = planDrop(kinds('a.pdf', 'b.pdf', 'c.docx', 'd.png', 'e.xml', 'F/', 'g.exe'), page(0), none);
    expect(p).toMatchObject({ pdfs: [0, 1], convert: [2], images: [3], einvoices: [4], folders: [5], unsupported: [6], ask: false, insertAt: null, place: null, rejected: null });
    expect(dropLabel(p, { kind: 'app' }, 0)).toBe('Open in a new tab');
  });

  it('elsewhere in the window, PDFs open in new tabs', () => {
    const p = planDrop(kinds('a.pdf'), { kind: 'app' }, open);
    expect(p.ask).toBe(false);
    expect(p.insertAt).toBeNull();
  });

  it('onto thumbnails: insert before that thumbnail, or open (the user chooses)', () => {
    const p = planDrop(kinds('a.pdf', 'b.docx', 'c.jpg'), { kind: 'thumbs', index: 2 }, open);
    expect(p).toMatchObject({ ask: true, insertAt: 2, place: null });
    expect(dropLabel(p, { kind: 'thumbs', index: 2 }, 5)).toBe('Insert pages after page 2 or open in a new tab');
    expect(dropLabel(planDrop(kinds('a.pdf'), { kind: 'thumbs', index: 0 }, open), { kind: 'thumbs', index: 0 }, 5)).toBe('Insert pages at the beginning or open in a new tab');
  });

  it('onto a page: pages go after it, pictures are placed at the point', () => {
    const p = planDrop(kinds('a.png', 'b.jpg'), page(3), open);
    expect(p.place).toEqual({ pageId: 'p3', x: 100, y: 200 });
    expect(p.ask).toBe(false);
    expect(dropLabel(p, page(3), 9)).toBe('Place the picture on page 4');
    const mixed = planDrop(kinds('a.png', 'b.pdf'), page(3), open);
    expect(mixed).toMatchObject({ place: { pageId: 'p3' }, ask: true, insertAt: 4 });
    expect(insertText(9, 9)).toBe('Insert pages at the end');
  });

  it('between pages: pictures become pages after the nearest page', () => {
    const p = planDrop(kinds('a.png'), page(1, false), open);
    expect(p).toMatchObject({ place: null, ask: true, insertAt: 2 });
  });

  it('a document that does not allow page changes: PDFs open instead, with the reason', () => {
    const blocked = { ...open, pagesBlocked: 'No pages' };
    const p = planDrop(kinds('a.pdf'), { kind: 'thumbs', index: 1 }, blocked);
    expect(p).toMatchObject({ ask: false, insertAt: null, note: 'No pages', rejected: null });
    expect(dropLabel(p, { kind: 'thumbs', index: 1 }, 3)).toBe('Open in a new tab');
  });

  it('a document that does not allow content changes: pictures are not placed', () => {
    const p = planDrop(kinds('a.png'), page(0), { ...open, contentBlocked: 'No content' });
    expect(p.place).toBeNull();
    expect(p.note).toBe('No content');
  });

  it('refuses drops into dialogs (outside their lists) and files Adika cannot open', () => {
    expect(planDrop(kinds('a.pdf'), { kind: 'dialog' }, open).rejected).toBe(NOT_IN_DIALOG);
    const p = planDrop(kinds('a.exe', 'b.dll'), { kind: 'app' }, open);
    expect(p.rejected).toBe(NOTHING_SUPPORTED);
    expect(dropLabel(p, { kind: 'app' }, 1)).toBe(NOTHING_SUPPORTED);
    // Mixed: the supported ones go on, the others are reported.
    expect(planDrop(kinds('a.exe', 'b.pdf'), { kind: 'app' }, open)).toMatchObject({ rejected: null, unsupported: [0], pdfs: [1] });
  });

  it('a folder offers its PDFs', () => {
    const p = planDrop(kinds('Scans/'), { kind: 'app' }, open);
    expect(dropLabel(p, { kind: 'app' }, 1)).toBe('Open the PDFs in this folder');
  });
});

describe('page drags', () => {
  const drag = { tabId: 't1', copyBlocked: null };
  it('reorders in the same document, copies into another', () => {
    expect(planPageDrop(drag, 't1', { kind: 'thumbs', index: 3 }, open)).toEqual({ action: 'reorder', at: 3, rejected: null });
    expect(planPageDrop(drag, 't2', { kind: 'thumbs', index: 0 }, open)).toEqual({ action: 'copy', at: 0, rejected: null });
    expect(planPageDrop(drag, 't2', page(4), open)).toEqual({ action: 'copy', at: 5, rejected: null });
  });
  it('hovering another tab switches to it', () => {
    expect(planPageDrop(drag, 't1', { kind: 'tab', tabId: 't2' }, open).action).toBe('switch');
    expect(planPageDrop(drag, 't1', { kind: 'tab', tabId: 't1' }, open).action).toBe('none');
  });
  it('respects page and copy restrictions', () => {
    expect(planPageDrop(drag, 't2', { kind: 'thumbs', index: 0 }, { ...open, pagesBlocked: 'Locked' })).toMatchObject({ action: 'none', rejected: 'Locked' });
    expect(planPageDrop({ tabId: 't1', copyBlocked: 'No copy' }, 't2', { kind: 'thumbs', index: 0 }, open)).toMatchObject({ action: 'none', rejected: 'No copy' });
    // Reordering one's own pages is not copying.
    expect(planPageDrop({ tabId: 't1', copyBlocked: 'No copy' }, 't1', { kind: 'thumbs', index: 0 }, open).action).toBe('reorder');
  });
  it('nothing happens on other targets', () => {
    expect(planPageDrop(drag, 't1', { kind: 'app' }, open)).toEqual({ action: 'none', at: null, rejected: null });
    expect(planPageDrop(drag, 't1', { kind: 'dialog' }, open).rejected).toBe(NOT_IN_DIALOG);
  });
  it('reordered ids (drop index in the old order)', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(reorderedIds(ids, ['a'], 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderedIds(ids, ['d'], 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderedIds(ids, ['b'], 4)).toEqual(['a', 'c', 'd', 'b']);
    expect(reorderedIds(ids, ['b'], 1)).toEqual(ids);
    expect(reorderedIds(ids, ['b'], 2)).toEqual(ids);
    expect(reorderedIds(ids, ['a', 'c'], 4)).toEqual(['b', 'd', 'a', 'c']);
  });
});
