/**
 * After a signed release build (npm run desktop:build:release): copies the NSIS
 * setup and its updater signature (.sig) to an output folder under the names the
 * GitHub release uses, writes latest.json for the in-app updater, and packs the
 * portable ZIP (the exe with portable.ini: no installer, data next to the exe).
 *
 *   node scripts/release-assets.mjs [--out dir] [--notes "text" | --notes-file notes.md] [--bundle-dir dir] [--exe path]
 *
 * Upload all four files to the release v<version> (the command is printed):
 * the updater reads releases/latest/download/latest.json, whose url must name
 * exactly the uploaded installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

export const REPO = 'unupunct/AdikaPDF';
export const installerName = (version) => `AdikaPDF_${version}_x64-setup.exe`;
export const installerUrl = (version) => `https://github.com/${REPO}/releases/download/v${version}/${installerName(version)}`;
export const portableName = (version) => `AdikaPDF_${version}_x64-portable.zip`;
export const PORTABLE_FOLDER = 'Adika PDF Editor';

export const PORTABLE_INI = [
  '; Adika PDF Editor, portable copy.',
  '; While this file is next to adika-pdf-editor.exe, settings, recovery backups, logs',
  '; and caches are kept in the Data folder here, and nothing is written to the registry.',
  '; Delete this file to use the profile folders of the Windows account instead.',
  '[Adika]',
  'Portable=1',
  '',
].join('\r\n');

export const PORTABLE_README = [
  'Adika PDF Editor - portable copy',
  '',
  'Run adika-pdf-editor.exe. Nothing is installed: settings, recovery backups, logs and',
  'caches go to the Data folder next to the exe (created at the first start), so the',
  'folder can live on a USB stick. Delete the folder to remove everything.',
  '',
  'Not in the portable copy: the "Adika PDF Editor" virtual printer, the Explorer',
  'menu entries and PDF thumbnails, and the .pdf file association (use the installer',
  'for those).',
  '',
  'Needs the Microsoft Edge WebView2 Runtime (part of Windows 10 and 11). If it is',
  'missing Adika says so; get it from https://go.microsoft.com/fwlink/p/?LinkId=2124703',
  '',
  'Updates: About > Check for updates finds new versions and downloads the new',
  'portable ZIP; unpack it over this folder (the Data folder stays).',
  '',
].join('\r\n');

/**
 * The portable ZIP's files. The exe holds the whole interface (pdf.js, OCR data
 * and fonts are embedded); printer.ps1, adika_thumbs.dll and uninstall.exe belong
 * to the installer only.
 */
export function portableEntries({ exe, license }) {
  const at = (name) => `${PORTABLE_FOLDER}/${name}`;
  return [
    { name: at('adika-pdf-editor.exe'), file: exe },
    { name: at('portable.ini'), text: PORTABLE_INI },
    { name: at('README-portable.txt'), text: PORTABLE_README },
    { name: at('LICENSE.txt'), file: license },
  ];
}

export async function buildPortableZip(entries) {
  const zip = new JSZip();
  const when = new Date();
  for (const e of entries) zip.file(e.name, e.file ? fs.readFileSync(e.file) : e.text, { date: when });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'DOS' });
}

/** The release exe tauri built next to the setup (signed in place before bundling). */
export function findExe(target, setupExe, given) {
  const exe = given ? path.resolve(given) : path.join(target, 'release', 'adika-pdf-editor.exe');
  if (!fs.existsSync(exe)) throw new Error(`No ${exe}: build with npm run desktop:build:release first.`);
  // Built (and signed) shortly before the setup; a much older exe is from an earlier build.
  if (fs.statSync(exe).mtimeMs + 6 * 3600 * 1000 < fs.statSync(setupExe).mtimeMs) throw new Error(`${exe} is older than the installer: rebuild with npm run desktop:build:release.`);
  return exe;
}

/** The updater manifest (Tauri v2 "static JSON" format). */
export function buildLatestJson({ version, notes, signature, pubDate = new Date() }) {
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Not a semantic version: ${version}`);
  const sig = String(signature ?? '').trim();
  if (!sig) throw new Error('The updater signature is empty.');
  return {
    version,
    notes: notes ?? '',
    pub_date: (pubDate instanceof Date ? pubDate : new Date(pubDate)).toISOString(),
    platforms: {
      'windows-x86_64': { signature: sig, url: installerUrl(version) },
    },
  };
}

/** The NSIS setup tauri built for this version, and its .sig (newer than the setup, or it is stale). */
export function findInstaller(bundleDir, version) {
  if (!fs.existsSync(bundleDir)) throw new Error(`No NSIS bundle folder: ${bundleDir}. Run npm run desktop:build:release first.`);
  const setup = fs.readdirSync(bundleDir).find((f) => f.endsWith(`_${version}_x64-setup.exe`));
  if (!setup) throw new Error(`No *_${version}_x64-setup.exe in ${bundleDir}. Is package.json's version the one you built?`);
  const exe = path.join(bundleDir, setup);
  const sig = `${exe}.sig`;
  if (!fs.existsSync(sig)) throw new Error(`${path.basename(sig)} is missing: build with npm run desktop:build:release (it sets the updater signing key).`);
  if (fs.statSync(sig).mtimeMs + 2000 < fs.statSync(exe).mtimeMs) throw new Error(`${path.basename(sig)} is older than the installer: rebuild with npm run desktop:build:release.`);
  return { exe, sig };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri', 'target');
  const bundleDir = path.resolve(arg(argv, '--bundle-dir') ?? path.join(target, 'release', 'bundle', 'nsis'));
  const out = path.resolve(arg(argv, '--out') ?? path.join(root, 'release-assets', `v${version}`));
  const notesFile = arg(argv, '--notes-file');
  const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : (arg(argv, '--notes') ?? `See https://github.com/${REPO}/releases/tag/v${version}`);

  const { exe, sig } = findInstaller(bundleDir, version);
  const signature = fs.readFileSync(sig, 'utf8');
  const latest = buildLatestJson({ version, notes, signature });
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(exe, path.join(out, installerName(version)));
  fs.writeFileSync(path.join(out, `${installerName(version)}.sig`), signature);
  fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  const zip = await buildPortableZip(portableEntries({ exe: findExe(target, exe, arg(argv, '--exe')), license: path.join(root, 'LICENSE') }));
  fs.writeFileSync(path.join(out, portableName(version)), zip);
  const files = [installerName(version), `${installerName(version)}.sig`, 'latest.json', portableName(version)];
  console.log(`Release assets for v${version} in ${out}:`);
  for (const f of files) console.log(`  ${f}`);
  console.log(`Upload: gh release upload v${version} ${files.map((f) => `"${path.join(out, f)}"`).join(' ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
