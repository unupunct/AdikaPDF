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
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

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
}

interface QuickSandbox {
  create(data: unknown): void;
  dispatchEvent(event: unknown): void;
  nukeSandbox(): void;
}
export type SandboxLoader = () => Promise<QuickSandbox>;

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

// Every sandbox reports through window events; the one being driven gets them.
let driving: FormScripting | null = null;
let listening = false;

export class FormScripting {
  private names = new Map<string, string>(); // widget id -> field name
  private widgets = new Map<string, WidgetInfo[]>(); // field name -> widgets
  private known = new Map<string, ScriptValue>(); // last value per field as the sandbox has it
  private collected: Record<string, FieldUpdate> = {};
  private alerts: string[] = [];
  private rejected = false;

  private constructor(private sandbox: QuickSandbox) {}

  /** Starts the scripts of a document (null when it has none). Runs the document's Open scripts. */
  static async start(doc: PDFDocumentProxy, load: SandboxLoader): Promise<{ scripting: FormScripting; updates: Record<string, FieldUpdate>; alerts: string[] } | null> {
    const [objects, calculationOrder, docActions, meta] = await Promise.all([
      fieldObjects(doc),
      doc.getCalculationOrderIds(),
      doc.getJSActions(),
      doc.getMetadata().catch(() => null),
    ]);
    if (!(await hasFormScripts(doc))) return null;
    const sandbox = await load();
    const s = new FormScripting(sandbox);
    for (const [name, ws] of Object.entries(objects)) {
      s.widgets.set(name, ws);
      for (const w of ws) s.names.set(w.id, name);
      const v = (ws.find((w) => w.type) as { value?: ScriptValue } | undefined)?.value;
      if (v !== undefined) s.known.set(name, v);
    }
    if (!listening) {
      listening = true;
      window.addEventListener('updatefromsandbox', (e) => driving?.receive((e as CustomEvent<SandboxDetail>).detail));
    }
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const run = s.drive(() =>
      sandbox.create({
        objects,
        calculationOrder: calculationOrder ?? [],
        appInfo: { platform: 'WIN', language: typeof navigator !== 'undefined' ? navigator.language : 'en-US' },
        docInfo: { ...info, numPages: doc.numPages, filename: '', baseURL: '', URL: '', filesize: 0, actions: docActions ?? {} },
      }),
    );
    if (!run.ok) {
      sandbox.nukeSandbox();
      throw new Error('The form scripts could not be started.');
    }
    const open = s.drive(() => sandbox.dispatchEvent({ id: 'doc', name: 'Open' }));
    return { scripting: s, updates: open.updates, alerts: open.alerts };
  }

  /** The value the scripts last gave a field. */
  valueOf(name: string): ScriptValue | undefined {
    return this.known.get(name);
  }

  /** Hands the user's value to the scripts (keystroke + validate, then calculations and formats). */
  commit(name: string, value: ScriptValue): CommitResult {
    // pdf.js lists the field itself (no type) before its widgets.
    const ws = (this.widgets.get(name) ?? []).filter((x) => x.type);
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
    const r = this.drive(() => this.sandbox.dispatchEvent(event));
    // Buttons report nothing for themselves; the value is what the user chose.
    if (!(name in r.updates) && !r.rejected) r.updates[name] = { value };
    if (r.updates[name]?.value !== undefined) this.known.set(name, r.updates[name].value!);
    else if (!r.rejected) this.known.set(name, value);
    return { accepted: !r.rejected, updates: r.updates, alerts: r.alerts };
  }

  /** Runs the document's WillSave / WillPrint scripts. */
  docEvent(name: 'WillSave' | 'DidSave' | 'WillPrint' | 'DidPrint'): CommitResult {
    const r = this.drive(() => this.sandbox.dispatchEvent({ id: 'doc', name }));
    return { accepted: true, updates: r.updates, alerts: r.alerts };
  }

  destroy(): void {
    if (driving === this) driving = null;
    try {
      this.sandbox.nukeSandbox();
    } catch {
      /* already gone */
    }
  }

  private drive(fn: () => void): { ok: boolean; rejected: boolean; updates: Record<string, FieldUpdate>; alerts: string[] } {
    this.collected = {};
    this.alerts = [];
    this.rejected = false;
    const prevAlert = window.alert;
    // app.alert inside a script: collected and shown by the app after the event.
    window.alert = (msg?: unknown) => {
      this.alerts.push(String(msg ?? ''));
    };
    driving = this;
    let ok = true;
    try {
      fn();
    } catch {
      ok = false;
    } finally {
      driving = null;
      window.alert = prevAlert;
    }
    return { ok, rejected: this.rejected, updates: this.collected, alerts: this.alerts };
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
