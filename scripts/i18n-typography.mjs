/**
 * Mechanical typography of the translations, as tests/translationQuality.test.ts expects:
 * French no-break space before ":" and inside « », narrow no-break space before ; ? !,
 * typographic apostrophe in French and Italian. Rewrites src/locales/{fr,it}.json and the
 * fr/it entries of i18n-pending/*.json (run it after merging new strings).
 *
 *   node scripts/i18n-typography.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apostrophe = (v) => v.replace(/(\p{L})'(?=[\p{L}{])/gu, '$1’');
const FIX = {
  fr: (v) =>
    apostrophe(v)
      .replace(/(\p{L}|[)”»}…]) ?:(?=\s|$)/gu, '$1\u00a0:')
      .replace(/(\p{L}|[)”»}…]) ?([;?!])(?=\s|$|[»”)])/gu, '$1\u202f$2')
      .replace(/«[ \u00a0]?/g, '«\u00a0')
      .replace(/[ \u00a0]?»/g, '\u00a0»'),
  it: apostrophe,
};

let changed = 0;
for (const lang of Object.keys(FIX)) {
  const path = join('src', 'locales', `${lang}.json`);
  const dict = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of Object.keys(dict)) {
    const v = FIX[lang](dict[k]);
    if (v !== dict[k]) (dict[k] = v), changed++;
  }
  writeFileSync(path, JSON.stringify(dict, null, 1) + '\n');
}
if (existsSync('i18n-pending'))
  for (const f of readdirSync('i18n-pending').filter((x) => x.endsWith('.json'))) {
    const path = join('i18n-pending', f);
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    let n = 0;
    for (const tr of Object.values(data))
      for (const lang of Object.keys(FIX))
        if (typeof tr?.[lang] === 'string') {
          const v = FIX[lang](tr[lang]);
          if (v !== tr[lang]) (tr[lang] = v), n++;
        }
    // Pending files keep their one-entry-per-line layout.
    if (n) writeFileSync(path, '{\n' + Object.entries(data).map(([k, v]) => `  ${JSON.stringify(k)}: { ${Object.entries(v).map(([l, t]) => `${JSON.stringify(l)}: ${JSON.stringify(t)}`).join(', ')} }`).join(',\n') + '\n}\n');
    changed += n;
  }
console.log(`${changed} translation(s) adjusted.`);
