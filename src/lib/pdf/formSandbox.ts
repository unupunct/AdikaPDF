/**
 * Acrobat form JavaScript (keystroke, validate, calculate and format actions,
 * document-level scripts) run in pdf.js' QuickJS sandbox: a separate
 * WebAssembly interpreter that sees only the form fields and the Acrobat API
 * pdf.js implements (AF* functions, this.getField, event, util, app.alert…),
 * with no access to files, the network or the app.
 *
 * One FormScripting per document. commit() hands a value to the sandbox the
 * way Acrobat does when a field loses focus and returns every field the
 * scripts changed (the value itself, totals, formatted text, hidden fields)
 * and the messages app.alert showed.
 *
 * In the app the sandbox runs in a Web Worker with a watchdog: a call that
 * runs past the time limit terminates the worker and turns the scripts off
 * for that document (stopped in the result).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { sandboxHost, type QuickSandbox, type SandboxCall, type SandboxReply } from './sandboxHost';

export type { QuickSandbox } from './sandboxHost';

export type ScriptValue = string | boolean | string[];

export interface FieldUpdate {
  value?: ScriptValue;
  /** Text shown in the field (Format action), null when there is none. */
  formatted?: string | null;
  hidden?: boolean;
}

export interface CommitResult {
  /** False when a validate script rejected the value (it is cleared, like Acrobat). */
  accepted: boolean;
  updates: Record<string, FieldUpdate>;
  alerts: string[];
  /** True when the scripts ran past the time limit and are now off for this document. */
  stopped?: boolean;
}

/**
 * Where the sandbox runs: a Web Worker in the app (so a script that never
 * returns can be stopped), the calling thread in tests.
 */
export interface ScriptRunner {
  call(c: SandboxCall): Promise<SandboxReply>;
  /** Stops the sandbox at once, even in the middle of a script. */
  terminate(): void;
}
export type SandboxLoader = () => Promise<ScriptRunner>;

/** How long one event's scripts may run before they are turned off. */
export const SCRIPT_TIME_LIMIT_MS = 2000;

/** Runs the sandbox in this thread: nothing can interrupt a script there. */
export function inThreadRunner(sandbox: QuickSandbox, win: Parameters<typeof sandboxHost>[0] = window): ScriptRunner {
  const host = sandboxHost(win, sandbox);
  return { call: async (c) => host.call(c), terminate: () => host.destroy() };
}

export interface WorkerLike {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

/** Starts the sandbox in a worker (formSandbox.worker.ts) and talks to it by message. */
export async function workerRunner(worker: WorkerLike, wasmUrl: string): Promise<ScriptRunner> {
  let next = 0;
  const pending = new Map<number, { resolve: (r: SandboxReply) => void; reject: (e: Error) => void }>();
  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  worker.onmessage = (e) => {
    const { id, reply, error } = e.data as { id: number; reply?: SandboxReply; error?: string };
    const p = pending.get(id);
    pending.delete(id);
    if (error !== undefined) p?.reject(new Error(error));
    else if (reply) p?.resolve(reply);
  };
  worker.onerror = (e) => failAll(new Error(`form script worker failed: ${String((e as { message?: string })?.message ?? e)}`));
  const send = (msg: Record<string, unknown>) =>
    new Promise<SandboxReply>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg });
    });
  try {
    await send({ wasmUrl });
  } catch (e) {
    worker.terminate();
    throw e;
  }
  return {
    call: (call) => send({ call }),
    terminate: () => {
      worker.terminate();
      failAll(new Error('form scripts stopped'));
    },
  };
}

interface SandboxDetail {
  id?: string;
  siblings?: string[];
  command?: string;
  value?: unknown;
  formattedValue?: string | null;
  hidden?: boolean;
  display?: number;
}

interface WidgetInfo {
  id: string;
  type: string;
  exportValues?: string;
  actions?: Map<string, string[]> | Record<string, string[]>;
}

const count = (m: unknown) => (m instanceof Map ? m.size : m && typeof m === 'object' ? Object.keys(m).length : 0);

/** pdf.js returns the fields as a Map (field name -> widgets). */
async function fieldObjects(doc: PDFDocumentProxy): Promise<Record<string, WidgetInfo[]>> {
  const o = (await doc.getFieldObjects()) as unknown;
  if (!o) return {};
  return o instanceof Map ? Object.fromEntries(o) : (o as Record<string, WidgetInfo[]>);
}

/** True when a form field has JavaScript of its own, or the document has scripts. */
export async function hasFormScripts(doc: PDFDocumentProxy): Promise<boolean> {
  const [objects, docActions] = await Promise.all([fieldObjects(doc), doc.getJSActions()]);
  if (count(docActions)) return true;
  for (const widgets of Object.values(objects)) for (const w of widgets) if (count(w.actions)) return true;
  return false;
}

/**
 * The calculation order, with every field that has a calculate script: a
 * form without /CO (or one that misses fields) is still calculated, as
 * Acrobat and Adika's own form logic do.
 */
function withAllCalculations(order: string[], objects: Record<string, WidgetInfo[]>): string[] {
  const out = [...order];
  const has = (a: WidgetInfo['actions']) => (a instanceof Map ? a.has('Calculate') : !!a && 'Calculate' in a);
  for (const ws of Object.values(objects)) {
    const w = ws.find((x) => has(x.actions));
    if (!w) continue;
    if (!ws.some((x) => out.includes(x.id))) out.push(ws[0].id);
  }
  return out;
}

interface Drive {
  ok: boolean;
  rejected: boolean;
  stopped: boolean;
  updates: Record<string, FieldUpdate>;
  alerts: string[];
}

export class FormScripting {
  private names = new Map<string, string>(); // widget id -> field name
  private widgets = new Map<string, WidgetInfo[]>(); // field name -> widgets
  private known = new Map<string, ScriptValue>(); // last value per field as the sandbox has it
  private collected: Record<string, FieldUpdate> = {};
  private alerts: string[] = [];
  private rejected = false;
  private queue: Promise<unknown> = Promise.resolve();
  private halted = false;
  private runner: ScriptRunner;
  private limitMs: number;

  private constructor(runner: ScriptRunner, limitMs: number) {
    this.runner = runner;
    this.limitMs = limitMs;
  }

  /**
   * Starts the scripts of a document (null when it has none) and runs its
   * Open scripts; `stopped` when those already ran past the time limit.
   */
  static async start(
    doc: PDFDocumentProxy,
    load: SandboxLoader,
    opts: { timeLimitMs?: number } = {},
  ): Promise<{ scripting: FormScripting; updates: Record<string, FieldUpdate>; alerts: string[]; stopped: boolean } | null> {
    const [objects, calculationOrder, docActions, meta] = await Promise.all([
      fieldObjects(doc),
      doc.getCalculationOrderIds(),
      doc.getJSActions(),
      doc.getMetadata().catch(() => null),
    ]);
    if (!(await hasFormScripts(doc))) return null;
    const s = new FormScripting(await load(), opts.timeLimitMs ?? SCRIPT_TIME_LIMIT_MS);
    for (const [name, ws] of Object.entries(objects)) {
      s.widgets.set(name, ws);
      for (const w of ws) s.names.set(w.id, name);
      const v = (ws.find((w) => w.type) as { value?: ScriptValue } | undefined)?.value;
      if (v !== undefined) s.known.set(name, v);
    }
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const run = await s.drive({
      kind: 'create',
      data: {
        objects,
        calculationOrder: withAllCalculations(calculationOrder ?? [], objects),
        appInfo: { platform: 'WIN', language: typeof navigator !== 'undefined' ? navigator.language : 'en-US' },
        docInfo: { ...info, numPages: doc.numPages, filename: '', baseURL: '', URL: '', filesize: 0, actions: docActions ?? {} },
      },
    });
    if (run.stopped) return { scripting: s, updates: {}, alerts: [], stopped: true };
    if (!run.ok) {
      s.destroy();
      throw new Error('The form scripts could not be started.');
    }
    const open = await s.drive({ kind: 'dispatch', event: { id: 'doc', name: 'Open' } });
    return { scripting: s, updates: open.updates, alerts: open.alerts, stopped: open.stopped };
  }

  /** False once the scripts ran past the time limit (or were destroyed). */
  get running(): boolean {
    return !this.halted;
  }

  /** The value the scripts last gave a field. */
  valueOf(name: string): ScriptValue | undefined {
    return this.known.get(name);
  }

  /** Hands the user's value to the scripts (keystroke + validate, then calculations and formats). */
  async commit(name: string, value: ScriptValue): Promise<CommitResult> {
    // pdf.js lists the field itself (no type) before its widgets.
    const ws = (this.widgets.get(name) ?? []).filter((x) => x.type);
    if (this.halted) return { accepted: true, updates: { [name]: { value } }, alerts: [], stopped: true };
    if (!ws.length) return { accepted: true, updates: { [name]: { value } }, alerts: [] };
    const w = ws[0];
    let event: Record<string, unknown>;
    if (w.type === 'checkbox') {
      event = { id: w.id, name: 'Action', value: value === true };
    } else if (w.type === 'radiobutton') {
      const chosen = ws.find((x) => x.exportValues === value) ?? w;
      event = { id: chosen.id, name: 'Action', value: chosen.exportValues === value };
    } else {
      event = { id: w.id, name: 'Keystroke', value, change: '', willCommit: true, commitKey: 1, selStart: -1, selEnd: -1 };
    }
    const r = await this.drive({ kind: 'dispatch', event });
    if (r.stopped) return { accepted: true, updates: { [name]: { value } }, alerts: [], stopped: true };
    // Buttons report nothing for themselves; the value is what the user chose.
    if (!(name in r.updates) && !r.rejected) r.updates[name] = { value };
    if (r.updates[name]?.value !== undefined) this.known.set(name, r.updates[name].value!);
    else if (!r.rejected) this.known.set(name, value);
    return { accepted: !r.rejected, updates: r.updates, alerts: r.alerts };
  }

  /** Runs the document's WillSave / WillPrint scripts. */
  async docEvent(name: 'WillSave' | 'DidSave' | 'WillPrint' | 'DidPrint'): Promise<CommitResult> {
    const r = await this.drive({ kind: 'dispatch', event: { id: 'doc', name } });
    return { accepted: true, updates: r.updates, alerts: r.alerts, stopped: r.stopped || undefined };
  }

  destroy(): void {
    this.halted = true;
    try {
      this.runner.terminate();
    } catch {
      /* already gone */
    }
  }

  /** One call into the sandbox at a time; a call past the time limit stops the scripts. */
  private drive(c: SandboxCall): Promise<Drive> {
    const run = async (): Promise<Drive> => {
      if (this.halted) return { ok: false, rejected: false, stopped: true, updates: {}, alerts: [] };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((res) => {
        // Starting runs every document-level script: a little more time.
        timer = setTimeout(() => res('timeout'), c.kind === 'create' ? this.limitMs * 3 : this.limitMs);
      });
      let reply: SandboxReply | 'timeout';
      try {
        reply = await Promise.race([this.runner.call(c), timeout]);
      } catch {
        reply = { ok: false, events: [], alerts: [] };
      } finally {
        clearTimeout(timer);
      }
      if (reply === 'timeout') {
        this.destroy();
        return { ok: false, rejected: false, stopped: true, updates: {}, alerts: [] };
      }
      this.collected = {};
      this.alerts = [...reply.alerts];
      this.rejected = false;
      for (const d of reply.events) this.receive(d as SandboxDetail);
      return { ok: reply.ok, rejected: this.rejected, stopped: false, updates: this.collected, alerts: this.alerts };
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }

  private receive(d: SandboxDetail): void {
    if (!d) return;
    if (!d.id) {
      if (d.command === 'error' && typeof d.value === 'string') this.alerts.push(d.value.split('\n')[0]);
      return;
    }
    const ids = [d.id, ...(d.siblings ?? [])];
    for (const id of ids) {
      const name = this.names.get(id);
      if (!name) continue;
      const u = (this.collected[name] ??= {});
      if ('value' in d && d.value !== undefined) {
        u.value = normalise(d.value, this.widgets.get(name)?.find((w) => w.type));
        this.known.set(name, u.value);
      }
      if ('formattedValue' in d) u.formatted = d.formattedValue ?? null;
      if (d.hidden !== undefined) u.hidden = d.hidden;
      if (d.display !== undefined) u.hidden = d.display === 1 || d.display === 3;
      // A rejected commit: the sandbox clears the field and asks for focus.
      if ((d as { focus?: boolean }).focus && d.value === '') this.rejected = true;
    }
  }
}

function normalise(v: unknown, w: WidgetInfo | undefined): ScriptValue {
  if (Array.isArray(v)) return v.map(String);
  if (w?.type === 'checkbox') return v === true || (typeof v === 'string' && v !== 'Off' && v !== '' && v !== 'false');
  if (typeof v === 'boolean') return v;
  return v === null || v === undefined ? '' : String(v);
}
