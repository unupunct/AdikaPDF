import { describe, expect, it } from 'vitest';
import { applyChange, collectTargets, defaultSpellLang, issuesOf } from '@/lib/spell';
import { makeField } from '@/lib/objectFactory';
import type { EditorObject, NoteObject, PageRef, TextObject } from '@/types';

const page = (id: string): PageRef => ({ id, kind: 'blank', sourceId: null, sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 595, height: 842 });

describe('check spelling', () => {
  it('collects comments, text boxes and filled text fields, not edited page text', () => {
    const base = { x: 0, y: 0, rotation: 0, opacity: 1 };
    const note = { ...base, id: 'n', type: 'note', pageId: 'p2', width: 20, height: 20, text: 'Plese check', color: '#ff0', author: 'A', createdAt: '', modifiedAt: '' } as NoteObject;
    const box = { ...base, id: 't', type: 'text', pageId: 'p1', width: 100, height: 20, text: 'Teh total', fontFamily: 'sans', bold: false, italic: false, fontSize: 12, color: '#000', align: 'left', lineHeight: 1.2, background: null } as TextObject;
    const edited = { ...box, id: 'e', text: 'Replaced page text', replaces: [{ x: 0, y: 0, width: 10, height: 10 }] } as TextObject;
    const typewriter = { ...box, id: 'w', annotation: true, text: 'Noted' } as TextObject;
    const field = { ...makeField('text', 'p1', { x: 0, y: 0, width: 100, height: 20 }, []), id: 'f', name: 'Remarks', value: 'Al good' };
    const empty = { ...makeField('text', 'p1', { x: 0, y: 0, width: 100, height: 20 }, []), id: 'g', name: 'Empty', value: '' };
    const targets = collectTargets([note, box, edited, typewriter, field, empty] as EditorObject[], [page('p1'), page('p2')]);
    expect(targets.map((t) => [t.key, t.label, t.text])).toEqual([
      ['obj:n', 'Comment, page 2', 'Plese check'],
      ['obj:t', 'Text box, page 1', 'Teh total'],
      ['obj:w', 'Typewriter, page 1', 'Noted'],
      ['obj:f', 'Form field Remarks', 'Al good'],
    ]);
  });

  it('applies a correction and moves the later findings of the same text', () => {
    const t = { key: 'obj:a', label: 'x', text: 'Teh cat sat on teh the mat' };
    const other = { key: 'obj:b', label: 'y', text: 'teh' };
    const issues = issuesOf(
      [t, other],
      [
        [
          { start: 0, length: 3, action: 'suggest', replacement: '', suggestions: ['The'] },
          { start: 15, length: 3, action: 'suggest', replacement: '', suggestions: ['the'] },
          { start: 19, length: 3, action: 'delete', replacement: '', suggestions: [] },
        ],
        [{ start: 0, length: 3, action: 'suggest', replacement: '', suggestions: ['the'] }],
      ],
    );
    expect(issues.map((i) => i.word)).toEqual(['Teh', 'teh', 'the', 'teh']);
    const a = applyChange(issues, 0, 'The');
    expect(a.text).toBe('The cat sat on teh the mat');
    const b = applyChange(a.rest, 0, 'the');
    expect(b.text).toBe('The cat sat on the the mat');
    // The repeated word goes with the space before it.
    const c = applyChange(b.rest, 0, '');
    expect(c.text).toBe('The cat sat on the mat');
    expect(c.rest.map((i) => i.target.key)).toEqual(['obj:b']);
  });

  it('starts in the interface language when Windows has it', () => {
    expect(defaultSpellLang('ro', ['en-US', 'ro-RO'])).toBe('ro-RO');
    expect(defaultSpellLang('de', ['en-US', 'de-AT'])).toBe('de-AT');
    expect(defaultSpellLang('hu', ['en-GB', 'en-US'])).toBe('en-US');
    expect(defaultSpellLang('en', ['en-US', 'fr-FR'], 'fr-FR')).toBe('fr-FR');
    expect(defaultSpellLang('en', [])).toBeNull();
  });
});
