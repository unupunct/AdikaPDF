/**
 * Automation: the command line (`--batch`) and watched folders (PDFs that
 * arrive in a folder are processed with a saved action sequence while
 * Adika runs; results go to an output folder, originals to "Processed").
 */
import { runBatchOp, runSequence, sequenceSuffix, BATCH_OPS, BatchSkip, outputPath, type ActionSequence, type BatchOp } from '@/lib/batch';
import { CLI_HELP, absolutePath, hasWildcard, parseCli, wildcard } from '@/lib/cli';
import { loadFontBytes } from '@/lib/fonts';
import { cliArgs, cliCwd, cliExit, cliPrint, fileStamp, isDesktop, listDir, makeDir, moveFile, readFile, writeFile } from '@/lib/platform';
import { loadSequences, ocrBytes } from './batch';

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));

async function processFile(input: string, job: { steps: BatchOp[]; suffix: string }, outDir: string | null): Promise<{ output: string; note?: string }> {
  const { colorHooks } = await import('./printProduction');
  const ctx = { fileName: baseName(input), loadFont: loadFontBytes, ocr: ocrBytes, colorHooks };
  const bytes = await readFile(input);
  const r = job.steps.length === 1 ? await runBatchOp(bytes, job.steps[0], ctx) : await runSequence(bytes, job.steps, ctx);
  const target = outDir ? `${outDir}\\${baseName(input)}` : input;
  if (outDir) await makeDir(outDir);
  const output = await outputPath(target, job.suffix, async (p) => (await fileStamp(p)) !== null);
  await writeFile(output, r.bytes);
  return { output, note: r.note };
}

// ---------------------------------------------------------------- command line

/** Runs `--batch` from the command line, then exits. Returns false when not in batch mode. */
export async function runCommandLine(): Promise<boolean> {
  if (!isDesktop) return false;
  const args = await cliArgs();
  if (!args.includes('--batch')) return false;
  const job = parseCli(args);
  const print = (s: string, err = false) => cliPrint(s, err).catch(() => undefined);
  if (job.help || job.errors.length) {
    for (const e of job.errors) await print(`error: ${e}`, true);
    await print(CLI_HELP, !!job.errors.length);
    await cliExit(job.help && !job.errors.length ? 0 : 2);
    return true;
  }
  let steps = job.steps;
  let suffix = steps.length === 1 ? BATCH_OPS.find((o) => o.kind === steps[0].kind)!.suffix : '-processed';
  if (job.sequence) {
    const seq = loadSequences().find((s) => s.name.toLowerCase() === job.sequence!.toLowerCase());
    if (!seq) {
      await print(`error: no saved sequence named "${job.sequence}". Saved: ${loadSequences().map((s) => s.name).join(', ') || 'none'}.`, true);
      await cliExit(2);
      return true;
    }
    steps = [...seq.steps.filter((s) => s.kind !== 'protect' || s.userPassword), ...steps];
    suffix = sequenceSuffix(seq.name);
  }
  const cwd = await cliCwd();
  const files: string[] = [];
  for (const f of job.files) {
    const abs = absolutePath(f, cwd);
    if (!hasWildcard(baseName(abs))) {
      files.push(abs);
      continue;
    }
    const re = wildcard(baseName(abs));
    try {
      for (const e of await listDir(dirName(abs))) if (!e.isDir && re.test(e.name)) files.push(e.path);
    } catch (e) {
      await print(`error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  if (!files.length) {
    await print('error: no files match.', true);
    await cliExit(2);
    return true;
  }
  const out = job.out ? absolutePath(job.out, cwd) : null;
  let failed = 0;
  for (const f of files) {
    try {
      const r = await processFile(f, { steps, suffix }, out);
      await print(`done: ${f} -> ${r.output}${r.note ? ` (${r.note})` : ''}`);
    } catch (e) {
      if (e instanceof BatchSkip) await print(`skipped: ${f}: ${e.message}`);
      else {
        failed++;
        await print(`failed: ${f}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  }
  await print(`${files.length - failed} of ${files.length} file(s) done.`);
  await cliExit(failed ? 1 : 0);
  return true;
}

// ---------------------------------------------------------------- watched folders

export interface WatchedFolder {
  id: string;
  folder: string;
  /** Saved sequence id. */
  sequenceId: string;
  /** Results folder; empty = "<folder>\\Output". */
  outFolder: string;
  enabled: boolean;
}

export interface WatchEvent {
  at: number;
  folder: string;
  file: string;
  status: 'done' | 'failed' | 'skipped';
  message: string;
}

const WATCH_KEY = 'adika.watchedFolders';

export function loadWatched(): WatchedFolder[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as WatchedFolder[]) : [];
  } catch {
    return [];
  }
}

export function saveWatched(list: WatchedFolder[]): void {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(list));
  } catch {
    /* not kept */
  }
  restartWatching();
}

const events: WatchEvent[] = [];
const listeners = new Set<() => void>();
export const watchEvents = () => [...events];
export function onWatchEvents(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function addEvent(e: WatchEvent) {
  events.unshift(e);
  events.length = Math.min(events.length, 50);
  for (const l of listeners) l();
}

/** Files seen with their size, to wait until a copy has finished. */
const pending = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function pollOnce(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const sequences = loadSequences();
    for (const w of loadWatched()) {
      if (!w.enabled || !w.folder) continue;
      const seq: ActionSequence | undefined = sequences.find((s) => s.id === w.sequenceId);
      if (!seq) continue;
      let entries;
      try {
        entries = await listDir(w.folder);
      } catch {
        continue; // folder gone (network drive offline…): try again later
      }
      for (const e of entries) {
        if (e.isDir || !/\.pdf$/i.test(e.name)) continue;
        // Process only when the size has been stable for one round (the copy is complete).
        if (pending.get(e.path) !== e.size) {
          pending.set(e.path, e.size);
          continue;
        }
        pending.delete(e.path);
        const out = w.outFolder || `${w.folder}\\Output`;
        try {
          const r = await processFile(e.path, { steps: seq.steps, suffix: sequenceSuffix(seq.name) }, out);
          await moveFile(e.path, `${w.folder}\\Processed\\${e.name}`);
          addEvent({ at: Date.now(), folder: w.folder, file: e.name, status: 'done', message: baseName(r.output) });
        } catch (err) {
          const skipped = err instanceof BatchSkip;
          await moveFile(e.path, `${w.folder}\\${skipped ? 'Skipped' : 'Failed'}\\${e.name}`).catch(() => undefined);
          addEvent({ at: Date.now(), folder: w.folder, file: e.name, status: skipped ? 'skipped' : 'failed', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } finally {
    busy = false;
  }
}

/** Starts (or restarts) watching the enabled folders; every few seconds while Adika runs. */
export function restartWatching(intervalMs = 4000): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (!isDesktop || !loadWatched().some((w) => w.enabled)) return;
  timer = setInterval(() => void pollOnce(), intervalMs);
  void pollOnce();
}

/** For tests: one polling round now. */
export const pollWatchedNow = pollOnce;
