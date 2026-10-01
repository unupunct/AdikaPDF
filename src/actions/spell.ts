/** Check spelling with the Windows spell checker (see src-tauri/src/spellcheck.rs). */
import { invoke } from '@tauri-apps/api/core';
import { usePDFStore } from '@/store/usePDFStore';
import { isDesktop } from '@/lib/platform';
import { collectTargets, type SpellFinding, type SpellTarget } from '@/lib/spell';
import { commitFieldValue, sourceFields } from './formFill';

export async function spellLanguages(): Promise<string[]> {
  if (!isDesktop) return [];
  return invoke<string[]>('spell_languages');
}

export async function spellCheckTexts(lang: string, texts: string[]): Promise<SpellFinding[][]> {
  return invoke<SpellFinding[][]>('spell_check', { lang, texts });
}

/** Adds a word to the Windows dictionary (or ignores it until Windows restarts the checker). */
export async function addToDictionary(lang: string, word: string, ignoreOnly = false): Promise<void> {
  await invoke('spell_add', { lang, word, ignoreOnly });
}

/** Everything people wrote in the open document: comments, text boxes, typewriter text, filled form fields. */
export async function collectSpellTargets(): Promise<SpellTarget[]> {
  const s = usePDFStore.getState();
  const out = collectTargets(s.objects, s.pages);
  for (const id of new Set(s.pages.map((p) => p.sourceId).filter((x): x is string => !!x))) {
    for (const f of await sourceFields(id)) {
      if (f.kind !== 'text' || f.readOnly) continue;
      const k = `${id}::${f.name}`;
      const v = k in s.fieldValues ? s.fieldValues[k] : f.value;
      if (typeof v === 'string' && v.trim()) out.push({ key: `field:${k}`, label: `Form field ${f.label ?? f.name}`, text: v });
    }
  }
  return out;
}

/** Writes a corrected text back where it came from (undoable). */
export async function applySpellText(target: SpellTarget, text: string): Promise<void> {
  const s = usePDFStore.getState();
  if (target.key.startsWith('obj:')) {
    const id = target.key.slice(4);
    const o = s.objects.find((x) => x.id === id);
    if (!o) return;
    if (o.type === 'field') s.updateObject(id, { value: text });
    else s.updateObject(id, { text } as never);
    return;
  }
  const k = target.key.slice(6);
  const i = k.indexOf('::');
  await commitFieldValue(k.slice(0, i), k.slice(i + 2), text);
}
