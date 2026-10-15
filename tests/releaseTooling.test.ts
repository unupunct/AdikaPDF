import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import pkg from '../package.json';

// Plain .mjs scripts (no type declarations): loaded by URL.
const load = async <T>(name: string) => (await import(/* @vite-ignore */ pathToFileURL(path.resolve('scripts', name)).href)) as T;

interface ReleaseAssets {
  buildLatestJson: (o: { version: string; notes?: string; signature: string; pubDate?: Date }) => {
    version: string;
    notes: string;
    pub_date: string;
    platforms: Record<string, { signature: string; url: string }>;
  };
  installerName: (v: string) => string;
  portableName: (v: string) => string;
  portableEntries: (o: { exe: string; license: string }) => Array<{ name: string; file?: string; text?: string }>;
  main: (argv: string[]) => Promise<void>;
}

interface SignScript {
  signPlan: (file: string, env: Record<string, string | undefined>) => { cmd: string; args: string[] } | null;
  run: (file: string, env: Record<string, string | undefined>, spawn?: (...a: unknown[]) => unknown) => number;
}

describe('release assets', () => {
  it('writes latest.json for the updater with the release download url', async () => {
    const { buildLatestJson } = await load<ReleaseAssets>('release-assets.mjs');
    const j = buildLatestJson({ version: '1.12.0', notes: 'Fixes', signature: 'c2lnbmF0dXJl\n', pubDate: new Date('2026-10-08T10:00:00Z') });
    expect(j).toEqual({
      version: '1.12.0',
      notes: 'Fixes',
      pub_date: '2026-10-08T10:00:00.000Z',
      platforms: { 'windows-x86_64': { signature: 'c2lnbmF0dXJl', url: 'https://github.com/unupunct/AdikaPDF/releases/download/v1.12.0/AdikaPDF_1.12.0_x64-setup.exe' } },
    });
    expect(() => buildLatestJson({ version: 'v1.12', signature: 'x' })).toThrow();
    expect(() => buildLatestJson({ version: '1.12.0', signature: ' ' })).toThrow(/signature/);
  });

  it('copies the NSIS setup and its .sig under the uploaded names', async () => {
    const { main, installerName, portableName } = await load<ReleaseAssets>('release-assets.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adika-rel-'));
    const bundle = path.join(tmp, 'nsis');
    const out = path.join(tmp, 'out');
    fs.mkdirSync(bundle);
    const setup = path.join(bundle, `Adika PDF Editor_${pkg.version}_x64-setup.exe`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // No .sig: an unsigned build is refused.
      fs.writeFileSync(setup, 'MZ installer');
      const exe = path.join(tmp, 'adika-pdf-editor.exe');
      await expect(main(['--bundle-dir', bundle, '--out', out, '--exe', exe])).rejects.toThrow(/\.sig is missing/);
      fs.writeFileSync(`${setup}.sig`, 'U0lH');
      // The portable ZIP needs the release exe.
      await expect(main(['--bundle-dir', bundle, '--out', out, '--exe', exe])).rejects.toThrow(/adika-pdf-editor\.exe/);
      fs.writeFileSync(exe, 'MZ app');
      await main(['--bundle-dir', bundle, '--out', out, '--notes', 'What is new', '--exe', exe]);
      const name = installerName(pkg.version);
      expect(fs.readFileSync(path.join(out, name), 'utf8')).toBe('MZ installer');
      expect(fs.readFileSync(path.join(out, `${name}.sig`), 'utf8')).toBe('U0lH');
      const latest = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
      expect(latest).toMatchObject({ version: pkg.version, notes: 'What is new' });
      expect(latest.platforms['windows-x86_64'].url.endsWith(`/v${pkg.version}/${name}`)).toBe(true);
      const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, portableName(pkg.version))));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
      expect(names).toEqual(['Adika PDF Editor/LICENSE.txt', 'Adika PDF Editor/README-portable.txt', 'Adika PDF Editor/adika-pdf-editor.exe', 'Adika PDF Editor/portable.ini']);
      expect(await zip.file('Adika PDF Editor/adika-pdf-editor.exe')!.async('string')).toBe('MZ app');
      expect(await zip.file('Adika PDF Editor/portable.ini')!.async('string')).toMatch(/^\[Adika\]\r\nPortable=1/m);
    } finally {
      log.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('portable ZIP', () => {
  it('holds the exe, the portable marker, a readme and the licence; nothing the installer alone needs', async () => {
    const { portableEntries, portableName } = await load<ReleaseAssets>('release-assets.mjs');
    expect(portableName('1.14.0')).toBe('AdikaPDF_1.14.0_x64-portable.zip');
    const entries = portableEntries({ exe: 'x.exe', license: 'LICENSE' });
    expect(entries.map((e) => e.name.split('/').pop())).toEqual(['adika-pdf-editor.exe', 'portable.ini', 'README-portable.txt', 'LICENSE.txt']);
    expect(entries.some((e) => /printer\.ps1|adika_thumbs\.dll|uninstall\.exe/.test(e.name))).toBe(false);
    // The marker the native side looks for (deploy.rs PORTABLE_MARKER).
    expect(fs.readFileSync(path.resolve('src-tauri/src/deploy.rs'), 'utf8')).toContain('PORTABLE_MARKER: &str = "portable.ini"');
  });
});

describe('code signing hook', () => {
  it('does nothing without signing settings', async () => {
    const { signPlan, run } = await load<SignScript>('sign.mjs');
    expect(signPlan('app.exe', {})).toBeNull();
    const spawn = vi.fn();
    expect(run('does-not-exist.exe', {}, spawn)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    // As tauri calls it: a plain process with no signing variables exits 0.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AZURE_|ADIKA_SIGN|SIGNTOOL|TRUSTED_SIGNING)/.test(k)) env[k] = v;
    const r = spawnSync(process.execPath, [path.resolve('scripts', 'sign.mjs'), 'does-not-exist.exe'], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });

  it('signs with a store certificate by thumbprint, with an RFC 3161 timestamp', async () => {
    const { signPlan } = await load<SignScript>('sign.mjs');
    const plan = signPlan('C:\\b\\Adika PDF Editor.exe', { ADIKA_SIGN_THUMBPRINT: 'ab cd'.padEnd(5) + '0'.repeat(36), SIGNTOOL: 'signtool.exe' })!;
    expect(plan.cmd).toBe('signtool.exe');
    expect(plan.args).toEqual(expect.arrayContaining(['sign', '/sha1', `abcd${'0'.repeat(36)}`, '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256']));
    expect(plan.args.at(-1)).toBe('C:\\b\\Adika PDF Editor.exe');
    expect(() => signPlan('a.exe', { ADIKA_SIGN_THUMBPRINT: '1234' })).toThrow(/40 hex/);
  });

  it('signs with Azure Trusted Signing', async () => {
    const { signPlan } = await load<SignScript>('sign.mjs');
    const env = { AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net', AZURE_TRUSTED_SIGNING_ACCOUNT: 'acct', AZURE_TRUSTED_SIGNING_PROFILE: 'prof' };
    expect(signPlan('a.exe', env)).toMatchObject({ cmd: 'trusted-signing-cli', args: ['-e', env.AZURE_TRUSTED_SIGNING_ENDPOINT, '-a', 'acct', '-c', 'prof', '-d', 'Adika PDF Editor', 'a.exe'] });
    const dlib = signPlan('a.exe', { ...env, AZURE_CODESIGNING_DLIB: 'C:\\dlib\\Azure.CodeSigning.Dlib.dll', SIGNTOOL: 'signtool.exe' })!;
    expect(dlib.args).toEqual(expect.arrayContaining(['/dlib', 'C:\\dlib\\Azure.CodeSigning.Dlib.dll', '/dmdf', '/tr', 'http://timestamp.acs.microsoft.com']));
  });
});
