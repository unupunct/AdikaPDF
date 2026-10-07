/** Subscribes to just the named fields of the editor store (shallow-compared), not the whole store. */
import { useShallow } from 'zustand/react/shallow';
import { usePDFStore } from '@/store/usePDFStore';

export type StoreState = ReturnType<typeof usePDFStore.getState>;

export function useStorePick<K extends keyof StoreState>(...keys: K[]): Pick<StoreState, K> {
  return usePDFStore(
    useShallow((st) => {
      const out = {} as Pick<StoreState, K>;
      for (const k of keys) out[k] = st[k];
      return out;
    }),
  );
}
