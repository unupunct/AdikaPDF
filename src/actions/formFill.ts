/**
 * Filling the existing form fields of a document, from the side panel or on
 * the page. A value goes through the form's own logic: its JavaScript in the
 * sandbox when it has any (Acrobat behaviour: keystroke, validate, calculate,
 * format, alerts), otherwise Adika's reading of the standard AF* actions.
 */
import type { FieldValue } from '@/store/usePDFStore';
import { formattedFor, useFormView } from '@/store/formView';
import { usePDFStore } from '@/store/usePDFStore';
import { showMessage } from '@/store/useDialogs';
import { readFormFields, type FormFieldInfo } from '@/actions/security';
import { calcOrder, calculate, parseNumber } from '@/lib/formLogic';
import { getSourceDoc, onSourceRelease, setViewerFieldValue } from '@/lib/pdf/pdfService';
import { FormScripting, inThreadRunner, workerRunner, type FieldUpdate, type QuickSandbox, type ScriptRunner, type WorkerLike } from '@/lib/pdf/formSandbox';
import { log } from '@/lib/log';

const fieldCache = new Map<string, { bytes: Uint8Array; fields: Promise<FormFieldInfo[]> }>();

/** The existing fields of a source (cached per file contents). */
export function sourceFields(sourceId: string): Promise<FormFieldInfo[]> {
  const src = usePDFStore.getState().sources[sourceId];
  if (!src) return Promise.resolve([]);
  const hit = fieldCache.get(sourceId);
  if (hit && hit.bytes === src.bytes) return hit.fields;
  const fields = readFormFields(src.bytes);
  fieldCache.set(sourceId, { bytes: src.bytes, fields });
  return fields;
}

const sandboxes = new Map<string, { doc: unknown; scripting: Promise<FormScripting | null> }>();

async function loadSandbox(): Promise<ScriptRunner> {
  const wasmUrl = new URL(`${import.meta.env.BASE_URL}pdfjs/wasm/`, document.baseURI).href;
  // In a worker, so a script that never returns can be stopped.
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('../lib/pdf/formSandbox.worker.ts', import.meta.url), { type: 'module' });
      return await workerRunner(worker as unknown as WorkerLike, wasmUrl);
    } catch (e) {
      log('warn', `form script worker: ${String(e)}`);
    }
  }
  // @ts-expect-error pdf.js ships no types for its sandbox bundle
  const mod: unknown = await import('pdfjs-dist/build/pdf.sandbox.mjs');
  const { QuickJSSandbox } = mod as { QuickJSSandbox: (wasmUrl: string) => Promise<QuickSandbox> };
  return inThreadRunner(await QuickJSSandbox(wasmUrl));
}

/** Turns a document's scripts off after they stopped responding; tells the user once. */
function scriptsStopped(sourceId: string): void {
  const hit = sandboxes.get(sourceId);
  if (hit) sandboxes.set(sourceId, { doc: hit.doc, scripting: Promise.resolve(null) });
  useFormView.setState((v) => ({ scripted: { ...v.scripted, [sourceId]: false } }));
  log('warn', 'form scripts ran past the time limit and were turned off');
  void showMessage('Form scripts turned off', "This form's scripts stopped responding and were turned off.");
}

/** The running scripts of a source, started on first use (null when the form has none or they fail to start). */
export async function formScripting(sourceId: string): Promise<FormScripting | null> {
  let doc;
  try {
    doc = await getSourceDoc(sourceId);
  } catch {
    return null;
  }
  const hit = sandboxes.get(sourceId);
  if (hit && hit.doc === doc) return hit.scripting;
  if (hit) void hit.scripting.then((s) => s?.destroy());
  const scripting = FormScripting.start(doc, loadSandbox)
    .then((r) => {
      if (!r) return null;
      if (r.stopped) {
        queueMicrotask(() => scriptsStopped(sourceId));
        return null;
      }
      useFormView.setState((v) => ({ scripted: { ...v.scripted, [sourceId]: true } }));
      applyView(sourceId, r.updates, r.scripting);
      void showAlerts(r.alerts);
      return r.scripting;
    })
    .catch((e: unknown) => {
      log('warn', `form scripts: ${String(e)}`);
      return null;
    });
  sandboxes.set(sourceId, { doc, scripting });
  return scripting;
}

// A closed document's scripts stop with it.
onSourceRelease((id) => {
  const s = sandboxes.get(id);
  sandboxes.delete(id);
  fieldCache.delete(id);
  void s?.scripting.then((x) => x?.destroy());
});

async function showAlerts(alerts: string[]): Promise<void> {
  for (const a of alerts) if (a.trim()) await showMessage('Message from the form', a);
}

function applyView(sourceId: string, updates: Record<string, FieldUpdate>, scripting: FormScripting): void {
  const formatted: Record<string, { value: string; text: string }> = {};
  const hidden: Record<string, boolean> = {};
  for (const [name, u] of Object.entries(updates)) {
    const k = `${sourceId}::${name}`;
    const value = u.value ?? scripting.valueOf(name);
    if (u.formatted !== undefined && typeof value === 'string') formatted[k] = { value, text: u.formatted ?? value };
    if (u.hidden !== undefined) hidden[k] = u.hidden;
  }
  useFormView.setState((v) => ({ formatted: { ...v.formatted, ...formatted }, hidden: { ...v.hidden, ...hidden } }));
}

/** The value a field has now (edited, or as saved in the file). */
function currentValue(sourceId: string, field: FormFieldInfo): FieldValue {
  const k = `${sourceId}::${field.name}`;
  const fv = usePDFStore.getState().fieldValues;
  return k in fv ? fv[k] : field.value;
}

/** Sets a field's value and lets the form calculate. Returns false when the form's logic rejected it. */
export async function commitFieldValue(sourceId: string, name: string, value: FieldValue): Promise<boolean> {
  const fields = await sourceFields(sourceId);
  const scripting = await formScripting(sourceId);
  const patch: Record<string, FieldValue> = {};
  let accepted = true;
  let stopped = false;
  if (scripting) {
    // Values changed outside the scripts (undo, recovery) are handed over first.
    const alerts: string[] = [];
    for (const f of fields) {
      if (f.name === name || f.logic?.calc) continue;
      const v = currentValue(sourceId, f);
      const known = scripting.valueOf(f.name);
      if (known === undefined || JSON.stringify(known) === JSON.stringify(v) || typeof v === 'number') continue;
      const pre = await scripting.commit(f.name, v as string | boolean | string[]);
      if (pre.stopped) break;
      for (const [n, u] of Object.entries(pre.updates)) if (u.value !== undefined && n !== f.name) patch[`${sourceId}::${n}`] = u.value;
      // A value the form rejects is cleared, as the scripts did.
      if (!pre.accepted) patch[`${sourceId}::${f.name}`] = '';
      applyView(sourceId, pre.updates, scripting);
      alerts.push(...pre.alerts);
    }
    const r = await scripting.commit(name, value as string | boolean | string[]);
    stopped = !!r.stopped;
    if (stopped) scriptsStopped(sourceId);
    else {
      accepted = r.accepted;
      for (const [n, u] of Object.entries(r.updates)) if (u.value !== undefined) patch[`${sourceId}::${n}`] = u.value;
      applyView(sourceId, r.updates, scripting);
      void showAlerts([...alerts, ...r.alerts]);
      if (!accepted) {
        delete patch[`${sourceId}::${name}`];
        if (Object.keys(patch).length) usePDFStore.getState().setFieldValues(patch);
        return false;
      }
      if (!(`${sourceId}::${name}` in patch)) patch[`${sourceId}::${name}`] = value;
    }
  }
  if (!scripting || stopped) {
    // The value, then every calculated field of that document (totals after their parts).
    patch[`${sourceId}::${name}`] = value;
    const cur = (n: string) => {
      const k = `${sourceId}::${n}`;
      if (k in patch) return patch[k];
      const f = fields.find((x) => x.name === n);
      return f ? currentValue(sourceId, f) : '';
    };
    const logic = Object.fromEntries(fields.map((f) => [f.name, f.logic ?? {}]));
    const names = fields.map((f) => f.name);
    for (const n of calcOrder(logic)) {
      const l = logic[n];
      const v = calculate(l.calc!, names, (x) => parseNumber(cur(x) as string));
      const dec = l.format && l.format.kind !== 'date' ? l.format.decimals + (l.format.kind === 'percent' ? 2 : 0) : 6;
      patch[`${sourceId}::${n}`] = Number.isFinite(v) ? String(Math.round(v * 10 ** dec) / 10 ** dec) : '';
    }
  }
  usePDFStore.getState().setFieldValues(patch);
  await Promise.all(
    Object.entries(patch).map(([k, v]) => {
      const fieldName = k.slice(sourceId.length + 2);
      // The page shows the formatted text when the form has a Format script.
      const formatted = formattedFor(k, v);
      return setViewerFieldValue(sourceId, fieldName, v as string | boolean | string[], formatted).catch(() => undefined);
    }),
  );
  usePDFStore.getState().bumpRenderEpoch();
  return accepted;
}
