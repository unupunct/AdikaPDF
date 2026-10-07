import { beforeEach, describe, expect, it, vi } from 'vitest';

// Backups go through Tauri commands: an in-memory recovery folder stands in for them.
const env = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  return { files: new Map<string, Uint8Array>(), asked: [] as string[] };
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, arg: unknown, opts?: { headers: Record<string, string> }) => {
    const { files } = env;
    if (cmd === 'recovery_write') files.set(decodeURIComponent(opts!.headers['x-name']), arg as Uint8Array);
    else if (cmd === 'recovery_read') {
      const b = files.get((arg as { name: string }).name);
      if (!b) throw new Error('missing');
      return b.slice().buffer;
    } else if (cmd === 'recovery_remove') {
      const dir = (arg as { dir: string }).dir;
      for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k);
    } else if (cmd === 'recovery_list') {
      const dirs = new Set([...files.keys()].filter((k) => k.endsWith('/state.json')).map((k) => k.split('/')[0]));
      return [...dirs].map((dir) => ({ dir, modified: 0 }));
    }
    return undefined;
  },
}));
vi.mock('@/lib/platform', () => ({ isDesktop: true, saveBytes: async () => null }));
vi.mock('@/actions/document', () => ({ refreshSignatureStatus: async () => undefined }));
vi.mock('@/store/useDialogs', () => ({
  askPassword: async (name: string) => {
    env.asked.push(name);
    return 'secret';
  },
}));
vi.mock('@/lib/pdf/pdfService', () => {
  class PasswordRequiredError extends Error {
    constructor(public readonly incorrect: boolean) {
      super('password');
    }
  }
  return {
    PasswordRequiredError,
    pdfjs: {},
    onSourceRelease: () => undefined,
    openPdf: async (bytes: Uint8Array, password?: string) => {
      // First byte: page count; second byte 1: needs the password "secret".
      if (bytes[1] === 1 && password !== 'secret') throw new PasswordRequiredError(!!password);
      return { numPages: bytes[0], getPage: async () => ({ view: [0, 0, 100, 200], rotate: 0 }) };
    },
    registerSource: () => undefined,
    releaseSource: async () => undefined,
  };
});

import { usePDFStore } from '@/store/usePDFStore';
import { newTab, switchTab, useTabs } from '@/store/tabs';
import { backupAllTabs, discardSessionBackups, listBackups, recoverBackups, startAutoBackup } from '@/lib/recovery';
import type { EditorObject } from '@/types';

const S = () => usePDFStore.getState();
const note = (id: string, pageId: string): EditorObject =>
  ({ id, type: 'note', pageId, x: 1, y: 1, rotation: 0, opacity: 1, text: id, color: '#ff0', author: '', createdAt: '' }) as unknown as EditorObject;
const states = () => [...env.files.entries()].filter(([k]) => k.endsWith('/state.json')).map(([k, v]) => ({ dir: k.split('/')[0], st: JSON.parse(new TextDecoder().decode(v)) }));
const settle = () => new Promise((r) => setTimeout(r, 20));

startAutoBackup();

beforeEach(async () => {
  await discardSessionBackups();
  env.files.clear();
  env.asked.length = 0;
});

describe('backups of every tab', () => {
  it('a tab is backed up when you switch away from it, not only the active one', async () => {
    await S().loadDocument(new Uint8Array([1, 0]), 'a.pdf', 'C:\\a.pdf');
    const tabA = useTabs.getState().activeId;
    S().addObject(note('a1', S().pages[0].id));
    newTab(); // switching away backs up a.pdf at once
    await S().loadDocument(new Uint8Array([2, 0]), 'b.pdf', 'C:\\b.pdf');
    S().addObject(note('b1', S().pages[1].id));
    switchTab(tabA);
    await settle();
    await backupAllTabs();
    const names = states().map((x) => x.st.fileName).sort();
    expect(names).toEqual(['a.pdf', 'b.pdf']);
  });

  it('recovering several backups backs all of them up again, asking for passwords', async () => {
    // Two backups of an earlier run.
    const put = (dir: string, name: string, src: Uint8Array, password?: boolean) => {
      env.files.set(`${dir}/src-x.pdf`, src);
      const st = {
        version: 1,
        savedAt: '2026-01-01T00:00:00Z',
        fileName: name,
        filePath: null,
        docMeta: null,
        pages: [{ id: 'p1', kind: 'source', sourceId: 'x', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 100, height: 200 }],
        objects: [note(`${name}-n`, 'p1')],
        fieldValues: { 'x::f': 'v' },
        outline: null,
        sources: [{ id: 'x', name, pageCount: 1, file: 'src-x.pdf', ...(password ? { password: true } : {}) }],
      };
      env.files.set(`${dir}/state.json`, new TextEncoder().encode(JSON.stringify(st)));
    };
    put('old-1', 'one.pdf', new Uint8Array([1, 0]));
    put('old-2', 'two.pdf', new Uint8Array([1, 1]), true);
    const found = await listBackups();
    expect(found.map((b) => b.dir).sort()).toEqual(['old-1', 'old-2']);
    expect(await recoverBackups(['old-1', 'old-2'])).toBe(2);
    expect(env.asked).toEqual(['two.pdf']);
    const after = states();
    expect(after.some((x) => x.dir.startsWith('old-'))).toBe(false);
    // The new tabs, and the earlier test's still-unsaved tabs.
    expect(after.map((x) => x.st.fileName).sort()).toEqual(['a.pdf', 'b.pdf', 'one.pdf', 'two.pdf']);
    // Field values follow their source to its new id.
    const srcId = Object.keys(S().sources)[0];
    expect(S().fieldValues[`${srcId}::f`]).toBe('v');
    expect(S().dirty).toBe(true);
    // The password is never written.
    for (const [, v] of env.files) expect(new TextDecoder().decode(v)).not.toContain('secret');
  });
});
