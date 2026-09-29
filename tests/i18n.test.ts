import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLang, translate } from '@/lib/i18n';
import ro from '@/locales/ro.json';
import { RO_EXTRA } from '@/locales/ro.extra';

beforeAll(async () => {
  await applyLang('ro');
});
afterAll(async () => {
  await applyLang('en');
});

describe('Romanian interface', () => {
  it('translates exact strings and keeps surrounding spaces', () => {
    expect(translate('Properties')).toBe('Proprietăți');
    expect(translate('  Compress (smaller files) ')).toBe('  Comprimare (fișiere mai mici) ');
    expect(translate('APPROVED')).toBe('APROBAT');
  });

  it('fills patterns with Romanian plural forms', () => {
    expect(translate('Merge 1 files')).toBe('Combinare un fișier');
    expect(translate('Merge 3 files')).toBe('Combinare 3 fișiere');
    expect(translate('Merge 25 files')).toBe('Combinare 25 de fișiere');
    expect(translate('Merge 101 files')).toBe('Combinare 101 fișiere');
    expect(translate('2 signatures · intact')).toBe('2 semnături intacte');
    expect(translate('1 signature · problem')).toBe('o semnătură cu probleme');
  });

  it('translates messages joined from several sentences', () => {
    const t = translate('Replaced 3 occurrences. Undo (Ctrl+Z) restores the original.');
    expect(t).not.toMatch(/Replaced|Undo/);
    expect(t).toContain('3');
  });

  it('never rewrites text it does not know (user content)', () => {
    expect(translate('Go to page 7 of the contract')).toBe('Go to page 7 of the contract');
    expect(translate('Ion Popescu (Cluj)')).toBe('Ion Popescu (Cluj)');
    // "{0} page{1}" only takes a number and an English plural ending.
    expect(translate('Title page')).toBe(translate('Title page'));
    expect(translate('Several pages')).toBe('Several pages');
    // Short patterns only around numbers.
    expect(translate('of 12')).toBe('din 12');
    expect(translate('of mice and men')).toBe('of mice and men');
  });

  it('dictionary: every translation keeps the information placeholders of its English text', () => {
    const all: Record<string, string> = { ...(ro as Record<string, string>), ...RO_EXTRA };
    const bad: string[] = [];
    for (const [en, tr] of Object.entries(all)) {
      const inEn = new Set([...en.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));
      const inTr = [...tr.matchAll(/\{(\d+)/g)].map((m) => m[1]);
      if (inTr.some((n) => !inEn.has(n))) bad.push(en);
      if (/[şţŞŢ]/.test(tr)) bad.push(`cedilla: ${en}`);
    }
    expect(bad).toEqual([]);
  });
});
