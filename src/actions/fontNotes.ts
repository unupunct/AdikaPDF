/**
 * Tells the user, once per edit, which letters of edited text were drawn in
 * another font because the document's (subset) font did not include them.
 */
import { usePDFStore } from '@/store/usePDFStore';
import type { FontFallbackNote } from '@/lib/pdf/exportPdf';

const told = new Set<string>();

export function tellFontFallbacks(notes: FontFallbackNote[]): void {
  const groups = new Map<string, { font: string; installed: boolean; chars: string }>();
  for (const n of notes) {
    const key = `${n.objectId}\u0000${n.text}`;
    if (told.has(key)) continue;
    told.add(key);
    for (const f of n.fallback) {
      const k = `${f.font}\u0000${f.installed}`;
      const g = groups.get(k) ?? { font: f.font, installed: f.installed, chars: '' };
      for (const ch of f.chars) if (!g.chars.includes(ch)) g.chars += ch;
      groups.set(k, g);
    }
  }
  const { toast } = usePDFStore.getState();
  for (const g of groups.values()) {
    toast(
      g.installed
        ? `“${g.chars}” was drawn in ${g.font} (installed in Windows) because the document's font did not include it.`
        : `“${g.chars}” was drawn in ${g.font} because the document's font did not include it.`,
      'info',
    );
  }
}
