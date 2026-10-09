import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OCR_LANG_CATALOG, ocrLangUrl } from '@/lib/ocrLangCatalog';
import {
  BUNDLED_OCR_LANGS,
  cacheKey,
  downloadOcrLang,
  installedOcrLangs,
  OcrLangMissingError,
  planOcrLangs,
  readDownloadedLangs,
  removeOcrLang,
  verifyOcrLang,
  type OcrLangIo,
} from '@/lib/ocrLangs';
import { parseOcrLangs } from '@/lib/pdf/ocr';
import { applyDeployment, PolicyError } from '@/lib/policy';

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

/** A fake app-data folder and network; `served` maps URLs to bytes. */
function fakeIo(served: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  const fetched: string[] = [];
  const io: OcrLangIo = {
    list: async () => [...files].map(([code, b]) => ({ code, size: b.length })),
    read: async (code) => files.get(code) ?? new Uint8Array(0),
    write: async (code, b) => void files.set(code, b),
    remove: async (code) => void files.delete(code),
    get: async (url) => {
      fetched.push(url);
      const b = served[url];
      if (!b) throw new Error(`404 ${url}`);
      return b;
    },
  };
  return { io, files, fetched };
}

/** Bytes that hash to a catalogue entry we patch in for the test. */
function withFakeEntry(code: string, bytes: Uint8Array): () => void {
  const entry = OCR_LANG_CATALOG.find((l) => l.code === code)!;
  const saved = { ...entry };
  entry.size = bytes.length;
  entry.sha256 = sha(bytes);
  return () => Object.assign(entry, saved);
}

afterEach(() => applyDeployment({}));

describe('OCR language catalogue', () => {
  it('pins about a hundred LSTM languages with sizes and SHA-256', () => {
    expect(OCR_LANG_CATALOG.length).toBeGreaterThanOrEqual(100);
    for (const l of OCR_LANG_CATALOG) {
      expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(l.size).toBeGreaterThan(100_000);
    }
    expect(new Set(OCR_LANG_CATALOG.map((l) => l.code)).size).toBe(OCR_LANG_CATALOG.length);
    for (const b of BUNDLED_OCR_LANGS) expect(OCR_LANG_CATALOG.some((l) => l.code === b.code)).toBe(true);
    expect(ocrLangUrl('chi_sim')).toBe('https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz');
  });

  it('matches the bundled files byte for byte (same flavour and version)', async () => {
    const dir = path.join('public', 'tesseract', 'lang');
    if (!fs.existsSync(dir)) return;
    for (const b of BUNDLED_OCR_LANGS) {
      const file = path.join(dir, `${b.code}.traineddata.gz`);
      if (!fs.existsSync(file)) continue;
      await expect(verifyOcrLang(b.code, new Uint8Array(fs.readFileSync(file)))).resolves.toBeUndefined();
    }
  });
});

describe('downloading OCR languages', () => {
  const data = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6]);

  it('downloads from the pinned URL, checks the hash and stores the file', async () => {
    const restore = withFakeEntry('ukr', data);
    try {
      const { io, files, fetched } = fakeIo({ [ocrLangUrl('ukr')]: data });
      await downloadOcrLang('ukr', io);
      expect(fetched).toEqual([ocrLangUrl('ukr')]);
      expect(files.get('ukr')).toEqual(data);
      expect(await installedOcrLangs(io)).toEqual([...BUNDLED_OCR_LANGS.map((l) => l.code), 'ukr']);
      expect(await readDownloadedLangs(['ukr'], io)).toEqual([{ code: 'ukr', data }]);
      await removeOcrLang('ukr', io);
      expect(files.size).toBe(0);
      expect(await installedOcrLangs(io)).toEqual(BUNDLED_OCR_LANGS.map((l) => l.code));
    } finally {
      restore();
    }
  });

  it('refuses a file whose hash or size differs and stores nothing', async () => {
    const restore = withFakeEntry('ukr', data);
    try {
      const tampered = data.slice();
      tampered[9] ^= 1;
      const a = fakeIo({ [ocrLangUrl('ukr')]: tampered });
      await expect(downloadOcrLang('ukr', a.io)).rejects.toThrow(/checksum/);
      expect(a.files.size).toBe(0);
      const b = fakeIo({ [ocrLangUrl('ukr')]: data.slice(0, 5) });
      await expect(downloadOcrLang('ukr', b.io)).rejects.toThrow(/wrong size/);
      expect(b.files.size).toBe(0);
    } finally {
      restore();
    }
  });

  it('checks a stored file again before using it', async () => {
    const restore = withFakeEntry('ukr', data);
    try {
      const { io, files } = fakeIo();
      files.set('ukr', new Uint8Array([0x1f, 0x8b, 0, 0, 0, 0, 0, 0, 0, 0]));
      await expect(readDownloadedLangs(['ukr'], io)).rejects.toThrow(/checksum/);
      files.clear();
      await expect(readDownloadedLangs(['ukr'], io)).rejects.toThrow(OcrLangMissingError);
    } finally {
      restore();
    }
  });

  it('refuses unknown languages and does not touch bundled ones', async () => {
    const { io, fetched } = fakeIo();
    await expect(downloadOcrLang('xxx', io)).rejects.toThrow(/Unknown/);
    await downloadOcrLang('ron', io);
    expect(fetched).toEqual([]);
    await expect(removeOcrLang('eng', io)).rejects.toThrow(/cannot be removed/);
  });

  it('is blocked by the DisableOnlineFeatures policy before anything is fetched', async () => {
    applyDeployment({ policies: { machine: { DisableOnlineFeatures: 1 } } });
    const { io, fetched } = fakeIo({ [ocrLangUrl('ukr')]: data });
    await expect(downloadOcrLang('ukr', io)).rejects.toThrow(PolicyError);
    await expect(downloadOcrLang('ukr', io)).rejects.toThrow(/Downloading OCR languages is turned off/);
    expect(fetched).toEqual([]);
  });
});

describe('OCR language resolution', () => {
  it('takes bundled languages first, then downloaded ones; reports missing ones', () => {
    expect(planOcrLangs(['ron', 'ukr', 'eng', 'jpn', 'zzz', 'RON'], ['ukr', 'ron'])).toEqual({ bundled: ['ron', 'eng'], downloaded: ['ukr'], missing: ['jpn'] });
    // A bundled language stays bundled even when a copy was downloaded.
    expect(planOcrLangs(['deu'], ['deu']).bundled).toEqual(['deu']);
  });

  it('parseOcrLangs accepts downloaded languages', () => {
    expect(parseOcrLangs('ukr+eng')).toEqual(['eng']);
    expect(parseOcrLangs('ukr+eng', ['ukr'])).toEqual(['ukr', 'eng']);
  });

  it('hands languages to the worker under the key tesseract.js reads', () => {
    expect(cacheKey('adika-ocr-x', 'ukr')).toBe('adika-ocr-x/ukr.traineddata');
  });
});
