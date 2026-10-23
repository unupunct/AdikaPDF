/**
 * Research prototype: where the XFA script runtime (runtime.js) runs.
 * - quickJsEngine: pdf.js' QuickJS sandbox, the one the app already uses for
 *   AcroForm JavaScript (formSandbox.ts). The runtime goes in as a document
 *   Open action and reports back through app.alert.
 * - nodeVmEngine: node:vm with a time limit (tests and measurements only).
 */
import type { QuickSandbox } from '../sandboxHost';
import { sandboxHost } from '../sandboxHost';

export interface ScriptEngine {
  /** Evaluates `source`, whose last action is `__emit(string)`; returns that string. */
  run(source: string): Promise<string>;
  readonly name: string;
}

type SandboxWindow = Parameters<typeof sandboxHost>[0];

export function quickJsEngine(sandbox: QuickSandbox, win: SandboxWindow): ScriptEngine {
  return {
    name: 'quickjs',
    async run(source) {
      const host = sandboxHost(win, sandbox);
      const code = `var __emit = function (s) { app.alert('XFARESULT:' + s); };\n${source}`;
      const created = host.call({
        kind: 'create',
        data: {
          objects: {},
          calculationOrder: [],
          appInfo: { platform: 'WIN', language: 'en-US' },
          docInfo: { numPages: 1, filename: '', baseURL: '', URL: '', filesize: 0, actions: { Open: [code] } },
        },
      });
      if (!created.ok) throw new Error('sandbox create failed');
      const r = host.call({ kind: 'dispatch', event: { id: 'doc', name: 'Open' } });
      host.destroy();
      const out = r.alerts.find((a) => a.startsWith('XFARESULT:'));
      if (!out) throw new Error(`no result from the sandbox (${r.alerts.slice(0, 3).join(' | ') || 'no alerts'})`);
      return out.slice('XFARESULT:'.length);
    },
  };
}

export function nodeVmEngine(timeoutMs = 120_000): ScriptEngine {
  return {
    name: 'node-vm',
    async run(source) {
      const vm = await import('node:vm');
      let out: string | undefined;
      const ctx = vm.createContext({ __emit: (s: string) => (out = s) });
      vm.runInContext(source, ctx, { timeout: timeoutMs });
      if (out === undefined) throw new Error('no result');
      return out;
    },
  };
}
