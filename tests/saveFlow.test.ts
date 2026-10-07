import { beforeEach, describe, expect, it, vi } from 'vitest';

// Save through the real action, with the file system, dialogs and PDF writers stubbed.
const env = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout, dispatchEvent: () => true };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  return {
    disk: new Map<string, string>(), // path -> stamp
    saved: [] as Array<{ path: string | null; how: string }>,
    choices: [] as Array<'confirm' | 'alt' | null>,
    asked: [] as string[],
    stampCalls: 0,
  };
});
vi.mock('@/lib/platform', () => ({
  isDesktop: false,
  fileStamp: async (path: string) => {
    env.stampCalls++;
    return env.disk.get(path) ?? null;
  },
  saveBytes: async (bytes: Uint8Array, name: string, _f: unknown, path: string | null) => {
    const target = path ?? `C:\\new\\${name}`;
    env.saved.push({ path, how: new TextDecoder().decode(bytes) });
    env.disk.set(target, `stamp-after-save-${env.saved.length}`);
    return target;
  },
  pickFiles: async () => [],
  readFile: async () => new Uint8Array(),
}));
vi.mock('@/store/useDialogs', () => ({
  askChoice: async (o: { title: string }) => {
    env.asked.push(o.title);
    return env.choices.shift() ?? null;
  },
  askConfirm: async () => true,
  askPassword: async () => null,
}));
vi.mock('@/lib/pdf/exportPdf', async (orig) => {
  const real = await orig<typeof import('@/lib/pdf/exportPdf')>();
  return { ...real, buildPdf: async () => new TextEncoder().encode('full'), buildIncrementalPdf: async () => new TextEncoder().encode('incremental') };
});
vi.mock('@/actions/xfaForms', () => ({ xfaSaveBytes: async () => null }));
vi.mock('@/lib/pdf/pdfService', () => ({
  PasswordRequiredError: class extends Error {},
  openPdf: async () => ({ numPages: 2, getPage: async () => ({ view: [0, 0, 100, 200], rotate: 0 }) }),
  registerSource: () => undefined,
  releaseSource: async () => undefined,
  rasterizePage: async () => null,
  canvasToBytes: async () => new Uint8Array(),
  onSourceRelease: () => undefined,
}));

import { usePDFStore } from '@/store/usePDFStore';
import { saveDocument } from '@/actions/document';
import { useSaveSettings } from '@/lib/saveSettings';
import type { EditorObject, SignatureValidation } from '@/types';

const S = () => usePDFStore.getState();
const PATH = 'C:\\docs\\contract.pdf';
const note = (pageId: string) => ({ id: `n${Math.random()}`, type: 'note', pageId, x: 1, y: 1, rotation: 0, opacity: 1, width: 20, height: 20, text: 'x', color: '#ff0', author: '', createdAt: '', modifiedAt: '' }) as unknown as EditorObject;

async function open(signed: boolean) {
  await S().loadDocument(new Uint8Array([1, 2, 3]), 'contract.pdf', PATH, undefined, true);
  env.disk.set(PATH, 'stamp-open');
  usePDFStore.setState({ fileStamp: 'stamp-open', signatureStatus: signed ? [{} as SignatureValidation] : [] });
}

beforeEach(() => {
  env.saved.length = 0;
  env.asked.length = 0;
  env.choices.length = 0;
  useSaveSettings.getState().setPreferIncremental(false);
});

describe('Save', () => {
  it('a signed document with only comments is saved incrementally, without asking', async () => {
    await open(true);
    S().addObject(note(S().pages[0].id));
    expect(await saveDocument()).toBe(true);
    expect(env.saved).toEqual([{ path: PATH, how: 'incremental' }]);
    expect(env.asked).toEqual([]);
    expect(S().dirty).toBe(false);
    // The stamp of our own save is known before the document counts as saved.
    expect(S().fileStamp).toBe('stamp-after-save-1');
  });

  it('an unsigned document is rewritten in full unless incremental saves are preferred', async () => {
    await open(false);
    S().addObject(note(S().pages[0].id));
    await saveDocument();
    useSaveSettings.getState().setPreferIncremental(true);
    S().addObject(note(S().pages[0].id));
    await saveDocument();
    expect(env.saved.map((x) => x.how)).toEqual(['full', 'incremental']);
  });

  it('a signed document that needs a full rewrite asks first: copy, anyway or cancel', async () => {
    await open(true);
    S().rotatePages([S().pages[0].id], 90);
    env.choices.push(null);
    expect(await saveDocument()).toBe(false);
    expect(env.saved).toHaveLength(0);
    env.choices.push('alt');
    expect(await saveDocument()).toBe(true);
    expect(env.saved.at(-1)).toEqual({ path: null, how: 'full' }); // a copy: the signed file is not touched
    S().rotatePages([S().pages[0].id], 90);
    env.choices.push('confirm');
    await saveDocument();
    expect(env.asked).toEqual(['Saving will invalidate the signatures', 'Saving will invalidate the signatures', 'Saving will invalidate the signatures']);
  });

  it('asks before overwriting a file another program changed', async () => {
    await open(false);
    S().addObject(note(S().pages[0].id));
    env.disk.set(PATH, 'stamp-someone-else');
    env.choices.push(null);
    expect(await saveDocument()).toBe(false);
    expect(env.asked).toEqual(['The file changed on disk']);
    env.choices.push('alt'); // save as a new file
    expect(await saveDocument()).toBe(true);
    expect(env.saved.at(-1)?.path).toBeNull();
    expect(S().filePath).toBe('C:\\new\\contract.pdf');
  });
});
