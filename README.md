<p align="center"><img src="public/brand/adika-logo.svg" alt="Adika PDF Editor" width="420"></p>

**Adika PDF Editor** is a privacy-first Windows PDF editor: edit, sign, organise, protect,
OCR and convert PDFs entirely on your computer. Nothing is uploaded.

## Features

| Area | What you can do |
| --- | --- |
| View | Continuous scroll, zoom (Ctrl+wheel, fit width/page), thumbnails, diacritic-insensitive search |
| Edit | Click-to-edit existing text, text boxes (Noto fonts, full Unicode incl. ă â î ș ț), images with crop, rectangles, ellipses, lines, arrows, freehand ink, highlights, snapping guides, undo/redo |
| Sign | Draw / type / upload signatures and initials; digital signatures (PAdES-style `adbe.pkcs7.detached`, SHA-256) with a `.pfx/.p12` ID, a self-signed ID, or a **USB token / smart card over PKCS#11**; optional RFC 3161 timestamp |
| Verify | Integrity, whole-file coverage, certificate chain against the Windows trust store, OCSP/CRL revocation |
| Organize | Drag-and-drop page grid, rotate, delete, duplicate, insert blank, merge, split, extract |
| Forms | Create text, checkbox, radio, dropdown and signature fields; fill existing forms; CSV export (single or batch) |
| Security | True redaction (content destroyed), AES-256 password protection with permissions, metadata sanitising |
| Convert to PDF | Word / Excel / PowerPoint (via installed Microsoft Office, LibreOffice fallback), images (PNG/JPG/WebP/TIFF/GIF/BMP), HTML files and web pages, Markdown, text, WIA scanner, camera |
| Convert from PDF | Word, Excel (table columns detected), PowerPoint, PNG/JPEG/TIFF, SVG, HTML5, Markdown, text |
| Optimise | Offline OCR (searchable text layer), compression, PDF/A-2b, flatten |

## Install

Download `Adika PDF Editor_x.y.z_x64-setup.exe` from Releases and run it. It adds Start-menu
and desktop shortcuts and an "Open with" entry for PDF files. Requires Windows 10/11 (WebView2,
installed automatically if missing).

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
- OCR language: English.

## License

MIT. Bundled Noto fonts are under the SIL Open Font License.
