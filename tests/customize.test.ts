import { describe, expect, it } from 'vitest';
import { comboOf, usableCombo } from '@/store/customize';
import { pressureWidth } from '@/lib/objectFactory';
import { makePen } from '@/lib/objectFactory';
import type { ToolStyle } from '@/types';

const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('custom shortcuts', () => {
  it('names key combinations', () => {
    expect(comboOf(k('e', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+E');
    expect(comboOf(k('1', { altKey: true }))).toBe('Alt+1');
    expect(comboOf(k('F9'))).toBe('F9');
    expect(comboOf(k('Control', { ctrlKey: true }))).toBeNull();
  });
  it('accepts only combinations that do not get in the way of typing', () => {
    expect(usableCombo('Ctrl+Shift+E')).toBe(true);
    expect(usableCombo('Alt+1')).toBe(true);
    expect(usableCombo('F9')).toBe(true);
    expect(usableCombo('Shift+F2')).toBe(true);
    expect(usableCombo('E')).toBe(false);
    expect(usableCombo('Shift+E')).toBe(false);
  });
});

describe('pen pressure', () => {
  const style = { stroke: '#000000', strokeWidth: 2, opacity: 1 } as ToolStyle;
  it('keeps pressure only when it varies', () => {
    expect(makePen('p', [0, 0, 10, 10, 20, 20], style, [0.2, 0.6, 0.9]).pressures).toEqual([0.2, 0.6, 0.9]);
    expect(makePen('p', [0, 0, 10, 10], style, [0.5, 0.5]).pressures).toBeUndefined();
    expect(makePen('p', [0, 0, 10, 10], style).pressures).toBeUndefined();
  });
  it('a normal press gives the set width', () => {
    expect(pressureWidth(2, 0.5)).toBeCloseTo(2);
    expect(pressureWidth(2, 0)).toBeCloseTo(0.6);
    expect(pressureWidth(2, 1)).toBeCloseTo(3.4);
  });
});
