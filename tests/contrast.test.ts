/**
 * Colour contrast of the interface in both themes (WCAG 2.2 AA): the theme
 * colours in index.css and the Tailwind colours used for text on coloured
 * backgrounds. jsdom cannot compute it on rendered components, so it is checked here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/index.css', 'utf8');

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2];
  return out;
}
const theme = vars(/@theme\s*\{([^}]*)\}/.exec(css)![1]);
const light = vars(/:root\s*\{([^}]*)\}/.exec(css)![1]);
const dark = vars(/\.dark\s*\{([^}]*)\}/.exec(css)![1]);
// Tailwind's default palette, for the classes the components combine with white text.
const tw: Record<string, string> = { white: '#ffffff', 'rose-600': '#e11d48', 'slate-900': '#0f172a', 'slate-700': '#334155' };
const color = (name: string): string => tw[name] ?? theme[`color-${name}`] ?? (() => { throw new Error(`unknown colour ${name}`); })();

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('colour contrast (WCAG AA, small text 4.5:1)', () => {
  const surfaces = ['bg', 'panel', 'panel-2', 'hover'];
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it(`${name} theme: text and muted text on every surface`, () => {
      const low: string[] = [];
      for (const fg of ['text', 'muted']) for (const bg of surfaces) if (contrast(t[fg], t[bg]) < 4.5) low.push(`${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
      expect(low).toEqual([]);
    });
    it(`${name} theme: the focus ring stands out from panels (3:1)`, () => {
      for (const bg of ['bg', 'panel']) expect(contrast(t.ring, t[bg])).toBeGreaterThanOrEqual(3);
    });
  }

  it('white text on the button and highlight colours', () => {
    const low = ['brand-700', 'brand-800', 'accent-700', 'accent-800', 'rose-600', 'slate-900', 'slate-700'].filter((bg) => contrast('#ffffff', color(bg)) < 4.5);
    expect(low).toEqual([]);
  });

  it('brand-coloured text: 700 on light panels, 300 on dark ones', () => {
    for (const bg of ['panel', 'panel-2', 'bg']) expect(contrast(color('brand-700'), light[bg])).toBeGreaterThanOrEqual(4.5);
    for (const bg of ['panel', 'panel-2', 'bg']) expect(contrast(color('brand-300'), dark[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('button classes use the colours checked above', () => {
    const src = readFileSync('src/components/ui/primitives.tsx', 'utf8');
    expect(src).toMatch(/primary: 'bg-brand-700 text-white/);
    expect(src).toMatch(/accent: 'bg-accent-700 text-white/);
  });
});
