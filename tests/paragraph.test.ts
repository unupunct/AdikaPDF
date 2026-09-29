import { describe, expect, it } from 'vitest';
import { paragraphAt, type Run } from '@/lib/paragraph';

/** A line of text as one run, 0.5 em per character. */
const line = (str: string, x: number, baseline: number, size = 11): Run => ({ str, origin: [x, baseline], dir: [1, 0], size, width: str.length * size * 0.5 });

describe('paragraph detection for Edit text', () => {
  const page: Run[] = [
    line('Contract de prestări servicii', 60, 80, 20), // title
    line('Între părți s-a convenit ca prestatorul să livreze bunurile în', 60, 130),
    line('termen de treizeci de zile de la semnarea contractului, la adre-', 60, 144),
    line('sa beneficiarului indicată mai jos.', 60, 158), // short last line
    line('Plata se face în termen de cincisprezece zile de la data livrării,', 60, 186),
    line('prin virament bancar în contul beneficiarului.', 60, 200),
    // A second column at the same height must not be merged.
    line('Anexa 1', 450, 130),
    line('Lista bunurilor', 450, 144),
  ];

  it('finds the whole paragraph around the click and rejoins hyphenated words', () => {
    const p = paragraphAt(page, 100, 142)!; // on the second line
    expect(p.lines).toHaveLength(3);
    expect(p.text).toBe('Între părți s-a convenit ca prestatorul să livreze bunurile în termen de treizeci de zile de la semnarea contractului, la adresa beneficiarului indicată mai jos.');
    expect(p.size).toBe(11);
    expect(p.lineHeight).toBeCloseTo(14 / 11, 5);
    expect(p.rects).toHaveLength(3);
    expect(p.x).toBe(60);
    expect(p.align).toBe('left');
  });

  it('stops at the paragraph break and at other columns and sizes', () => {
    const second = paragraphAt(page, 70, 198)!;
    expect(second.lines.map((l) => l.text)).toEqual(['Plata se face în termen de cincisprezece zile de la data livrării,', 'prin virament bancar în contul beneficiarului.']);
    const title = paragraphAt(page, 70, 75)!;
    expect(title.lines).toHaveLength(1);
    expect(title.size).toBe(20);
    const annex = paragraphAt(page, 455, 128)!;
    expect(annex.lines.map((l) => l.text)).toEqual(['Anexa 1', 'Lista bunurilor']);
  });

  it('returns null where there is no text', () => {
    expect(paragraphAt(page, 300, 400)).toBeNull();
  });
});
