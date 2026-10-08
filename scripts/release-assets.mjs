#!/usr/bin/env node
/**
 * After a signed release build (npm run desktop:build:release): copies the NSIS
 * setup and its updater signature (.sig) to an output folder under the names the
 * GitHub release uses, and writes latest.json for the in-app updater.
 *
 *   node scripts/release-assets.mjs [--out dir] [--notes "text" | --notes-file notes.md] [--bundle-dir dir]
 *
 * Upload all three files to the release v<version> (gh release upload v<v> <out>/*):
 * the updater reads releases/latest/download/latest.json, whose url must name
 * exactly the uploaded installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'unupunct/AdikaPDF';
export const installerName = (version) => `AdikaPDF_${version}_x64-setup.exe`;
export const installerUrl = (version) => `https://github.com/${REPO}/releases/download/v${version}/${installerName(version)}`;

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

export function main(argv = process.argv.slice(2)) {
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
  console.log(`Release assets for v${version} in ${out}:`);
  for (const f of [installerName(version), `${installerName(version)}.sig`, 'latest.json']) console.log(`  ${f}`);
  console.log(`Upload: gh release upload v${version} "${path.join(out, '*')}" (or list the three files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
