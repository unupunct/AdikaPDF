import { describe, expect, it } from 'vitest';
import { isAltGrCharacter, shortcutAllowed, worksWhileTyping, type KeyLike } from '@/hooks/shortcutKeys';

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('shortcut key gate', () => {
  it('treats AltGr characters (Ctrl+Alt) as typing, not shortcuts', () => {
    // German keyboard: AltGr+ß = "\", AltGr+Q = "@"
    expect(isAltGrCharacter(k('\\', { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isAltGrCharacter(k('@', { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isAltGrCharacter(k('ą', { ctrlKey: true, altKey: true }))).toBe(true);
    expect(shortcutAllowed(k('\\', { ctrlKey: true, altKey: true }), false)).toBe(false);
    // Reported as AltGraph even for a letter
    expect(isAltGrCharacter(k('e', { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' }))).toBe(true);
  });

  it('keeps real Ctrl+Alt letter shortcuts and Ctrl+\\', () => {
    expect(isAltGrCharacter(k('q', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(shortcutAllowed(k('q', { ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(shortcutAllowed(k('\\', { ctrlKey: true }), false)).toBe(true);
    expect(isAltGrCharacter(k('ArrowLeft', { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('lets only a short list of shortcuts through while typing', () => {
    expect(worksWhileTyping(k('s', { ctrlKey: true }))).toBe(true);
    expect(worksWhileTyping(k('S', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(worksWhileTyping(k('F5'))).toBe(true);
    expect(worksWhileTyping(k('Escape'))).toBe(true);
    expect(worksWhileTyping(k('Tab', { ctrlKey: true }))).toBe(true);
    // Paste as plain text, select all, undo, find & replace, split view, plain letters: the field's own
    expect(shortcutAllowed(k('V', { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(shortcutAllowed(k('a', { ctrlKey: true }), true)).toBe(false);
    expect(shortcutAllowed(k('z', { ctrlKey: true }), true)).toBe(false);
    expect(shortcutAllowed(k('h', { ctrlKey: true }), true)).toBe(false);
    expect(shortcutAllowed(k('\\', { ctrlKey: true }), true)).toBe(false);
    expect(shortcutAllowed(k('Backspace'), true)).toBe(false);
    expect(shortcutAllowed(k('ArrowLeft', { altKey: true }), true)).toBe(false);
    expect(shortcutAllowed(k('t'), true)).toBe(false);
    expect(shortcutAllowed(k('t'), false)).toBe(true);
  });
});
