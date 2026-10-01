# Adika PDF Editor

Privacy-first, offline Windows PDF editor (read, comment, edit, sign, organise, protect, OCR, convert). Version 1.8.0. MIT. Repo: https://github.com/unupunct/AdikaPDF (branch `main`).

## Architecture
- **Tauri 2 desktop app.** Almost all logic runs in the WebView (React 18 + TypeScript + Vite 7 + Tailwind 4, state in zustand, canvas via Konva, rendering via pdf.js, writing via pdf-lib).
- **Rust side (`src-tauri/src/`)** is thin: file I/O with raw IPC bodies (`lib.rs`), Windows certificate store listing and CNG/CryptoAPI signing (`certstore.rs`; E2E imports a throwaway .pfx in memory via `ADIKA_WINSTORE_TEST_PFX`), app cache files (`appdata.rs`, `%LOCALAPPDATA%\Adika PDF Editor\Data` or `ADIKA_DATA_DIR`), Office/HTML/WIA conversion (`convert.rs`), HTTP + Windows cert store for OCSP/CRL/timestamps (`net.rs`), PKCS#11 token signing (`pkcs11.rs`), logs and crash reports (`logging.rs`), and the virtual-printer watcher (`print_watcher.rs`, started with a special CLI flag, no window).
- Single-instance plugin: a second launch forwards PDF paths to the running window (`adika://open-files` event).
- Installer: NSIS (`src-tauri/windows/hooks.nsh`, `printer.ps1` creates the "Adika PDF Editor" printer on top of Microsoft Print To PDF and enables the Print Spooler).

## Layout
- `src/actions/`: user-facing operations (convert, document, print, quickTools, security, sign)
- `src/components/`: ribbon, modals, sidebar, viewer, shell, inspector, ui primitives
- `src/lib/pdf/`: format engines (convert, exportPdf, exportFormats, pdfa, ocr, compress, repair, xps, dxf, epub, email, annotations)
- PDF -> Word/ODT/RTF/Markdown/Excel/CSV/EPUB share one page-layout analysis: `wordLayout.ts` (pure: paragraphs, alignment, lists, ruled/aligned tables, columns, image placement, running headers/footers), `docx.ts` (reads images/rules/colours from pdf.js via `collectDocxGraphics`, `planDocument`, writes .docx in flowing or exact mode), `docWriters.ts` (ODT, RTF, Markdown, rows, reflow blocks).
- Text engine `src/lib/pdf/textRemoval.ts`: interprets page content streams (glyphs with Unicode and exact boxes), deletes letters inside areas, writes replacement text in the document's own font and reflows the line. Used by redaction (vector first, raster fallback when images/drawings/forms/unmeasurable fonts are under a box), Find & replace (`actions/findReplace.ts`, rebuilds the source immediately, undoable) and Edit text. `textSearch.ts` finds matches on it; `lib/patterns.ts` has the redaction patterns (IBAN mod 97, CNP, Luhn).
- Saving drops unreferenced objects (`lib/pdf/prune.ts`): otherwise a redacted page's original stream stays in the file.
- `lib/formDetect.ts` (Detect fields, on the rendered page), `lib/batch.ts` + `actions/batch.ts` (Batch), `lib/updates.ts` (opt-in GitHub release check; version from package.json via `__APP_VERSION__`).
- Interface language: `lib/i18n.ts` translates the DOM at runtime from `src/locales/ro.json` + `ro.extra.ts` (English string -> Romanian; `{0}` patterns, plural `{0#one|few|many}`). New UI strings need a Romanian entry: `tests/i18nCoverage.test.ts` fails otherwise and `node scripts/i18n-extract.cjs . out.json` lists them. Mark user/document content with `data-no-translate`. E2E pins English at start.
- `src/lib/crypto/`: `digitalSignature.ts` (signing and verification: classic or PAdES baseline B-B/B-T/B-LT/B-LTA, document timestamps, DSS/LTV, certification, QcStatements), `euTrustedList.ts` (EU LOTL + national trusted lists parsed into CA/QC and TSA/QTST trust anchors), `encrypt.ts` (AES-256)
- Other round-8 engines: `src/lib/mailMerge.ts` (CSV/XLSX reader, form fill per row), `src/lib/batch.ts` (batch ops and action sequences), `src/lib/pdf/accessibility.ts` (checker + auto-tagger), `editableScan.ts` (OCR text as visible text), `visualCompare.ts` (pixel diff report)
- Round 9: `src/lib/scan/` (cleanup: deskew, orientation, specks, edges, blank pages; `ccitt.ts` Group 4 encoder; `scanPdf.ts` PDF building, separator sheets, splitting) with `src-tauri/src/scanner.rs` (WIA without the dialog, feeder batches); `src/lib/barcode/` (Code 128 encode + read, QR encode — tests decode with the jsqr dev dependency); `src/lib/print/` (generic CMYK model + generated ICC output profile, colour conversion of content streams / images / shadings, PDF/X preflight + conversion, bleed and printer marks, ink coverage); `src/lib/cli.ts` + `actions/automation.ts` (`--batch` command line: no window, console output via `automation.rs`, exit codes; watched folders); `src/lib/searchIndex.ts` + `actions/folderSearch.ts` (folder search index in app data); `src/lib/pdf/review.ts` (review-state replies, merging reviewers' copies); `src/lib/crypto/pubsec.ts` (certificate encryption Adobe.PubSec / adbe.pkcs7.s5; Windows-store decryption in `certstore.rs`)
- Interface languages: `src/locales/<lang>.json` for de, fr, hu, it, es (same keys as Romanian; `tests/i18nLanguages.test.ts` requires every Romanian key in every language), plural rule per language in `lib/i18n.ts`
- The main window is created in `lib.rs` setup (config has `"create": false`): hidden for `--batch`, and in E2E mode it uses `ADIKA_WEBVIEW_DATA` as its WebView profile so tests never touch the user's settings
- `src/store/`: zustand stores (`usePDFStore.ts` is the main one, `tabs.ts`)
- `tests/*.test.ts`: vitest unit tests. `tests/manual/`: harness that converts real PDFs to .docx/.odt/.rtf/.md/.csv/.xlsx/.epub for a round-trip check in Word (`W2D_IN=a.pdf;b.pdf W2D_OUT=dir npx vitest run --config tests/manual/vitest.config.ts`). `tests/e2e/`: drives the release exe over the WebView2 debug port (`ADIKA_E2E=1`). `tests/token/`: SoftHSM2 token tests (SoftHSM lives in the git-ignored `.tools/`).
- `scripts/copy-*-assets.mjs`: copy pdf.js and Tesseract assets into `public/` on `npm install` (git-ignored).

## Commands
```
npm install
npm run desktop:dev      # dev window, hot reload
npm run desktop:build    # installer -> src-tauri/target/release/bundle/nsis/
npm test                 # unit tests
npx tauri build --no-bundle && npm run test:e2e
npm run typecheck
```

## This machine (home PC, HP Z240, Windows 11)
- Installed: Node 24.19, npm 11.17, Git 2.55, Python 3.13, gh 2.101, PowerShell 7.6, VS Code, Rust 1.98.1 (stable-x86_64-pc-windows-msvc, in `%USERPROFILE%\.cargo\bin`), Visual Studio Build Tools 2022 17.14 (C++ workload). `cargo check` in `src-tauri` passes (about 4 min cold on this HDD).
- Project is on D: (a spinning HDD), so installs and builds are slower than on the SSD.
- A new PowerShell window may be needed after installs so PATH includes the new tools.
- The project was started on the user's work PC; `node_modules/` and `src-tauri/target/` were copied over from there (the target folder has installers 1.0.0 to 1.2.0).
