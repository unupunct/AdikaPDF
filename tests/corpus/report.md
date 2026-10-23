# Corpus run report (round 16)

2,453 public test PDFs (pdf.js `test/pdfs` 1,003 + 280 reachable `.link` targets, qpdf 717, pdfium 301, pypdf 70 + 35 samples, pdf-lib 47), run on 2026-10-22 with `node tests/corpus/orchestrate.mjs run` (4 workers, 60 s per stage). Many of them are deliberately broken (fuzzer finds, qpdf/pdfium "bad" files). The corpus is kept outside git (`.tools/corpus`, see CLAUDE.md "Round 16").

"Before" is commit 06f2e08 (1.15.0) run with the same harness; "after" is the round-16 branch.

Statuses: **pass**; **skip** (not applicable: password needed, incremental save blocked, unsupported encryption); **error** (exception); **wrong** (finished with a wrong result: output does not reopen, page count changed, page-1 text lost, redacted text still there, search hit missing); **timeout** (over 60 s, or hung); **crash** (worker died).

## Failures per stage (error + wrong + timeout + crash)

| Stage | before | after |
|---|---|---|
| open (pdf.js + the app's repair) | 69 | 69 |
| save (`buildPdf`) | 61 | 14 |
| incremental save | 148 | 14 |
| text extraction | 2 | 2 |
| Word export | 10 | 9 |
| compress | 49 | 12 |
| PDF/A (one file in four) | 12 | 3 |
| signature verification | 0 | 0 |
| PDF/UA check | 45 | 9 |
| hidden-information scan | 57 | 9 |
| redaction | 66 | 6 |
| search (Find & replace / redact) | 31 | 6 |
| **total** | **550** | **153** |

Redaction "wrong" before included 22 files where the box missed the text (the text survived on the saved page); after: none of that kind is left.

## What was fixed

- Files pdf.js opens but pdf-lib cannot use (untyped catalog / page tree, broken parents, fewer pages, page trees looping, no `%PDF-` header, number parse errors): edited from a repaired copy (`lib/pdf/editable.ts`); repair learned untyped trees, pages written directly into /Kids, object streams with a wrong /Type or an abbreviated filter (/Fl), objects right after `endobj`, US Letter as the default size (as pdf.js). Pages pdf-lib still cannot find are saved from their rendering instead of crashing `setPageOrder`.
- Display ↔ PDF mapping used pdf-lib's CropBox; pdf.js (and the app's page sizes) use CropBox ∩ MediaBox with fallbacks for empty boxes: on such pages redaction boxes landed elsewhere and the text stayed (`lib/pdf/viewBox.ts`, used by save, redaction, search, comments, OCR, signing placement).
- Text engine: fonts set by a graphics state (`gs` /Font), negative font sizes (search found nothing), Type3 fonts with a y-mirroring FontMatrix (redaction missed the letters).
- Search for Find & replace / redact: pages whose fonts the engine reads differently from pdf.js (no ToUnicode, glyph names without meaning) take pdf.js matches; text runs on /UserUnit pages are in page points.
- Saving: rich text fields, an /AcroForm that is not a dictionary, a /Contents that is not a stream no longer fail the save.
- Incremental save: comments on XFA forms are appended (only filled-in XFA values need a full save); files without a usable xref get a complete table (classic, or a cross-reference stream for objects in object streams); the trailer /ID is written as hex (a literal ID with high bytes was re-encoded as UTF-8, which broke encrypted files).
- Decryption whose object streams do not inflate is refused (file read-only) instead of saving garbage.

## Remaining known failures

- **open (69)**: pdf.js refuses the file and the app's repair finds no pages (fuzzed / truncated files: "Invalid PDF structure", "Invalid Root reference", bad xref entries, files with 0 pages), 4 pages that pdf.js renders for minutes (huge shadings / tiling patterns), 3 canvases too large for @napi-rs/canvas in the harness. Same before and after.
- **pdf-lib cannot read the objects at all** (about 8 files across save / compress / PDF/UA / hidden info): a Brotli-compressed file (`/BrotliDecode`, not supported by pdf-lib), a page tree with /Count but no /Kids, header-less fuzz files whose objects do not parse.
- **Word export / text timeouts (11)**: pdf.js needs over 60 s in Node to render or read these pages (very large shadings, thousands of text runs); a rendering cost, not a hang.
- **Incremental save (14)**: files whose page objects pdf-lib cannot parse (saved in full instead), XFA-less files without any parseable xref.
- **Redaction (6)**: identical text drawn several times at the same place (all copies go, the check counts them as lost: 3 files), one CJK Type3 font whose glyphs fall outside the boxes the engine computes, a fuzzed file whose saved output pdf.js refuses, Brotli.
- **Search (6)**: TeX fonts whose built-in encoding (inside the Type1 program) maps codes to ligatures, so the engine and pdf.js agree on most letters and the cross-check keeps the engine; qpdf's split-content-stream tests (a token split across two content streams).
- `issue19484` (V4 RC4-40 "under-documented" scheme): the key is accepted but the streams do not decrypt like Acrobat's; now refused (read-only) instead of saved as garbage.

## After: all stages

| Stage | pass | skip | error | wrong | timeout | crash | failures before |
|---|---|---|---|---|---|---|---|
| open | 2328 | 56 | 64 | 0 | 4 | 1 | 69 → 69 |
| decrypt | 63 | 8 | 0 | 0 | 0 | 0 | 0 → 0 |
| repair | 51 | 0 | 0 | 0 | 0 | 0 | 0 → 0 |
| save | 2306 | 0 | 10 | 4 | 0 | 0 | 61 → 14 |
| incremental | 2255 | 51 | 14 | 0 | 0 | 0 | 148 → 14 |
| text | 2318 | 0 | 0 | 0 | 2 | 0 | 2 → 2 |
| docx | 2311 | 0 | 0 | 0 | 9 | 0 | 10 → 9 |
| compress | 2306 | 0 | 9 | 2 | 1 | 0 | 49 → 12 |
| pdfa | 592 | 0 | 1 | 1 | 1 | 0 | 12 → 3 |
| signature | 62 | 0 | 0 | 0 | 0 | 0 | 0 → 0 |
| pdfua | 2307 | 0 | 9 | 0 | 0 | 0 | 45 → 9 |
| hidden | 2307 | 0 | 9 | 0 | 0 | 0 | 57 → 9 |
| redact | 1572 | 0 | 1 | 5 | 0 | 0 | 66 → 6 |
| search | 1239 | 0 | 1 | 5 | 0 | 0 | 31 → 6 |
## Failure signatures

| Count | Stage · status · signature | Examples |
|---|---|---|
| 15 | open · error · InvalidPDFException: Invalid PDF structure. \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669 | `pdfium/testing__resources__bug_1327884.pdf`, `pdfium/testing__resources__pixel__bug_828206.pdf`, `qpdf/examples__qtest__bookmarks__3.pdf` |
| 11 | open · error · Error: not opened (InvalidPDFException: Invalid Root reference. \| BaseExceptionClosure@pdf.mjs:N < pdf.mjs); repair failed (Error: No recoverable p \| run.Cm2sd7-x.js:2794 | `pdfium/testing__resources__bug_113.pdf`, `pdfium/testing__resources__bug_1324189.pdf`, `pdfium/testing__resources__bug_1324503.pdf` |
| 11 | open · error · Error: not opened (InvalidPDFException: Invalid PDF structure. \| BaseExceptionClosure@pdf.mjs:N < pdf.mjs:); repair failed (Error: No recoverable p \| run.Cm2sd7-x.js:2794 | `pdfium/testing__resources__bug_298.pdf`, `pdfium/testing__resources__bug_325_a.pdf`, `pdfium/testing__resources__bug_325_b.pdf` |
| 7 | docx · timeout · timeout 60000 ms | `pdfjs-links/bug1199237.pdf`, `pdfjs/issue12963.pdf`, `pdfjs-links/issue15559.pdf` |
| 6 | open · error · Error: Invalid page request. \| WorkerTransport.getPage@pdf.mjs:23402 < PDFDocumentProxy.getPage@pdf.mjs:22214 | `qpdf/examples__qtest__name-number-tree__out.pdf`, `qpdf/qpdf__qtest__qpdf__c-empty.pdf`, `qpdf/qpdf__qtest__qpdf__empty.pdf` |
| 6 | open · error · UnknownErrorException: Bad (uncompressed) XRef entry: NR \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669 | `qpdf/qpdf__qtest__qpdf__bad-xref-entry.pdf`, `qpdf/qpdf__qtest__qpdf__bad25.pdf`, `qpdf/qpdf__qtest__qpdf__bad26.pdf` |
| 5 | search · wrong · search: "…" not found | `pdfjs/issue6132.pdf`, `pdfjs-links/issue13971.pdf`, `qpdf/qpdf__qtest__qpdf__split-content-stream.pdf` |
| 4 | open · timeout · hang | `pdfjs-links/issue15492.pdf`, `pdfjs/axial_shading_many_inputs.pdf`, `pdfjs/tiling-pattern-tiny-steps-large.pdf` |
| 3 | open · error · Error: Create skia surface failed \| Object.createCanvas@index.js:137 < NodeCanvasFactory._createCanvas@pdf.mjs:16143 | `pdfjs-links/issue17190.pdf`, `pdfjs-links/issue17190_1.pdf`, `pdfjs-links/issue7802.pdf` |
| 3 | redact · wrong · redact: page 1 text around the box lost (n -> m chars) | `pdfjs/issue20513.pdf`, `pdfjs-links/issue10004.pdf`, `pdfjs-links/issue21089.pdf` |
| 3 | incremental · error · Error: This PDF has no cross-reference table, so it cannot be updated incrementally. \| incrementalUpdate@incremental.ts:113 < buildIncrementalPdf@exportPdf.ts:1648 | `pdfjs/poppler-85140-0.pdf`, `pdfium/testing__resources__bug_455199.pdf`, `pdfjs/bug1980958.pdf` |
| 3 | save · error · Error: Failed to parse PDF document (line:N col:N offset=N): No PDF header found \| MissingPDFHeaderError.PDFParsingError [as constructor]@errors.js:229 < new MissingPDFHeaderError@errors.js:306 | `qpdf/qpdf__qtest__qpdf__fuzz-16214.pdf`, `qpdf/qpdf__qtest__qpdf__inspect.pdf`, `pdfium/testing__resources__javascript__xfa_specific__bug_1238_2.pdf` |
| 3 | incremental · error · Error: Failed to parse PDF document (line:N col:N offset=N): No PDF header found \| MissingPDFHeaderError.PDFParsingError [as constructor]@errors.js:229 < new MissingPDFHeaderError@errors.js:306 | `qpdf/qpdf__qtest__qpdf__fuzz-16214.pdf`, `qpdf/qpdf__qtest__qpdf__inspect.pdf`, `pdfium/testing__resources__javascript__xfa_specific__bug_1238_2.pdf` |
| 3 | compress · error · Error: Failed to parse PDF document (line:N col:N offset=N): No PDF header found \| MissingPDFHeaderError.PDFParsingError [as constructor]@errors.js:229 < new MissingPDFHeaderError@errors.js:306 | `qpdf/qpdf__qtest__qpdf__fuzz-16214.pdf`, `qpdf/qpdf__qtest__qpdf__inspect.pdf`, `pdfium/testing__resources__javascript__xfa_specific__bug_1238_2.pdf` |
| 3 | pdfua · error · Error: Failed to parse PDF document (line:N col:N offset=N): No PDF header found \| MissingPDFHeaderError.PDFParsingError [as constructor]@errors.js:229 < new MissingPDFHeaderError@errors.js:306 | `qpdf/qpdf__qtest__qpdf__fuzz-16214.pdf`, `qpdf/qpdf__qtest__qpdf__inspect.pdf`, `pdfium/testing__resources__javascript__xfa_specific__bug_1238_2.pdf` |
| 3 | hidden · error · Error: Failed to parse PDF document (line:N col:N offset=N): No PDF header found \| MissingPDFHeaderError.PDFParsingError [as constructor]@errors.js:229 < new MissingPDFHeaderError@errors.js:306 | `qpdf/qpdf__qtest__qpdf__fuzz-16214.pdf`, `qpdf/qpdf__qtest__qpdf__inspect.pdf`, `pdfium/testing__resources__javascript__xfa_specific__bug_1238_2.pdf` |
| 2 | save · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__annotiter.pdf`, `pdfjs/Brotli-Prototype-FileA.pdf` |
| 2 | save · wrong · save: page 1 text lost (n -> m chars) | `pdfium/testing__resources__bug_1139.pdf`, `pdfjs-links/issue10004.pdf` |
| 2 | open · error · InvalidPDFException: Invalid Root reference. \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669 | `pdfium/testing__resources__pixel__bug_830221.pdf`, `qpdf/qpdf__qtest__qpdf__issue-141a.pdf` |
| 2 | incremental · error · ExportError: A page of this document could not be read. \| exportPdf.ts:1651 < incrementalUpdate@incremental.ts:121 | `pdfium/testing__resources__pixel__direct_content_stream.pdf`, `pdfium/testing__resources__bug_481363.pdf` |
| 2 | open · error · UnknownErrorException: Illegal character: N \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669 | `qpdf/qpdf__qtest__qpdf__issue-263.pdf`, `qpdf/qpdf__qtest__qpdf__issue-335a.pdf` |
| 2 | save · wrong · save: output does not open (InvalidPDFException: Invalid Root reference. \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669) | `pdfium/testing__resources__bug_455199.pdf`, `pdfjs/bug1980958.pdf` |
| 2 | text · timeout · timeout 60000 ms | `pdfjs-links/bug810214.pdf`, `pdfjs-links/bug858128.pdf` |
| 2 | docx · timeout · timeout | `pdfjs-links/bug810214.pdf`, `pdfjs-links/bug858128.pdf` |
| 1 | pdfa · timeout · timeout | `pdfjs/issue12963.pdf` |
| 1 | save · error · Error: Expected instance of PDFArray, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__bug_216.pdf` |
| 1 | incremental · error · Error: Expected instance of PDFArray, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__bug_216.pdf` |
| 1 | compress · error · Error: Expected instance of PDFArray, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__bug_216.pdf` |
| 1 | pdfua · error · Error: Expected instance of PDFArray, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__bug_216.pdf` |
| 1 | hidden · error · Error: Expected instance of PDFArray, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__bug_216.pdf` |
| 1 | open · error · Error: not opened (InvalidPDFException: Invalid PDF structure. \| BaseExceptionClosure@pdf.mjs:N < pdf.mjs:); repair failed (Error: This PDF is encr \| run.Cm2sd7-x.js:2794 | `pdfium/testing__resources__bug_424613308.pdf` |
| 1 | compress · timeout · timeout | `pdfjs-links/issue15559.pdf` |
| 1 | incremental · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfjs/Brotli-Prototype-FileA.pdf` |
| 1 | compress · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfjs/Brotli-Prototype-FileA.pdf` |
| 1 | pdfua · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfjs/Brotli-Prototype-FileA.pdf` |
| 1 | hidden · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfjs/Brotli-Prototype-FileA.pdf` |
| 1 | redact · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfjs/Brotli-Prototype-FileA.pdf` |
| 1 | search · error · Error: Expected instance of PDFDict, but got instance of undefined \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfjs/Brotli-Prototype-FileA.pdf` |
| 1 | open · error · Error: not opened (UnknownErrorException: Illegal character: N \| BaseExceptionClosure@pdf.mjs:N < pdf.mjs:); repair failed (Error: This PDF is encr \| run.Cm2sd7-x.js:2794 | `pdfjs/poppler-742-0-fuzzed.pdf` |
| 1 | pdfa · wrong · pdfa: page count | `pdfjs/poppler-85140-0.pdf` |
| 1 | open · error · UnknownErrorException: Bad encoding in flate stream \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669 | `pdfjs/poppler-90-0-fuzzed.pdf` |
| 1 | open · error · Error: not opened (UnknownErrorException: End of file inside array. \| BaseExceptionClosure@pdf.mjs:N < pdf); repair failed (Error: No recoverable p \| run.Cm2sd7-x.js:2794 | `pdfjs/poppler-937-0-fuzzed.pdf` |
| 1 | open · error · Error: [`Get shader of radial gradient failed`] \| CanvasGraphics.shadingFill@pdf.mjs:18974 < CanvasGraphics.executeOperatorList@pdf.mjs:17493 | `pdfjs/type3_glyph_error.pdf` |
| 1 | open · error · UnknownErrorException: Missing endstream command. \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669 | `qpdf/qpdf__qtest__qpdf__bad24.pdf` |
| 1 | open · error · Error: not opened (UnknownErrorException: Maximum call stack size exceeded \| BaseExceptionClosure@pdf.mjs:N); repair failed (Error: No recoverable  \| run.Cm2sd7-x.js:2794 | `qpdf/qpdf__qtest__qpdf__issue-146.pdf` |
| 1 | compress · wrong · compress: output does not open (InvalidPDFException: Invalid Root reference. \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669) | `pdfium/testing__resources__bug_455199.pdf` |
| 1 | redact · wrong · redact: output does not open (InvalidPDFException: Invalid Root reference. \| BaseExceptionClosure@pdf.mjs:6666 < pdf.mjs:6669) | `pdfium/testing__resources__bug_455199.pdf` |
| 1 | compress · wrong · compress: page count | `pdfium/testing__resources__bug_481363.pdf` |
| 1 | open · error · Error: not opened (UnknownErrorException: Pages tree contains circular reference. \| BaseExceptionClosure@pdf.); repair failed (Error: No recoverabl \| run.Cm2sd7-x.js:2794 | `pdfium/testing__resources__bug_544880.pdf` |
| 1 | save · error · TypeError: _this.catalog.Pages is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfium/testing__resources__bug_709793.pdf` |
| 1 | incremental · error · TypeError: _this.catalog.Pages is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfium/testing__resources__bug_709793.pdf` |
| 1 | compress · error · TypeError: _this.catalog.Pages is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfium/testing__resources__bug_709793.pdf` |
| 1 | pdfua · error · TypeError: _this.catalog.Pages is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfium/testing__resources__bug_709793.pdf` |
| 1 | hidden · error · TypeError: _this.catalog.Pages is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfium/testing__resources__bug_709793.pdf` |
| 1 | save · error · TypeError: `ref` must be of type `PDFRef`, but was actually of type `NaN` \| exports.assertIs@validators.js:140 < new PDFPage@PDFPage.js:27 | `pdfjs-links/issue9540.pdf` |
| 1 | incremental · error · TypeError: `ref` must be of type `PDFRef`, but was actually of type `NaN` \| exports.assertIs@validators.js:140 < new PDFPage@PDFPage.js:27 | `pdfjs-links/issue9540.pdf` |
| 1 | compress · error · TypeError: `ref` must be of type `PDFRef`, but was actually of type `NaN` \| exports.assertIs@validators.js:140 < new PDFPage@PDFPage.js:27 | `pdfjs-links/issue9540.pdf` |
| 1 | pdfua · error · TypeError: `ref` must be of type `PDFRef`, but was actually of type `NaN` \| exports.assertIs@validators.js:140 < new PDFPage@PDFPage.js:27 | `pdfjs-links/issue9540.pdf` |
| 1 | hidden · error · TypeError: `ref` must be of type `PDFRef`, but was actually of type `NaN` \| exports.assertIs@validators.js:140 < new PDFPage@PDFPage.js:27 | `pdfjs-links/issue9540.pdf` |
| 1 | redact · wrong · redact: text under the box survived | `pdfjs/bug1245391_reduced.pdf` |
| 1 | pdfa · error · Error: Failed to parse PDF document (line:N col:N offset=N): No PDF header found \| MissingPDFHeaderError.PDFParsingError [as constructor]@errors.js:229 < new MissingPDFHeaderError@errors.js:306 | `pdfium/testing__resources__javascript__xfa_specific__bug_1238_2.pdf` |
| 1 | save · error · Error: Expected instance of PDFDict, but got instance of PDFInvalidObject \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__redirect.pdf` |
| 1 | incremental · error · Error: Expected instance of PDFDict, but got instance of PDFInvalidObject \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__redirect.pdf` |
| 1 | compress · error · Error: Expected instance of PDFDict, but got instance of PDFInvalidObject \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__redirect.pdf` |
| 1 | pdfua · error · Error: Expected instance of PDFDict, but got instance of PDFInvalidObject \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__redirect.pdf` |
| 1 | hidden · error · Error: Expected instance of PDFDict, but got instance of PDFInvalidObject \| new UnexpectedObjectTypeError@errors.js:38 < PDFContext.lookup@PDFContext.js:95 | `pdfium/testing__resources__redirect.pdf` |
| 1 | save · error · TypeError: _this.catalog.Pages(...).traverse is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfjs/issue15590.pdf` |
| 1 | incremental · error · TypeError: _this.catalog.Pages(...).traverse is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfjs/issue15590.pdf` |
| 1 | compress · error · TypeError: _this.catalog.Pages(...).traverse is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfjs/issue15590.pdf` |
| 1 | pdfua · error · TypeError: _this.catalog.Pages(...).traverse is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfjs/issue15590.pdf` |
| 1 | hidden · error · TypeError: _this.catalog.Pages(...).traverse is not a function \| PDFDocument.computePages [as populate]@PDFDocument.js:28 < Cache.access@Cache.js:13 | `pdfjs/issue15590.pdf` |
| 1 | open · crash · oom | `pdfjs/issue_cmap12.pdf` |

## Slowest files

- 172 s `pdfjs/bug1978317.pdf`
- 139 s `pdfjs-links/issue10989.pdf`
- 134 s (not shown)
- 132 s `qpdf/qpdf__qtest__qpdf__shared-unnamed-field.pdf`
- 128 s `pdfjs/issue16263.pdf`
- 117 s `pdfjs-links/bug1901253.pdf`
- 83 s `pdfjs-links/issue19281.pdf`
- 73 s `pdfium/testing__resources__bug_2034.pdf`
- 73 s `pdfjs-links/issue16127.pdf`
- 70 s `pdfium/testing__resources__bug_1646.pdf`
