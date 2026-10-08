/**
 * Update check: asks GitHub for the latest release of Adika and compares it
 * with this build. Nothing else is sent (no IDs, no document data). The
 * automatic weekly check is opt-in; "Check for updates" in About always works.
 *
 * In the desktop app the signed update feed (latest.json of the latest release,
 * read by the Tauri updater) is asked first: its installer is downloaded,
 * verified and run from the app. Without it (older releases, browser, other
 * windows) the GitHub release is shown and "Download" opens its page.
 */
import { create } from 'zustand';
import { httpGet, isDesktop } from './platform';
import { log } from './log';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
export const RELEASES_API = 'https://api.github.com/repos/unupunct/AdikaPDF/releases/latest';
export const RELEASES_PAGE = 'https://github.com/unupunct/AdikaPDF/releases/latest';
export const releaseTagPage = (version: string) => `https://github.com/unupunct/AdikaPDF/releases/tag/v${version}`;
const SETTINGS_KEY = 'adika.updates';
const WEEK = 7 * 24 * 3600 * 1000;

export interface ReleaseInfo {
  version: string;
  name: string;
  url: string;
  notes: string;
  publishedAt: string;
}

/** Numeric compare of "1.10.2" style versions (a leading "v" is ignored); >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** GitHub "latest release" JSON → ReleaseInfo (null for drafts, pre-releases or bad data). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft || r.prerelease || typeof r.tag_name !== 'string') return null;
  const version = r.tag_name.replace(/^v/i, '');
  if (!/^\d+(\.\d+)*/.test(version)) return null;
  const url = typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : RELEASES_PAGE;
  return {
    version,
    name: typeof r.name === 'string' && r.name ? r.name : `Adika PDF Editor ${version}`,
    url,
    notes: typeof r.body === 'string' ? r.body : '',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
  };
}

interface Settings {
  auto: boolean;
  lastCheck: number;
}

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return { auto: s.auto === true, lastCheck: typeof s.lastCheck === 'number' ? s.lastCheck : 0 };
  } catch {
    return { auto: false, lastCheck: 0 };
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode: the setting just isn't remembered */
  }
}

/** A signed update the app can install itself. */
export interface PendingUpdate {
  version: string;
  notes: string;
  date: string;
  /** Downloads, verifies the signature and runs the installer (on Windows the app then exits). */
  downloadAndInstall: (onProgress: (done: number, total: number | null) => void) => Promise<void>;
}

/** Asks the signed update feed: an update, null (nothing newer) or undefined (feed not usable here). */
export type UpdaterCheck = () => Promise<PendingUpdate | null | undefined>;

type Status = 'idle' | 'checking' | 'latest' | 'available' | 'error';
type Phase = 'idle' | 'downloading' | 'installing';

interface UpdateState {
  status: Status;
  latest: ReleaseInfo | null;
  error: string;
  auto: boolean;
  setAuto: (on: boolean) => void;
  /** Dismiss the status-bar notice for this version. */
  dismissed: string;
  dismiss: () => void;
  /** The latest version can be installed from the app (signed feed). */
  installable: boolean;
  phase: Phase;
  progress: { done: number; total: number | null };
  installError: string;
  /** The "update available" dialog (it stays open while the update downloads). */
  promptOpen: boolean;
  setPrompt: (open: boolean) => void;
}

export const useUpdates = create<UpdateState>()((set, get) => ({
  status: 'idle',
  latest: null,
  error: '',
  auto: loadSettings().auto,
  setAuto: (auto) => {
    saveSettings({ ...loadSettings(), auto });
    set({ auto });
  },
  dismissed: '',
  dismiss: () => set({ dismissed: get().latest?.version ?? '' }),
  installable: false,
  phase: 'idle',
  progress: { done: 0, total: null },
  installError: '',
  promptOpen: false,
  setPrompt: (promptOpen) => {
    if (promptOpen || get().phase === 'idle') set({ promptOpen, installError: '' });
  },
}));

let pending: PendingUpdate | null = null;

/** The Tauri updater (main window of the desktop app only: its permission is granted there). */
export const pluginUpdaterCheck: UpdaterCheck = async () => {
  if (!isDesktop) return undefined;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    if (getCurrentWindow().label !== 'main') return undefined;
    const { check } = await import('@tauri-apps/plugin-updater');
    const u = await check({ timeout: 30_000 });
    if (!u) return null;
    return {
      version: u.version,
      notes: u.body ?? '',
      date: u.date ?? '',
      downloadAndInstall: (onProgress) => {
        let done = 0;
        let total: number | null = null;
        return u.downloadAndInstall((ev) => {
          if (ev.event === 'Started') total = ev.data.contentLength ?? null;
          else if (ev.event === 'Progress') done += ev.data.chunkLength;
          onProgress(done, total);
        });
      },
    };
  } catch (e) {
    // No latest.json (an older release), offline, unreadable feed: the GitHub check decides.
    log('warn', `Update feed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
};

/** Ask now. `fetchJson` (GitHub API) and `updater` (signed feed) are replaceable for tests. */
export async function checkForUpdates(
  fetchJson: () => Promise<unknown> = async () => JSON.parse(new TextDecoder().decode(await httpGet(RELEASES_API))),
  updater: UpdaterCheck = pluginUpdaterCheck,
): Promise<ReleaseInfo | null> {
  if (useUpdates.getState().phase !== 'idle') return useUpdates.getState().latest;
  useUpdates.setState({ status: 'checking', error: '', installError: '' });
  try {
    const feed = await updater().catch(() => undefined);
    if (feed !== undefined) {
      saveSettings({ ...loadSettings(), lastCheck: Date.now() });
      pending = feed && compareVersions(feed.version, APP_VERSION) > 0 ? feed : null;
      if (!pending) {
        useUpdates.setState({ status: 'latest', installable: false });
        return null;
      }
      const rel: ReleaseInfo = { version: pending.version, name: `Adika PDF Editor ${pending.version}`, url: releaseTagPage(pending.version), notes: pending.notes, publishedAt: pending.date };
      useUpdates.setState({ status: 'available', latest: rel, installable: true });
      return rel;
    }
    pending = null;
    const rel = parseRelease(await fetchJson());
    saveSettings({ ...loadSettings(), lastCheck: Date.now() });
    if (!rel) throw new Error('GitHub did not return a release.');
    const newer = compareVersions(rel.version, APP_VERSION) > 0;
    useUpdates.setState({ status: newer ? 'available' : 'latest', latest: rel, installable: false });
    return newer ? rel : null;
  } catch (e) {
    useUpdates.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export type InstallDecision = 'install' | 'confirm-unsaved' | 'close-windows';

/**
 * Before the installer replaces the app (it closes every window): other windows
 * may hold unsaved work this one cannot back up, so they are closed first;
 * unsaved documents here need the user's go-ahead (they are kept as recovery copies).
 */
export function installDecision(o: { dirtyDocuments: number; otherWindows: number }): InstallDecision {
  if (o.otherWindows > 0) return 'close-windows';
  if (o.dirtyDocuments > 0) return 'confirm-unsaved';
  return 'install';
}

export interface InstallDeps {
  dirtyDocuments: () => Promise<number>;
  otherWindows: () => Promise<number>;
  confirmUnsaved: (n: number) => Promise<boolean>;
  /** Writes recovery copies of every unsaved document (offered again after the restart). */
  backup: () => Promise<void>;
}

const defaultInstallDeps: InstallDeps = {
  dirtyDocuments: async () => (await import('@/store/tabs')).dirtyTabCount(),
  otherWindows: async () => {
    if (!isDesktop) return 0;
    const { getAllWebviewWindows, getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const me = getCurrentWebviewWindow().label;
    return (await getAllWebviewWindows()).filter((w) => w.label !== me).length;
  },
  confirmUnsaved: async (n) => {
    const { askConfirm } = await import('@/store/useDialogs');
    return askConfirm({
      title: 'Install the update?',
      message:
        n === 1
          ? 'A document has unsaved changes. Save it first, or install now: Adika keeps a recovery copy and offers to restore it after the restart.'
          : `${n} documents have unsaved changes. Save them first, or install now: Adika keeps recovery copies and offers to restore them after the restart.`,
      confirmLabel: 'Install anyway',
    });
  },
  backup: async () => (await import('@/lib/recovery')).backupAllTabs(),
};

/** "Install and restart": asks about unsaved work, then downloads (with progress), verifies and runs the installer. False when it did not start or failed. */
export async function installUpdate(deps: InstallDeps = defaultInstallDeps, update: PendingUpdate | null = pending): Promise<boolean> {
  if (!update || useUpdates.getState().phase !== 'idle') return false;
  useUpdates.setState({ installError: '' });
  const dirty = await deps.dirtyDocuments();
  const decision = installDecision({ dirtyDocuments: dirty, otherWindows: await deps.otherWindows() });
  if (decision === 'close-windows') {
    useUpdates.setState({ installError: 'Close the other Adika windows first (they may have unsaved changes), then try again.' });
    return false;
  }
  if (decision === 'confirm-unsaved') {
    if (!(await deps.confirmUnsaved(dirty))) return false;
    await deps.backup();
  }
  useUpdates.setState({ phase: 'downloading', progress: { done: 0, total: null } });
  try {
    await update.downloadAndInstall((done, total) => {
      useUpdates.setState({ progress: { done, total } });
    });
    // On Windows the installer has taken over and the app exits here.
    useUpdates.setState({ phase: 'installing' });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `Update install: ${msg}`);
    useUpdates.setState({ phase: 'idle', installError: msg });
    return false;
  }
}

/** At start-up: check once a week, only when the user turned it on. */
export function maybeAutoCheck(now = Date.now()): boolean {
  const s = loadSettings();
  if (!s.auto || now - s.lastCheck < WEEK) return false;
  void checkForUpdates();
  return true;
}
