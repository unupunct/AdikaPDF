/**
 * Authenticode signing hook: tauri.conf.json bundle.windows.signCommand calls it
 * for the app exe, the NSIS installer and uninstaller; build:thumbs calls it for
 * adika_thumbs.dll. It signs only when configured, otherwise it does nothing
 * (exit 0) so unsigned builds keep working.
 *
 *   node scripts/sign.mjs <file>
 *
 * (a) Azure Trusted Signing: AZURE_TRUSTED_SIGNING_ENDPOINT, _ACCOUNT, _PROFILE
 *     (+ AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET or an az login).
 *     Uses trusted-signing-cli, or signtool + Azure.CodeSigning.Dlib.dll when
 *     AZURE_CODESIGNING_DLIB points to that DLL.
 * (b) A certificate in the Windows store: ADIKA_SIGN_THUMBPRINT (SHA-1), optional
 *     ADIKA_SIGN_STORE (default My) and ADIKA_SIGN_MACHINE_STORE=1, via signtool.
 * Timestamp (RFC 3161): ADIKA_SIGN_TIMESTAMP_URL, defaults per option.
 * signtool: SIGNTOOL, else the newest Windows Kits x64 signtool, else PATH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DESCRIPTION = 'Adika PDF Editor';
const HOMEPAGE = 'https://github.com/unupunct/AdikaPDF';

export function findSigntool(env = process.env) {
  if (env.SIGNTOOL) return env.SIGNTOOL;
  const kits = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  try {
    const versions = fs
      .readdirSync(kits)
      .filter((d) => /^10\./.test(d) && fs.existsSync(path.join(kits, d, 'x64', 'signtool.exe')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length) return path.join(kits, versions[versions.length - 1], 'x64', 'signtool.exe');
  } catch {
    /* no Windows SDK: rely on PATH */
  }
  return 'signtool';
}

/**
 * What to run for `file`: null when signing is not configured.
 * `metadata` is the Dlib metadata file to write first (signtool + Azure).
 */
export function signPlan(file, env = process.env) {
  const azure = env.AZURE_TRUSTED_SIGNING_ENDPOINT && env.AZURE_TRUSTED_SIGNING_ACCOUNT && env.AZURE_TRUSTED_SIGNING_PROFILE;
  if (azure) {
    const ts = env.ADIKA_SIGN_TIMESTAMP_URL || 'http://timestamp.acs.microsoft.com';
    if (env.AZURE_CODESIGNING_DLIB) {
      const metadataPath = path.join(os.tmpdir(), `adika-sign-metadata-${process.pid}.json`);
      return {
        cmd: findSigntool(env),
        args: ['sign', '/v', '/fd', 'SHA256', '/tr', ts, '/td', 'SHA256', '/d', DESCRIPTION, '/du', HOMEPAGE, '/dlib', env.AZURE_CODESIGNING_DLIB, '/dmdf', metadataPath, file],
        metadata: { path: metadataPath, json: { Endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT, CodeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT, CertificateProfileName: env.AZURE_TRUSTED_SIGNING_PROFILE } },
      };
    }
    return {
      cmd: env.TRUSTED_SIGNING_CLI || 'trusted-signing-cli',
      args: ['-e', env.AZURE_TRUSTED_SIGNING_ENDPOINT, '-a', env.AZURE_TRUSTED_SIGNING_ACCOUNT, '-c', env.AZURE_TRUSTED_SIGNING_PROFILE, '-d', DESCRIPTION, file],
    };
  }
  if (env.ADIKA_SIGN_THUMBPRINT) {
    const thumb = env.ADIKA_SIGN_THUMBPRINT.replace(/[^0-9a-fA-F]/g, '');
    if (thumb.length !== 40) throw new Error('ADIKA_SIGN_THUMBPRINT must be the certificate\'s SHA-1 thumbprint (40 hex digits).');
    const ts = env.ADIKA_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
    const store = [...(env.ADIKA_SIGN_MACHINE_STORE === '1' ? ['/sm'] : []), '/s', env.ADIKA_SIGN_STORE || 'My'];
    return {
      cmd: findSigntool(env),
      args: ['sign', ...store, '/sha1', thumb, '/fd', 'SHA256', '/tr', ts, '/td', 'SHA256', '/d', DESCRIPTION, '/du', HOMEPAGE, file],
    };
  }
  return null;
}

/** Signs `file` when configured; returns the exit code (0 also when nothing was done). */
export function run(file, env = process.env, spawn = spawnSync) {
  if (!file) {
    console.error('usage: node scripts/sign.mjs <file>');
    return 2;
  }
  const plan = signPlan(file, env);
  if (!plan) return 0; // not configured: unsigned build
  if (!fs.existsSync(file)) {
    console.error(`sign: no such file: ${file}`);
    return 1;
  }
  try {
    if (plan.metadata) fs.writeFileSync(plan.metadata.path, JSON.stringify(plan.metadata.json));
    console.log(`sign: ${path.basename(file)}`);
    const r = spawn(plan.cmd, plan.args, { stdio: 'inherit', env });
    if (r.error) {
      console.error(`sign: could not run ${plan.cmd}: ${r.error.message}`);
      return 1;
    }
    return r.status ?? 1;
  } finally {
    if (plan.metadata) fs.rmSync(plan.metadata.path, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(run(process.argv[2]));
  } catch (e) {
    console.error(`sign: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
