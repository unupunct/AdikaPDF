/**
 * What a form's own scripts show (keyed "sourceId::field name"): the
 * formatted text of a value (e.g. "1.234,50 €" for 1234.5) and fields the
 * scripts hid. The formatted text applies only while the value is the one it
 * was made for.
 */
import { create } from 'zustand';

export interface FormView {
  formatted: Record<string, { value: string; text: string }>;
  hidden: Record<string, boolean>;
  /** Sources whose form runs scripts. */
  scripted: Record<string, boolean>;
}

export const useFormView = create<FormView>()(() => ({ formatted: {}, hidden: {}, scripted: {} }));

/** The formatted text for a field's current value, if its scripts made one. */
export function formattedFor(key: string, value: unknown): string | undefined {
  const f = useFormView.getState().formatted[key];
  return f && typeof value === 'string' && f.value === value ? f.text : undefined;
}

/** Formatted texts still valid for the given values (for saving). */
export function formattedDisplay(values: Record<string, unknown>, fileValue: (key: string) => unknown = () => undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, f] of Object.entries(useFormView.getState().formatted)) {
    const v = k in values ? values[k] : fileValue(k);
    if (typeof v === 'string' && v === f.value && f.text && f.text !== v) out[k] = f.text;
  }
  return out;
}
