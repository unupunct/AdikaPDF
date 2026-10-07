/**
 * Runs pdf.js' QuickJS form sandbox under Node: a minimal window (events,
 * timers, alert) and fetch() for the file: URLs of the wasm.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function installSandboxEnv(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.window) {
    const win = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(win, { setTimeout, clearTimeout, setInterval, clearInterval, CustomEvent, URL, console, alert: () => {}, confirm: () => true, prompt: () => null });
    g.window = win;
  }
  const realFetch = globalThis.fetch;
  if (!(realFetch as { sandboxStub?: boolean }).sandboxStub) {
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('file:')) return new Response(readFileSync(fileURLToPath(url)), { headers: { 'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
      return realFetch(input, init);
    }) as typeof fetch & { sandboxStub?: boolean };
    stub.sandboxStub = true;
    globalThis.fetch = stub;
  }
}

export const sandboxWasmUrl = pathToFileURL(join(process.cwd(), 'node_modules', 'pdfjs-dist', 'wasm') + '/').href;

export async function loadQuickSandbox() {
  installSandboxEnv();
  // @ts-expect-error pdf.js ships no types for its sandbox bundle
  const mod: unknown = await import('pdfjs-dist/legacy/build/pdf.sandbox.mjs');
  const { QuickJSSandbox } = mod as { QuickJSSandbox: (url: string) => Promise<{ create(d: unknown): void; dispatchEvent(e: unknown): void; nukeSandbox(): void }> };
  return QuickJSSandbox(sandboxWasmUrl);
}

/** The sandbox in this thread (no watchdog can interrupt it). */
export async function loadTestSandbox() {
  // Imported here: sandboxWorker.mjs loads this file in plain Node, without the @ alias.
  const { inThreadRunner } = await import('@/lib/pdf/formSandbox');
  return inThreadRunner(await loadQuickSandbox(), (globalThis as unknown as { window: Parameters<typeof inThreadRunner>[1] }).window);
}

/** The sandbox in a Node worker thread, like the app's Web Worker: it can be terminated mid-script. */
export async function loadWorkerSandbox() {
  const { workerRunner } = await import('@/lib/pdf/formSandbox');
  const { Worker } = await import('node:worker_threads');
  const w = new Worker(new URL('./sandboxWorker.mjs', import.meta.url));
  const like = {
    postMessage: (m: unknown) => w.postMessage(m),
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    terminate: () => void w.terminate(),
    terminated: false,
  };
  w.on('message', (data) => like.onmessage?.({ data }));
  w.on('error', (e) => like.onerror?.(e));
  w.on('exit', () => (like.terminated = true));
  return { runner: await workerRunner(like, sandboxWasmUrl), worker: like };
}
