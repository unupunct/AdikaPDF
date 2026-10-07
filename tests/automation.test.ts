import { describe, expect, it } from 'vitest';
import { absolutePath, combineSteps, parseCli, wildcard } from '@/lib/cli';
import { emptyIndex, fold, indexPlan, parseQuery, searchIndex, type SearchIndex } from '@/lib/searchIndex';

describe('command line', () => {
  it('parses steps in order, options and files', () => {
    const j = parseCli(['--batch', '--ocr', 'ron+eng', '--compress', 'strong', '--watermark', 'CIORNĂ', '--page-numbers', '--grayscale', '--out', 'rezultate', 'a.pdf', 'scans\\*.pdf']);
    expect(j.errors).toEqual([]);
    expect(j.steps).toEqual([
      { kind: 'ocr', lang: 'ron+eng' },
      { kind: 'compress', level: 'strong' },
      { kind: 'watermark', text: 'CIORNĂ' },
      { kind: 'pageNumbers', format: '{page} / {pages}' },
      { kind: 'grayscale' },
    ]);
    expect(j.out).toBe('rezultate');
    expect(j.files).toEqual(['a.pdf', 'scans\\*.pdf']);
    expect(parseCli(['--batch', '--sequence', 'Arhivă', 'x.pdf'])).toMatchObject({ sequence: 'Arhivă', errors: [] });
  });

  it('reports mistakes and help', () => {
    expect(parseCli(['--batch', 'a.pdf']).errors).toEqual(['No steps given (for example --ocr or --sequence "Name").']);
    expect(parseCli(['--batch', '--ocr']).errors).toEqual(['No files given.']);
    expect(parseCli(['--batch', '--bogus', '--flatten', 'a.pdf']).errors).toEqual(['Unknown option --bogus.']);
    expect(parseCli(['--batch', '--compress', 'huge', 'a.pdf']).errors[0]).toMatch(/Unknown compression level/);
    expect(parseCli(['--batch', '--protect']).errors[0]).toMatch(/needs a password/);
    expect(parseCli(['--batch', '--help']).help).toBe(true);
  });

  it('never takes a file for an optional value', () => {
    const j = parseCli(['--batch', '--ocr', 'scan.pdf', '--compress', 'b.pdf', '--page-numbers', 'C:\\docs\\c.pdf']);
    expect(j.errors).toEqual([]);
    expect(j.steps).toEqual([
      { kind: 'ocr', lang: 'ron+eng' },
      { kind: 'compress', level: 'balanced' },
      { kind: 'pageNumbers', format: '{page} / {pages}' },
    ]);
    expect(j.files).toEqual(['scan.pdf', 'b.pdf', 'C:\\docs\\c.pdf']);
    const k = parseCli(['--batch', '--ocr=deu+chi_sim', '--compress=Strong', '--page-numbers=Page {page}', '--watermark=DRAFT', '--out=D:\\out', 'a.pdf']);
    expect(k.errors).toEqual([]);
    expect(k.steps).toEqual([
      { kind: 'ocr', lang: 'deu+chi_sim' },
      { kind: 'compress', level: 'strong' },
      { kind: 'pageNumbers', format: 'Page {page}' },
      { kind: 'watermark', text: 'DRAFT' },
    ]);
    expect(k.out).toBe('D:\\out');
    expect(parseCli(['--batch', '--page-numbers', '{page}', 'a.pdf']).steps).toEqual([{ kind: 'pageNumbers', format: '{page}' }]);
    expect(parseCli(['--batch', '--compress=huge', 'a.pdf']).errors[0]).toMatch(/Unknown compression level/);
  });

  it('refuses a saved sequence that cannot take more steps after it', () => {
    const seq = [{ kind: 'flatten' as const }, { kind: 'protect' as const, userPassword: 'secret' }];
    expect(combineSteps(seq, [{ kind: 'compress', level: 'strong' }]).error).toMatch(/must be the last step/);
    // Saved sequences keep no password: that step is dropped.
    expect(combineSteps([{ kind: 'flatten' }, { kind: 'protect', userPassword: '' }], [{ kind: 'grayscale' }])).toEqual({ steps: [{ kind: 'flatten' }, { kind: 'grayscale' }], error: null });
    expect(combineSteps([{ kind: 'pdfa' }], [{ kind: 'protect', userPassword: 'x' }]).error).toMatch(/forbids encryption/);
  });

  it('matches wildcards and resolves relative paths', () => {
    expect(wildcard('*.pdf').test('Raport 2026.PDF')).toBe(true);
    expect(wildcard('scan-??.pdf').test('scan-07.pdf')).toBe(true);
    expect(wildcard('scan-??.pdf').test('scan-7.pdf')).toBe(false);
    expect(wildcard('a+b(1).pdf').test('a+b(1).pdf')).toBe(true);
    expect(absolutePath('docs/a.pdf', 'C:\\Users\\ana')).toBe('C:\\Users\\ana\\docs\\a.pdf');
    expect(absolutePath('.\\a.pdf', 'D:\\')).toBe('D:\\a.pdf');
    expect(absolutePath('E:\\x.pdf', 'C:\\')).toBe('E:\\x.pdf');
    expect(absolutePath('\\\\server\\share\\x.pdf', 'C:\\')).toBe('\\\\server\\share\\x.pdf');
  });
});

describe('folder search', () => {
  const index: SearchIndex = {
    ...emptyIndex(),
    folders: ['D:\\Acte'],
    files: {
      'D:\\Acte\\contract închiriere.pdf': { path: 'D:\\Acte\\contract închiriere.pdf', size: 1, modified: 1, pages: ['Contract de închiriere nr. 12', 'Chiria lunară este de 2.500 lei, plătită până pe data de 5.', 'Semnături: proprietar și chiriaș.'] },
      'D:\\Acte\\factură.pdf': { path: 'D:\\Acte\\factură.pdf', size: 1, modified: 1, pages: ['FACTURĂ fiscală — total de plată 2.500 lei'] },
      'D:\\Acte\\scan.pdf': { path: 'D:\\Acte\\scan.pdf', size: 1, modified: 1, pages: [''] },
    },
  };

  it('ignores case and diacritics; all words must appear', () => {
    expect(fold('ÎNCHIRIERE Șțăâ')).toBe('inchiriere staa');
    expect(parseQuery('chiria "2.500 lei" plătită')).toEqual({ words: ['chiria', 'platita'], phrases: ['2.500 lei'] });
    const r = searchIndex(index, 'CHIRIA platita');
    expect(r.map((x) => x.name)).toEqual(['contract închiriere.pdf']);
    expect(r[0].hits.map((h) => h.page)).toEqual([2, 3]); // “chiriaș” on page 3 starts with the word too
    expect(r[0].hits[0].snippet[1]).toBe('Chiria');
  });

  it('finds phrases across files, ranks by matches, and snippets keep the original text', () => {
    const r = searchIndex(index, '"2.500 lei"');
    expect(r.map((x) => x.name).sort()).toEqual(['contract închiriere.pdf', 'factură.pdf']);
    const f = r.find((x) => x.name === 'factură.pdf')!;
    expect(f.hits[0].snippet.join('')).toContain('FACTURĂ fiscală');
    expect(searchIndex(index, 'factura')[0].name).toBe('factură.pdf');
    expect(searchIndex(index, 'nimic de gasit')).toEqual([]);
    expect(searchIndex(index, '   ')).toEqual([]);
  });

  it('re-reads only new and changed files, drops removed ones', () => {
    const plan = indexPlan(index, [
      { path: 'D:\\Acte\\contract închiriere.pdf', size: 1, modified: 1 },
      { path: 'D:\\Acte\\factură.pdf', size: 2, modified: 1 },
      { path: 'D:\\Acte\\nou.pdf', size: 5, modified: 9 },
    ]);
    expect(plan.toRead.sort()).toEqual(['D:\\Acte\\factură.pdf', 'D:\\Acte\\nou.pdf']);
    expect(plan.toDrop).toEqual(['D:\\Acte\\scan.pdf']);
  });
});
