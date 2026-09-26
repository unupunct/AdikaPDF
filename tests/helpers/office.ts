// Runs the Office COM PowerShell helpers from vitest (Windows only).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SCRATCH = resolve(here, '..', '..', '.tools', 'scratch-c');

export function scratchPath(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  return join(SCRATCH, name);
}

export type ComResult = { ok: true; text: string; pages: number; tables: number } | { ok: false; skip: boolean; reason: string };

function runPs(script: string, args: string[], timeoutMs: number) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, script), ...args],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  );
}

/** Opens `path` in Word (read-only) and returns Content.Text. */
export function wordReadText(path: string): ComResult {
  if (process.platform !== 'win32') return { ok: false, skip: true, reason: 'not Windows' };
  const out = `${path}.word.txt`;
  rmSync(out, { force: true });
  const r = runPs('word-read-text.ps1', ['-Path', path, '-OutPath', out], 180_000);
  if (r.error) return { ok: false, skip: true, reason: `powershell failed: ${r.error.message}` };
  if (r.status === 2) return { ok: false, skip: true, reason: (r.stdout || '').trim() || 'Word COM unavailable' };
  if (r.status !== 0 || !existsSync(out)) return { ok: false, skip: false, reason: `${r.stdout}\n${r.stderr}`.trim() };
  const raw = readFileSync(out, 'utf8');
  const m = /^PAGES=(\d+)\nTABLES=(\d+)\n/.exec(raw);
  return { ok: true, pages: Number(m?.[1] ?? 0), tables: Number(m?.[2] ?? 0), text: raw.slice(m?.[0].length ?? 0) };
}

/** Creates a .msg via Outlook COM. */
export function outlookMakeMsg(outPath: string, attachmentPath: string): { ok: true } | { ok: false; reason: string } {
  if (process.platform !== 'win32') return { ok: false, reason: 'not Windows' };
  rmSync(outPath, { force: true });
  const r = runPs('outlook-make-msg.ps1', ['-OutPath', outPath, '-AttachmentPath', attachmentPath], 45_000);
  if (r.error) return { ok: false, reason: `powershell failed: ${r.error.message}` };
  if (r.status !== 0 || !existsSync(outPath)) return { ok: false, reason: (r.stdout || r.stderr || `exit ${r.status}`).trim() };
  return { ok: true };
}
