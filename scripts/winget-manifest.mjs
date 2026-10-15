/**
 * winget manifests (version, installer, en-US and ro-RO locale) for a release,
 * with the SHA-256 of the setup in release-assets (npm run release:assets first).
 *
 *   node scripts/winget-manifest.mjs [--version 1.14.0] [--installer path] [--out dir] [--date YYYY-MM-DD]
 *
 * Writes deploy/winget/manifests/u/unupunct/AdikaPDFEditor/<version>/. Submitting
 * them to microsoft/winget-pkgs is the owner's decision (README "winget").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installerName, installerUrl, REPO } from './release-assets.mjs';

export const PACKAGE_ID = 'unupunct.AdikaPDFEditor';
export const MANIFEST_VERSION = '1.6.0';
/** The uninstall key name the NSIS setup writes (Apps & features entry). */
export const PRODUCT_CODE = 'Adika PDF Editor';

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

const header = (kind) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${MANIFEST_VERSION}.schema.json\n`;
/** YAML single-quoted scalar. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function manifestDir(version) {
  return path.join('manifests', 'u', 'unupunct', 'AdikaPDFEditor', version);
}

/** File name → content of the four manifests. */
export function buildManifests({ version, sha256, releaseDate }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!/^[0-9A-F]{64}$/i.test(sha256)) throw new Error('InstallerSha256 must be 64 hex digits.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new Error(`ReleaseDate must be YYYY-MM-DD: ${releaseDate}`);
  const sha = sha256.toUpperCase();
  const url = installerUrl(version);
  const files = {};
  files[`${PACKAGE_ID}.yaml`] =
    header('version') +
    `PackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${version}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: ${MANIFEST_VERSION}\n`;
  const installer = (scope, custom) =>
    `- Architecture: x64\n  Scope: ${scope}\n  InstallerUrl: ${url}\n  InstallerSha256: ${sha}\n  InstallerSwitches:\n    Custom: ${custom}\n`;
  files[`${PACKAGE_ID}.installer.yaml`] =
    header('installer') +
    `PackageIdentifier: ${PACKAGE_ID}\n` +
    `PackageVersion: ${version}\n` +
    `InstallerLocale: en-US\n` +
    `MinimumOSVersion: 10.0.17763.0\n` +
    `InstallerType: nullsoft\n` +
    `InstallModes:\n- interactive\n- silent\n- silentWithProgress\n` +
    `InstallerSwitches:\n  Silent: /S\n  SilentWithProgress: /P\n` +
    `UpgradeBehavior: install\n` +
    `FileExtensions:\n- pdf\n` +
    `ProductCode: ${q(PRODUCT_CODE)}\n` +
    `ReleaseDate: ${releaseDate}\n` +
    `AppsAndFeaturesEntries:\n- DisplayName: ${q(PRODUCT_CODE)}\n  Publisher: unupunct\n  ProductCode: ${q(PRODUCT_CODE)}\n` +
    `Installers:\n` +
    installer('user', '/CURRENTUSER') +
    installer('machine', '/ALLUSERS') +
    `ManifestType: installer\nManifestVersion: ${MANIFEST_VERSION}\n`;
  const locale = (loc, kind, t) =>
    header(kind) +
    `PackageIdentifier: ${PACKAGE_ID}\n` +
    `PackageVersion: ${version}\n` +
    `PackageLocale: ${loc}\n` +
    `Publisher: unupunct\n` +
    `PublisherUrl: https://github.com/unupunct\n` +
    `PublisherSupportUrl: https://github.com/${REPO}/issues\n` +
    `PackageName: Adika PDF Editor\n` +
    `PackageUrl: https://github.com/${REPO}\n` +
    `License: MIT\n` +
    `LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE\n` +
    `Copyright: ${q('Copyright (c) 2026 unupunct')}\n` +
    `ShortDescription: ${q(t.short)}\n` +
    `Description: ${q(t.long)}\n` +
    (kind === 'defaultLocale' ? `Moniker: adikapdf\n` : '') +
    `Tags:\n${t.tags.map((x) => `- ${x}\n`).join('')}` +
    `ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}\n` +
    `ManifestType: ${kind}\nManifestVersion: ${MANIFEST_VERSION}\n`;
  files[`${PACKAGE_ID}.locale.en-US.yaml`] = locale('en-US', 'defaultLocale', {
    short: 'Privacy-first offline PDF editor with e-signatures',
    long: 'Adika PDF Editor reads, comments, edits, signs, organises, protects, OCRs and converts PDF files entirely on your computer. No uploads.',
    tags: ['pdf', 'pdf-editor', 'e-signature', 'ocr', 'offline'],
  });
  files[`${PACKAGE_ID}.locale.ro-RO.yaml`] = locale('ro-RO', 'locale', {
    short: 'Editor PDF offline, cu semnături electronice, care îți păstrează confidențialitatea',
    long: 'Adika PDF Editor citește, comentează, editează, semnează, organizează, protejează, recunoaște text (OCR) și convertește fișiere PDF numai pe calculatorul tău. Nimic nu este încărcat online.',
    tags: ['pdf', 'editor-pdf', 'semnatura-electronica', 'ocr', 'offline'],
  });
  return files;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = arg(argv, '--version') ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const setup = path.resolve(arg(argv, '--installer') ?? path.join(root, 'release-assets', `v${version}`, installerName(version)));
  if (!fs.existsSync(setup)) throw new Error(`No ${setup}: run npm run release:assets first (the hash must be the uploaded file's).`);
  const releaseDate = arg(argv, '--date') ?? new Date().toISOString().slice(0, 10);
  const out = path.resolve(arg(argv, '--out') ?? path.join(root, 'deploy', 'winget', manifestDir(version)));
  const files = buildManifests({ version, sha256: sha256File(setup), releaseDate });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);
  console.log(`winget manifests for ${PACKAGE_ID} ${version} in ${out}`);
  console.log(`Check: winget validate --manifest "${out}"   Test: winget install --manifest "${out}"`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
