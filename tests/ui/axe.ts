/**
 * axe-core on rendered components. jsdom lays nothing out, so colour contrast is
 * checked on the theme colours in contrast.test.ts, and focusable controls under
 * aria-hidden (which axe leaves "incomplete" without layout) by `hiddenFocusables`.
 */
import axe from 'axe-core';

export interface AxeProblem {
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** Controls reachable with Tab inside an aria-hidden subtree (axe rule aria-hidden-focus). */
export function hiddenFocusables(root: Element): Element[] {
  return [...root.querySelectorAll('[aria-hidden="true"]')]
    .filter((h) => !h.closest('[inert]') && !h.hasAttribute('data-radix-focus-guard'))
    .flatMap((h) => [...h.querySelectorAll(FOCUSABLE)])
    .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('tabindex') !== '-1');
}

export async function axeProblems(root: Element = document.body, minImpact: 'serious' | 'critical' = 'serious'): Promise<AxeProblem[]> {
  const res = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  const levels = minImpact === 'critical' ? ['critical'] : ['serious', 'critical'];
  const out = res.violations
    .filter((v) => levels.includes(v.impact ?? ''))
    .map((v) => ({ rule: v.id, impact: v.impact ?? '', help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`) }));
  const hidden = hiddenFocusables(root);
  if (hidden.length) out.push({ rule: 'aria-hidden-focus', impact: 'serious', help: 'ARIA hidden element must not be focusable or contain focusable elements', nodes: hidden.slice(0, 5).map((e) => e.outerHTML.slice(0, 160)) });
  return out;
}

export function describeProblems(list: AxeProblem[]): string {
  return list.map((p) => `${p.impact} ${p.rule}: ${p.help}\n    ${p.nodes.join('\n    ')}`).join('\n');
}
