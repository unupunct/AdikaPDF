# Adika PDF Editor

Privacy-first, offline Windows PDF editor (read, comment, edit, sign, organise, protect, OCR, convert). Version 1.2.0. MIT. Repo: https://github.com/unupunct/AdikaPDF (branch `main`).

## Architecture
- **Tauri 2 desktop app.** Almost all logic runs in the WebView (React 18 + TypeScript + Vite 7 + Tailwind 4, state in zustand, canvas via Konva, rendering via pdf.js, writing via pdf-lib).
- **Rust side (`src-tauri/src/`)** is thin: file I/O with raw IPC bodies (`lib.rs`), Office/HTML/WIA conversion (`convert.rs`), HTTP + Windows cert store for OCSP/CRL/timestamps (`net.rs`), PKCS#11 token signing (`pkcs11.rs`), logs and crash reports (`logging.rs`), and the virtual-printer watcher (`print_watcher.rs`, started with a special CLI flag, no window).
- Single-instance plugin: a second launch forwards PDF paths to the running window (`adika://open-files` event).
- Installer: NSIS (`src-tauri/windows/hooks.nsh`, `printer.ps1` creates the "Adika PDF Editor" printer on top of Microsoft Print To PDF and enables the Print Spooler).

## Layout
- `src/actions/`: user-facing operations (convert, document, print, quickTools, security, sign)
- `src/components/`: ribbon, modals, sidebar, viewer, shell, inspector, ui primitives
- `src/lib/pdf/`: format engines (convert, exportPdf, exportFormats, pdfa, ocr, compress, repair, xps, dxf, epub, email, annotations)
- `src/lib/crypto/`: `digitalSignature.ts` (PAdES-style signing and verification), `encrypt.ts` (AES-256)
- `src/store/`: zustand stores (`usePDFStore.ts` is the main one, `tabs.ts`)
- `tests/*.test.ts`: vitest unit tests. `tests/e2e/`: drives the release exe over the WebView2 debug port (`ADIKA_E2E=1`). `tests/token/`: SoftHSM2 token tests (SoftHSM lives in the git-ignored `.tools/`).
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
- Installed: Node 24.19, npm 11.17, Git 2.55, Python 3.13, gh 2.101, PowerShell 7.6, VS Code.
- **Missing for native builds: Rust (MSVC toolchain) and Visual Studio 2022 Build Tools (C++ workload).** Frontend work and `npm test` run without them; `desktop:dev` / `desktop:build` / e2e need them.
- Project is on D: (a spinning HDD), so installs and builds are slower than on the SSD.
- A new PowerShell window may be needed after installs so PATH includes the new tools.
- The project was started on the user's work PC; `node_modules/` and `src-tauri/target/` were copied over from there (the target folder has installers 1.0.0 to 1.2.0).

## Known issues spotted
- README.md lines 14 and 38 lost their backslashes in paths (`%LOCALAPPDATA%Adika PDF EditorPrinted`, `C:Program FilesAdika PDF Editorlogs`).
