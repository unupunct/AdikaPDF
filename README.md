<p align="center"><img src="public/brand/adika-logo.svg" alt="Adika PDF Editor" width="420"></p>

**Adika PDF Editor** is a privacy-first Windows PDF editor: edit, sign, organise, protect,
OCR and convert PDFs entirely on your computer. Nothing is uploaded. The interface is in
**English or Română** (button in the top bar; it follows the Windows language on first start).

## Features

| Area | What you can do |
| --- | --- |
| Read | Tabs for several documents, continuous / single-page / two-page (facing, cover) layouts, rotate view, night mode, full screen (F11), presentation mode (F5), clickable links and bookmarks (outline), page labels, Back/Forward history, text selection and copy, attachments and layers (optional content) panels, search with case / whole-word options and a results list, document properties, printing, recent files, auto-reload when the file changes on disk, repair of damaged files; **Read aloud** with the Windows voices (page, to the end or the selection; pause, voice, speed; Ctrl+Shift+V/B/C/E), **Snapshot** (copy an area as a picture), **Magnifier** (2×–4× lens), **Auto-scroll** (Ctrl+Shift+H; ↑/↓ speed, − reverse, Esc stop) |
| View | Zoom (Ctrl+wheel, fit width/page), thumbnails, diacritic-insensitive search |
| Comment | Foxit-style Comment tab: Hand, Select, Select text, sticky **Notes**, **Typewriter**, Highlight / Underline / Strikeout / Squiggly on selected text, drawing tools, comments list, author name. Saved as standard PDF annotations that Acrobat and other readers show and edit; **Stamps** (Approved, Draft, Confidential…, dynamic with name and date, or a picture), **Text box**, **Callout**, **Cloud**, **Polygon**, **Polyline**, **Attach file**, **Measure** distance / perimeter / area with a drawing scale (e.g. 1 cm = 2 m), saved as PDF measurements Acrobat and Foxit read; import/export comments as **XFDF / FDF**, **comment summary** PDF, **compare** two versions |
| Tools | One-click hub (ribbon and start screen): PDF to Word, PDF to JPG, Word to PDF, JPG to PDF, Merge PDF, PDF to PPT, Compress PDF, PPT to PDF, PDF to Excel, Excel to PDF |
| Print to PDF | A **"Adika PDF Editor" virtual printer**: print from a browser or any program and the pages open in Adika as a PDF (saved in `%LOCALAPPDATA%\Adika PDF Editor\Printed`) |
| Edit | **Find & replace** (Ctrl+H) across the document: the old letters are deleted from the page, the new text uses the document's own font when it has the letters and the rest of the line moves to make room; click-to-edit existing text (the original run is removed, not covered), text boxes (Noto fonts, full Unicode incl. ă â î ș ț), images with crop, rectangles, ellipses, lines, arrows, freehand ink, highlights, snapping guides, undo/redo; **links** to web pages or pages; **watermark** (text or picture), **header & footer** with page numbers, date and file name, **Bates numbering**, **background**, all removable |
| Sign | Draw / type / upload signatures and initials; digital signatures (PAdES-style `adbe.pkcs7.detached`, SHA-256) with a `.pfx/.p12` ID, a self-signed ID, or a **USB token / smart card over PKCS#11**; optional RFC 3161 timestamp |
| Verify | Integrity, whole-file coverage, certificate chain against the Windows trust store, OCSP/CRL revocation |
| Organize | Drag-and-drop page grid, rotate, delete, duplicate, insert blank, merge, split, extract, **crop pages**, **edit bookmarks** (add, rename, move, nest) |
| Forms | **Detect fields**: turns a flat or scanned form into a fillable one (fill-in lines, empty boxes, checkboxes, named after their labels); create text, checkbox, radio, dropdown and signature fields; fill existing forms; CSV export (single or batch) |
| Security | True redaction: the covered letters are deleted and the rest of the page stays text (pages with images or drawings under a box are rebuilt as an image); **Find & redact** e-mails, phone numbers, IBANs, CNPs, card numbers, dates or chosen words; AES-256 password protection with permissions, metadata sanitising |
| Convert to PDF | Word / Excel / PowerPoint (via installed Microsoft Office, LibreOffice fallback), images (PNG/JPG/WebP/TIFF/GIF/BMP, **HEIC/HEIF** iPhone photos), HTML files and web pages, Markdown, text, **EPUB** e-books, **e-mails** (.eml, Outlook .msg, .mht — attachments kept inside the PDF), **XPS / OpenXPS** (vector), **DXF** CAD drawings (vector, CAD layers as PDF layers), WIA scanner, camera |
| Convert from PDF | Word (.docx, flowing or exact layout: fonts, colours, tables, columns, images and headers/footers kept), **OpenDocument (.odt)**, **RTF**, Excel (table columns detected), **CSV**, PowerPoint, PNG/JPEG/TIFF, SVG, HTML5, **EPUB**, Markdown, text, **JSON** (text with positions, outline, metadata, form data) |
| Optimise | Offline OCR in 10 languages (Română, English, Deutsch, Français, Español, Italiano, Magyar, Português, Nederlands, Polski) with a searchable Unicode text layer, compression, **PDF/A-1b, 2b and 3b** (3b can embed the source files), flatten; **Batch**: OCR, compress, watermark, PDF/A, password, sanitise or flatten many files at once (results saved next to the originals) |
| Updates | Optional update check (About → Check for updates, or once a week): asks GitHub for the latest version, nothing else is sent |

## Install

Download `Adika PDF Editor_x.y.z_x64-setup.exe` from Releases and run it. It adds Start-menu
and desktop shortcuts and an "Open with" entry for PDF files. Requires Windows 10/11 (WebView2,
installed automatically if missing).

Installing for all users (per machine) also adds the **Adika PDF Editor** printer. It uses
Windows' own "Microsoft Print To PDF" driver, so no extra driver is installed. The Windows Print
Spooler service is needed; if it is stopped, the installer starts it and sets it to start
automatically. To re-create the printer later, run `printer.ps1 -EnableSpooler` from the install
folder as administrator.

**Logs.** Diagnostic logs and crash reports are written to the `logs` folder in the install
folder (for example `C:\Program Files\Adika PDF Editor\logs`). The installer makes it writable
for users. If that folder cannot be written, logs go to `%LOCALAPPDATA%\Adika PDF Editor\logs`.
Open the folder from the About dialog (*Open logs folder*). Attach `crash-*.log` files when
reporting a problem.

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
- Password-protected PDFs open read-only.
- PDF/A output carries the required markers; validate critical archives with veraPDF.
- OCR is statistical: on clean scans most words come out exactly, but check important text (e.g. a capital Ș at the start of a line can be read as S).
- EPUB with DRM, binary DXF and DWG files are not supported (save DWG drawings as DXF).

## License

MIT. Third-party components keep their own licences, including: pdf.js and Noto fonts (Apache-2.0 / SIL OFL), pdf-lib and Tesseract.js (MIT, traineddata Apache-2.0), node-forge (BSD/GPL dual, used under BSD), **libheif-js (LGPL-3.0, shipped as a separate, unmodified module)**, @kenjiuno/msgreader (Apache-2.0), @kenjiuno/decompressrtf (BSD-2-Clause), postal-mime (MIT-0), dxf-parser (MIT), docx and JSZip (MIT).
