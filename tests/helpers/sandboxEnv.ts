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

export async function loadTestSandbox() {
  installSandboxEnv();
  // @ts-expect-error pdf.js ships no types for its sandbox bundle
  const mod: unknown = await import('pdfjs-dist/legacy/build/pdf.sandbox.mjs');
  const { QuickJSSandbox } = mod as { QuickJSSandbox: (url: string) => Promise<{ create(d: unknown): void; dispatchEvent(e: unknown): void; nukeSandbox(): void }> };
  return QuickJSSandbox(sandboxWasmUrl);
}
