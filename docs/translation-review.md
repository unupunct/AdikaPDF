# Translation review (1.14.0)

A consistency and quality pass over the six interface languages (ro, de, fr, hu, it, es).
It was done by checking rules mechanically and reading the flagged strings. It is **not** a
review by native speakers: the doubts below need one.

## What is checked automatically

`tests/translationQuality.test.ts` (runs with `npm test`):

- **Placeholders and plurals**: every `{0}`, `{1}` and `{page}`/`{pages}`/`{file}`/`{date}`/`{bates}`
  kept (English plural suffixes like `file{1}` may be dropped); no extra placeholders; balanced
  braces; plural patterns `{0#…|…}` have the number of forms the language's rule in `lib/i18n.ts`
  uses (Romanian 2–3, Hungarian 1–2, the others 2).
- **English left over**: a translation identical to the English fails unless it is a name, format
  or code, or is in the reviewed list in the test (words that are the same in that language, such
  as German *Version*, French *Signature*, Italian *File*).
- **Form of address**: Romanian, German, French and Hungarian address the user formally
  (dumneavoastră, Sie, vous, Ön); Italian and Spanish informally (tu, tú).
- **Core terms**: document, page, comment, signature, redaction, bookmark, field, form, save,
  export, e-invoice, watermark, password, certificate, timestamp, layer, encryption are
  translated with the same word everywhere:

  | term | ro | de | fr | hu | it | es |
  |---|---|---|---|---|---|---|
  | redaction | anonimizare | Schwärzung | biffure | kitakarás | oscuramento | censura |
  | bookmark | marcaj | Lesezeichen | signet | könyvjelző | segnalibro | marcador |
  | timestamp | marcă temporală | Zeitstempel | horodatage | időbélyeg | marca temporale | marca de tiempo (authority: sellado de tiempo) |
  | signature | semnătură | Signatur (digital) / Unterschrift (handwritten) | signature | aláírás | firma | firma |
  | e-invoice | factură electronică | E-Rechnung | facture électronique | e-számla | fattura elettronica | factura electrónica |

- **Typography**: Romanian ș ț ă (never ş ţ ã); Hungarian ő ű (never õ û ô); French no-break space
  before `:` and inside « », narrow no-break space before `; ? !`; typographic apostrophe ’ in
  French and Italian; `…` stays `…`; menu paths (`Security → Apply & save`) use the language's own
  tab and command names; `ro.extra.ts` never gives a string in `ro.json` another translation.

`node scripts/i18n-typography.mjs` applies the French and Italian typography mechanically (also
to `i18n-pending/*.json`): run it after merging new strings.

## Fixed in this pass

- **es**: 35 strings in the formal *usted* form (cloud and batch signing, hidden information,
  e-invoices, update) now use *tú* like the other 2 600; *añadir* → *agregar* (22 strings; 69 already
  used *agregar*); *sello de tiempo* → *marca de tiempo* (9 strings).
- **it**: 7 strings in the plural *voi* form (batch signing) now use *tu*; "Firma cloud" →
  "Firma nel cloud" (the button's name); 164 straight apostrophes → ’.
- **fr**: *caviardage* → *biffure* in 4 strings (the tool and the other 10 strings say *biffure*);
  422 strings got no-break spaces before `: ; ? !` and inside « »; 63 straight apostrophes → ’.
- **ro**: *redactare* (which means editing/writing) → *anonimizare* in 4 strings ("Apply
  redactions" is now "Aplicare anonimizare"); "Split" no longer reads "Împărțire ecran" (split
  screen) on the Split document button: `ro.extra.ts` overrode the `ro.json` entry.

## Doubts for a native speaker

### Romanian
- "Cut" = *Decupează*, "Paste" = *Lipește* (imperatives, in the shortcut list) while "Copy" =
  *Copiere*; and "Crop" is also *Decupare*. Office uses *Decupare* for Cut and *Trunchiere* for Crop.
- "Split" (*Împărțire*) is one string for three things: splitting a document, the split view
  button, and a scan separator sheet. The same holds in every language.
- *marcaj* is used for bookmarks; *semn de carte* would be the more literal term. Fine?
- Pending ANAF/enterprise strings use the informal *organizația ta* and *marcaj temporal* (see below).

### German
- *Signatur* for digital signatures, *Unterschrift* for handwritten ones (6 strings): intended.
- English kept: *Preflight*, *Barcode*, *Tags*, *Layout*, *Hand* (pan tool), *Portfolio*.
- *Belegebene* for document-level invoice charges/discounts: check with an accountant.
- Long button labels: "Groß-/Kleinschreibung beachten" (Match case), "Tastenkombination
  festlegen" (Set shortcut), "Urheberrechtlich geschützt".

### French
- "Trapped" = *Défonce (Trapped)*: trapping is usually *recouvrement* (or *grossi-maigri*);
  *défonce* is the knockout, a different prepress term.
- *biffure* vs *caviardage*: both are used in French; *biffure* is Acrobat's word and is now used
  throughout. Confirm.
- "Split" = *Fractionner* also labels the split view toggle.
- Narrow no-break space (U+202F) before `; ? !`: Segoe UI shows it; confirm it reads well.

### Hungarian
- One plural form only (`hu` → form 0): fine for nouns after numbers, but check strings where the
  English sentence agrees in number.
- "Confirm in the browser once for every {0} file(s)" = *Erősítse meg a böngészőben egyszer minden
  {0} fájlhoz*: does it say "once per group of N files"?
- "Redo" = *Mégis* (as in Windows); "Open link?" = *Megnyitja a hivatkozást?*.

### Italian
- "Strikeout" = *Barrato* (adjective) where the other tools are verbs (*Evidenzia*, *Sottolinea*).
- English kept: *Batch*, *Home* (ribbon tab, as in Office), *Layout*, *Output intent*, *Token / smart card*.
- *fornitore* and *prestatore di servizi fiduciari* both appear for the trust service provider.

### Spanish
- Regional variant: *archivo*, *ordenador* (1), *agregar*, *vínculo*, *rellenar*. Spain would say
  *añadir* and *enlace*, Latin America *computadora*. Pick one and check.
- *censura/censurar* for redaction (Acrobat ES: *censurar*). OK?
- Pending strings in the *usted* form (see below).

## Strings that may overflow buttons

Translations of short labels (English ≤ 24 characters) longer than 2.2× the English. Most are fine
in menus and dialogs; check those on ribbon buttons and narrow side panels.

- **ro** (24): Squiggly → Subliniere ondulată; Match case → Potrivire litere mari/mici; Sanitize →
  Curățare date ascunse; Batch → Procesare în lot; Preflight → Verificare pre-tipar; Copyrighted →
  Protejat prin drepturi de autor; Commenting → Adăugarea de comentarii; Crop tool → Instrument de decupare.
- **de** (33): Match case → Groß-/Kleinschreibung beachten; Restore aspect → Seitenverhältnis
  wiederherstellen; Merge PDFs → PDF-Dateien zusammenführen; Set shortcut → Tastenkombination
  festlegen; Badge rendering failed → Das Signaturabzeichen konnte nicht gerendert werden; Recent →
  Zuletzt verwendet; Custom → Benutzerdefiniert.
- **fr** (36): Tool defaults → Paramètres par défaut de l’outil; E-books & mail → Livres
  électroniques et e-mails; OCR pages → Pages à traiter par OCR; Rotate view → Faire pivoter
  l’affichage; Move right → Déplacer vers la droite; New e-invoice → Nouvelle facture électronique.
- **hu** (29): Match case → Kis- és nagybetűk megkülönböztetése; OCR pages → OCR-rel feldolgozandó
  oldalak; Batch → Kötegelt feldolgozás; Set shortcut → Billentyűparancs beállítása; Monospace →
  Rögzített szélességű; Commenting → Megjegyzések hozzáadása.
- **it** (39): Checked by default → Selezionata per impostazione predefinita; Screen readers →
  Utilità per la lettura dello schermo; Tool defaults → Impostazioni predefinite strumenti;
  Magnifier → Lente di ingrandimento; Ribbon → Barra multifunzione; Registration → Iscrizione
  registro imprese.
- **es** (28): Tool defaults → Valores predeterminados de las herramientas; E-mail the filled form →
  Enviar por correo electrónico el formulario rellenado; Match case → Coincidir mayúsculas y
  minúsculas; Resizing pages → Cambiando el tamaño de las páginas; Auto-scroll → Desplazamiento automático.

## Pending strings (`i18n-pending/*.json`, other 1.14.0 work)

Checked with the same rules; `tests/translationQuality.test.ts` will flag these once merged:

- **enterprise.json**: ro uses the informal *organizația ta* in 12 strings (→ *organizația
  dumneavoastră*), ro "Default timestamp server" / "Timestamping is turned off…" use *marcaj
  temporal* / *Marcarea temporală* (→ *marcă temporală*); es "Managed by your organisation" =
  *Administrado por su organización* (→ *tu organización*).
- **anaf.json**: es *usted* forms in 10 strings (*Inicie sesión*, *Introduzca*, *Vuelva a
  conectarse*, *registrada por usted*) → *Inicia sesión*, *Introduce*, *Vuelve a conectarte*,
  *registrada por ti*.
- **pdfua.json**: es "Select boxes, then:" = *Seleccione recuadros y luego:* → *Selecciona…*.
- **standards.json**: it *Scegliete PDF/A-2b…* → *Scegli PDF/A-2b…*; es *Elija PDF/A-2b…* → *Elige PDF/A-2b…*.
- French (107) and Italian (78) typography: run `node scripts/i18n-typography.mjs` after merging.
