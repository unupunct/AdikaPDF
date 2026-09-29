/**
 * Update check: asks GitHub for the latest release of Adika and compares it
 * with this build. Nothing else is sent (no IDs, no document data). The
 * automatic weekly check is opt-in; "Check for updates" in About always works.
 */
import { create } from 'zustand';
import { httpGet } from './platform';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
export const RELEASES_API = 'https://api.github.com/repos/unupunct/AdikaPDF/releases/latest';
export const RELEASES_PAGE = 'https://github.com/unupunct/AdikaPDF/releases/latest';
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

type Status = 'idle' | 'checking' | 'latest' | 'available' | 'error';

interface UpdateState {
  status: Status;
  latest: ReleaseInfo | null;
  error: string;
  auto: boolean;
  setAuto: (on: boolean) => void;
  /** Dismiss the status-bar notice for this version. */
  dismissed: string;
  dismiss: () => void;
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
}));

/** Ask GitHub now. `fetchJson` is replaceable for tests. */
export async function checkForUpdates(fetchJson: () => Promise<unknown> = async () => JSON.parse(new TextDecoder().decode(await httpGet(RELEASES_API)))): Promise<ReleaseInfo | null> {
  useUpdates.setState({ status: 'checking', error: '' });
  try {
    const rel = parseRelease(await fetchJson());
    saveSettings({ ...loadSettings(), lastCheck: Date.now() });
    if (!rel) throw new Error('GitHub did not return a release.');
    const newer = compareVersions(rel.version, APP_VERSION) > 0;
    useUpdates.setState({ status: newer ? 'available' : 'latest', latest: rel });
    return newer ? rel : null;
  } catch (e) {
    useUpdates.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** At start-up: check once a week, only when the user turned it on. */
export function maybeAutoCheck(now = Date.now()): boolean {
  const s = loadSettings();
  if (!s.auto || now - s.lastCheck < WEEK) return false;
  void checkForUpdates();
  return true;
}
