/**
 * How Save writes a file. By default a signed document is saved as an
 * incremental update (its signatures stay valid) and anything else is
 * rewritten in full, which also drops earlier revisions of the file.
 */
import { create } from 'zustand';

const KEY = 'adika.save';

interface SaveSettings {
  /** Save as an incremental update whenever the changes allow it (not only for signed documents). */
  preferIncremental: boolean;
  setPreferIncremental: (v: boolean) => void;
}

function load(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as { preferIncremental?: boolean }).preferIncremental === true;
  } catch {
    return false;
  }
}

export const useSaveSettings = create<SaveSettings>()((set) => ({
  preferIncremental: load(),
  setPreferIncremental: (preferIncremental) => {
    set({ preferIncremental });
    try {
      localStorage.setItem(KEY, JSON.stringify({ preferIncremental }));
    } catch {
      /* storage unavailable: kept for this session */
    }
  },
}));
