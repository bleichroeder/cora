import { create } from 'zustand';
import type { VoiceSettings } from '@cora/shared';

/**
 * A session's own voice. Two ways it gets one: you pick any of your ElevenLabs voices on its card (it keeps that), or,
 * with Settings › Voice › Sessions' voices on "each its own", a new session is given one from the set you ticked
 * there, whichever is least in use among the sessions open now (so neighbours sound different). Neither: it speaks
 * with the sessions' voice. Kept in this browser.
 */
const KEY = 'cora.session.voice';
export type Voice = { id: string; name: string };
/** a session's voice: `auto` when it was given one from the set (it follows the set), not picked on its card */
export type Kept = Voice & { auto?: true };

const load = (): Record<string, Kept> => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    // (an id alone: given from the set, before picks kept names)
    return Object.fromEntries(
      Object.entries(raw).flatMap(([k, v]): [string, Kept][] => (typeof v === 'string' ? [[k, { id: v, name: '', auto: true }]] : v && typeof v === 'object' && typeof (v as Kept).id === 'string' ? [[k, v as Kept]] : [])),
    );
  } catch {
    return {};
  }
};

export const useSessionVoices = create<{ by: Record<string, Kept>; set(sessionId: string, voice: Kept | null): void }>((set, get) => ({
  by: load(),
  set: (sessionId, voice) => {
    const rest = Object.entries(get().by).filter(([k]) => k !== sessionId);
    const by = Object.fromEntries((voice ? [...rest, [sessionId, voice] as const] : rest).slice(-400));
    set({ by });
    try {
      localStorage.setItem(KEY, JSON.stringify(by));
    } catch {
      /* this time only */
    }
  },
}));

/** The set sessions are given voices from (none: they speak with the sessions' one voice, unless you pick one). */
export const voicePool = (v: VoiceSettings): Voice[] => (v.sessionVoices?.each ? (v.sessionVoices.pool ?? []) : []);

/** Which of `pool` a new session gets: the least used among `open` sessions' voices, the first of them on a tie. */
export function pickVoice(pool: Voice[], by: Record<string, Kept | string>, open: string[]): string | undefined {
  if (!pool.length) return undefined;
  const uses = new Map(pool.map((p) => [p.id, 0]));
  for (const sid of open) {
    const k = by[sid];
    const id = typeof k === 'string' ? k : k?.id;
    if (id && uses.has(id)) uses.set(id, uses.get(id)! + 1);
  }
  return [...pool].sort((a, b) => uses.get(a.id)! - uses.get(b.id)!)[0].id;
}

/**
 * What a session's voice is: the one you picked on its card; else the one it was given from the set (while it's still
 * in the set); else, with a set, the one it would be given now. None: the sessions' voice.
 */
export function voiceOf(sessionId: string, v: VoiceSettings, by: Record<string, Kept>, open: string[]): Kept | undefined {
  const k = by[sessionId];
  if (k && !k.auto) return k;
  const pool = voicePool(v);
  if (!pool.length) return undefined;
  const have = k && pool.find((p) => p.id === k.id);
  if (have) return { ...have, auto: true };
  const id = pickVoice(pool, by, open.filter((x) => x !== sessionId));
  const p = pool.find((x) => x.id === id);
  return p ? { ...p, auto: true } : undefined;
}

/** A session's voice when it speaks (one given from the set now is kept, so it sounds the same next time). */
export function sessionVoice(sessionId: string, v: VoiceSettings, open: () => string[]): Kept | undefined {
  const st = useSessionVoices.getState();
  const got = voiceOf(sessionId, v, st.by, open());
  if (got?.auto && st.by[sessionId]?.id !== got.id) st.set(sessionId, got);
  return got;
}

/** Your ElevenLabs voices, fetched the first time a card's menu opens. */
export const useVoiceList = create<{ list: Voice[] | null; load(): void }>((set, get) => ({
  list: null,
  load: () => {
    if (get().list) return;
    void fetch('/api/voice/voices')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { voices?: Voice[] } | null) => set({ list: (j?.voices ?? []).map((v) => ({ id: v.id, name: v.name })) }))
      .catch(() => set({ list: [] }));
  },
}));
