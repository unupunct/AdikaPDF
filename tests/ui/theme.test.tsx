import { afterEach, describe, expect, it } from 'vitest';
import { followSystemTheme, usePDFStore } from '@/store/usePDFStore';

/** A prefers-color-scheme query whose changes the test fires. */
function fakeQuery() {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  return {
    addEventListener: (_t: string, l: (e: { matches: boolean }) => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: (e: { matches: boolean }) => void) => void listeners.delete(l),
    fire: (matches: boolean) => listeners.forEach((l) => l({ matches })),
    get count() {
      return listeners.size;
    },
  };
}

describe('theme follows Windows until the user picks one', () => {
  afterEach(() => {
    localStorage.removeItem('adika.theme');
    usePDFStore.setState({ theme: 'light' });
  });

  it('follows changes of the system setting while nothing is chosen', () => {
    localStorage.removeItem('adika.theme');
    const mq = fakeQuery();
    const stop = followSystemTheme(mq as unknown as MediaQueryList);
    mq.fire(true);
    expect(usePDFStore.getState().theme).toBe('dark');
    mq.fire(false);
    expect(usePDFStore.getState().theme).toBe('light');
    stop();
    expect(mq.count).toBe(0);
  });

  it('keeps the theme the user chose', () => {
    const mq = fakeQuery();
    const stop = followSystemTheme(mq as unknown as MediaQueryList);
    usePDFStore.getState().setTheme('light');
    mq.fire(true);
    expect(usePDFStore.getState().theme).toBe('light');
    stop();
  });
});
