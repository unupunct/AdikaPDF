import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUG_FIELDS, FEATURE_FIELDS, MAX_URL_LENGTH, osFromUserAgent, reportText, reportUrl, sanitizeReport, type ReportDraft } from '../src/lib/report';

const env = { version: '1.16.0', os: 'Windows 11 Pro 24H2 (build 26200.6899, x86_64)', language: 'ro (Română)', install: 'Installed' as const };

describe('problem report address', () => {
  it('pre-fills the issue form fields by id, encoded', () => {
    const d: ReportDraft = { kind: 'bug', title: 'Ș & ț? #1', env };
    const { url, crashLogOmitted } = reportUrl(d);
    expect(crashLogOmitted).toBe(false);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://github.com/unupunct/AdikaPDF/issues/new');
    expect(u.searchParams.get('template')).toBe('bug_report.yml');
    expect(u.searchParams.get('title')).toBe('[Bug]: Ș & ț? #1');
    expect(u.searchParams.get('version')).toBe('1.16.0');
    expect(u.searchParams.get('os')).toBe(env.os);
    expect(u.searchParams.get('language')).toBe('ro (Română)');
    expect(u.searchParams.get('install')).toBe('Installed');
    // Empty sections are left for the user, nothing else is sent.
    expect([...u.searchParams.keys()].sort()).toEqual(['install', 'language', 'os', 'template', 'title', 'version']);
    expect(url).not.toContain('+');
    expect(url).not.toMatch(/[ &#?]{2}/);
  });

  it('feature requests use their own form', () => {
    const u = new URL(reportUrl({ kind: 'feature', title: '', env }).url);
    expect(u.searchParams.get('template')).toBe('feature_request.yml');
    expect(u.searchParams.get('os')).toBeNull();
  });

  it('keeps a crash log when it fits, leaves it for the clipboard when it does not', () => {
    const small = reportUrl({ kind: 'bug', title: 'Crash', env, crashLog: 'Panic: boom' });
    expect(new URL(small.url).searchParams.get('crash-log')).toBe('Panic: boom');
    const big = reportUrl({ kind: 'bug', title: 'Crash', env, crashLog: 'x'.repeat(20000) });
    expect(big.crashLogOmitted).toBe(true);
    expect(big.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(new URL(big.url).searchParams.get('crash-log')).toBeNull();
    expect(reportText({ kind: 'bug', title: 'Crash', env, crashLog: 'x'.repeat(20000) })).toContain('x'.repeat(20000));
  });

  it('the copied text has the form headings', () => {
    const t = reportText({ kind: 'bug', title: 'Save fails', env });
    expect(t.split('\n')[0]).toBe('[Bug]: Save fails');
    for (const f of BUG_FIELDS.filter((x) => x.id !== 'crash-log')) expect(t).toContain(`### ${f.label}`);
    expect(t).not.toContain('### Crash report');
  });

  it('the GitHub issue forms have the same field ids and labels', () => {
    const forms: Array<[string, ReadonlyArray<{ id: string; label: string }>]> = [
      ['.github/ISSUE_TEMPLATE/bug_report.yml', BUG_FIELDS],
      ['.github/ISSUE_TEMPLATE/feature_request.yml', FEATURE_FIELDS],
    ];
    for (const [file, fields] of forms) {
      const yml = readFileSync(file, 'utf8');
      const ids = [...yml.matchAll(/^\s+id: ([\w-]+)$/gm)].map((m) => m[1]);
      expect(ids).toEqual(fields.map((f) => f.id));
      for (const f of fields) expect(yml).toContain(`label: ${f.label}`);
    }
  });

  it('names Windows from the user agent as a fallback', () => {
    expect(osFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows 10 or 11');
    expect(osFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Unknown');
  });
});

describe('crash report clean-up', () => {
  const log = [
    'Adika PDF Editor 1.16.0 crash report',
    'Source: user interface',
    'Error: Could not read C:\\Users\\Ion Popescu\\Documents\\Contract Popescu 2026.pdf: access denied',
    'Saved to D:\\Clienti\\ACME SRL\\facturi\\F-123.xml, then failed',
    'at render (http://tauri.localhost/assets/index-AbC123.js:1:2345)',
    'Panic at C:\\Users\\Ion Popescu\\.cargo\\registry\\src\\wry-0.57.0\\src\\webview2\\mod.rs:956',
    'Logs: C:\\Users\\Ion Popescu\\AppData\\Local\\Adika PDF Editor\\logs\\crash-20261022-101500-123-4567.log',
    'Share \\\\fileserver\\scans\\Ion\\scan 7.tiff',
    'file:///C:/Users/Ion%20Popescu/Desktop/a.pdf',
    'Mail ion.popescu@example.ro about report.docx',
    'User Ion Popescu opened oferta.pdf',
    'Merged "Raport anual 2026.pdf" into “Dosar complet.docx”',
  ].join('\r\n');
  const out = sanitizeReport(log, { userName: 'Ion Popescu', profile: 'C:\\Users\\Ion Popescu' });

  it('removes the user, paths, document names and e-mail addresses', () => {
    expect(out).not.toMatch(/Popescu|Ion\b|ACME|Clienti|Contract|F-123|oferta|fileserver|scan 7|example\.ro|Raport|Dosar/);
    expect(out).toContain('Merged "<file>.pdf" into “<file>.docx”');
    expect(out).toContain('User <user> opened <file>.pdf');
    expect(out).toContain('%USERPROFILE%');
    expect(out).toContain('<file>.pdf');
    expect(out).toContain('<file>.docx');
    expect(out).toContain('<e-mail>');
    expect(out).toContain('<user>');
    expect(out).toContain('<drive>\\<path>');
  });

  it('keeps what helps: program files, line numbers, the app folder, the crash file', () => {
    expect(out).toContain('index-AbC123.js:1:2345');
    expect(out).toContain('mod.rs:956');
    expect(out).toContain('%LOCALAPPDATA%\\Adika PDF Editor\\…\\crash-20261022-101500-123-4567.log');
    expect(out).toContain('Source: user interface');
    expect(out).not.toContain('\r');
  });

  it('works without knowing the user name', () => {
    const t = sanitizeReport('at C:\\Users\\maria\\Desktop\\bilant.xlsx', {});
    expect(t).not.toMatch(/maria|bilant/);
    expect(t).toContain('%USERPROFILE%');
  });
});
