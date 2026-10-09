<p align="center"><img src="public/brand/adika-logo.svg" alt="Adika PDF Editor" width="420"></p>

**Adika PDF Editor** is a privacy-first Windows PDF editor: edit, sign, organise, protect,
OCR and convert PDFs entirely on your computer. Nothing is uploaded. The interface is in
**English, Română, Deutsch, Français, Magyar, Italiano or Español** (menu in the top bar; it follows the Windows language on first start).

## Features

| Area | What you can do |
| --- | --- |
| Read | Tabs for several documents, continuous / single-page / two-page (facing, cover) layouts, rotate view, night mode, full screen (F11), presentation mode (F5), clickable links and bookmarks (outline), page labels, Back/Forward history, text selection and copy, attachments and layers (optional content) panels, search with case / whole-word options and a results list, document properties, printing, recent files, auto-reload when the file changes on disk, repair of damaged files; **Read aloud** with the Windows voices (page, to the end or the selection; pause, voice, speed; Ctrl+Shift+V/B/C/E), **Snapshot** (copy an area as a picture), **Magnifier** (2×–4× lens), **Auto-scroll** (Ctrl+Shift+H; ↑/↓ speed, − reverse, Esc stop); a document tab can be dragged out into a **window of its own** |
| View | Zoom (Ctrl+wheel, fit width/page), thumbnails, diacritic-insensitive search; **Split view** (Ctrl+\\): another part of the document or another open tab side by side; **tool search** (Ctrl+K) finds any command in English or Romanian; **Reading view**: the text reflowed like an e-book, with text size, line width, font and light / sepia / dark themes; **Search folders**: the text of every PDF in chosen folders (subfolders too), from an index kept on this computer; diacritics ignored, a hit opens the file at its page |
| Comment | Foxit-style Comment tab: Hand, Select, Select text, sticky **Notes**, **Typewriter**, Highlight / Underline / Strikeout / Squiggly on selected text, drawing tools, comments list, author name. Saved as standard PDF annotations that Acrobat and other readers show and edit; **Stamps** (Approved, Draft, Confidential…, dynamic with name and date, or a picture), **Text box**, **Callout**, **Cloud**, **Polygon**, **Polyline**, **Attach file**, **Measure** distance / perimeter / area with a drawing scale (e.g. 1 cm = 2 m), saved as PDF measurements Acrobat and Foxit read; import/export comments as **XFDF / FDF**, **comment summary** PDF, **compare** two versions; **Compare visually**: both versions overlaid pixel by pixel (new ink blue, removed ink red, changed areas boxed); **review status** of comments (Accepted, Rejected, Completed, Cancelled), shown and filterable; **merge reviewers' copies** of a document; **Check spelling** (F7) of comments, text boxes and filled form fields with the Windows spell checker (any installed language, your own dictionary); compare with a **list of changes (redline)**; comments already in a file (from Acrobat, Foxit, Word…) can be **edited, moved and deleted**, keeping their author and replies; **rich text in text boxes**: bold, italic, underline, strikethrough, colour and size for parts of a typewriter / text box comment, and comments from other apps keep their formatting when edited (/RC rich text); **rotate stamps** (also stamps already in the file), saved as a turned appearance that every viewer shows |
| Tools | One-click hub (ribbon and start screen): PDF to Word, PDF to JPG, Word to PDF, JPG to PDF, Merge PDF, PDF to PPT, Compress PDF, PPT to PDF, PDF to Excel, Excel to PDF |
| Print | Print dialog with page ranges, **several pages per sheet** (2–16), **booklet** (fold and staple) and **poster** (enlarged over several sheets, with cut marks); also saved as PDF |
| Print to PDF | A **"Adika PDF Editor" virtual printer**: print from a browser or any program and the pages open in Adika as a PDF (saved in `%LOCALAPPDATA%\Adika PDF Editor\Printed`) |
| Edit | **Paragraph editing**: Edit text opens the whole paragraph as one box that rewraps while typing; **Edit image**: move, resize, rotate, replace or delete pictures already in the PDF; **Find & replace** (Ctrl+H) across the document: the old letters are deleted from the page, the new text uses the document's own font when it has the letters and the rest of the line moves to make room; a letter the document's subset font lacks (ș, ț, €, a capital never used) is taken from the same font installed in Windows (e.g. Arial for an Arial subset), else from a look-alike open font (Liberation Sans, Noto Serif…) at the same size and baseline, only for that letter, and Adika says which letters it drew that way; click-to-edit existing text (the original run is removed, not covered), text boxes (Noto fonts, full Unicode incl. ă â î ș ț), images with crop, rectangles, ellipses, lines, arrows, freehand ink, highlights, snapping guides, undo/redo; **links** to web pages or pages; **watermark** (text or picture), **header & footer** with page numbers, date and file name, **Bates numbering**, **background**, all removable; **Edit drawing**: lines, boxes and shapes already in the PDF can be moved, resized, recoloured or deleted; restyled text (colour, size) keeps the **document's own font**; **pen pressure** (Windows Ink) for ink |
| Sign | Draw / type / upload signatures and initials; digital signatures (PAdES-style `adbe.pkcs7.detached`, SHA-256) with a `.pfx/.p12` ID, a self-signed ID, or a **USB token / smart card over PKCS#11**; optional RFC 3161 timestamp; **several signatures** on one document (each added as an incremental update, so earlier ones stay valid); **certify** a document (no changes / forms and signing / also comments); **long-term validation** (certificate chains and OCSP/CRL answers saved in the file); **EU format (PAdES baseline, eIDAS)**: levels B-B, B-T (timestamp), B-LT (validation data, also for the timestamp authority) and B-LTA (archive document timestamp); sign with **certificates installed in Windows** (qualified certificates from card drivers, imported .pfx; Windows asks for the PIN); **remote / cloud qualified signatures** via the Cloud Signature Consortium API: any provider offering it, sign in through your browser (PIN / one-time code or confirmation at the provider); **sign many files at once** (files or a folder with subfolders; .pfx, Windows certificate, token or cloud signature with the PIN / authorization asked once — a token stays logged in for the batch, a cloud provider authorizes many signatures at a time; invisible, at a fixed page and corner, or in an empty signature field; saved with a suffix, into a folder or replacing the originals; result list as CSV; also `--batch --sign` on the command line); **signature appearance designer** (Design appearance… in the signing dialogs and in Sign many files): named profiles with layout (graphic left / on top, text only, graphic only), a handwritten signature, logo or your name in a script font, which details show (name, date format, reason, location, contact, issuer, a custom line with {name} {date} {cn} {o} …), font, size (fits the box), colours, border and a faded logo, with a live preview at the real size; the text is real, selectable text in an embedded font, sharp at any zoom |
| Verify | Integrity, whole-file coverage, certificate chain against the Windows trust store, OCSP/CRL revocation; recognises the changes allowed after signing (validation data, signatures, form filling, comments) and the certification level, and flags anything else, including tampering tricks that hide changes in later updates; certificate purposes, timestamp tokens and OCSP/CRL answers are themselves verified, and weak algorithms (SHA-1, short keys) are flagged; uses saved validation data offline; shows the **PAdES level**; **EU Trusted Lists** (downloaded from the European Commission, kept offline) recognise qualified certificate authorities and timestamp authorities; the lists' own XML signatures are verified (the EU list of lists against the LOTL-signing certificates published in the Official Journal, OJ C/2026/1944, also through the Commission's pivot lists when those certificates change; each national list against the certificates the EU list names for it), lists that fail are not used, and saved lists are checked again whenever they are loaded, and **qualified electronic signatures** (QcStatements); document timestamps verified; the checks can be saved as a **validation report** (PDF) |
| Organize | Drag-and-drop page grid, rotate, delete, duplicate, insert blank, merge, split, extract, **crop pages**, **edit bookmarks** (add, rename, move, nest); **Replace pages** from another PDF (comments and bookmarks kept); **bookmarks from headings**; **links from web and e-mail addresses**; split at **top-level bookmarks** (named parts), by **file size**, or at **blank pages and separator sheets**; **page size**: pages to A4, Letter… (content scaled to fit, or the page grown around it); **contents page** from the bookmarks, with links; **PDF Portfolios** (one PDF carrying files of any kind); **layers**: rename, delete with their content, merge, flatten; objects can be saved in a layer |
| Forms | **Smart fields**: number, currency, percent and date formats, minimum / maximum, totals and formulas (Qty * Price), saved as standard Acrobat form actions and calculated live while filling; **Detect fields**: turns a flat or scanned form into a fillable one (fill-in lines, empty boxes, checkboxes, named after their labels); create text, checkbox, radio, dropdown and signature fields; fill existing forms; CSV export (single or batch); **Mail merge**: fill the form once per row of a CSV or Excel table, one PDF per row (file names from the columns) or one combined PDF; **buttons** (e-mail the filled form, clear, print, open a web page, show / hide fields, go to a page) and **barcode fields** (QR or Code 128 made from the field values); existing fields are **filled on the page**; the form's own **JavaScript** (calculations, checks, formats, messages) runs in a sandbox; **XFA forms**: static ones keep their XFA data, dynamic ones (government and bank forms that show "Please wait…") are laid out and filled, and saving keeps them XFA forms; XFA data as XML |
| Security | True redaction: the covered letters are deleted and the rest of the page stays text (pages with images or drawings under a box are rebuilt as an image); anything you added under a box, alternate text, tags, thumbnails and form data of the covered area go too, and pages that were replaced leave nothing behind; **Find & redact** e-mails, phone numbers, IBANs, CNPs, card numbers, dates or chosen words — in the page text and also in comments and replies, form field values (names and tooltips on request), bookmarks, metadata (Info and XMP), attachment names, link addresses and alternate text, each hit listed with its place (comments removed or blacked out, field values cleared, bookmarks blacked out or removed; the file is rewritten so no old copy stays); AES-256 password protection with permissions, metadata sanitising; **Remove hidden information**: finds metadata, scripts, attachments, comments, form values, hidden layers and text, bookmarks, tags, thumbnails, private application data, links and earlier versions, with a preview, and removes what you choose; **Accessibility** checker and fixer (PDF/UA-style): tags paragraphs, headings, pictures, links and fields in reading order, sets title and language, picture descriptions with previews, decorative pictures as artifacts; **encrypt for certificates**: only the chosen people open the document, each with their own card, token or digital ID — no shared password; the **Tags** panel edits the tag tree (type, alternate text, reading order); full **PDF/UA-1 check** after the Matterhorn Protocol (failures by checkpoint and condition, page and tag, click to see them on the page; untagged content found in the page content; checks a person must make listed with guidance), opt-in fixes and **Fix all safe issues** (metadata, language, role mapping, link / field / comment tags, list structure, untagged content as artifacts or paragraphs…), report as PDF, HTML or text; **Reading order** shows numbered boxes over each page: drag to reorder, set P / H1–H6 / Figure / Table / List / Artifact, draw a rectangle to tag untagged content |
| Convert to PDF | Word / Excel / PowerPoint (via installed Microsoft Office, LibreOffice fallback), images (PNG/JPG/WebP/TIFF/GIF/BMP, **HEIC/HEIF** iPhone photos), HTML files and web pages, Markdown, text, **EPUB** e-books, **e-mails** (.eml, Outlook .msg, .mht — attachments kept inside the PDF), **XPS / OpenXPS** (vector), **DXF** CAD drawings (vector, CAD layers as PDF layers), WIA scanner, camera; **Scan to PDF**: flatbed or document feeder (both sides), colour / grey / black and white, resolution and paper size set in Adika; pages straightened, turned upright, cleaned of specks and dark edges; blank pages removed; **separator sheets** (with a barcode that names the next document) split a batch into several PDFs; black-and-white pages stored with fax (Group 4) compression; photos and multi-page TIFFs as pages; **e-invoices**: Romanian **e-Factura** (ANAF XML or ZIP), UBL / Peppol and CII open as a readable invoice PDF with the XML attached and the sums checked |
| Convert from PDF | Word (.docx, flowing or exact layout: fonts, colours, tables, columns, images and headers/footers kept), **OpenDocument (.odt)**, **RTF**, Excel (table columns detected), **CSV**, PowerPoint, PNG/JPEG/TIFF, SVG, HTML5, **EPUB**, Markdown, text, **JSON** (text with positions, outline, metadata, form data); **Export pictures**: every image into a ZIP, JPEGs exactly as stored; scanned pages are recognised first and **tables in scans** become real tables (Word, Excel); **Factur-X / ZUGFeRD** e-invoices made from a PDF and its XML, and the invoice inside such a PDF shown and saved |
| Create e-invoices | **New e-invoice** (Convert tab, start screen): Romanian **e-Factura** (CIUS-RO UBL for ANAF's SPV), **Peppol BIS Billing 3.0** UBL and **Factur-X / ZUGFeRD** (CII EN 16931); invoices, credit notes (also from an opened invoice), corrected and self-billed invoices; EN 16931 sums (line discounts, document discounts and charges, VAT per category and rate with exemption reasons, advance payments, rounding, VAT in RON for other currencies); live checks of the EN 16931, CIUS-RO (CUI / CNP, counties, Bucharest sectors, lengths) and Peppol rules; saved seller profiles with logo, bank accounts and numbering, customers and a product catalogue; saved as XML, as a PDF/A-3 with the XML attached, or as a Factur-X PDF; **ANAF e-Factura** (optional, online only when you press a button): fill a seller or buyer from ANAF's public VAT register by CUI (name, address, county, VAT and e-Factura register status, inactive / deregistered warnings), check the XML with ANAF's public validation service next to Adika's own checks, and send invoices to ANAF's SPV, follow their status, list sent and received invoices and error reports and open or save them (needs your own application registered with ANAF) |
| Optimise | Offline OCR in 10 bundled languages (Română, English, Deutsch, Français, Español, Italiano, Magyar, Português, Nederlands, Polski) and about 90 more **downloadable on demand** from the OCR dialog (only when you click Download; each file checked against a pinned SHA-256; blocked by the DisableOnlineFeatures policy; also used by Batch and --ocr=<lang>) with a searchable Unicode text layer, compression, **PDF/A-1b, 2b and 3b** (3b can embed the source files; fonts the file only names are embedded, CMYK colours converted to RGB or kept under a CMYK output intent, PDF/A-1 transparency flattened; validated with veraPDF in CI), flatten; **Batch**: OCR, compress, watermark, PDF/A, password, sanitise or flatten many files at once (results saved next to the originals); OCR can also make scans **editable**: the text becomes real text in a similar font, size and ink colour over the painted-out scan; **batch action sequences** (saved chains of OCR, compress, watermark, page numbers, PDF/A, protect, sanitize, flatten) |
| Print production | **Preflight** against PDF/X-4, PDF/X-1a:2003 or PDF/A-2b and **conversion to PDF/X** (trim boxes, output intent with an embedded CMYK profile, metadata; for X-1a CMYK colours and flattened transparency); colours to **grey or CMYK**; **output preview** of the separations and total ink; **bleed and printer marks** (crop, registration, colour bars, page information) |
| Automation | **Command line** (`adika-pdf-editor.exe --batch --ocr --compress --out results *.pdf`, or a saved `--sequence`), exit codes for scripts; **watched folders**: PDFs copied into a folder are processed with a saved sequence while Adika runs; **Explorer menu**: Combine in Adika, Compress, Make searchable (OCR), Convert to PDF; **PDF thumbnails** in Explorer; **Send by e-mail** from your mail program; your own **Quick Access toolbar** and **keyboard shortcuts** |
| Document properties | Title, authors, subject, keywords, **copyright** status, notice and URL, **custom properties**; written into the XMP metadata in step with the document information |
| Updates | Optional update check (About → Check for updates, or once a week): asks GitHub for the latest version, nothing else is sent; **one-click updates**: shows what is new, downloads the installer with progress, checks its signature against Adika's update key and installs it (asks first when documents are unsaved and keeps recovery copies); nothing is contacted unless you check or turned the weekly check on; **automatic backup** of every unsaved document every few seconds and recovery after a crash; asks before closing with unsaved changes; **signed documents are saved as an incremental update** (signatures stay valid when you add comments or fill in fields; a setting does this for all documents); warns when the file changed on disk or a save would break signatures; long operations can be **cancelled** |

## Install

Download `AdikaPDF_x.y.z_x64-setup.exe` from Releases and run it. It adds Start-menu
and desktop shortcuts and an "Open with" entry for PDF files. Requires Windows 10/11 (WebView2,
installed automatically if missing).

Installing for all users (per machine) also adds the **Adika PDF Editor** printer. It uses
Windows' own "Microsoft Print To PDF" driver, so no extra driver is installed. The Windows Print
Spooler service is needed; if it is stopped, the installer starts it and sets it to start
automatically. To re-create the printer later, run `printer.ps1 -EnableSpooler` from the install
folder as administrator.

**Logs.** Diagnostic logs and crash reports are written for each user to
`%LOCALAPPDATA%\Adika PDF Editor\logs`. Open the folder from the About dialog (*Open logs
folder*). Attach `crash-*.log` files when reporting a problem.

Office files are converted with macros turned off; password-protected Office files are refused
rather than asking for a password in the background.

### Portable version

`AdikaPDF_x.y.z_x64-portable.zip` (Releases) runs without installing, e.g. from a USB stick: unpack
it and start `adika-pdf-editor.exe`. The `portable.ini` file next to the exe switches Adika to
portable mode: settings (the WebView2 profile), recovery backups, logs and caches go to a `Data`
folder next to the exe, and nothing is written to the registry. Not included: the virtual printer,
Explorer menu entries and thumbnails, the `.pdf` association. The Microsoft Edge WebView2 Runtime
must be present (it is part of Windows 10 and 11; Adika shows a message with the download link
when it is missing). *Check for updates* in About offers the new portable ZIP (unpack it over the
folder; `Data` stays); a portable copy never runs the installer. If an installed Adika is already
running, starting the portable one opens its files in the running window (one instance per user).
Temporary files (conversions, e-mail attachments) still use `%TEMP%`.

## Deploying in a company

### Unattended install

The setup is an NSIS installer. Switches (combine as needed; `/D=` must come last):

| Switch | Effect |
| --- | --- |
| `/S` | Silent: no windows, no questions |
| `/P` | Passive: progress bar only (used by the in-app updater) |
| `/ALLUSERS` / `/CURRENTUSER` | Per-machine (Program Files, needs an elevated prompt) or per-user (`%LOCALAPPDATA%`) install. Without either, a silent install reuses the previous mode, else installs per machine when elevated |
| `/NOPRINTER` | No virtual printer, no Print Spooler changes, no print helper at log-on |
| `/NOSHELL` | No Explorer menu entries (Combine / Compress / OCR / Convert) and no PDF thumbnail handler |
| `/NOUPDATES` | Turns the update check off (same effect as the `DisableUpdateCheck` policy) |
| `/LANG=ro` | Default interface language (`en`, `ro`, `de`, `fr`, `hu`, `it`, `es`); users can still change it |
| `/FORCECLOSE` | Silent only: end Adika if it does not close by itself (see below) |
| `/NS` | No desktop shortcut |
| `/R` | Start Adika after a silent / passive install |
| `/D=C:\Path` | Install folder |

```bat
AdikaPDF_1.14.0_x64-setup.exe /S /ALLUSERS /NOUPDATES /LANG=ro
"C:\Program Files\Adika PDF Editor\uninstall.exe" /S
```

`/NOPRINTER`, `/NOSHELL`, `/NOUPDATES` and `/LANG=` are remembered in
`HKLM\Software\unupunct\Adika PDF Editor` (`HKCU\…` for a per-user install) as `NoPrinter`,
`NoShell`, `DisableUpdateCheck`, `DefaultLanguage`, so later updates keep them; `/NOPRINTER=0`
(likewise the others) turns an option back on and removes what it skipped before. A Group Policy
value always wins over these defaults. The `.pdf` "Open with" association is registered in every case.

**Running copies.** An interactive setup asks Adika to close (users are offered to save) and shows
*Retry / Cancel* if it stays open. A silent setup never shows anything: it asks every Adika window
to close and waits 8 seconds. Windows without unsaved work close; if one stays open (unsaved work
waiting for the user, or another user's session), the setup **stops without changing anything**
and exits with code 2 (a message is printed when started from a console), so a deployment tool can
retry later. With `/FORCECLOSE` the remaining copies are ended instead; unsaved documents are
offered again from the automatic recovery backup at the next start. The same applies to a silent
uninstall. A silent uninstall keeps the users' data (`%LOCALAPPDATA%\Adika PDF Editor`).

### Group Policy

Adika reads `HKLM\SOFTWARE\Policies\Adika PDF Editor` and `HKCU\SOFTWARE\Policies\Adika PDF Editor`
at start-up; a machine value wins over a user value. Policies in effect are listed read-only in
About under *Managed by your organisation*.

| Value | Type | Effect |
| --- | --- | --- |
| `DisableUpdateCheck` | DWORD 1 | No update check, no downloads or installs of updates |
| `DisableOnlineFeatures` | DWORD 1 | No network use at all: update check, OCSP / CRL checks, trusted timestamps, LTV data, EU Trusted List download, cloud signing, ANAF connection, converting a web page by address (also refused by the native side) |
| `DisableCloudSigning` | DWORD 1 | No remote (CSC) signing |
| `DefaultLanguage` | String `en`/`ro`/`de`/`fr`/`hu`/`it`/`es` | Interface language until the user picks one |
| `DefaultTimestampServer` | String (http/https URL) | Timestamp authority offered for signatures and used for archive timestamps |
| `AllowedSigningCertificateIssuers` | String, `;`-separated (or multi-string) | Sign only with certificates whose issuer name contains one of the texts |
| `SaveIncremental` | DWORD 1 / 0 | Forces *Save as incremental update* on or off (signed documents are always saved incrementally) |

Adika has no telemetry, so there is nothing to turn off: nothing is sent unless a user starts an
online feature.

ADMX templates are in `deploy/policies` (`AdikaPDFEditor.admx`, `en-US` and `ro-RO` ADML). For the
domain Central Store copy `AdikaPDFEditor.admx` to
`\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\` and each language folder's
`AdikaPDFEditor.adml` to the matching subfolder (`en-US\`, `ro-RO\`); create `PolicyDefinitions`
from `C:\Windows\PolicyDefinitions` first if the domain has none. For a single computer use
`C:\Windows\PolicyDefinitions` instead. The settings then appear in the Group Policy editor under
*Computer / User Configuration → Administrative Templates → Adika PDF Editor*. Without templates:

```bat
reg add "HKLM\SOFTWARE\Policies\Adika PDF Editor" /v DisableOnlineFeatures /t REG_DWORD /d 1 /f
```

### winget

`deploy/winget/manifests/…` holds the manifests (`unupunct.AdikaPDFEditor`: version, installer with
user and machine scope, en-US and ro-RO locales). After `npm run release:assets`, run
`npm run release:winget` to write them for the release with the SHA-256 of the uploaded setup (the
committed set has a placeholder hash until then). Check with `winget validate --manifest <folder>`
and `winget install --manifest <folder>` (needs `winget settings --enable LocalManifestFiles`). To
publish, open a pull request adding the folder to `manifests/u/unupunct/AdikaPDFEditor/<version>/`
of [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) (or use `wingetcreate submit`);
that is the maintainer's decision, nothing here submits it.

## Build from source

Requirements: Node 20+, Rust (MSVC toolchain), Visual Studio 2022 Build Tools with the C++ workload.

```bash
npm install
npm run desktop:build      # installer in src-tauri/target/release/bundle/nsis/
npm run desktop:dev        # development window with hot reload
```

### Releases and updates

The in-app updater reads `latest.json` from the latest GitHub release and installs the NSIS setup
only when its signature matches the public key in `tauri.conf.json` (`plugins.updater.pubkey`).

```bash
npm run desktop:build:release   # tauri build + updater signature (.sig); key from %USERPROFILE%\.tauri\adika-updater.key
npm run release:assets -- --notes-file notes.md   # release-assets/v<version>/: AdikaPDF_<v>_x64-setup.exe, .sig, latest.json, AdikaPDF_<v>_x64-portable.zip
npm run release:winget                            # deploy/winget/manifests/.../<version>/ with the setup's SHA-256
gh release create v<version> release-assets/v<version>/* --title "Adika PDF Editor <version>" --notes-file notes.md
```

The key can also come from `TAURI_SIGNING_PRIVATE_KEY` (key text) or `TAURI_SIGNING_PRIVATE_KEY_PATH`,
with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep the private key out of the repository; losing it
means installed copies can no longer update themselves. Upload the installer under the name in
`latest.json`. Releases without `latest.json` still work: the app then opens the release page.

### Code signing

Unsigned builds work, but Windows SmartScreen warns about them. `scripts/sign.mjs` is Tauri's
`signCommand` (app, installer, uninstaller) and also signs `adika_thumbs.dll` in `build:thumbs`; it
does nothing unless one of these is configured:

- **Azure Trusted Signing** (about 10 USD/month; individuals and organisations with a verified
  identity): `AZURE_TRUSTED_SIGNING_ENDPOINT` (e.g. `https://weu.codesigning.azure.net`),
  `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, plus `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (or `az login`). Signs with `trusted-signing-cli`
  (`cargo install trusted-signing-cli`), or with signtool and the Azure Code Signing Dlib when
  `AZURE_CODESIGNING_DLIB` points to `Azure.CodeSigning.Dlib.dll`.
- **A code signing certificate in the Windows store** (OV/EV from a CA, roughly 200–600 USD/year,
  usually on a hardware token): `ADIKA_SIGN_THUMBPRINT` (SHA-1 thumbprint), optional
  `ADIKA_SIGN_STORE` (default `My`) and `ADIKA_SIGN_MACHINE_STORE=1`. Uses signtool from the
  Windows SDK (or `SIGNTOOL`).

Signatures get an RFC 3161 timestamp (`ADIKA_SIGN_TIMESTAMP_URL` overrides the default server),
so they stay valid after the certificate expires.

## Tests

```bash
npm test                   # unit tests: export engine, encryption, signatures, conversions
npx tauri build --no-bundle
npm run test:e2e           # drives the real desktop app over WebView2's debug port
```

The end-to-end suite launches the release executable with `ADIKA_E2E=1`, which exposes test
hooks and replaces file dialogs with a queue; it covers every ribbon feature and verifies each
output file independently with pdf-lib and pdf.js.

## Notes and limits

- Hardware-token signing is tested end to end against a SoftHSM2 token (RSA-2048 and ECDSA P-256, verified independently with pyHanko): `bash tests/token/setup-softhsm.sh && node tests/e2e/token.mjs`.
- Self-signed signatures prove integrity, not identity; for eIDAS qualified signatures use a
  certificate from a qualified provider on a token.
- Cloud signatures need an account with a trust service provider that offers the Cloud Signature Consortium (CSC) API, and an application registration there: the provider gives you the service URL and a client ID (sometimes a client secret and a fixed redirect URI such as `http://127.0.0.1:<port>/callback`). Sign-in tokens are kept in memory only, for the session.
- ANAF e-Factura: the CUI lookup (`webservicesp.anaf.ro`, VAT register v9: at most one request a second, answers kept for the session) and **Check with ANAF** (public validation service, FACT1 / FCN) need no account. Sending to SPV, the status, the message list and downloads use ANAF's OAuth API (`logincert.anaf.ro`, `api.anaf.ro`): register an application for the e-Factura service in ANAF's portal (anaf.ro → Servicii online → Înregistrare utilizatori → Dezvoltatori aplicații), then enter its client ID, client secret and callback URL in **ANAF e-Factura → Settings**. With a callback such as `http://localhost:8765/callback` Adika receives the sign-in on that port; with any other (https) callback you paste the address the browser ends on. The browser presents your qualified certificate (SPV rights for the CUI) during sign-in; Adika never sees it. The client secret is kept in Windows Credential Manager; tokens stay in memory unless you tick *Stay connected*, which keeps the refresh token (valid up to a year) in Credential Manager. **Use ANAF's test environment** sends to `api.anaf.ro/test` (no legal effect). Uploads are logged in the app data folder (`anaf-uploads.json`). Nothing is sent to ANAF in the background.
- Very large documents (thousands of pages, hundreds of MB): the first page shows as soon as the first pages are read; the other pages start with the first page's size and get their real size (and rotation) in the background, around the page you are on first, without moving the view. Only the pages and thumbnails near the view exist at any time, and pages far away free their memory. Saving, printing and other whole-document commands wait until every page size is known ("Reading page sizes…"). Search shows its first matches while it goes on. Limits: pdf.js reads page sizes one page at a time, so a 10,000-page file whose page tree is flat takes about 10 s in the background; the Organize page grid still shows every page; while a file is open it is held in memory twice (once for the viewer, once for saving), and saving needs about the file's size again. Benchmark: `npx vitest run --config tests/manual/vitest.config.ts tests/manual/largeDocs.run.ts` (`LARGE_MODE=eager` for the old way, `LARGE_SAVE=1` adds saving).
- Redacted pages are rebuilt as images (run OCR afterwards to make them searchable again).
- Password-protected PDFs (RC4 40–128-bit, AES-128 and AES-256) can be edited and are saved with the same passwords and permissions, also as incremental updates. Opened without the owner password, the owner's restrictions apply as in Acrobat (for example: comments and form filling allowed, page content locked; printing and copying as permitted); "Enter owner password…" lifts them, and with the owner password the protection can also be removed. PDFs encrypted with another security handler still open read-only.
- PDF/A output fixes the usual veraPDF failures: fonts that are only named are embedded (the same font installed in Windows, else Liberation Sans for Helvetica/Arial and the Foxit fonts of pdf.js for Times, Courier, Symbol and ZapfDingbats, on the original widths so nothing moves), DeviceCMYK colours are converted to RGB for the sRGB output intent (or, with **Keep CMYK (print)**, RGB to CMYK under a generic CMYK output intent), squares and circles without an appearance get one, and for PDF/A-1 pages with transparency are flattened to images. What it cannot fix (a font found nowhere, inline CMYK images) is listed. CI validates samples with veraPDF (job "veraPDF" in `.github/workflows/ci.yml`, samples from `tests/pdfa-ci/`); validate critical archives with veraPDF too.
- EU Trusted Lists: the pinned LOTL-signing certificates (`LOTL_PINS` in `src/lib/crypto/euTrustedList.ts`, SHA-256) are those of OJ C/2026/1944 (15.4.2026, https://eur-lex.europa.eu/eli/C/2026/1944/oj). A change announced through pivot LOTLs is followed automatically; a new OJ publication is picked up by an app update.
- Form scripts that run too long are stopped and turned off for that document.
- OCR is statistical: on clean scans most words come out exactly, but check important text (e.g. a capital Ș at the start of a line can be read as S).
- EPUB with DRM, binary DXF and DWG files are not supported (save DWG drawings as DXF).

## License

MIT. Third-party components keep their own licences, including: pdf.js and Noto fonts (Apache-2.0 / SIL OFL), Liberation Sans (SIL OFL, from pdf.js, used for missing letters), pdf-lib and Tesseract.js (MIT, traineddata Apache-2.0), node-forge (BSD/GPL dual, used under BSD), **libheif-js (LGPL-3.0, shipped as a separate, unmodified module)**, @kenjiuno/msgreader (Apache-2.0), @kenjiuno/decompressrtf (BSD-2-Clause), postal-mime (MIT-0), dxf-parser (MIT), docx and JSZip (MIT).
