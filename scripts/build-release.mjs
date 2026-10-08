/**
 * Release build: `tauri build` with updater artifacts (the NSIS setup's .sig).
 * The updater signing key comes from TAURI_SIGNING_PRIVATE_KEY when set, else
 * from TAURI_SIGNING_PRIVATE_KEY_PATH or %USERPROFILE%\.tauri\adika-updater.key
 * (read into the build's environment only, never printed). Password:
 * TAURI_SIGNING_PRIVATE_KEY_PASSWORD (empty when unset).
 * Authenticode signing is separate (scripts/sign.mjs, its own env vars).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.tauri', 'adika-updater.key');
  if (!fs.existsSync(keyPath)) {
    console.error(`No updater signing key: set TAURI_SIGNING_PRIVATE_KEY or put the key at ${keyPath}.`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8').trim();
  console.log(`Updater signing key: ${keyPath}`);
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const overlay = path.join(root, 'src-tauri', 'tauri.release.conf.json');
const r = spawnSync(process.execPath, [cli, 'build', '--config', overlay, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
