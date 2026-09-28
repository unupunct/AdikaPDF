import { describe, expect, it } from 'vitest';
import { pickVoice, speechChunks, speechText, type VoiceInfo } from '@/lib/readAloud';

describe('speechText', () => {
  it('joins lines, undoes line-end hyphenation and tidies spaces', () => {
    const items = [
      { str: 'Contractul se încheie ', hasEOL: false },
      { str: 'pentru o perioa-', hasEOL: true },
      { str: 'dă de doi ani.', hasEOL: true },
      { str: '', hasEOL: true },
      { str: 'Semnat:  Ana', hasEOL: false },
    ];
    expect(speechText(items)).toBe('Contractul se încheie pentru o perioadă de doi ani. Semnat: Ana');
  });

  it('keeps real hyphens (next line starts with a capital or a digit)', () => {
    expect(speechText([{ str: 'Cluj-', hasEOL: true }, { str: 'Napoca', hasEOL: false }])).toBe('Cluj-Napoca');
    expect(speechText([{ str: 'pagina 3-', hasEOL: true }, { str: '4', hasEOL: false }])).toBe('pagina 3-4');
  });
});

describe('speechChunks', () => {
  it('splits into sentences and cuts long ones at commas or spaces', () => {
    const long = 'Unu, doi, trei, patru, cinci, șase, șapte, opt, nouă, zece, '.repeat(8) + 'gata.';
    const chunks = speechChunks(`Prima propoziție. A doua? A treia! ${long}`, 120);
    expect(chunks.slice(0, 3)).toEqual(['Prima propoziție.', 'A doua?', 'A treia!']);
    expect(chunks.every((c) => c.length <= 121)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('zece, gata.');
  });

  it('keeps text without final punctuation', () => {
    expect(speechChunks('Titlu fără punct')).toEqual(['Titlu fără punct']);
  });
});

describe('pickVoice', () => {
  const voices: VoiceInfo[] = [
    { uri: 'en', name: 'Microsoft David', lang: 'en-US', local: true },
    { uri: 'ro', name: 'Microsoft Andrei', lang: 'ro-RO', local: true },
    { uri: 'de-online', name: 'Online Katja', lang: 'de-DE', local: false },
  ];
  it('uses the chosen voice, else a Romanian one for Romanian text, else the UI language', () => {
    expect(pickVoice(voices, 'Hello', 'de-online')?.uri).toBe('de-online');
    expect(pickVoice(voices, 'Bună ziua, ce mai faceți?', null, 'en-US')?.uri).toBe('ro');
    expect(pickVoice(voices, 'Hello there', null, 'en-GB')?.uri).toBe('en');
    expect(pickVoice(voices, 'Guten Tag', null, 'fr-FR')?.uri).toBe('en'); // no French voice: first local one
    expect(pickVoice([], 'x', null)).toBeNull();
  });
});
