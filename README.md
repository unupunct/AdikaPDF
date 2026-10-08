<p align="center"><img src="public/brand/adika-logo.svg" alt="Adika PDF Editor" width="420"></p>

**Adika PDF Editor** is a privacy-first Windows PDF editor: edit, sign, organise, protect,
OCR and convert PDFs entirely on your computer. Nothing is uploaded. The interface is in
**English, Română, Deutsch, Français, Magyar, Italiano or Español** (menu in the top bar; it follows the Windows language on first start).

## Features

| Area | What you can do |
| --- | --- |
| Read | Tabs for several documents, continuous / single-page / two-page (facing, cover) layouts, rotate view, night mode, full screen (F11), presentation mode (F5), clickable links and bookmarks (outline), page labels, Back/Forward history, text selection and copy, attachments and layers (optional content) panels, search with case / whole-word options and a results list, document properties, printing, recent files, auto-reload when the file changes on disk, repair of damaged files; **Read aloud** with the Windows voices (page, to the end or the selection; pause, voice, speed; Ctrl+Shift+V/B/C/E), **Snapshot** (copy an area as a picture), **Magnifier** (2×–4× lens), **Auto-scroll** (Ctrl+Shift+H; ↑/↓ speed, − reverse, Esc stop); a document tab can be dragged out into a **window of its own** |
| View | Zoom (Ctrl+wheel, fit width/page), thumbnails, diacritic-insensitive search; **Split view** (Ctrl+\\): another part of the document or another open tab side by side; **tool search** (Ctrl+K) finds any command in English or Romanian; **Reading view**: the text reflowed like an e-book, with text size, line width, font and light / sepia / dark themes; **Search folders**: the text of every PDF in chosen folders (subfolders too), from an index kept on this computer; diacritics ignored, a hit opens the file at its page |
| Comment | Foxit-style Comment tab: Hand, Select, Select text, sticky **Notes**, **Typewriter**, Highlight / Underline / Strikeout / Squiggly on selected text, drawing tools, comments list, author name. Saved as standard PDF annotations that Acrobat and other readers show and edit; **Stamps** (Approved, Draft, Confidential…, dynamic with name and date, or a picture), **Text box**, **Callout**, **Cloud**, **Polygon**, **Polyline**, **Attach file**, **Measure** distance / perimeter / area with a drawing scale (e.g. 1 cm = 2 m), saved as PDF measurements Acrobat and Foxit read; import/export comments as **XFDF / FDF**, **comment summary** PDF, **compare** two versions; **Compare visually**: both versions overlaid pixel by pixel (new ink blue, removed ink red, changed areas boxed); **review status** of comments (Accepted, Rejected, Completed, Cancelled), shown and filterable; **merge reviewers' copies** of a document; **Check spelling** (F7) of comments, text boxes and filled form fields with the Windows spell checker (any installed language, your own dictionary); compare with a **list of changes (redline)**; comments already in a file (from Acrobat, Foxit, Word…) can be **edited, moved and deleted**, keeping their author and replies |
| Tools | One-click hub (ribbon and start screen): PDF to Word, PDF to JPG, Word to PDF, JPG to PDF, Merge PDF, PDF to PPT, Compress PDF, PPT to PDF, PDF to Excel, Excel to PDF |
| Print | Print dialog with page ranges, **several pages per sheet** (2–16), **booklet** (fold and staple) and **poster** (enlarged over several sheets, with cut marks); also saved as PDF |
| Print to PDF | A **"Adika PDF Editor" virtual printer**: print from a browser or any program and the pages open in Adika as a PDF (saved in `%LOCALAPPDATA%\Adika PDF Editor\Printed`) |
| Edit | **Paragraph editing**: Edit text opens the whole paragraph as one box that rewraps while typing; **Edit image**: move, resize, rotate, replace or delete pictures already in the PDF; **Find & replace** (Ctrl+H) across the document: the old letters are deleted from the page, the new text uses the document's own font when it has the letters and the rest of the line moves to make room; click-to-edit existing text (the original run is removed, not covered), text boxes (Noto fonts, full Unicode incl. ă â î ș ț), images with crop, rectangles, ellipses, lines, arrows, freehand ink, highlights, snapping guides, undo/redo; **links** to web pages or pages; **watermark** (text or picture), **header & footer** with page numbers, date and file name, **Bates numbering**, **background**, all removable; **Edit drawing**: lines, boxes and shapes already in the PDF can be moved, resized, recoloured or deleted; restyled text (colour, size) keeps the **document's own font**; **pen pressure** (Windows Ink) for ink |
| Sign | Draw / type / upload signatures and initials; digital signatures (PAdES-style `adbe.pkcs7.detached`, SHA-256) with a `.pfx/.p12` ID, a self-signed ID, or a **USB token / smart card over PKCS#11**; optional RFC 3161 timestamp; **several signatures** on one document (each added as an incremental update, so earlier ones stay valid); **certify** a document (no changes / forms and signing / also comments); **long-term validation** (certificate chains and OCSP/CRL answers saved in the file); **EU format (PAdES baseline, eIDAS)**: levels B-B, B-T (timestamp), B-LT (validation data, also for the timestamp authority) and B-LTA (archive document timestamp); sign with **certificates installed in Windows** (qualified certificates from card drivers, imported .pfx; Windows asks for the PIN) |
| Verify | Integrity, whole-file coverage, certificate chain against the Windows trust store, OCSP/CRL revocation; recognises the changes allowed after signing (validation data, signatures, form filling, comments) and the certification level, and flags anything else, including tampering tricks that hide changes in later updates; certificate purposes, timestamp tokens and OCSP/CRL answers are themselves verified, and weak algorithms (SHA-1, short keys) are flagged; uses saved validation data offline; shows the **PAdES level**; **EU Trusted Lists** (downloaded from the European Commission, kept offline) recognise qualified certificate authorities and timestamp authorities (the lists' own signatures are not verified), and **qualified electronic signatures** (QcStatements); document timestamps verified; the checks can be saved as a **validation report** (PDF) |
| Organize | Drag-and-drop page grid, rotate, delete, duplicate, insert blank, merge, split, extract, **crop pages**, **edit bookmarks** (add, rename, move, nest); **Replace pages** from another PDF (comments and bookmarks kept); **bookmarks from headings**; **links from web and e-mail addresses**; split at **top-level bookmarks** (named parts), by **file size**, or at **blank pages and separator sheets**; **page size**: pages to A4, Letter… (content scaled to fit, or the page grown around it); **contents page** from the bookmarks, with links; **PDF Portfolios** (one PDF carrying files of any kind); **layers**: rename, delete with their content, merge, flatten; objects can be saved in a layer |
| Forms | **Smart fields**: number, currency, percent and date formats, minimum / maximum, totals and formulas (Qty * Price), saved as standard Acrobat form actions and calculated live while filling; **Detect fields**: turns a flat or scanned form into a fillable one (fill-in lines, empty boxes, checkboxes, named after their labels); create text, checkbox, radio, dropdown and signature fields; fill existing forms; CSV export (single or batch); **Mail merge**: fill the form once per row of a CSV or Excel table, one PDF per row (file names from the columns) or one combined PDF; **buttons** (e-mail the filled form, clear, print, open a web page, show / hide fields, go to a page) and **barcode fields** (QR or Code 128 made from the field values); existing fields are **filled on the page**; the form's own **JavaScript** (calculations, checks, formats, messages) runs in a sandbox; **XFA forms**: static ones keep their XFA data, dynamic ones (government and bank forms that show "Please wait…") are laid out and filled, and saving keeps them XFA forms; XFA data as XML |
| Security | True redaction: the covered letters are deleted and the rest of the page stays text (pages with images or drawings under a box are rebuilt as an image); anything you added under a box, alternate text, tags, thumbnails and form data of the covered area go too, and pages that were replaced leave nothing behind; **Find & redact** e-mails, phone numbers, IBANs, CNPs, card numbers, dates or chosen words; AES-256 password protection with permissions, metadata sanitising; **Remove hidden information**: finds metadata, scripts, attachments, comments, form values, hidden layers and text, bookmarks, tags, thumbnails, private application data, links and earlier versions, with a preview, and removes what you choose; **Accessibility** checker and fixer (PDF/UA-style): tags paragraphs, headings, pictures, links and fields in reading order, sets title and language, picture descriptions with previews, decorative pictures as artifacts; **encrypt for certificates**: only the chosen people open the document, each with their own card, token or digital ID — no shared password; the **Tags** panel edits the tag tree (type, alternate text, reading order) |
| Convert to PDF | Word / Excel / PowerPoint (via installed Microsoft Office, LibreOffice fallback), images (PNG/JPG/WebP/TIFF/GIF/BMP, **HEIC/HEIF** iPhone photos), HTML files and web pages, Markdown, text, **EPUB** e-books, **e-mails** (.eml, Outlook .msg, .mht — attachments kept inside the PDF), **XPS / OpenXPS** (vector), **DXF** CAD drawings (vector, CAD layers as PDF layers), WIA scanner, camera; **Scan to PDF**: flatbed or document feeder (both sides), colour / grey / black and white, resolution and paper size set in Adika; pages straightened, turned upright, cleaned of specks and dark edges; blank pages removed; **separator sheets** (with a barcode that names the next document) split a batch into several PDFs; black-and-white pages stored with fax (Group 4) compression; photos and multi-page TIFFs as pages; **e-invoices**: Romanian **e-Factura** (ANAF XML or ZIP), UBL / Peppol and CII open as a readable invoice PDF with the XML attached and the sums checked |
| Convert from PDF | Word (.docx, flowing or exact layout: fonts, colours, tables, columns, images and headers/footers kept), **OpenDocument (.odt)**, **RTF**, Excel (table columns detected), **CSV**, PowerPoint, PNG/JPEG/TIFF, SVG, HTML5, **EPUB**, Markdown, text, **JSON** (text with positions, outline, metadata, form data); **Export pictures**: every image into a ZIP, JPEGs exactly as stored; scanned pages are recognised first and **tables in scans** become real tables (Word, Excel); **Factur-X / ZUGFeRD** e-invoices made from a PDF and its XML, and the invoice inside such a PDF shown and saved |
| Optimise | Offline OCR in 10 languages (Română, English, Deutsch, Français, Español, Italiano, Magyar, Português, Nederlands, Polski) with a searchable Unicode text layer, compression, **PDF/A-1b, 2b and 3b** (3b can embed the source files), flatten; **Batch**: OCR, compress, watermark, PDF/A, password, sanitise or flatten many files at once (results saved next to the originals); OCR can also make scans **editable**: the text becomes real text in a similar font, size and ink colour over the painted-out scan; **batch action sequences** (saved chains of OCR, compress, watermark, page numbers, PDF/A, protect, sanitize, flatten) |
| Print production | **Preflight** against PDF/X-4, PDF/X-1a:2003 or PDF/A-2b and **conversion to PDF/X** (trim boxes, output intent with an embedded CMYK profile, metadata; for X-1a CMYK colours and flattened transparency); colours to **grey or CMYK**; **output preview** of the separations and total ink; **bleed and printer marks** (crop, registration, colour bars, page information) |
| Automation | **Command line** (`adika-pdf-editor.exe --batch --ocr --compress --out results *.pdf`, or a saved `--sequence`), exit codes for scripts; **watched folders**: PDFs copied into a folder are processed with a saved sequence while Adika runs; **Explorer menu**: Combine in Adika, Compress, Make searchable (OCR), Convert to PDF; **PDF thumbnails** in Explorer; **Send by e-mail** from your mail program; your own **Quick Access toolbar** and **keyboard shortcuts** |
| Document properties | Title, authors, subject, keywords, **copyright** status, notice and URL, **custom properties**; written into the XMP metadata in step with the document information |
| Updates | Optional update check (About → Check for updates, or once a week): asks GitHub for the latest version, nothing else is sent; **automatic backup** of every unsaved document every few seconds and recovery after a crash; asks before closing with unsaved changes; **signed documents are saved as an incremental update** (signatures stay valid when you add comments or fill in fields; a setting does this for all documents); warns when the file changed on disk or a save would break signatures; long operations can be **cancelled** |

## Install

Download `Adika PDF Editor_x.y.z_x64-setup.exe` from Releases and run it. It adds Start-menu
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

## Build from source

Requirements: Node 20+, Rust (MSVC toolchain), Visual Studio 2022 Build Tools with the C++ workload.

```bash
npm install
npm run desktop:build      # installer in src-tauri/target/release/bundle/nsis/
npm run desktop:dev        # development window with hot reload
```

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
- Redacted pages are rebuilt as images (run OCR afterwards to make them searchable again).
- Password-protected PDFs (RC4 40–128-bit, AES-128 and AES-256) can be edited and are saved with the same passwords and permissions, also as incremental updates. Opened without the owner password, the owner's restrictions apply as in Acrobat (for example: comments and form filling allowed, page content locked; printing and copying as permitted); "Enter owner password…" lifts them, and with the owner password the protection can also be removed. PDFs encrypted with another security handler still open read-only.
- PDF/A output carries the required markers and warns about what it cannot fix (e.g. CMYK content); validate critical archives with veraPDF.
- Form scripts that run too long are stopped and turned off for that document.
- OCR is statistical: on clean scans most words come out exactly, but check important text (e.g. a capital Ș at the start of a line can be read as S).
- EPUB with DRM, binary DXF and DWG files are not supported (save DWG drawings as DXF).

## License

MIT. Third-party components keep their own licences, including: pdf.js and Noto fonts (Apache-2.0 / SIL OFL), pdf-lib and Tesseract.js (MIT, traineddata Apache-2.0), node-forge (BSD/GPL dual, used under BSD), **libheif-js (LGPL-3.0, shipped as a separate, unmodified module)**, @kenjiuno/msgreader (Apache-2.0), @kenjiuno/decompressrtf (BSD-2-Clause), postal-mime (MIT-0), dxf-parser (MIT), docx and JSZip (MIT).
