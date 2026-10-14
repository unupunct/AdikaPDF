/**
 * Quality checks of the six interface languages (beyond tests/i18nLanguages:
 * every key present). Placeholders and plural forms, English left over, the
 * form of address, the same word for the same core term, and typography.
 * Doubts that need a native speaker are listed in docs/translation-review.md.
 */
import { describe, expect, it } from 'vitest';
import ro from '@/locales/ro.json';
import { RO_EXTRA } from '@/locales/ro.extra';
import de from '@/locales/de.json';
import fr from '@/locales/fr.json';
import hu from '@/locales/hu.json';
import it_ from '@/locales/it.json';
import es from '@/locales/es.json';

type Lang = 'ro' | 'de' | 'fr' | 'hu' | 'it' | 'es';
const LANGS: Record<Lang, Record<string, string>> = { ro: { ...(ro as Record<string, string>), ...RO_EXTRA }, de, fr, hu, it: it_, es };
const entries = (l: Lang) => Object.entries(LANGS[l]);

describe('translations: placeholders and plural forms', () => {
  // Plural forms by lib/i18n.ts pluralForm: Romanian 1 / few / "de" (two when the last two agree), Hungarian one.
  const FORMS: Record<Lang, [number, number]> = { ro: [2, 3], de: [2, 2], fr: [2, 2], hu: [1, 2], it: [2, 2], es: [2, 2] };
  const slots = (s: string) => [...s.matchAll(/\{(\d+)(?:#[^}]*)?\}/g)].map((m) => m[1]);
  for (const l of Object.keys(LANGS) as Lang[]) {
    it(`${l}: every placeholder kept, plural patterns well formed`, () => {
      const bad: string[] = [];
      for (const [en, v] of entries(l)) {
        const mine = new Set(slots(v));
        // English plural suffixes ("file{1}") may be dropped.
        for (const n of slots(en)) if (!mine.has(n) && !new RegExp(`([A-Za-z]|\\{\\d\\} )\\{${n}\\}`).test(en)) bad.push(`missing {${n}}: ${en} => ${v}`);
        for (const n of mine) if (!slots(en).includes(n)) bad.push(`extra {${n}}: ${en} => ${v}`);
        for (const t of ['{page}', '{pages}', '{file}', '{date}', '{bates}']) if (en.includes(t) !== v.includes(t)) bad.push(`${t}: ${en} => ${v}`);
        if ((v.match(/\{/g) ?? []).length !== (v.match(/\}/g) ?? []).length) bad.push(`braces: ${v}`);
        for (const m of v.matchAll(/\{(\d+)#([^}]*)\}/g)) {
          const forms = m[2].split('|');
          const [min, max] = FORMS[l];
          if (forms.length < min || forms.length > max || forms.some((f) => !f.trim())) bad.push(`plural forms (${forms.length}): ${en} => ${v}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe('translations: nothing left in English', () => {
  // Names, formats and codes stay as they are.
  const KEEP = /\b(Adika|PDF|Word|Excel|PowerPoint|Markdown|OpenDocument|Office|Windows|Microsoft|Edge|Acrobat|Foxit|Peppol|Factur-X|ZUGFeRD|XRechnung|JavaScript|Noto|Sans|Serif|Mono|UBL|CII|XML|HTML|CSV|JSON|EPUB|XPS|SVG|CAD|DXF|OCR|WIA|ZIP|PAdES|ECDSA|RSA|IBAN|BIC|PIN|URL|e-Factura|CIUS-RO|EN|EU|RON|DPI|Ctrl|Esc)\b/g;
  const codeLike = (en: string) => !/\p{Ll}{3,}/u.test(en.replace(/\{[^}]*\}/g, '').replace(KEEP, '').replace(/\.\w{2,4}\b/g, '').replace(/\S+@\S+/g, ''));
  // Reviewed: the same word in this language, a name, or the term the language uses.
  const REVIEWED: Record<Lang, string[]> = {
    ro: ['{0}-jpg.zip', 'Rich Text', 'Text', 'Document', 'Link', 'Font', 'Română + English', 'Letter', 'Rich Text (.rtf)', 'Export', 'Format', 'Office', 'Standard', 'Ion Popescu Strada Lalelelor 5', 'Prefix', 'Zoom', 'Export CSV', 'Markdown / text', 'EPUB / e-mail / XPS', 'EPUB, e-mail, XPS', 'Adika PDF Editor', 'English', 'Română', 'Deutsch', 'Français', 'Español', 'Italiano', 'Magyar', 'Português', 'Nederlands', 'Polski', 'Dialog', 'Normal', 'Legal', 'Oval', 'Sepia', 'Cyan', 'Magenta', 'Trapped', 'Contract', 'E-mail', 'Contact', 'KGM kilogram', 'SET set', 'PAdES baseline {0}.', 'Factur-X / ZUGFeRD (CII, EN 16931)', '(test)', 'test', 'Callback URL', 'XObjects', 'Contact:'],
    de: ['Position', 'Scanner (WIA)', 'Layout', 'Organisation', 'Updates', 'Version', 'Codes:', 'Suffix', 'Hand', 'Ellipse', 'Polygon', 'Update', 'Poster', 'Minimum', 'Maximum', 'Name', 'Scanner', 'Preflight', 'Status: {0}.', 'Barcode', 'Status…', 'Portfolio', 'Tags', 'Details', 'Logo…', 'EU: Peppol BIS Billing 3.0 (UBL)', 'Region', 'Status', 'Problem'],
    fr: ['Images', 'Position', 'Rotation °', 'Signature', 'Note', 'Description', 'Type', 'Distance', 'Page (1–{0})', 'Pages', 'Compression', 'Orientation', 'Portrait', 'Scanner (WIA)', 'capture', 'Organisation', 'pages', 'Version', 'Page', 'Image', 'Rotation (°)', 'Centre', 'Application', 'Signatures', 'Rectangle', 'Ellipse', 'Pause', 'Style', 'Validation', 'Protection', 'signature', 'page', 'Page {0}', 'Structure', 'Date', 'Minimum', 'Maximum', 'Dates', 'Scanner', 'Source', 'page {0}', 'Portfolio', 'signatures', 'Certification', 'Logo…', 'Images (PNG, JPEG)', 'LTR litre', 'Messages', 'production', 'Figure', 'Annotations', 'Condition'],
    hu: ['Minimum', 'Maximum', 'Peppol UBL XML', 'Factur-X XML (CII)', 'Factur-X PDF', 'EU: Peppol BIS Billing 3.0 (UBL)'],
    it: ['File', 'Password', 'file', 'Scanner (WIA)', 'Layout', 'Area', 'Token / smart card', 'Batch', 'Home', 'Poster', 'Formula', 'Scanner', 'Output intent', 'Portfolio', 'Logo…', 'Romania: e-Factura (CIUS-RO)', 'RON per 1 {0}', 'Client secret'],
    es: ['Cheque', 'Sector'],
  };
  for (const l of Object.keys(LANGS) as Lang[]) {
    it(`${l}: no interface text identical to the English unless reviewed`, () => {
      const reviewed = new Set(REVIEWED[l]);
      const left = entries(l)
        .filter(([en, v]) => v === en && /\p{L}{3,}/u.test(en) && !codeLike(en) && !reviewed.has(en))
        // Kept in English by Romanian too: names and formats.
        .filter(([en]) => l === 'ro' || LANGS.ro[en] !== en)
        .map(([en]) => en);
      expect(left).toEqual([]);
    });
  }
});

describe('translations: one form of address per language', () => {
  // Romanian, German, French and Hungarian address the user formally; Italian and Spanish informally.
  const WRONG: Record<Lang, RegExp> = {
    ro: /(?<!\p{L})(tu|tău|tale|poți|vrei|ești)(?!\p{L})/iu,
    de: /(?<!\p{L})(du|dein|deine|deinen|deinem|deiner|dich|dir|kannst|willst|musst)(?!\p{L})/u,
    fr: /(?<!\p{L})(tu|ton|tes|toi|peux|veux|dois)(?!\p{L})/iu,
    hu: /(?<!\p{L})(kattints|válaszd|nyisd|mentsd|próbáld|szeretnéd|akarod)(?!\p{L})/iu,
    it: /(?<!\p{L})(Lei|vostr[oaie]|Aggiungete|Inserite|Confermate|Chiudete|Riprovate|riprovate|Selezionate|Premete|Scegliete|Salvate il|Aprite)(?!\p{L})/u,
    es: /(?<!\p{L})(usted|ustedes|Introduzca|introduzca|Pulse|Seleccione|Elija|Guarde|guarde|Haga|Inicie|Confirme|Añada|Vuelva|vuelva|Cierre|Indique|indique|Suba|Quite|Marque|desea|Firme muchos|Firme con)(?!\p{L})/u,
  };
  for (const l of Object.keys(LANGS) as Lang[]) {
    it(`${l}: no strings in the other form`, () => {
      const odd = entries(l)
        .filter(([, v]) => WRONG[l].test(v))
        .map(([en, v]) => `${v.match(WRONG[l])![0]}: ${en} => ${v}`);
      expect(odd).toEqual([]);
    });
  }
});

describe('translations: core terms', () => {
  // [English term, English uses that mean something else, the word each language uses]
  const GLOSSARY: Array<[string, RegExp, RegExp | null, Record<Lang, RegExp>]> = [
    ['document', /\bdocuments?\b/i, /document (charge|discount)|document feeder/i, { ro: /document/i, de: /dokument/i, fr: /document/i, hu: /dokumentum/i, it: /document/i, es: /document/i }],
    ['page', /\bpages?\b/i, /web pages?|contents page|multi-page|cover page|page headers and footers|^page$|\{pages?\}/i, { ro: /pagin/i, de: /seite/i, fr: /page/i, hu: /oldal/i, it: /pagin/i, es: /p[áa]gin/i }],
    ['comment', /\bcomments?\b/i, /comment on|FOR COMMENT|signing and comments/i, { ro: /comentari/i, de: /kommentar/i, fr: /commentaire/i, hu: /megjegyzés/i, it: /comment/i, es: /comentario/i }],
    ['signature', /\bsignatures?\b/i, /Cloud Signature Consortium|for signatures \(key usage\)/i, { ro: /semnătur/i, de: /signatur|unterschrift/i, fr: /signature/i, hu: /aláírás/i, it: /firm/i, es: /firma/i }],
    ['redaction', /\bredact(ion|ions|ed)?\b/i, null, { ro: /anonimiz/i, de: /schwärz/i, fr: /biff/i, hu: /kitakar/i, it: /oscur/i, es: /censur/i }],
    ['bookmark', /\bbookmarks?\b/i, null, { ro: /marcaj/i, de: /lesezeichen/i, fr: /signet/i, hu: /könyvjelző/i, it: /segnalibr/i, es: /marcador/i }],
    ['field', /\bfields?\b/i, null, { ro: /câmp/i, de: /feld|felder/i, fr: /champ/i, hu: /mező/i, it: /camp/i, es: /campo/i }],
    ['form', /\bforms?\b/i, /of the form\b/i, { ro: /formular/i, de: /formular/i, fr: /formulaire/i, hu: /űrlap/i, it: /modul/i, es: /formulario/i }],
    ['save', /\bsav(e|ed|ing)\b/i, /save a copy|alone are saved|saved without|saved next to its original/i, { ro: /salv/i, de: /speicher/i, fr: /enregistr/i, hu: /ment/i, it: /salva|salvi/i, es: /gu[aá]rd/i }],
    ['export', /\bexport(s|ed|ing)?\b/i, /G export|An export \(G\)/, { ro: /export/i, de: /export/i, fr: /export/i, hu: /export/i, it: /esport/i, es: /export/i }],
    ['e-invoice', /\be-invoices?\b/i, null, { ro: /factur/i, de: /rechnung/i, fr: /facture/i, hu: /száml/i, it: /fattur/i, es: /factura/i }],
    ['watermark', /\bwatermarks?\b/i, null, { ro: /filigran/i, de: /wasserzeichen/i, fr: /filigrane/i, hu: /vízjel/i, it: /filigran/i, es: /marca de agua/i }],
    ['password', /\bpasswords?\b/i, null, { ro: /parol/i, de: /kennw[oö]rt/i, fr: /mots? de passe/i, hu: /jelsz/i, it: /password/i, es: /contraseña/i }],
    ['certificate', /\bcertificates?\b/i, /^Sign with a|Sign many PDFs|Open with your certificate|EU qualified certificate|Windows certificate/i, { ro: /certificat/i, de: /zertifikat/i, fr: /certificat/i, hu: /tanúsítvány/i, it: /certificat/i, es: /certificado/i }],
    ['timestamp', /\btimestamps?\b/i, null, { ro: /m[aă]rc(ă|a|ii|aj) temporal|marcare temporală/i, de: /zeitstempel/i, fr: /horodat/i, hu: /időbélyeg/i, it: /marca temporale|marche temporali|marcatura temporale/i, es: /marcas? de tiempo|sellado de tiempo/i }],
    ['layer', /\blayers?\b/i, /text layer/i, { ro: /strat/i, de: /ebene/i, fr: /calque/i, hu: /réteg/i, it: /livell/i, es: /capa/i }],
    ['encryption', /\bencrypt(ed|ion|s)?\b/i, null, { ro: /cript/i, de: /verschlüssel/i, fr: /chiffr/i, hu: /titkosít/i, it: /crittograf|cifrat/i, es: /cifr/i }],
  ];
  for (const [term, re, skip, words] of GLOSSARY) {
    it(`“${term}” is translated with the same word`, () => {
      const odd: string[] = [];
      for (const l of Object.keys(LANGS) as Lang[])
        for (const [en, v] of entries(l)) if (re.test(en) && !(skip && skip.test(en)) && !words[l].test(v)) odd.push(`[${l}] ${en} => ${v}`);
      expect(odd).toEqual([]);
    });
  }
});

describe('translations: one entry per string', () => {
  it('ro.extra.ts does not give a string already in ro.json another translation', () => {
    const json = ro as Record<string, string>;
    expect(Object.keys(RO_EXTRA).filter((k) => k in json && json[k] !== RO_EXTRA[k]).map((k) => `${k}: ${json[k]} / ${RO_EXTRA[k]}`)).toEqual([]);
  });
});

describe('translations: typography', () => {
  it('Romanian uses ș and ț with a comma below and ă (not ş, ţ, ã)', () => {
    expect(entries('ro').filter(([, v]) => /[şţŞŢãÃ]/.test(v)).map(([, v]) => v)).toEqual([]);
  });
  it('Hungarian uses ő and ű (not õ, û, ô)', () => {
    expect(entries('hu').filter(([, v]) => /[õûôÕÛÔ]/.test(v)).map(([, v]) => v)).toEqual([]);
  });
  it('French: no-break space before : and inside « », narrow no-break space before ; ? !', () => {
    const bad = entries('fr')
      .map(([, v]) => v)
      .filter((v) => / [:;?!](\s|$)|\p{L}[:;?!](\s|$)|« | »/u.test(v) || /[\u00a0][;?!]|\u202f:/.test(v));
    expect(bad).toEqual([]);
  });
  it('French and Italian use the typographic apostrophe', () => {
    const bad = [...entries('fr'), ...entries('it')].map(([, v]) => v).filter((v) => /\p{L}'\p{L}/u.test(v));
    expect(bad).toEqual([]);
  });
  it('the ellipsis character stays an ellipsis', () => {
    const bad: string[] = [];
    for (const l of Object.keys(LANGS) as Lang[]) for (const [en, v] of entries(l)) if (en.endsWith('…') && !v.endsWith('…')) bad.push(`[${l}] ${en} => ${v}`);
    expect(bad).toEqual([]);
  });
  it('menu paths (Tab → Command) use the language’s own tab and command names', () => {
    const bad: string[] = [];
    for (const l of Object.keys(LANGS) as Lang[]) {
      const d = LANGS[l];
      for (const [en, v] of entries(l))
        for (const m of en.matchAll(/\b(Home|View|Edit|Comment|Sign|Organize|Forms|Security|Convert)((?: → [A-Z][^→.,;:)”"]*?)+)(?=$|[.,;:)”"])/g))
          for (const part of [m[1], ...m[2].split(' → ').slice(1)].map((p) => p.trim())) {
            const want = d[part];
            if (want && !v.toLowerCase().includes(want.toLowerCase().replace(/…$/, ''))) bad.push(`[${l}] ${part} = ${want}: ${v}`);
          }
    }
    expect(bad).toEqual([]);
  });
});
