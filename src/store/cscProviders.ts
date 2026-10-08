/**
 * Remote signing providers (Cloud Signature Consortium API) the user has
 * added: addresses and the client registration only, kept in this
 * computer's app storage. Sign-in tokens are never stored (memory only).
 */
import { create } from 'zustand';
import type { CscProvider } from '@/lib/crypto/csc';

interface CscProviders {
  providers: CscProvider[];
  lastProvider: string | null;
  lastCredential: string | null;
  upsert: (p: CscProvider) => void;
  remove: (id: string) => void;
  remember: (provider: string | null, credential: string | null) => void;
}

const KEY = 'adika.cscProviders';

type Saved = Pick<CscProviders, 'providers' | 'lastProvider' | 'lastCredential'>;

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>;
    const providers = Array.isArray(v.providers)
      ? v.providers.filter((p): p is CscProvider => !!p && typeof p.id === 'string' && typeof p.baseUrl === 'string' && typeof p.clientId === 'string')
      : [];
    return { providers, lastProvider: typeof v.lastProvider === 'string' ? v.lastProvider : null, lastCredential: typeof v.lastCredential === 'string' ? v.lastCredential : null };
  } catch {
    return { providers: [], lastProvider: null, lastCredential: null };
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ providers: s.providers, lastProvider: s.lastProvider, lastCredential: s.lastCredential }));
  } catch {
    /* storage unavailable: kept for this session */
  }
}

export const useCscProviders = create<CscProviders>()((set, get) => ({
  ...load(),
  upsert: (p) => {
    const providers = get().providers.some((x) => x.id === p.id) ? get().providers.map((x) => (x.id === p.id ? p : x)) : [...get().providers, p];
    set({ providers, lastProvider: p.id });
    save(get());
  },
  remove: (id) => {
    set({ providers: get().providers.filter((p) => p.id !== id), lastProvider: get().lastProvider === id ? null : get().lastProvider });
    save(get());
  },
  remember: (lastProvider, lastCredential) => {
    set({ lastProvider, lastCredential });
    save(get());
  },
}));
