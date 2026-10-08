// Node worker thread standing in for src/lib/pdf/formSandbox.worker.ts in tests:
// the same message protocol around the same sandboxHost.
import { parentPort } from 'node:worker_threads';
import { loadQuickSandbox } from './sandboxEnv.ts';
import { sandboxHost } from '../../src/lib/pdf/sandboxHost.ts';

let host = null;
parentPort.on('message', async ({ id, wasmUrl, call }) => {
  try {
    if (wasmUrl) {
      const sandbox = await loadQuickSandbox(); // installs globalThis.window first
      host = sandboxHost(globalThis.window, sandbox);
      parentPort.postMessage({ id, reply: { ok: true, events: [], alerts: [] } });
    } else if (call && host) {
      parentPort.postMessage({ id, reply: host.call(call) });
    } else throw new Error('sandbox not started');
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) });
  }
});
