import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import ro from '@/locales/ro.json';
import { RO_EXTRA } from '@/locales/ro.extra';

const require = createRequire(import.meta.url);
const { extractUiStrings } = require('../scripts/i18n-extract.cjs') as { extractUiStrings: (repo: string) => Array<{ text: string; where: string[] }> };

describe('Romanian dictionary coverage', () => {
  it('every interface string in components and actions has a Romanian translation', () => {
    const dict: Record<string, string> = { ...(ro as Record<string, string>), ...RO_EXTRA };
    const ui = extractUiStrings(process.cwd()).filter((s) => s.where.some((w) => /^src\/(components|actions|hooks|lib\/(patterns|batch|updates))\//.test(w)));
    const missing = ui.filter((s) => !(s.text in dict)).map((s) => `${s.text}  (${s.where[0]})`);
    // Add new strings to src/locales/ro.json (node scripts/i18n-extract.cjs lists them all).
    expect(missing).toEqual([]);
  }, 60000);
});
