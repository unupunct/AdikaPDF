/**
 * Report a problem / Suggest a feature / Report this crash: the review dialog
 * opens with what GitHub will get; the browser opens only when the user asks.
 * Nothing is ever sent by Adika itself.
 */
import { create } from 'zustand';
import { isDesktop } from '@/lib/platform';
import { LANGS, useLang } from '@/lib/i18n';
import { usePolicy } from '@/lib/policy';
import { APP_VERSION } from '@/lib/updates';
import { osFromUserAgent, sanitizeReport, type ReportEnv, type ReportKind } from '@/lib/report';

export interface ReportState {
  open: boolean;
  kind: ReportKind;
  title: string;
  /** The crash report being reported (sanitised, editable), or null. */
  crash: { name: string; text: string } | null;
  env: ReportEnv | null;
}

export const useReport = create<ReportState>()(() => ({ open: false, kind: 'bug', title: '', crash: null, env: null }));

const DONT_ASK = 'adika.crashReports.dontAsk';
const SEEN = 'adika.crashReports.seen';

let osText: Promise<string> | null = null;

export async function reportEnv(): Promise<ReportEnv> {
  osText ??= (async () => {
    if (isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      const v = await invoke<string>('os_version').catch(() => '');
      if (v) return v;
    }
    return osFromUserAgent(navigator.userAgent);
  })();
  const lang = useLang.getState().lang;
  return {
    version: APP_VERSION,
    os: await osText,
    language: `${lang} (${LANGS.find((l) => l.id === lang)?.label ?? lang})`,
    install: usePolicy.getState().portable ? 'Portable' : 'Installed',
  };
}

export async function openReport(kind: ReportKind, crash: ReportState['crash'] = null): Promise<void> {
  const env = await reportEnv();
  useReport.setState({ open: true, kind, title: crash ? 'Adika closed unexpectedly' : '', crash, env });
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* no storage */
  }
}

export function crashPromptsOff(): boolean {
  return readJson(DONT_ASK, false);
}

export function setCrashPromptsOff(off: boolean): void {
  writeJson(DONT_ASK, off);
}

/** A crash report's text without paths, document names or the user name. */
export async function sanitizedCrash(name: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  const [text, user] = await Promise.all([invoke<string>('crash_report_read', { name }), invoke<string>('os_user_name').catch(() => '')]);
  return sanitizeReport(text, { userName: user, profile: user ? `C:\\Users\\${user}` : null });
}

/**
 * At start-up: a crash report not offered before (Rust panic, or the
 * interface's crash screen) → a toast with "Report this crash…". Each report
 * is offered once; "Don't ask again" in the dialog turns this off.
 */
export async function offerCrashReport(): Promise<void> {
  if (!isDesktop || crashPromptsOff()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const reports = await invoke<Array<{ name: string; modified: number }>>('crash_reports').catch(() => []);
  const seen = new Set(readJson<string[]>(SEEN, []));
  const fresh = reports.filter((r) => !seen.has(r.name));
  if (!fresh.length) return;
  writeJson(SEEN, reports.map((r) => r.name).slice(0, 200));
  const newest = fresh[0];
  const { usePDFStore } = await import('@/store/usePDFStore');
  usePDFStore.getState().toast('Adika ran into a problem last time and saved a crash report. You can look at it and report it on GitHub.', 'info', {
    label: 'Report this crash…',
    run: () =>
      void sanitizedCrash(newest.name)
        .then((text) => openReport('bug', { name: newest.name, text }))
        .catch((e: unknown) => usePDFStore.getState().toast(String(e), 'error')),
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
