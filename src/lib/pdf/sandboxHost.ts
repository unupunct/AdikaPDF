/**
 * The part of the form-script sandbox that runs next to QuickJS: one call
 * (create the sandbox or dispatch an event) and everything it reported. It
 * runs in the sandbox Web Worker in the app and in the calling thread in
 * tests. No imports: the Node test worker loads this file as is.
 */

export interface QuickSandbox {
  create(data: unknown): void;
  dispatchEvent(event: unknown): void;
  nukeSandbox(): void;
}

export type SandboxCall = { kind: 'create'; data: unknown } | { kind: 'dispatch'; event: unknown };

export interface SandboxReply {
  ok: boolean;
  /** The details of every updatefromsandbox event, in order. */
  events: unknown[];
  /** app.alert messages. */
  alerts: string[];
}

interface SandboxWindow {
  addEventListener(type: string, fn: (e: Event) => void): void;
  alert: (msg?: unknown) => void;
}

/** Runs calls against one sandbox, collecting what it sends back through the window. */
export function sandboxHost(win: SandboxWindow, sandbox: QuickSandbox): { call(c: SandboxCall): SandboxReply; destroy(): void } {
  let events: unknown[] | null = null;
  win.addEventListener('updatefromsandbox', (e) => events?.push((e as CustomEvent).detail));
  return {
    call(c) {
      events = [];
      const alerts: string[] = [];
      const prevAlert = win.alert;
      win.alert = (msg?: unknown) => {
        alerts.push(String(msg ?? ''));
      };
      let ok = true;
      try {
        if (c.kind === 'create') sandbox.create(c.data);
        else sandbox.dispatchEvent(c.event);
      } catch {
        ok = false;
      } finally {
        win.alert = prevAlert;
      }
      const out = { ok, events, alerts };
      events = null;
      return out;
    },
    destroy() {
      try {
        sandbox.nukeSandbox();
      } catch {
        /* already gone */
      }
    },
  };
}
