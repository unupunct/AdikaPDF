/**
 * Signature appearance profiles (Sign → Design appearance…), kept in this
 * computer's app storage. One may be the default for new signatures; without
 * any, Adika's standard badge is used.
 */
import { create } from 'zustand';
import type { AppearanceProfile } from '@/lib/crypto/sigAppearance';

interface SigProfiles {
  profiles: AppearanceProfile[];
  defaultId: string | null;
  upsert: (p: AppearanceProfile) => void;
  remove: (id: string) => void;
  setDefault: (id: string | null) => void;
}

const KEY = 'adika.sigAppearances';

type Saved = Pick<SigProfiles, 'profiles' | 'defaultId'>;

function valid(p: unknown): p is AppearanceProfile {
  const x = p as AppearanceProfile;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.layout === 'string' && !!x.details && !!x.labels && !!x.graphic;
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>;
    const profiles = Array.isArray(v.profiles) ? v.profiles.filter(valid) : [];
    const defaultId = typeof v.defaultId === 'string' && profiles.some((p) => p.id === v.defaultId) ? v.defaultId : null;
    return { profiles, defaultId };
  } catch {
    return { profiles: [], defaultId: null };
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ profiles: s.profiles, defaultId: s.defaultId }));
  } catch {
    /* storage unavailable or full: kept for this session */
  }
}

export const useSigProfiles = create<SigProfiles>()((set, get) => ({
  ...load(),
  upsert: (p) => {
    const profiles = get().profiles.some((x) => x.id === p.id) ? get().profiles.map((x) => (x.id === p.id ? p : x)) : [...get().profiles, p];
    set({ profiles });
    save(get());
  },
  remove: (id) => {
    set({ profiles: get().profiles.filter((p) => p.id !== id), defaultId: get().defaultId === id ? null : get().defaultId });
    save(get());
  },
  setDefault: (defaultId) => {
    set({ defaultId });
    save(get());
  },
}));

/** The profile with this id, else the default one, else null (the standard badge). */
export function profileById(id: string | null | undefined): AppearanceProfile | null {
  if (id === 'standard') return null;
  const s = useSigProfiles.getState();
  return s.profiles.find((p) => p.id === id) ?? s.profiles.find((p) => p.id === s.defaultId) ?? null;
}
