import { describe, expect, it } from 'vitest';
import { APP_VERSION, checkForUpdates, compareVersions, parseRelease, useUpdates } from '@/lib/updates';
import pkg from '../package.json';

describe('update check', () => {
  it('knows its own version from package.json', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.5.0', '1.5.0')).toBe(0);
    expect(compareVersions('1.5', '1.5.1')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('reads the GitHub latest-release answer and skips drafts / pre-releases', () => {
    const r = parseRelease({ tag_name: 'v1.6.0', name: 'Adika PDF Editor 1.6.0', html_url: 'https://github.com/unupunct/AdikaPDF/releases/tag/v1.6.0', body: 'notes', draft: false, prerelease: false });
    expect(r).toMatchObject({ version: '1.6.0', url: 'https://github.com/unupunct/AdikaPDF/releases/tag/v1.6.0' });
    expect(parseRelease({ tag_name: 'v2.0.0', prerelease: true })).toBeNull();
    expect(parseRelease({ message: 'API rate limit exceeded' })).toBeNull();
    // A link that is not on github.com falls back to the releases page.
    expect(parseRelease({ tag_name: '1.6.0', html_url: 'https://evil.example/x' })!.url).toMatch(/^https:\/\/github\.com\/unupunct\/AdikaPDF\//);
  });

  it('reports newer, same and failed checks', async () => {
    const [maj, min] = APP_VERSION.split('.').map(Number);
    expect(await checkForUpdates(async () => ({ tag_name: `v${maj}.${min + 1}.0` }))).toMatchObject({ version: `${maj}.${min + 1}.0` });
    expect(useUpdates.getState().status).toBe('available');
    expect(await checkForUpdates(async () => ({ tag_name: `v${APP_VERSION}` }))).toBeNull();
    expect(useUpdates.getState().status).toBe('latest');
    await checkForUpdates(async () => {
      throw new Error('offline');
    });
    expect(useUpdates.getState()).toMatchObject({ status: 'error', error: 'offline' });
  });
});
