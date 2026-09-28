/**
 * Read aloud (Acrobat "Read Out Loud"): speaks page text or a selection with
 * the voices installed in Windows, through the WebView's speech engine —
 * offline, no text leaves the computer. Text is prepared (hyphenation undone,
 * lines joined, split into sentence-sized pieces) and spoken one piece at a
 * time so pause, stop and page changes react at once.
 */
import { create } from 'zustand';

export interface TextPiece {
  str: string;
  hasEOL?: boolean;
}

/** Page text for speech: items joined, line-end hyphens removed, whitespace tidied. */
export function speechText(items: TextPiece[]): string {
  let out = '';
  for (const it of items) {
    const s = it.str;
    if (!s) {
      if (it.hasEOL && out && !/\s$/.test(out)) out += ' ';
      continue;
    }
    out += s;
    if (it.hasEOL) {
      // "exam-" + new line + "ple" → "example"; otherwise the line break is a space.
      if (/[\p{L}\p{N}]-$/u.test(out)) out = out.slice(0, -1) + '\u0000';
      else out += ' ';
    }
  }
  return out
    .replace(/\u0000(\s*)(\p{Ll})/gu, '$2')
    .replace(/\u0000/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits text into sentences of at most `max` characters (long ones at commas or spaces). */
export function speechChunks(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["'”»)]*|$)\s*/gu) ?? [];
  const out: string[] = [];
  for (const raw of sentences) {
    let s = raw.trim();
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

export interface VoiceInfo {
  uri: string;
  name: string;
  lang: string;
  local: boolean;
}

/** The voice to use: the chosen one, else one for the text's language (Romanian letters → ro), else the system's. */
export function pickVoice(voices: VoiceInfo[], text: string, preferred: string | null, uiLang = 'en'): VoiceInfo | null {
  if (!voices.length) return null;
  const chosen = preferred ? voices.find((v) => v.uri === preferred) : undefined;
  if (chosen) return chosen;
  const lang = /[ăâîșțşţ]/i.test(text) ? 'ro' : uiLang.slice(0, 2).toLowerCase();
  const byLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  return byLang.find((v) => v.local) ?? byLang[0] ?? voices.find((v) => v.local) ?? voices[0];
}

// ------------------------------------------------------------------ player

export type ReadStatus = 'idle' | 'speaking' | 'paused';

interface ReadAloudState {
  status: ReadStatus;
  /** Page being read (for the status bar and scrolling). */
  pageId: string | null;
  voices: VoiceInfo[];
  voiceUri: string | null;
  rate: number;
  setVoice: (uri: string | null) => void;
  setRate: (rate: number) => void;
}

const SETTINGS_KEY = 'adika.readAloud';

function loadSettings(): { voiceUri: string | null; rate: number } {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { voiceUri?: string; rate?: number };
    return { voiceUri: s.voiceUri ?? null, rate: typeof s.rate === 'number' ? s.rate : 1 };
  } catch {
    return { voiceUri: null, rate: 1 };
  }
}

function saveSettings(p: { voiceUri: string | null; rate: number }): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: settings just are not remembered */
  }
}

export const useReadAloud = create<ReadAloudState>()((set, get) => ({
  status: 'idle',
  pageId: null,
  voices: [],
  ...loadSettings(),
  setVoice: (voiceUri) => {
    set({ voiceUri });
    saveSettings({ voiceUri, rate: get().rate });
  },
  setRate: (rate) => {
    set({ rate });
    saveSettings({ voiceUri: get().voiceUri, rate });
  },
}));

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

function refreshVoices(): void {
  if (!speechAvailable()) return;
  const voices = window.speechSynthesis.getVoices().map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService }));
  useReadAloud.setState({ voices });
}

if (speechAvailable()) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

/** A source of text to read: pieces are fetched lazily (page by page). */
export interface ReadingJob {
  /** Returns the next block of text and the page it belongs to, or null at the end. */
  next: () => Promise<{ text: string; pageId: string | null } | null>;
  /** Called when a new page starts being read. */
  onPage?: (pageId: string) => void;
}

let session = 0;

/** Speaks a job; any earlier reading stops. Resolves when finished or stopped. */
export async function read(job: ReadingJob): Promise<void> {
  if (!speechAvailable()) throw new Error('Read aloud is not available: Windows has no speech voices installed.');
  const synth = window.speechSynthesis;
  synth.cancel();
  const my = ++session;
  const alive = () => my === session;
  useReadAloud.setState({ status: 'speaking' });
  try {
    for (;;) {
      const block = await job.next();
      if (!block || !alive()) break;
      if (block.pageId) {
        useReadAloud.setState({ pageId: block.pageId });
        job.onPage?.(block.pageId);
      }
      for (const piece of speechChunks(block.text)) {
        if (!alive()) return;
        await speakOne(piece);
      }
    }
  } finally {
    if (alive()) useReadAloud.setState({ status: 'idle', pageId: null });
  }
}

function speakOne(text: string): Promise<void> {
  return new Promise((resolve) => {
    const st = useReadAloud.getState();
    if (!st.voices.length) refreshVoices();
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(useReadAloud.getState().voices, text, st.voiceUri, navigator.language);
    const native = voice ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === voice.uri) : undefined;
    if (native) {
      u.voice = native;
      u.lang = native.lang;
    }
    u.rate = st.rate;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export function pauseReading(): void {
  if (!speechAvailable() || useReadAloud.getState().status !== 'speaking') return;
  window.speechSynthesis.pause();
  useReadAloud.setState({ status: 'paused' });
}

export function resumeReading(): void {
  if (!speechAvailable() || useReadAloud.getState().status !== 'paused') return;
  window.speechSynthesis.resume();
  useReadAloud.setState({ status: 'speaking' });
}

export function stopReading(): void {
  session++;
  if (speechAvailable()) window.speechSynthesis.cancel();
  useReadAloud.setState({ status: 'idle', pageId: null });
}
