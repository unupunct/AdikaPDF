import { describe, expect, it } from 'vitest';
import ro from '@/locales/ro.json';
import { RO_EXTRA } from '@/locales/ro.extra';
import de from '@/locales/de.json';
import fr from '@/locales/fr.json';
import hu from '@/locales/hu.json';
import it_ from '@/locales/it.json';
import es from '@/locales/es.json';
import { applyLang, setDictionary, translate } from '@/lib/i18n';

const romanian = { ...(ro as Record<string, string>), ...RO_EXTRA };
const DICTS: Record<string, Record<string, string>> = { de, fr, hu, it: it_, es };
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\d+)(?:#[^}]*)?\}/g)].map((m) => m[1]))];

describe('interface languages', () => {
  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang}: every interface string is translated, placeholders intact`, () => {
      const missing = Object.keys(romanian).filter((k) => typeof dict[k] !== 'string' || !dict[k].trim());
      // New strings need a translation in every language (the Romanian one lists them).
      expect(missing.slice(0, 20)).toEqual([]);
      const bad: string[] = [];
      for (const [en, v] of Object.entries(dict)) {
        const got = new Set(placeholders(v));
        for (const n of placeholders(en)) if (!got.has(n) && !new RegExp(`([A-Za-z]|\\{\\d\\} )\\{${n}\\}`).test(en)) bad.push(`${en} => ${v}`);
        for (const n of got) if (!placeholders(en).includes(n)) bad.push(`${en} => ${v}`);
        for (const t of ['{page}', '{pages}', '{file}']) if (en.includes(t) && !v.includes(t)) bad.push(`${en} => ${v}`);
      }
      expect(bad.slice(0, 10)).toEqual([]);
    });
  }

  it('uses each language’s plural rule', async () => {
    const check = async (lang: 'de' | 'fr' | 'hu' | 'ro', to: string, cases: Array<[string, string]>) => {
      await applyLang(lang);
      setDictionary({ '{0} file{1} saved.': to });
      for (const [en, want] of cases) expect(translate(en)).toBe(want);
    };
    await check('de', '{0#Eine Datei|# Dateien} gespeichert.', [
      ['1 file saved.', 'Eine Datei gespeichert.'],
      ['0 files saved.', '0 Dateien gespeichert.'],
      ['3 files saved.', '3 Dateien gespeichert.'],
    ]);
    await check('fr', '{0## fichier enregistré|# fichiers enregistrés}.', [
      ['0 files saved.', '0 fichier enregistré.'],
      ['1 file saved.', '1 fichier enregistré.'],
      ['2 files saved.', '2 fichiers enregistrés.'],
    ]);
    await check('hu', '{0} fájl mentve.', [['5 files saved.', '5 fájl mentve.']]);
    await check('ro', '{0#Un fișier salvat|# fișiere salvate|# de fișiere salvate}.', [
      ['1 file saved.', 'Un fișier salvat.'],
      ['5 files saved.', '5 fișiere salvate.'],
      ['25 files saved.', '25 de fișiere salvate.'],
    ]);
    await applyLang('en');
  });

  it('translates real interface strings in every language', async () => {
    for (const lang of ['de', 'fr', 'hu', 'it', 'es'] as const) {
      await applyLang(lang);
      expect(translate('Save')).not.toBe('Save');
      expect(translate('Page 2 of 5')).toMatch(/2.*5/);
    }
    await applyLang('en');
    expect(translate('Save')).toBe('Save');
  });
});
