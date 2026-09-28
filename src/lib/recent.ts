/** Recently opened files (per user, in local storage). */
export interface RecentFile {
  path: string;
  name: string;
  pages: number;
  openedAt: number;
}

const KEY = 'adika.recent.v1';
const MAX = 20;

export function getRecent(): RecentFile[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as RecentFile[]).filter((r) => r && typeof r.path === 'string') : [];
  } catch {
    return [];
  }
}

function store(list: RecentFile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage unavailable: recent list is best-effort */
  }
  window.dispatchEvent(new Event('adika:recent'));
}

export function addRecent(path: string, name: string, pages: number): void {
  const key = path.toLowerCase();
  store([{ path, name, pages, openedAt: Date.now() }, ...getRecent().filter((r) => r.path.toLowerCase() !== key)]);
}

export function removeRecent(path: string): void {
  store(getRecent().filter((r) => r.path.toLowerCase() !== path.toLowerCase()));
}

export function clearRecent(): void {
  store([]);
}
