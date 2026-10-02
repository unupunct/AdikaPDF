// Form JavaScript off the UI thread: the app can terminate this worker when a
// script never returns (formSandbox.ts watchdog).
import { sandboxHost, type QuickSandbox, type SandboxCall } from './sandboxHost';

declare const self: Record<string, unknown> & {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

// pdf.js' sandbox talks to `window`: timers, events and URL exist in a worker
// too; dialogs cannot block here, so confirm says no and prompt has no answer.
self.window = self;
self.alert = () => {};
self.confirm = () => false;
self.prompt = () => null;

let host: ReturnType<typeof sandboxHost> | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; wasmUrl?: string; call?: SandboxCall }>) => {
  const { id, wasmUrl, call } = e.data;
  try {
    if (wasmUrl) {
      // @ts-expect-error pdf.js ships no types for its sandbox bundle
      const mod: unknown = await import('pdfjs-dist/build/pdf.sandbox.mjs');
      const { QuickJSSandbox } = mod as { QuickJSSandbox: (wasmUrl: string) => Promise<QuickSandbox> };
      host = sandboxHost(self as never, await QuickJSSandbox(wasmUrl));
      self.postMessage({ id, reply: { ok: true, events: [], alerts: [] } });
    } else if (call && host) {
      self.postMessage({ id, reply: host.call(call) });
    } else throw new Error('sandbox not started');
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
