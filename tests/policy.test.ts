import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  applyDeployment,
  assertOnline,
  defaultTsaUrl,
  dnString,
  FALLBACK_TSA,
  mergePolicies,
  NO_POLICIES,
  onlineAllowed,
  parseValue,
  POLICY_DEFS,
  PolicyError,
  signingIssuerAllowed,
  usePolicy,
} from '@/lib/policy';
import { apiRequest, htmlToPdf, httpGet, httpPost } from '@/lib/platform';
import { checkForUpdates, maybeAutoCheck, pluginUpdaterCheck, portableZipUrl, useUpdates } from '@/lib/updates';
import { preferIncremental, useSaveSettings } from '@/lib/saveSettings';
import { attr, descendants, parseXmlDoc, textOf } from '@/lib/xml';

afterEach(() => applyDeployment({}));

describe('policy values', () => {
  it('machine policies win over user policies, installer values only fill in their own policies', () => {
    const { policies, entries } = mergePolicies({
      machine: { DisableOnlineFeatures: 0, DefaultTimestampServer: 'https://tsa.corp.example/' },
      user: { disableonlinefeatures: 1, DisableCloudSigning: 1, DefaultTimestampServer: 'http://other.example' },
      installer: { DisableUpdateCheck: 1, DefaultLanguage: 'ro', DisableCloudSigning: 0, NoPrinter: 1, '': 'C:\\Program Files\\Adika PDF Editor' },
    });
    expect(policies).toMatchObject({
      disableOnlineFeatures: false,
      disableCloudSigning: true,
      disableUpdateCheck: true,
      defaultLanguage: 'ro',
      defaultTimestampServer: 'https://tsa.corp.example/',
    });
    expect(entries.find((e) => e.name === 'DisableOnlineFeatures')).toMatchObject({ source: 'machine', value: 'Off' });
    expect(entries.find((e) => e.name === 'DisableCloudSigning')).toMatchObject({ source: 'user', value: 'On' });
    expect(entries.find((e) => e.name === 'DefaultLanguage')).toMatchObject({ source: 'installer', value: 'ro' });
    // A user policy overrides an installer default.
    expect(mergePolicies({ user: { DefaultLanguage: 'de' }, installer: { DefaultLanguage: 'ro' } }).policies.defaultLanguage).toBe('de');
    expect(mergePolicies({}).policies).toEqual(NO_POLICIES);
  });

  it('reads each type and ignores values that do not fit', () => {
    expect(parseValue('flag', 1)).toBe(true);
    expect(parseValue('flag', 0)).toBe(false);
    expect(parseValue('flag', 'true')).toBe(true);
    expect(parseValue('flag', 'maybe')).toBeUndefined();
    expect(parseValue('flag', ['1'])).toBeUndefined();
    expect(parseValue('lang', 'RO')).toBe('ro');
    expect(parseValue('lang', 'pl')).toBeUndefined();
    expect(parseValue('lang', 3)).toBeUndefined();
    expect(parseValue('url', ' http://timestamp.example/tsa ')).toBe('http://timestamp.example/tsa');
    expect(parseValue('url', 'file:///c:/x')).toBeUndefined();
    expect(parseValue('list', 'certSIGN; CN=DigiSign Qualified CA;;')).toEqual(['certSIGN', 'CN=DigiSign Qualified CA']);
    expect(parseValue('list', ['A', ' ', 'B'])).toEqual(['A', 'B']);
    expect(parseValue('list', '  ')).toBeUndefined();
    expect(mergePolicies({ machine: { SaveIncremental: 0 } }).policies.saveIncremental).toBe(false);
    expect(mergePolicies({ machine: { DefaultLanguage: 'xx' }, user: { DefaultLanguage: 'fr' } }).policies.defaultLanguage).toBe('fr');
  });

  it('decides which online features may run', () => {
    const p = (o: object) => ({ ...NO_POLICIES, ...o });
    expect(onlineAllowed('timestamp', NO_POLICIES)).toBe(true);
    expect(onlineAllowed('updates', p({ disableUpdateCheck: true }))).toBe(false);
    expect(onlineAllowed('timestamp', p({ disableUpdateCheck: true }))).toBe(true);
    expect(onlineAllowed('cloudSign', p({ disableCloudSigning: true }))).toBe(false);
    expect(onlineAllowed('anaf', p({ disableCloudSigning: true }))).toBe(true);
    for (const f of ['updates', 'revocation', 'timestamp', 'trustedList', 'cloudSign', 'anaf', 'urlConvert', 'ocrLanguages', 'network'] as const) {
      expect(onlineAllowed(f, p({ disableOnlineFeatures: true }))).toBe(false);
    }
  });

  it('blocks every network entry point when online features are off', async () => {
    applyDeployment({ policies: { machine: { DisableOnlineFeatures: 1 } } });
    expect(() => assertOnline('anaf')).toThrow(PolicyError);
    expect(() => assertOnline('anaf')).toThrow(/ANAF connection is turned off by your organisation/);
    await expect(httpGet('https://example.com/crl')).rejects.toThrow(PolicyError);
    await expect(httpPost('http://ocsp.example', 'application/ocsp-request', new Uint8Array(1))).rejects.toThrow(PolicyError);
    await expect(apiRequest({ url: 'https://csc.example/csc/v2/info', method: 'POST' })).rejects.toThrow(PolicyError);
    await expect(htmlToPdf({ url: 'https://example.com' })).rejects.toThrow();
    // The update check stops before asking anything.
    let asked = false;
    expect(await checkForUpdates(async () => ((asked = true), { tag_name: 'v99.0.0' }), async () => ((asked = true), undefined))).toBeNull();
    expect(asked).toBe(false);
    expect(useUpdates.getState()).toMatchObject({ status: 'error', error: 'The update check is turned off by your organisation.' });
  });

  it('turns off the update check alone, including the weekly one', async () => {
    applyDeployment({ policies: { user: { DisableUpdateCheck: 1 } } });
    try {
      localStorage.setItem('adika.updates', JSON.stringify({ auto: true, lastCheck: 0 }));
    } catch {
      /* node: no storage, the check is off anyway */
    }
    expect(maybeAutoCheck()).toBe(false);
    expect(await checkForUpdates(async () => ({ tag_name: 'v99.0.0' }))).toBeNull();
    expect(onlineAllowed('timestamp')).toBe(true);
  });

  it('timestamp server and save mode follow the policies', () => {
    expect(defaultTsaUrl()).toBe(FALLBACK_TSA);
    applyDeployment({ policies: { machine: { DefaultTimestampServer: 'https://tsa.corp.example/rfc3161', SaveIncremental: 1 } } });
    expect(defaultTsaUrl()).toBe('https://tsa.corp.example/rfc3161');
    useSaveSettings.setState({ preferIncremental: false });
    expect(preferIncremental()).toBe(true);
    applyDeployment({});
    expect(preferIncremental()).toBe(false);
  });

  it('allows signing certificates only from the listed issuers', () => {
    const issuer = { attributes: [{ shortName: 'CN', value: 'certSIGN Qualified CA Class 3 G2' }, { shortName: 'O', value: 'CERTSIGN SA' }, { shortName: 'C', value: 'RO' }] };
    const dn = dnString(issuer);
    expect(dn).toBe('CN=certSIGN Qualified CA Class 3 G2, O=CERTSIGN SA, C=RO');
    expect(signingIssuerAllowed(dn)).toBe(true);
    const list = (s: string) => mergePolicies({ machine: { AllowedSigningCertificateIssuers: s } }).policies;
    expect(signingIssuerAllowed(dn, list('certsign qualified ca'))).toBe(true);
    expect(signingIssuerAllowed(dn, list('DigiSign; CN=Trans Sped'))).toBe(false);
    expect(signingIssuerAllowed('CN=Ion Popescu', list('DigiSign'))).toBe(false);
  });
});

describe('portable mode', () => {
  it('never uses the installer updater and downloads the portable ZIP', async () => {
    applyDeployment({ portable: true, dataDir: 'E:\\Adika PDF Editor\\Data' });
    expect(usePolicy.getState()).toMatchObject({ portable: true, dataDir: 'E:\\Adika PDF Editor\\Data' });
    expect(await pluginUpdaterCheck()).toBeUndefined();
    expect(portableZipUrl('1.14.0')).toBe('https://github.com/unupunct/AdikaPDF/releases/download/v1.14.0/AdikaPDF_1.14.0_x64-portable.zip');
  });
});

describe('Group Policy templates', () => {
  const admx = parseXmlDoc(fs.readFileSync('deploy/policies/AdikaPDFEditor.admx', 'utf8'));
  const policies = descendants(admx, 'policy');

  it('define the same policies as the app, under the policy key', () => {
    expect(policies.map((p) => attr(p, 'name')).sort()).toEqual(POLICY_DEFS.map((d) => d.name).sort());
    for (const p of policies) {
      expect(attr(p, 'key')).toBe('Software\\Policies\\Adika PDF Editor');
      expect(attr(p, 'class')).toBe('Both');
      // The registry value has the policy's name (directly or in its one element).
      const valueNames = [attr(p, 'valueName'), ...descendants(p, 'enum').concat(descendants(p, 'text')).map((e) => attr(e, 'valueName'))].filter(Boolean);
      expect(valueNames).toEqual([attr(p, 'name')]);
      const kind = POLICY_DEFS.find((d) => d.name === attr(p, 'name'))!.kind;
      expect(kind === 'flag' ? !!attr(p, 'valueName') : descendants(p, 'elements').length === 1).toBe(true);
    }
    const langs = descendants(policies.find((p) => attr(p, 'name') === 'DefaultLanguage'), 'string').map((s) => textOf(s));
    expect(langs).toEqual(['en', 'ro', 'de', 'fr', 'hu', 'it', 'es']);
  });

  it('have every string and presentation in English and Romanian', () => {
    const src = fs.readFileSync('deploy/policies/AdikaPDFEditor.admx', 'utf8');
    const strings = [...src.matchAll(/\$\(string\.([A-Za-z0-9_]+)\)/g)].map((m) => m[1]);
    const presentations = [...src.matchAll(/\$\(presentation\.([A-Za-z0-9_]+)\)/g)].map((m) => m[1]);
    for (const lang of ['en-US', 'ro-RO']) {
      const adml = parseXmlDoc(fs.readFileSync(`deploy/policies/${lang}/AdikaPDFEditor.adml`, 'utf8'));
      const ids = new Set(descendants(adml, 'string').map((s) => attr(s, 'id')));
      for (const s of strings) expect(ids.has(s), `${lang}: ${s}`).toBe(true);
      const pres = new Set(descendants(adml, 'presentation').map((p) => attr(p, 'id')));
      for (const p of presentations) expect(pres.has(p), `${lang}: ${p}`).toBe(true);
    }
  });
});

interface Winget {
  PACKAGE_ID: string;
  buildManifests: (o: { version: string; sha256: string; releaseDate: string }) => Record<string, string>;
  sha256File: (f: string) => string;
  manifestDir: (v: string) => string;
  main: (argv: string[]) => string;
}

describe('winget manifests', () => {
  const load = async () => (await import(/* @vite-ignore */ pathToFileURL(path.resolve('scripts', 'winget-manifest.mjs')).href)) as Winget;

  it('hashes the release setup and writes version, installer and locale manifests', async () => {
    const w = await load();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adika-winget-'));
    try {
      const setup = path.join(tmp, 'AdikaPDF_1.14.0_x64-setup.exe');
      fs.writeFileSync(setup, 'MZ setup bytes');
      const expected = crypto.createHash('sha256').update('MZ setup bytes').digest('hex').toUpperCase();
      expect(w.sha256File(setup)).toBe(expected);
      const out = path.join(tmp, 'm');
      const log = console.log;
      console.log = () => undefined;
      try {
        w.main(['--version', '1.14.0', '--installer', setup, '--out', out, '--date', '2026-10-20']);
      } finally {
        console.log = log;
      }
      expect(fs.readdirSync(out).sort()).toEqual([
        'unupunct.AdikaPDFEditor.installer.yaml',
        'unupunct.AdikaPDFEditor.locale.en-US.yaml',
        'unupunct.AdikaPDFEditor.locale.ro-RO.yaml',
        'unupunct.AdikaPDFEditor.yaml',
      ]);
      const inst = fs.readFileSync(path.join(out, 'unupunct.AdikaPDFEditor.installer.yaml'), 'utf8');
      expect(inst.match(new RegExp(`InstallerSha256: ${expected}`, 'g'))).toHaveLength(2);
      expect(inst).toContain('InstallerType: nullsoft');
      expect(inst).toContain('  Silent: /S\n');
      expect(inst).toMatch(/Scope: user\n[\s\S]*Custom: \/CURRENTUSER/);
      expect(inst).toMatch(/Scope: machine\n[\s\S]*Custom: \/ALLUSERS/);
      expect(inst).toContain('InstallerUrl: https://github.com/unupunct/AdikaPDF/releases/download/v1.14.0/AdikaPDF_1.14.0_x64-setup.exe');
      expect(inst).toContain('ReleaseDate: 2026-10-20');
      const en = fs.readFileSync(path.join(out, 'unupunct.AdikaPDFEditor.locale.en-US.yaml'), 'utf8');
      expect(en).toContain('ManifestType: defaultLocale');
      expect(en).toContain('Publisher: unupunct');
      expect(fs.readFileSync(path.join(out, 'unupunct.AdikaPDFEditor.locale.ro-RO.yaml'), 'utf8')).not.toContain('Moniker');
      expect(() => w.main(['--version', '1.14.0', '--installer', path.join(tmp, 'missing.exe')])).toThrow(/release:assets/);
      expect(() => w.buildManifests({ version: '1.14.0', sha256: 'abc', releaseDate: '2026-10-20' })).toThrow(/64 hex/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the committed manifest set is what the script writes (apart from hash and date)', async () => {
    const w = await load();
    const dir = path.join('deploy', 'winget', w.manifestDir('1.14.0'));
    const generated = w.buildManifests({ version: '1.14.0', sha256: '0'.repeat(64), releaseDate: '2026-10-09' });
    const norm = (s: string) => s.replace(/InstallerSha256: \w+/g, 'H').replace(/ReleaseDate: [\d-]+/, 'D').replace(/\r\n/g, '\n');
    for (const [name, text] of Object.entries(generated)) expect(norm(fs.readFileSync(path.join(dir, name), 'utf8'))).toBe(norm(text));
  });
});
