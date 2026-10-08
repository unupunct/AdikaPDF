/** Which key presses may run a shortcut (pure, unit-tested). */

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: string) => boolean;
}

/**
 * A character typed with AltGr: Windows reports AltGr as Ctrl+Alt, so on
 * German, Hungarian, French or Spanish keyboards "\", "@", "{"… arrive with
 * both modifiers. A Ctrl+Alt letter or digit stays a shortcut.
 */
export function isAltGrCharacter(e: KeyLike): boolean {
  if (!(e.ctrlKey && e.altKey) || e.metaKey || e.key.length !== 1) return false;
  return e.getModifierState?.('AltGraph') === true || !/^[a-z0-9]$/i.test(e.key);
}

/** Shortcuts that also work while typing in a field: they have no meaning for the text. */
export function worksWhileTyping(e: KeyLike): boolean {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (/^f([1-9]|1[0-2])$/.test(key) || key === 'escape') return true;
  if (!mod || e.altKey) return false;
  if (key === 'tab') return true;
  if (e.shiftKey) return key === 's';
  return ['s', 'o', 'p', 'w', 'f', '=', '+', '-', '0'].includes(key);
}

/** True when the key press may run a shortcut; `typing` when focus is in a text field. */
export function shortcutAllowed(e: KeyLike, typing: boolean): boolean {
  if (isAltGrCharacter(e)) return false;
  return !typing || worksWhileTyping(e);
}

/** Focus in a field that takes typed text (inputs, text areas, selects, editable content). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
