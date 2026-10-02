/**
 * Application log. Lines go to the native log files (see src-tauri/src/logging.rs);
 * in a plain browser they only go to the console.
 */
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './platform';

export type LogLevel = 'info' | 'warn' | 'error';

let installed = false;
let recent = 0;

/** Writes one log line (best effort, rate-limited against error storms). */
export function log(level: LogLevel, message: string): void {
  if (!isDesktop) return;
  const now = Date.now();
  if (level !== 'info' && now - recent < 20) return;
  recent = now;
  void invoke('log_write', { level, message: message.slice(0, 8000) }).catch(() => undefined);
}

/** Writes a crash report file; returns its path (or null in the browser). */
export async function logCrash(source: string, details: string): Promise<string | null> {
  if (!isDesktop) return null;
  return invoke<string>('log_crash', { source, details }).catch(() => null);
}

export async function logsFolder(): Promise<string | null> {
  if (!isDesktop) return null;
  return invoke<string>('logs_path').catch(() => null);
}

export async function openLogsFolder(): Promise<void> {
  if (isDesktop) await invoke('open_logs_folder');
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`;
  try {
    return typeof e === 'string' ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Captures uncaught errors and unhandled promise rejections. */
export function installGlobalErrorLogging(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    // Resource load errors have no message; skip them.
    if (!e.message) return;
    log('error', `Uncaught ${e.message} at ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? `\n${e.error.stack}` : ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as unknown;
    // Late work for a closed document is expected; don't log it as an error.
    if (reason instanceof Error && reason.name === 'SourceClosedError') return;
    // A cancelled operation is not a failure.
    if ((reason instanceof Error || reason instanceof DOMException) && reason.name === 'AbortError') return;
    log('error', `Unhandled promise rejection: ${errorText(reason)}`);
    notifyFailure(reason);
  });
}

let lastNotice = 0;

/** Shows an error toast for a failure nothing else reported (at most one every few seconds). */
function notifyFailure(reason: unknown): void {
  const now = Date.now();
  if (now - lastNotice < 5000) return;
  lastNotice = now;
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  const message = text ? `Something went wrong: ${text.slice(0, 300)}` : 'Something went wrong.';
  void import('../store/usePDFStore').then((m) => m.usePDFStore.getState().toast(message, 'error')).catch(() => undefined);
}
