import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ReadingOrderLayer } from '@/components/viewer/ReadingOrderLayer';
import { useA11y } from '@/store/a11y';
import type { PageRef } from '@/types';

const page = (id: string): PageRef => ({ id, kind: 'blank', sourceId: null, sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 595, height: 842 }) as PageRef;

describe('ReadingOrderLayer', () => {
  // Store selectors must return stable values: a new [] per call made React 19 loop ("Maximum update depth exceeded").
  it('renders on pages other than the selected one without an update loop', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    act(() => useA11y.setState({ orderMode: false, selectedPage: 'p-other', selected: ['x'] }));
    const view = render(
      <>
        <ReadingOrderLayer page={page('p1')} zoom={1} />
        <ReadingOrderLayer page={page('p2')} zoom={1} />
      </>,
    );
    act(() => useA11y.setState({ epoch: useA11y.getState().epoch + 1 }));
    view.unmount();
    spy.mockRestore();
    expect(errors.filter((e) => /getSnapshot should be cached|Maximum update depth/.test(e))).toEqual([]);
  });
});
