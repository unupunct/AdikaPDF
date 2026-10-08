import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION, checkForUpdates, compareVersions, installDecision, installUpdate, parseRelease, useUpdates, type InstallDeps, type PendingUpdate } from '@/lib/updates';
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

describe('one-click update', () => {
  const [maj, min] = APP_VERSION.split('.').map(Number);
  const next = `${maj}.${min + 1}.0`;
  const fakeUpdate = (fail?: string): PendingUpdate & { installed: number } => {
    const u = {
      version: next,
      notes: 'New things',
      date: '2026-10-08T10:00:00Z',
      installed: 0,
      downloadAndInstall: async (onProgress: (done: number, total: number | null) => void) => {
        onProgress(50, 100);
        onProgress(100, 100);
        if (fail) throw new Error(fail);
        u.installed++;
      },
    };
    return u;
  };
  const deps = (o: { dirty?: number; windows?: number; confirm?: boolean }) => {
    const calls: string[] = [];
    const d: InstallDeps = {
      dirtyDocuments: async () => o.dirty ?? 0,
      otherWindows: async () => o.windows ?? 0,
      confirmUnsaved: async (n) => {
        calls.push(`confirm:${n}`);
        return o.confirm ?? false;
      },
      backup: async () => {
        calls.push('backup');
      },
    };
    return { d, calls };
  };
  beforeEach(() => useUpdates.setState({ phase: 'idle', installError: '', progress: { done: 0, total: null } }));

  it('decides: other windows first, then unsaved documents', () => {
    expect(installDecision({ dirtyDocuments: 0, otherWindows: 0 })).toBe('install');
    expect(installDecision({ dirtyDocuments: 2, otherWindows: 0 })).toBe('confirm-unsaved');
    expect(installDecision({ dirtyDocuments: 0, otherWindows: 1 })).toBe('close-windows');
    expect(installDecision({ dirtyDocuments: 3, otherWindows: 1 })).toBe('close-windows');
  });

  it('asks before installing over unsaved documents and keeps recovery copies', async () => {
    const u = fakeUpdate();
    const no = deps({ dirty: 2, confirm: false });
    expect(await installUpdate(no.d, u)).toBe(false);
    expect(no.calls).toEqual(['confirm:2']);
    expect(u.installed).toBe(0);
    expect(useUpdates.getState().phase).toBe('idle');

    const yes = deps({ dirty: 1, confirm: true });
    expect(await installUpdate(yes.d, u)).toBe(true);
    expect(yes.calls).toEqual(['confirm:1', 'backup']);
    expect(u.installed).toBe(1);
    expect(useUpdates.getState()).toMatchObject({ phase: 'installing', progress: { done: 100, total: 100 } });
  });

  it('installs without asking when everything is saved; refuses while other windows are open', async () => {
    const u = fakeUpdate();
    const clean = deps({});
    expect(await installUpdate(clean.d, u)).toBe(true);
    expect(clean.calls).toEqual([]);

    useUpdates.setState({ phase: 'idle' });
    const windows = deps({ dirty: 1, windows: 1 });
    expect(await installUpdate(windows.d, u)).toBe(false);
    expect(windows.calls).toEqual([]);
    expect(useUpdates.getState().installError).toMatch(/other Adika windows/);
    expect(u.installed).toBe(1);
  });

  it('reports a failed download and stays usable', async () => {
    expect(await installUpdate(deps({}).d, fakeUpdate('signature mismatch'))).toBe(false);
    expect(useUpdates.getState()).toMatchObject({ phase: 'idle', installError: 'signature mismatch' });
  });

  it('uses the signed feed when there is one, else the GitHub release page', async () => {
    const github = vi.fn(async () => ({ tag_name: `v${next}`, html_url: 'https://github.com/unupunct/AdikaPDF/releases/tag/x' }));
    expect(await checkForUpdates(github, async () => fakeUpdate())).toMatchObject({ version: next, notes: 'New things' });
    expect(useUpdates.getState()).toMatchObject({ status: 'available', installable: true });
    expect(github).not.toHaveBeenCalled();

    expect(await checkForUpdates(github, async () => null)).toBeNull();
    expect(useUpdates.getState()).toMatchObject({ status: 'latest', installable: false });

    // No latest.json (an older release) or not the desktop app: the GitHub release, "Download".
    expect(await checkForUpdates(github, async () => undefined)).toMatchObject({ version: next });
    expect(useUpdates.getState()).toMatchObject({ status: 'available', installable: false });
    expect(await checkForUpdates(github, async () => Promise.reject(new Error('404')))).toMatchObject({ version: next });
    expect(github).toHaveBeenCalledTimes(2);
  });
});
