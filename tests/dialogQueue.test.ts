import { describe, expect, it } from 'vitest';
import { askConfirm, askPassword, useDialogs } from '@/store/useDialogs';

describe('prompt queue', () => {
  it('a second confirm waits for the first instead of replacing it', async () => {
    const first = askConfirm({ title: 'First', message: '' });
    const second = askConfirm({ title: 'Second', message: '' });
    expect(useDialogs.getState().confirm?.title).toBe('First');
    useDialogs.getState().confirm!.resolve(true);
    expect(await first).toBe(true);
    expect(useDialogs.getState().confirm?.title).toBe('Second');
    useDialogs.getState().confirm!.resolve(false);
    expect(await second).toBe(false);
    expect(useDialogs.getState().confirm).toBeNull();
  });

  it('password prompts for two files are asked one after the other', async () => {
    const a = askPassword('a.pdf', false);
    const b = askPassword('b.pdf', false);
    expect(useDialogs.getState().password?.fileName).toBe('a.pdf');
    useDialogs.getState().password!.resolve(null);
    expect(await a).toBeNull();
    expect(useDialogs.getState().password?.fileName).toBe('b.pdf');
    useDialogs.getState().password!.resolve('pw');
    expect(await b).toBe('pw');
    expect(useDialogs.getState().password).toBeNull();
  });
});
