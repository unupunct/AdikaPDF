# ANAF tax declarations ("PDF inteligent") in Adika: feasibility study

Date: 22 October 2026. Base: Adika 1.15.0 (branch `claude/round-16`). Prototype code: `src/lib/pdf/xfaScript/`, tests `tests/xfaScript.test.ts`, manual runner `tests/manual/anafForms.run.ts`.

## Rezumat (română)

**Ce sunt.** Declarațiile ANAF (D100, D112, D205, D300, D390, D394 etc.) se completează în formulare „PDF inteligent”. Toate cele șase descărcate de pe static.anaf.ro sunt **formulare XFA dinamice** (paginile există doar în șablonul XFA), cu drepturi de utilizare Adobe Reader (semnătură UR3 „ARE Production V8.1”) și cu **100–600 de scripturi JavaScript** fiecare (aproape deloc FormCalc). Butonul „Validare” rulează scripturile ANAF: verifică datele, **construiește XML-ul declarației în JavaScript** și îl **atașează la PDF** (`event.target.createDataObject("D300.xml", xml)`), apoi deblochează câmpul de semnătură. Se depune PDF-ul semnat cu certificat calificat pe e-guvernare.ro.

**Ce face Adika azi.** Deschide toate formularele (pdf.js le așază: 2–14 pagini, 44–572 de câmpuri, 1–4 s), permite completarea și salvează valorile înapoi în formularul XFA (actualizare incrementală, doar pachetul `datasets`). **Nu rulează scripturile formularului**: fără calcule, fără validare, fără XML, fără atașare; rândurile repetabile (adăugare creanțe, salariați) nu se pot adăuga; câmpurile nelegate de date (`bind none`, des întâlnite în D112/D205) se pierd la salvare. Semnarea rescrie fișierul (formularul rămâne XFA, dar semnătura UR3 Adobe devine invalidă).

**Prototipul.** Un model minim de obiecte XFA (≈1.150 de linii) rulează **scripturile originale ANAF** în sandbox-ul QuickJS pe care Adika îl folosește deja. Pe șase formulare, toate scripturile au putut fi executate, cu 0–4 erori distincte per formular, iar cele rămase sunt în mare parte defecte ale formularelor înseși (funcții inexistente). Pentru **D100 și D300** fluxul complet (completare → Validare) a produs **XML-ul declarației generat de codul ANAF**; **D300.xml trece de schema XSD oficială v12**. D100.xml diferă de XSD-ul publicat (2022) prin trei atribute noi pe care schema publicată nu le are încă.

**Recomandare.** Nu un motor XFA complet (opțiunea A), ci un **hibrid**: Adika păstrează formularul așezat ca acum, iar la „Validare” rulează **în fundal scripturile oficiale ANAF** peste valorile completate, afișează mesajele lor, atașează XML-ul rezultat și semnează incremental (PAdES, certificat calificat din Windows, token sau cloud). Efort estimat: **11–20 săptămâni-om** pentru D100/D300/D390/D394/D205/D112, în trei etape; prima etapă (D100, D300, D390, fără rânduri repetabile) în **5–8 săptămâni-om**. **Neverificat:** dacă e-guvernare.ro/SPV acceptă un PDF semnat de Adika (nu am depus nimic). De aceea etapa 0 este o verificare de acceptare cu o declarație reală.

## Summary (English)

- All six current ANAF forms analysed (D100, D112, D205, D300, D390, D394) are **dynamic XFA**, Reader-extended (UR3), with **100–600 JavaScript scripts** each (200 k–700 k characters), 0–24 tiny FormCalc scripts, and the whole declaration logic in script objects: `Validare` checks the data, **builds the declaration XML as a string** and **attaches it** to the PDF as an embedded file, then unlocks an XFA signature field (`<signature type="PDF1.6">`).
- Adika today opens, lays out, fills and saves these forms, but runs none of their scripts: no calculations, no validation, no XML, no rows can be added. That is the gap that matters.
- A ≈1,150-line prototype XFA object model runs the **unmodified ANAF scripts** in the QuickJS sandbox Adika already ships. With every event fired once, 0–4 distinct scripts per form fail, most of them because of bugs in the forms themselves. Scripted user flows for **D100 and D300 produced the declaration XML from ANAF's own code**; D300.xml **validates against ANAF's XSD v12**.
- Recommendation: **hybrid option** (ANAF's scripts headless + Adika UI + incremental attach/sign), 11–20 person-weeks in phases, preceded by an acceptance check on the real portal, which this study could not do.

## 1. What the forms are and how they are filed

ANAF publishes, for each declaration and each legal version, a "soft A" (the PDF form, for Adobe Reader) and a "soft J" (Java validator + PDF generator for XML produced by accounting software; "softul J se adresează doar contribuabililor care își generează fișierul xml din aplicațiile informatice proprii"). The PDF form workflow is:

1. Fill the form in Adobe Reader (scripts calculate totals, check CUI/CNP/IBAN check digits, look up nomenclatures, add rows).
2. Click **Validare** (D300: "VALIDEAZA FORMULARUL"). The scripts check everything. Errors go into an attached `Erori.txt` / `Erori si avertizari.txt`. If there are none, `D300.xml` (or `D100.xml`, `D394.xml`…) is attached and the form is locked.
3. Sign the unlocked signature field with a qualified certificate (Adobe creates a PDF signature).
4. Upload the PDF at www.e-guvernare.ro → "Depunere declarații" (certificate login), which returns an upload index; status and receipt come later (ANAF guide `Ghid-v2.pdf`).

The "soft J" route shows that ANAF's server does not need the XFA form itself. `D300Validator_*.zip` ships `D300Validator.jar` and `D300Pdf.jar` (iText 5 + BouncyCastle, classes `d300/PdfCreator`, `Pdf_v0..v8`), meaning: validate the XML, then build a PDF for it. The DUKIntegrator shell that combines them (validate → create PDF → optionally sign) was not downloaded or run here. Its signing step is widely described but **not verified in this study**.

## 2. Forms analysed

Downloaded on 22 Oct 2026 from `https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/` (official site, reachable), kept in `D:\MyAIProjects\AdikaPDF\.tools\anaf-forms\` (git-ignored, not committed):

| Form | File | Size | XFA | Pages (pdf.js) | Template | Fields | Subforms | Repeating sections | Buttons |
|---|---|---|---|---|---|---|---|---|---|
| D100 (impozite, D710) | `D100_710_XML_0126_191026.pdf` | 166 KB | dynamic | 2 | 2.6 MB | 119 | 11 | 3 (unbounded) | 27 |
| D112 (salarii) | `D112_XML_2026_0726_070926.pdf` | 319 KB | dynamic | 14 | 1.6 MB | 685 | 57 | 9 (up to 9999) | 74 |
| D205 | `D205_XML_2025_120226.pdf` | 142 KB | dynamic | 2 | 2.5 MB | 101 | 21 | 3 | 17 |
| D300 (decont TVA) | `D300_v12.0.2_12022026.pdf` | 176 KB | dynamic | 7 | 2.8 MB | 296 | 112 | 77 occur rules, rows fixed | 9 |
| D390 (VIES) | `D390_XML_2020_300424.pdf` | 126 KB | dynamic | 3 | 2.5 MB | 60 | 25 | 3 | 15 |
| D394 | `D394_26092025.pdf` | 250 KB | dynamic | 13 | 3.4 MB | 607 | 253 | 31 | 30 |

Also downloaded: `structura_D300_v12.0.0_10022026.pdf` (XML layout), `d300_v12_11022026.xml` (the D300 v12 XSD), `d100_24022022.xsd`, `Ghid-v2.pdf`, and `D300Validator_11022026_2.zip`, which was only listed and its class names read, never run. D406 (SAF-T) is XML-only and out of scope.

Common structure (all six):
- `/NeedsRendering true`, no AcroForm fields at all (`/Fields` empty), page 1 says "Please wait…". The pages exist only in the XFA template.
- Packets: `config`, `template`, `localeSet`, `datasets` (121 B – 11 KB), `xmpmeta`, `xfdf`, and a `form` packet in 4 of 6 (saved form state).
- `/Perms /UR3`: Adobe Reader Extensions signature "ARE Production V8.1 G3 P24", `/Form [/FillIn /Import …]`, `/Document [/FullSave]`, `/Annots [...]`. `/SigFlags 2`.
- Template size is mostly embedded pictures (logo BMPs). The scripts are 0.1–0.7 MB.
- Releases are frequent. D112 had 4 versions in 2024, 2 in 2025 and 2 so far in 2026, plus "soft A updated" re-releases. D300 had 3 versions in 2025. Each version must be downloaded anew, and the old one is still used for older periods.

## 3. The scripts

Counts from the template (non-empty scripts, script objects included):

| Form | Scripts | JavaScript | FormCalc | JS chars | Script objects | Main events |
|---|---|---|---|---|---|---|
| D100 | 158 | 158 | 0 | 203 k | 13 | exit 45, click 43, enter 24, calculate 17, change 6, initialize 4, validate 3 |
| D112 | 600 | 599 | 1 | 704 k | 32 | exit 268, calculate 137, click 93, change 46, initialize 11, preOpen 2, docReady, preSave |
| D205 | 112 | 104 | 8 | 121 k | 14 | click 39, exit 20, enter 12, calculate 15, docReady 2 |
| D300 | 197 | 173 | 24 | 136 k | 7 | exit 60, change 27, ready 20, enter 18, initialize 16, calculate 39, mouseUp 6, validate 6 |
| D390 | 100 | 99 | 1 | 112 k | 39 | exit 22, click 18, change 16, calculate 9, initialize 8, ready 3 |
| D394 | 342 | 342 | 0 | 481 k | 27 | calculate 204, exit 64, click 32, change 10, initialize 9 |

API use (occurrences in the scripts):

| | D100 | D112 | D205 | D300 | D390 | D394 |
|---|---|---|---|---|---|---|
| `app.alert` | 84 | 101 | 45 | 76 | 59 | 188 |
| `xfa.host.messageBox` | 30 | 135 | 19 | 51 | 14 | 27 |
| `xfa.host.setFocus` | 33 | 55 | 26 | 54 | 2 | 5 |
| `xfa.host.resetData` | 5 | 6 | 0 | 2 | 0 | 0 |
| `app.execDialog` (Acrobat dialogs) | 1 | 5 | 2 | 0 | 0 | 1 |
| instance managers (`_x.addInstance`, `instanceManager`) | 18 | 253 | 11 | 6 | 9 | 76 |
| `resolveNode(s)` | 0 | 190 | 15 | 5 | 19 | 29 |
| `xfa.form.recalculate` | 11 | 20 | 11 | 0 | 6 | 22 |
| `createDataObject` (attach) | 3 | 3 | 3 | 4 | 2 | 8 |
| `importDataObject` (file dialog) | 0 | 0 | 2 | 2 | 1 | 2 |
| `.presence =` / reads | 84 | 157 | 25 | 16 | 8 | 114 |
| `xfa.layout.*` | 3 | 1 | 4 | 2 | 5 | 6 |

No `submit` actions to the network, no SOAP or `Net.HTTP`, and no `xfa.signature.sign`. `xfa.host.gotoURL` is used only for "report a problem" (D300). FormCalc is marginal: D300's 24 scripts are one-line sums (`$ = r12_1.c2 + r12_2.c2`), D390/D112 one `sum(x[*].y[*])` each, D205's eight are commented out or mislabelled JavaScript.

How **Validare** builds and attaches the XML (D300 script object `genValid`, abridged):

```js
xml += "</declaratie300>";
var file = event.target;                     // the Acrobat Doc, not an XFA node
file.removeDataObject("D300.xml");
encFile = encodeURI(xml);
event.target.createDataObject("D300.xml", encFile);
var oFile = event.target.getDataObjectContents("D300.xml");
var cFile = util.stringFromStream(oFile, "utf-8");
oFile = util.streamFromString(decodeURI(cFile));
event.target.setDataObjectContents("D300.xml", oFile);
```

D100's button (abridged):

```js
var sir = validari.valid1();
if (sir == "") {
  var vb = generareXML.fnXML();                 // builds "<declaratie100 luna=… an=…>"
  form1.sub2.SignatureField1.presence = "visible";
  monitor1.blochez();                           // lock the form
} else {
  form1.sub2.SignatureField1.access = "readOnly";
  file.createDataObject("Erori.txt", sir);
}
```

The XML is assembled by string concatenation from `rawValue`s (`" luna=\"" + v1 + "\""`), with an `EL()` / `schEnt()` helper that escapes entities. The signature field is an XFA field `<field name="sgn"><ui><signature type="PDF1.6"><manifest action="all"/></signature></ui>`, kept `readOnly` until validation succeeds. Signing it in Acrobat creates an ordinary PDF signature over the whole file. Lists such as obligation types (D100 "Alege creanța fiscală") use `app.execDialog` with a list box, not XFA fields. File imports (D394 `import2`, D390 `import1`: CSV/TXT) and the D300 "attach ZIP" use `importDataObject`, which opens Acrobat's file dialog.

**Usage rights.** UR3 only enables Reader features (filling, saving, attachments, signing in the free Reader). It is not a filing requirement. Acrobat itself appends incremental updates when the user fills and signs, and nothing in the forms or the guide says ANAF checks UR3. If a tool rewrites the file, Reader later warns that extended features are no longer available. That is a nuisance for users who reopen the file in Reader, but there is no evidence it affects filing (not verified).

**What ANAF checks on upload** (from the workflow and the soft-J design; **not verified by an upload**): a PDF signed with a qualified certificate whose holder is enrolled for the taxpayer, and an embedded XML named after the declaration that passes ANAF's validator. The soft-J route (a plain PDF with the XML attached, no XFA) indicates the XFA form is not what the server reads. Whether the server also checks the attachment name, the PDF producer, the `universalCode` field or the signature format (adbe.pkcs7.detached vs ETSI.CAdES.detached / PAdES) is unknown.

## 4. Adika today (measured)

Node (pdf.js 6.3 as bundled, `tests/manual/anafForms.run.ts`) and the release exe (1.15.0, E2E harness):

| Form | pdf.js layout (Node) | Inputs laid out | Opens in Adika (exe) | Fields on page 1 | Value written back to `datasets` |
|---|---|---|---|---|---|
| D100 | 1.4 s | 91 | 3.6 s, 2 pages | 72 | yes |
| D112 | 2.1–2.7 s | 572 | 15.7 s, 14 pages | 38 | **no** (field `bind="none"`) |
| D205 | 0.9 s | 83 | 2.6 s, 2 pages | 34 | **no** (`bind="none"`) |
| D300 | 1.5 s | 284 | 3.9 s, 7 pages | 34 | yes |
| D390 | 0.8 s | 44 | 2.2 s, 3 pages | 23 | yes |
| D394 | 2.3–3.5 s | 556 | 6.2 s, 13 pages | 49 | yes |

What works:
- Every form opens and is laid out by pdf.js' XFA engine (the D300 first page looks right: header, "VALIDEAZA FORMULARUL" button, fields, captions), as an AcroForm PDF built by `xfaMeasure.ts` / `xfaPdf.ts`. The info toast says it stays an XFA form.
- Filling and saving: `fillXfaData` → pdf.js `saveDocument` appends an incremental update that replaces only the `datasets` stream (original bytes kept, so the UR3 signature still covers the original revision, as when Reader saves). XFA, `/NeedsRendering` and `/Perms` stay.

What does not:
1. **No form scripts run** (CLAUDE.md: "XFA's own scripts don't run"). There are no totals, no check-digit messages, no nomenclature lookups and no defaults. Validare does nothing, so no XML is made and none is attached.
2. **Repeating sections are frozen** at their initial count. You cannot add a second D100 obligation, a D112 employee or a D394 partner.
3. **Values of unbound fields (`bind="none"`) are not saved.** pdf.js writes only `datasets`, and Acrobat keeps such values in the `form` packet. D112 (77 unbound) and D205 (22) rely on them.
4. `access="protected"` fields can be typed into in the converted form (the E2E run wrote into D300's `universalCode`).
5. **Signing**: `signPdf` on a file without signature fields does a full pdf-lib rewrite. In the experiment (attach `D300.xml` incrementally, then PAdES-sign with a test certificate), XFA, the attachment and `/Perms` survive and Adika's signature verifies (whole file). But the original bytes are no longer a prefix, so the UR3 signature no longer verifies. Signing a converted form through the UI saves the regular AcroForm PDF, not the XFA form.
6. No ANAF XML can be produced or attached from the UI (the existing "XFA data" export is the `datasets` XML, not the declaration XML).

## 5. Prototype: ANAF's own scripts in a minimal XFA object model

`src/lib/pdf/xfaScript/`:
- `model.ts`: template → script-visible JSON (containers, occur rules, typed defaults, items, presence/access, null tests, tooltips, `<variables>` texts and script objects, every script with its event).
- `runtime.js` (plain ES2020, about 850 lines): nodes as Proxies (`rawValue` typed by numericEdit/decimal/integer, `editValue`, `formattedValue`, `isNull`, `presence`, `access`, `mandatory`, `validate.nullTest`, `ui.oneOfChild.className`, `assist.toolTip`, auto-created property bags for `border`, `font`, `fillColor`…). It also has implicit name resolution the XFA way (`with` over a Proxy scope: own children, then up the ancestors, unnamed subforms and areas transparent, `_name` instance managers, script objects and `<variables>` by name, members of `this`), a SOM subset in `resolveNode(s)` (`a.b[2].c`, `[*]`, `$`, `$form`, `xfa.form`, `..x`, `#class`, `parent`), and instance managers (`count/min/max/addInstance/insertInstance/removeInstance/setInstances/moveInstance`, initialize events on new instances). Host objects include `xfa.host` (messageBox with Yes/No answers, setFocus, resetData…), `xfa.form.recalculate/execValidate`, `xfa.layout` stubs, `app` (alert, viewerVersion, execDialog with scripted list picks, thermometer…), `util` (printd, printf, stream helpers), and the Acrobat Doc as `event.target` with data objects (`createDataObject`, `getDataObjectContents`, `setDataObjectContents`, `removeDataObject`, `dataObjects`). Events cover initialize → calculate → validate → ready/docReady, then user steps (`enter`, `change`, `exit`, `mouseDown/Up`, `click`) with recalculation after each step. A FormCalc subset covers sums, `+ - * /` and SOM references.
- `engines.ts`: **pdf.js' QuickJS sandbox** (the one `formSandbox.ts` uses for AcroForm JavaScript; the runtime goes in as a document Open action and reports through `app.alert`) or `node:vm`. The results are identical in both.
- `tests/xfaScript.test.ts`: a synthetic declaration form (script objects, repeating rows added by a button, JS and FormCalc calculations, a `<variables>` global, Validare that attaches `D999.xml` or `Erori.txt`), run in node:vm **and QuickJS**.

Results on the real forms (QuickJS; "all events" fires every script once, every button included, with empty data):

| Form | Distinct scripts run | Failed | Cause of the failures | Time |
|---|---|---|---|---|
| D100 | 158 | 0 | – | 0.5 s |
| D112 | 717 instances (after row adds) | 4 | 3 × a button calling `Verificare.VerifAsig`, which does not exist in the form (dead code); 1 × `null.length` on an empty date | 2.2 s |
| D205 | 104 | 0 | – | 0.3 s |
| D300 | 173 | 1 | `btnTab` is referenced but not defined in the form | 0.7 s |
| D390 | 100 | 0 | – | 0.2 s |
| D394 | 353 | 2 | removing below `min` (Acrobat refuses too); one sort button on an undefined subform | 0.8 s |

Functional flows (typed values, then Validare):
- **D100**: period 09/2026, CUI, name, address, obligation picked from the Acrobat dialog ("(103)"), amounts, declarant, then `B_VALID` → ANAF's message "Validarea s-a terminat cu succes !" and an attached `D100.xml` with the computed `cod_bugetar`, `scadenta 25.10.2026`, `nr_evid 10103010926251026000039`, `totalPlata_A 2000`. Against the published XSD (`d100_24022022.xsd`, still the one listed for the 01/2026 version) three attributes the current form writes (`d_modif`, `mail`, `bifa_impozit_minim`) are not in that schema. Otherwise it is valid. In other words, the published XSD lags and the form's script and the Java validator are the reference.
- **D300**: year, L / 9, identification, bank/IBAN, pro-rata, CAEN, row 1 = 1000, declarant, then `btnValid` (mouseUp, then click). The first attempts showed ANAF's own messages ("Cod CAEN este element obligatoriu", "116 campuri obligatorii") until the runtime modelled `validate.nullTest`. Then came "Formularul este valid. A fost atasat fisierul D300.xml." The XML (`nr_evid`, `totalPlata_A`, `R17_1` computed by the form) **validates against ANAF's XSD v12** (`d300_v12_11022026.xml`).

What it took: the six forms ran after about six rounds of small additions (`<variables>` texts, `variables` by SOM, members of `this` without `this.`, transparent areas, `editValue`, `nodes.remove`, the `validate`/`ui`/`assist` properties, mouseDown/mouseUp before click, execDialog). None needed a change to ANAF's code. "Runs without error" is not the same as "behaves like Acrobat", though. Only D100 and D300 were checked end to end, and layout-dependent behaviour (presence changes, new rows) is not shown on the page.

## 6. Gaps to a usable feature

1. **Script runtime in the app**: hardening (data binding/`$record`, `formattedValue` with pictures, dates `dateTimeEdit` formats, `xfa.host.currentPage`, `messageBox` answers from a real dialog, `execDialog` rendered from its description, `importDataObject` through Adika's file picker, time limits via the existing worker watchdog).
2. **Two-way link with Adika's converted form**: values typed on the page go into the runtime, and the runtime's `rawValue`, `presence`, `access` and `fillColor` changes come back to the page fields, using the same field names (`form1[0].Antet[0]…`).
3. **Layout changes**: added rows and visibility changes need a new layout. pdf.js can lay out again from the template plus `datasets` with N records (data-driven instances), but bound/unbound field values must be carried over and only bound repeating subforms grow this way. Alternatively, repeating sections can be edited in a side-panel grid generated from the model.
4. **Saving the XFA original**: datasets plus the values of unbound fields (form packet or data), attachments created by the scripts (`EmbeddedFiles`), and **incremental signing** (a new signature field, PAdES or adbe.pkcs7.detached, original bytes kept so UR3 stays valid).
5. **Regression corpus**: ANAF republishes forms several times a year. A monthly job downloads the current versions and replays scripted flows (like `steps.json` here) through the runtime and the XSDs.

## 7. Options

| | What | Effort (person-weeks) | Main risks |
|---|---|---|---|
| **A** | Full XFA engine: runtime + live re-layout (presence, instances, pagination) so the form behaves as in Acrobat on the page | **18–30**, then 0.5–1 pw/month | Acrobat parity is open-ended (XFA 3.3 spec ~1,500 pages). pdf.js layout cannot be updated in place, so every change means a re-layout (2–15 s for D112) or a fork of pdf.js' XFA layout. High regression risk with each ANAF release. |
| **B** | ANAF-specific: Adika's own UI and schema per declaration, own XML writer and rules (from "structura" PDFs, XSDs, "Anexa validări"), then package and sign | **3–5 common + 2–10 per declaration** (D300 ≈3, D100 ≈2, D390 ≈2, D394 ≈5, D112 ≈8–10, D205 ≈3) → 25–40 for six | Rules duplicated by hand and re-done for every ANAF version (D112 changes 2–4×/year). Divergence from ANAF's validator means rejected filings. Legal exposure when Adika's rules are wrong. |
| **B′ (hybrid, recommended)** | Keep Adika's converted form. Run **ANAF's own scripts headless** for calculations, validation and XML. Show their messages. Attach the XML. Sign incrementally. | **11–20** (below) | Unknown Acrobat behaviours in future form versions, mitigated by the corpus job. Layout-dependent features need step 3. Acceptance not yet verified. |
| **C** | Partial: Adika fills; the XML comes from the official Java tool (soft J / DUKIntegrator) or accounting software; Adika only packages (XML attached) and signs (Windows store, PKCS#11, cloud CSC, batch) | **2–4** | Needs Java and ANAF's tools on the user's machine (cannot be bundled without checking ANAF's terms). Adds little for users who already use DUKIntegrator, except cloud and batch signing. Acceptance of an Adika-signed PDF not verified. |
| **D** | Do nothing; keep "open and fill", point users to Adobe Reader | 0 | Adika stays unusable for the most common Romanian business PDF task. |

B′ breakdown:
- Runtime to production: 3–5.
- Page ⇄ runtime link and Validate UI (messages, error list, dialogs, file import): 3–5.
- Repeating sections (re-layout from datasets or side-panel grid): 3–6.
- XFA-original save with attachments, unbound values and incremental PAdES signing that keeps UR3: 1–2.
- Corpus and regression job: 1–2.

## 8. Recommendation and phased plan

**B′, in phases, gated by an acceptance check.**

0. **Acceptance check (≈1 pw, needs a real taxpayer)**: for a declaration that is due anyway, produce the PDF two ways (Acrobat; Adika prototype path: same XML attached + Adika's PAdES signature with the user's qualified certificate) and file **only one real declaration** per the user's normal obligations. Confirm the index and receipt. Also confirm with ANAF support (asistpublic) which signature format and attachment names are required. Stop here if Adika-signed PDFs are refused.
1. **Phase 1 (5–8 pw)**: D100, D300, D390 (few or no repeating rows). A Validate button runs ANAF's scripts in the worker sandbox, shows messages and errors on the fields, attaches the XML to the XFA original, and offers incremental signing with existing identities (Windows store, PKCS#11, CSC cloud). Ship behind an "experimental" label.
2. **Phase 2 (4–8 pw)**: repeating sections and Acrobat dialogs → D394, D205, D112 (D112 last: 685 fields, 9 repeating sections, employee annexes).
3. **Phase 3 (2–4 pw, then ~2 days/month)**: monthly corpus job over the current ANAF forms with scripted flows and XSD checks. Optionally add an "XML from accounting software → package and sign" path (option C) for users of soft J.

Not recommended: a general XFA engine (A). ANAF's forms use a narrow, stable subset of the object model (rawValue, presence/access, instance managers, script objects, data objects, messageBox/alert), and Adika does not need Acrobat-level layout to file a declaration.

## 9. Not verified

- Acceptance by e-guvernare.ro / SPV of any Adika-produced PDF (none uploaded). Which signature subfilter, attachment name, PDF producer or form identifier the server checks.
- Whether a full rewrite (UR3 invalid) or a non-XFA PDF with the XML attached is accepted. The soft-J route suggests a non-XFA PDF is, but DUKIntegrator was not run.
- Behaviour in Acrobat of a form saved by Adika (Reader extended features after Adika's incremental update; values of unbound fields).
- That the XML produced in the prototype is byte-identical to Acrobat's (same code path, but not compared with an Acrobat-produced file). ANAF's Java validators were not run.
- Forms other than the six. SAF-T (D406).

## 10. Reproducing

```
# forms (not in the repo) in D:\MyAIProjects\AdikaPDF\.tools\anaf-forms
ANAF_ENGINE=quickjs ANAF_ALL=1 npx vitest run --config tests/manual/vitest.config.ts tests/manual/anafForms.run.ts
ANAF_ENGINE=quickjs ANAF_STEPS=steps.json npx vitest run --config tests/manual/vitest.config.ts tests/manual/anafForms.run.ts   # scripted flows; XML written next to the forms
ANAF_PACKAGE=D300_v12.0.2_12022026.pdf ANAF_XML=<D300.xml> npx vitest run --config tests/manual/vitest.config.ts tests/manual/anafForms.run.ts
npx vitest run tests/xfaScript.test.ts   # synthetic form, node:vm + QuickJS
```

`steps.json` is keyed by form: `{"D300": [["fill", "form1.Antet.metaDate.an_r", "2026"], …, ["click", "form1.btnDoc.btnValid"]], "D100": [… ["pick", "\\(103\\)"], ["click", "form1.subB.B_Oblig"] …]}`. The flows used here: D100 (period, CUI 18547290, name, address, phone, e-mail, pick "(103)", SUMA01I/SUMA03I 1000, declarant, B_VALID); D300 (an_r 2026, tipDecont L, luna 9, den, cif, judet 12, loc, bank, IBAN RO49AAAA1B31007593840000, proRata 100, caen 6201, r1.c2 1000, declarant, btnValid). All data is invented.
