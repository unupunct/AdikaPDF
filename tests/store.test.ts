import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store reads window/localStorage when it is created and opens PDFs with pdf.js: both stubbed.
const released = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  return [] as string[];
});
vi.mock('@/lib/pdf/pdfService', () => ({
  openPdf: async (bytes: Uint8Array) => {
    if (bytes[0] === 0xff) throw new Error('broken');
    const pages = bytes[0] || 1;
    return {
      numPages: pages,
      getPage: async (n: number) => {
        if (bytes[1] === n) throw new Error('bad page');
        return { view: [0, 0, 100, 200], rotate: 0 };
      },
    };
  },
  registerSource: () => undefined,
  releaseSource: async (id: string) => void released.push(id),
}));

import { usePDFStore, sameDoc, OWNER_PASSWORD_READ_ONLY } from '@/store/usePDFStore';
import { newTab, switchTab, tabWithPath, useTabs } from '@/store/tabs';
import type { EditorObject } from '@/types';

const S = () => usePDFStore.getState();
const note = (id: string, pageId: string): EditorObject =>
  ({ id, type: 'note', pageId, x: 10, y: 10, rotation: 0, opacity: 1, text: 'hi', color: '#ff0', author: '', createdAt: '' }) as unknown as EditorObject;

async function open(pages = 2, path: string | null = 'C:\\docs\\a.pdf') {
  await S().loadDocument(new Uint8Array([pages, 0]), 'a.pdf', path);
}

beforeEach(async () => {
  released.length = 0;
  await S().closeDocument();
});

describe('history and the dirty flag', () => {
  it('commit marks dirty; undo back to the saved state is clean, redo dirty again', async () => {
    await open();
    expect(S().dirty).toBe(false);
    const page = S().pages[0].id;
    S().addObject(note('n1', page));
    expect(S().dirty).toBe(true);
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(S().objects).toHaveLength(0);
    expect(S().dirty).toBe(false);
    S().redo();
    expect(S().objects).toHaveLength(1);
    expect(S().dirty).toBe(true);
  });

  it('after saving, the saved state is the clean one', async () => {
    await open();
    const page = S().pages[0].id;
    S().addObject(note('n1', page));
    S().markSaved('C:\\docs\\a.pdf');
    expect(S().dirty).toBe(false);
    S().addObject(note('n2', page));
    expect(S().dirty).toBe(true);
    S().undo();
    expect(S().dirty).toBe(false);
    S().undo(); // before the save: unsaved compared with the file
    expect(S().dirty).toBe(true);
    S().redo();
    expect(S().dirty).toBe(false);
  });

  it('a no-op commit adds no undo step and keeps the document clean', async () => {
    await open();
    S().commit(() => ({}));
    S().reorderObject('missing', 'front'); // recipe returns {}
    S().commit((s) => ({ pages: s.pages }));
    expect(S().past).toHaveLength(0);
    expect(S().dirty).toBe(false);
  });

  it('abandoning a just-created object leaves a clean document clean', async () => {
    await open();
    S().addObject(note('t1', S().pages[0].id));
    S().abandonNewObject('t1');
    expect(S().objects).toHaveLength(0);
    expect(S().past).toHaveLength(0);
    expect(S().dirty).toBe(false);
  });

  it('changes outside the history (properties, a tool result) stay unsaved through undo', async () => {
    await open();
    S().addObject(note('n1', S().pages[0].id));
    S().setDocMeta({ title: 'New' });
    S().undo();
    expect(S().dirty).toBe(true);

    await open();
    usePDFStore.setState({ dirty: true }); // e.g. a repaired file
    S().addObject(note('n1', S().pages[0].id));
    S().undo();
    expect(S().dirty).toBe(true);
    expect(sameDoc(S(), S().savedDoc)).toBe(false);
  });
});

describe('sources', () => {
  it('a source whose pages are gone is released once no undo step needs it', async () => {
    await open(1);
    const first = S().pages[0].sourceId!;
    const { pages } = await S().addSource(new Uint8Array([1, 0]), 'b.pdf');
    S().commit((s) => ({ pages: [...s.pages, ...pages] }));
    const second = pages[0].sourceId!;
    S().deletePages([pages[0].id]);
    expect(S().sources[second]).toBeDefined(); // undo can bring it back
    S().undo();
    S().undo(); // before the merge
    S().addObject(note('n1', S().pages[0].id)); // the redo steps are gone, and with them the merged file
    expect(S().sources[second]).toBeUndefined();
    expect(released).toContain(second);
    expect(S().sources[first]).toBeDefined();
  });

  it('a source that fails to load midway is not left registered', async () => {
    await open(1);
    const before = Object.keys(S().sources);
    released.length = 0;
    await expect(S().addSource(new Uint8Array([3, 2]), 'bad.pdf')).rejects.toThrow('bad page');
    expect(Object.keys(S().sources)).toEqual(before);
    expect(released).toHaveLength(1);
  });

  it('remembers the password in memory and whether the bytes are the file on disk', async () => {
    const { source } = await S().addSource(new Uint8Array([1, 0]), 'p.pdf', 'secret', true);
    expect(source.password).toBe('secret');
    expect(source.original).toBe(true);
    await S().loadDocument(new Uint8Array([1, 0]), 'a.pdf', 'C:\\a.pdf', undefined, true);
    expect(Object.values(S().sources)[0].original).toBe(true);
  });

  it('an encrypted file opened without a password (owner password) opens read-only', async () => {
    const enc = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF');
    enc[0] = 1;
    enc[1] = 0;
    await S().loadDocument(enc, 'locked.pdf', null);
    expect(S().readOnlyReason).toBe(OWNER_PASSWORD_READ_ONLY);
  });
});

describe('tabs', () => {
  it('each tab keeps its own saved state; a path already open is found', async () => {
    await open(1, 'C:\\docs\\a.pdf');
    S().addObject(note('n1', S().pages[0].id));
    const first = useTabs.getState().activeId;
    newTab();
    await open(1, 'C:\\docs\\b.pdf');
    expect(S().dirty).toBe(false);
    expect(tabWithPath('c:/DOCS/A.pdf')).toBe(first);
    switchTab(first);
    expect(S().dirty).toBe(true);
    S().undo();
    expect(S().dirty).toBe(false);
  });
});
