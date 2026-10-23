/**
 * Research prototype: runs an XFA form's scripts (model.ts) in an engine
 * (engines.ts) with the minimal XFA object model of runtime.js, and sums up
 * what ran, what failed and what the scripts produced (messages, attached
 * data objects such as the declaration XML, field values).
 */
import runtimeSource from './runtime.js?raw';
import type { XfaModel } from './model';
import type { ScriptEngine } from './engines';

export interface XfaRunOptions {
  /** SOM path -> value, typed in like a user would (enter, change, exit, recalculation). */
  fill?: Record<string, string | number>;
  /** Ordered user actions: ['fill', som, value], ['click', som], ['pick', regex for the next Acrobat dialog list]. */
  steps?: Array<['fill', string, string | number] | ['click', string] | ['pick', string]>;
  /** Buttons to click after filling (SOM paths). */
  click?: string[];
  /** Fire every interactive event once (enter, exit, change, mouse…) to see what breaks. */
  allEvents?: boolean;
  /** Click every button once, in document order. */
  allClicks?: boolean;
  /** Keep the first lines of each error's stack. */
  stacks?: boolean;
  /** Answer No to yes/no questions (default Yes). */
  answerNo?: boolean;
  /** Names of the buttons from the click list (alias kept for the manual runner). */
  clickButtons?: string[];
}

export interface XfaRunResult {
  runs: number;
  ok: number;
  errors: Array<{ node: string; event: string; error: string }>;
  messages: Array<{ kind: string; text: string }>;
  skippedFormCalc: number;
  perEvent: Record<string, { runs: number; ok: number; errors: number; formcalc: number }>;
  dataObjects: Array<{ name: string; contents: string }>;
  values: Record<string, unknown>;
  /** Every script that ran: 'ok' or 'error' (at least once). */
  scriptKeys: Record<string, 'ok' | 'error'>;
  ms: number;
  summary: { scripts: number; distinctRan: number; distinctFailed: number; runs: number; okRuns: number; formcalcSkipped: number; topErrors: Array<[string, number]> };
}

export function xfaRunSource(model: XfaModel, opts: XfaRunOptions): string {
  const o = { ...opts, click: opts.click ?? opts.clickButtons };
  return `${runtimeSource}\n__emit(JSON.stringify(xfaRun(JSON.parse(${JSON.stringify(JSON.stringify(model))}), ${JSON.stringify(o)})));`;
}

/** Groups error messages with the node-specific parts removed. */
export function topErrors(errors: XfaRunResult['errors'], n = 15): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const e of errors) {
    const k = e.error.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').slice(0, 140);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export async function runXfaScripts(engine: ScriptEngine, model: XfaModel, opts: XfaRunOptions = {}): Promise<XfaRunResult> {
  const raw = JSON.parse(await engine.run(xfaRunSource(model, opts))) as Omit<XfaRunResult, 'summary'>;
  const keys = Object.values(raw.scriptKeys);
  return {
    ...raw,
    summary: {
      scripts: model.stats.scripts,
      distinctRan: keys.length,
      distinctFailed: keys.filter((k) => k === 'error').length,
      runs: raw.runs,
      okRuns: raw.ok,
      formcalcSkipped: raw.skippedFormCalc,
      topErrors: topErrors(raw.errors),
    },
  };
}
