/**
 * Feasibility check on ANAF "PDF inteligent" declaration forms (not part of
 * `npm test`; the forms are not in the repository):
 *   ANAF_DIR=D:\MyAIProjects\AdikaPDF\.tools\anaf-forms npx vitest run --config tests/manual/vitest.config.ts tests/manual/anafForms.run.ts
 * For every PDF in ANAF_DIR: does pdf.js lay out the dynamic XFA, how many
 * inputs it produces, can a value be written back (fillXfaData), and what
 * the XFA script prototype (src/lib/pdf/xfaScript) makes of the form's
 * scripts. Results are printed and written to ANAF_DIR/report.json.
 */
import { it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { fillXfaData, readXfaPackets, xfaInputs, xfaKind, type XfaHtmlNode } from '../../src/lib/pdf/xfa';
import { buildXfaModel } from '../../src/lib/pdf/xfaScript/model';
import { runXfaScripts } from '../../src/lib/pdf/xfaScript/run';
import { quickJsEngine, nodeVmEngine } from '../../src/lib/pdf/xfaScript/engines';
import { loadQuickSandbox } from '../helpers/sandboxEnv';

const DIR = process.env.ANAF_DIR ?? 'D:/MyAIProjects/AdikaPDF/.tools/anaf-forms';
const ENGINE = process.env.ANAF_ENGINE ?? 'quickjs';
const ONLY = process.env.ANAF_ONLY;

it('ANAF forms', { timeout: 30 * 60_000 }, async () => {
  if (!existsSync(DIR)) return;
  const files = readdirSync(DIR).filter((f) => /^D\d+.*\.pdf$/i.test(f) && (!ONLY || f.includes(ONLY)));
  const report: Record<string, unknown> = {};
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(DIR, f)));
    const r: Record<string, unknown> = { size: bytes.length };
    report[f] = r;
    r.kind = await xfaKind(bytes);
    // 1. Layout by pdf.js' XFA engine.
    let t = performance.now();
    const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: true, verbosity: 0, standardFontDataUrl: join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/') + '/' });
    const doc = await task.promise;
    r.isPureXfa = doc.isPureXfa;
    r.numPages = doc.numPages;
    const html = doc.allXfaHtml as XfaHtmlNode | null;
    const inputs = xfaInputs(html?.children ?? []);
    r.layoutMs = Math.round(performance.now() - t);
    r.inputs = inputs.length;
    r.inputTypes = inputs.reduce<Record<string, number>>((a, i) => ((a[i.type] = (a[i.type] ?? 0) + 1), a), {});
    r.sampleInputs = inputs.slice(0, 6).map((i) => i.name);
    // 2. Write a value back into the original (what Save does after filling).
    const firstText = inputs.find((i) => i.type === 'text');
    await task.destroy();
    if (firstText) {
      t = performance.now();
      const saved = await fillXfaData(pdfjs as never, bytes, { [firstText.name]: '12345678' }, { standardFontDataUrl: join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/') + '/' });
      r.fillMs = Math.round(performance.now() - t);
      r.savedGrowth = saved.length - bytes.length;
      r.savedIsIncremental = Buffer.from(saved.subarray(0, bytes.length)).equals(Buffer.from(bytes));
      const after = readXfaPackets(await PDFDocument.load(saved, { updateMetadata: false, ignoreEncryption: true }));
      const ds = after?.find(([n]) => n === 'datasets')?.[1] ?? '';
      r.valueInDatasets = ds.includes('12345678');
    }
    // 3. The form's own scripts in the prototype runtime.
    const packets = readXfaPackets(await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }))!;
    const template = packets.find(([n]) => n === 'template')![1];
    t = performance.now();
    const model = buildXfaModel(template);
    r.modelMs = Math.round(performance.now() - t);
    const engine = ENGINE === 'node' ? nodeVmEngine() : quickJsEngine(await loadQuickSandbox(), (globalThis as unknown as { window: never }).window);
    t = performance.now();
    // ANAF_STEPS: a JSON file { "D100": [["fill", som, value], ["pick", regex], ["click", som]…] } (keyed by form)
    const steps = process.env.ANAF_STEPS ? (JSON.parse(readFileSync(process.env.ANAF_STEPS, 'utf8')) as Record<string, never>)[f.split('_')[0]] : undefined;
    const run = await runXfaScripts(engine, model, {
      steps,
      click: process.env.ANAF_CLICK?.split(',').filter(Boolean),
      allEvents: process.env.ANAF_ALL === '1',
      allClicks: process.env.ANAF_ALL === '1',
      stacks: true,
    });
    r.model = model.stats;
    r.scriptMs = Math.round(performance.now() - t);
    r.scripts = run.summary;
    r.errors = run.errors.slice(0, 40);
    r.messages = run.messages.slice(0, 15);
    r.dataObjects = run.dataObjects.map((d) => ({ name: d.name, length: d.contents.length, head: d.contents.slice(0, 300) }));
    for (const d of run.dataObjects) writeFileSync(join(DIR, `out-${ENGINE}-${f.split('_')[0]}-${d.name.replace(/[^\w.-]+/g, '_')}`), d.contents);
    console.log(f, JSON.stringify(r, null, 1));
  }
  writeFileSync(join(DIR, `report-${ENGINE}.json`), JSON.stringify(report, null, 1));
});

/**
 * ANAF_PACKAGE=<form file name> ANAF_XML=<declaration XML>: the "PDF + XML +
 * signature" package Acrobat produces after Validare and Sign — the XML as an
 * embedded file (incremental update) and a PAdES signature with a throwaway
 * test certificate. Checks what survives: XFA, the UR3 usage rights, the
 * attachment, the signature.
 */
it('ANAF package (attach XML, sign)', { timeout: 10 * 60_000 }, async () => {
  const name = process.env.ANAF_PACKAGE;
  const xmlPath = process.env.ANAF_XML;
  if (!name || !xmlPath) return;
  const { incrementalUpdate } = await import('../../src/lib/pdf/incremental');
  const { signPdf, verifyPdfSignatures } = await import('../../src/lib/crypto/digitalSignature');
  const { issue, identityOf } = await import('../helpers/sigPki');
  const original = new Uint8Array(readFileSync(join(DIR, name)));
  const xml = new Uint8Array(readFileSync(xmlPath));
  const xmlName = xmlPath.split(/[\\/]/).pop()!.replace(/^out-\w+-\w+-/, '');
  const attached = await incrementalUpdate(original, (d) => {
    const ef = d.context.flateStream(xml, { Type: 'EmbeddedFile', Subtype: 'text/xml', Params: { Size: xml.length } });
    const efRef = d.context.register(ef);
    const spec = d.context.register(d.context.obj({ Type: 'Filespec', F: PDFString.of(xmlName), UF: PDFHexString.fromText(xmlName), EF: { F: efRef } }));
    let names = d.catalog.lookup(PDFName.of('Names'));
    if (!(names instanceof PDFDict)) {
      names = d.context.obj({});
      d.catalog.set(PDFName.of('Names'), d.context.register(names as PDFDict));
    }
    (names as PDFDict).set(PDFName.of('EmbeddedFiles'), d.context.register(d.context.obj({ Names: [PDFString.of(xmlName), spec] })));
  });
  const ca = await issue({ cn: 'Test Root', ca: true, bits: 1024 });
  const leaf = await issue({ cn: 'POPESCU ION', issuer: ca, bits: 1024 });
  const signed = await signPdf(attached.bytes, { identity: identityOf(leaf, [ca.cert]), pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
  const out: Record<string, unknown> = {};
  const check = async (label: string, bytes: Uint8Array) => {
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    const acro = d.catalog.lookup(PDFName.of('AcroForm'));
    const names = d.catalog.lookup(PDFName.of('Names'));
    const ef = names instanceof PDFDict ? names.lookup(PDFName.of('EmbeddedFiles')) : null;
    out[label] = {
      size: bytes.length,
      keepsOriginalBytes: Buffer.from(bytes.subarray(0, original.length)).equals(Buffer.from(original)),
      xfa: acro instanceof PDFDict && acro.has(PDFName.of('XFA')),
      needsRendering: d.catalog.has(PDFName.of('NeedsRendering')),
      ur3: d.catalog.lookup(PDFName.of('Perms')) instanceof PDFDict,
      embeddedFiles: ef instanceof PDFDict ? ((ef.lookup(PDFName.of('Names')) as PDFArray | undefined)?.size() ?? 0) / 2 : 0,
    };
  };
  await check('attached', attached.bytes);
  await check('signed', signed);
  out.signatures = (await verifyPdfSignatures(signed)).map((s) => ({ field: s.fieldName, integrity: s.integrity, wholeFile: s.coversWholeFile, signer: s.signerName }));
  writeFileSync(join(DIR, `package-${name}`), signed);
  writeFileSync(join(DIR, 'package-report.json'), JSON.stringify(out, null, 1));
});
