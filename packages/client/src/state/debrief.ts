import { create } from 'zustand';
import { nextBeat, nextStep, prevStep, type Debrief, type DebriefsMsg, type DebriefSummary, type Playing, type Settings } from '@cora/shared';
import { onSpeechEnd, speak, stopSpeaking, useVoice } from '../lib/voice';
import { sendToSession } from './composer';
import { DEBRIEF_ASK, askProgress, debriefPlace, nav, replyOf } from '../lib/debrief';
import { sessionEvents, useBrain } from './store';

/** The debrief playing: whose, which, where in it, playing it through or stepping, reading aloud or not. */
type On = { sessionId: string; d: Debrief; at: Playing; playing: boolean; speak: boolean };

type DebriefState = {
  /** each session's debriefs, newest first */
  lists: Record<string, DebriefSummary[]>;
  /** debriefs you've seen (their list was on show), and since when that's counted: older ones count as seen */
  seen: Record<string, true>;
  since: number;
  markSeen(ids: string[]): void;
  on: On | null;
  /** a session whose debrief waits for an IDE panel open on its folder (the Board offers to add one) */
  needsIde: string | null;
  /** asks for a debrief in flight, per session: since when, and whether its turn ended without one */
  asking: Record<string, { depth: 'quick' | 'teach'; at: number; missed?: boolean }>;
  /** the Debrief button: ask the session for one (sent at once, as a prompt), and follow it */
  askFor(sessionId: string, depth: 'quick' | 'teach'): Promise<{ ok: boolean; error?: string }>;
  dismissAsk(sessionId: string): void;
  load(sessionId: string): Promise<void>;
  apply(m: DebriefsMsg): void;
  start(sessionId: string, id: string): Promise<void>;
  next(): void;
  back(): void;
  play(): void;
  pause(): void;
  toggleSpeak(): void;
  ask(text: string): Promise<void>;
  end(): void;
};

const beatText = (d: Debrief, at: Playing) => nav(d).steps[at.step]?.beats[at.beat]?.text ?? '';
const stepChars = (d: Debrief, step: number) => (nav(d).steps[step]?.beats ?? []).reduce((n, b) => n + b.text.length, 0);
const voiceReady = () => {
  const v = useVoice.getState().settings;
  return v.enabled && !v.muted;
};
const post = (url: string, body: object) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; reason?: string }>) : null))
    .catch(() => null);

/** Seen debriefs, in this browser only (a convenience: none kept means none new before now). */
const SEEN = 'cora.debriefs.seen';
function loadSeen(): { seen: Record<string, true>; since: number } {
  try {
    const j = JSON.parse(localStorage.getItem(SEEN) ?? 'null') as { ids?: string[]; since?: number } | null;
    if (j && typeof j.since === 'number') return { seen: Object.fromEntries((j.ids ?? []).map((id) => [id, true as const])), since: j.since };
  } catch {
    /* none kept */
  }
  const since = Date.now();
  saveSeen({}, since);
  return { seen: {}, since };
}
function saveSeen(seen: Record<string, true>, since: number): void {
  try {
    localStorage.setItem(SEEN, JSON.stringify({ ids: Object.keys(seen).slice(-500), since }));
  } catch {
    /* only a convenience */
  }
}
/** A session has a debrief you haven't seen yet. */
export const hasNewDebrief = (s: { lists: Record<string, DebriefSummary[]>; seen: Record<string, true>; since: number }, sessionId: string) =>
  (s.lists[sessionId] ?? []).some((x) => !s.seen[x.id] && x.createdAt > s.since);

let timer: ReturnType<typeof setTimeout> | undefined;
let ideWait: ReturnType<typeof setInterval> | undefined;
/** the line being read for the player (its id), to know when it ends */
let saying: string | null = null;

export const useDebrief = create<DebriefState>((set, get) => {
  const move = (at: Playing) => set((s) => (s.on ? { on: { ...s.on, at } } : s));
  const hush = () => {
    clearTimeout(timer);
    if (saying) stopSpeaking();
    saying = null;
  };
  /** The step (and beat) to the IDE; none open on the folder: wait for one (the Board offers to add it). */
  const show = async (): Promise<boolean> => {
    const on = get().on;
    if (!on) return false;
    const r = await post('/api/ide/debrief/show', { sessionId: on.sessionId, id: on.d.id, step: on.at.step, beat: on.at.beat, playing: on.playing, speak: on.speak });
    if (r?.ok) {
      if (get().needsIde) set({ needsIde: null });
      return true;
    }
    if (r?.reason === 'no-ide' && !ideWait) {
      set({ needsIde: on.sessionId });
      ideWait = setInterval(() => {
        const now = get().on;
        if (!now) return void (clearInterval(ideWait), (ideWait = undefined));
        void post('/api/ide/debrief/show', { sessionId: now.sessionId, id: now.d.id, step: now.at.step, beat: now.at.beat, playing: now.playing, speak: now.speak }).then((x) => {
          if (!x?.ok || !ideWait) return;
          clearInterval(ideWait);
          ideWait = undefined;
          set({ needsIde: null });
          sayBeat();
        });
      }, 2000);
    }
    return false;
  };
  /** Read the beat (playing, or reading aloud), or give it time to be read; then beatDone. */
  const sayBeat = () => {
    clearTimeout(timer);
    const on = get().on;
    if (!on || get().needsIde) return;
    const text = beatText(on.d, on.at);
    if (voiceReady() && (on.playing || on.speak)) {
      saying = `debrief:${on.d.id}:${on.at.step}:${on.at.beat}:${Date.now()}`;
      void speak(saying, text, 1200, false, on.sessionId, { now: true });
      // the speech never ending (it failed): go on anyway
      timer = setTimeout(beatDone, Math.max(10_000, text.length * 120));
    } else if (on.playing) timer = setTimeout(beatDone, Math.min(12_000, Math.max(2500, text.length * 60)));
  };
  /** A beat was read: the next one in the step; playing, the next step after a pause scaled to the step. */
  const beatDone = () => {
    clearTimeout(timer);
    saying = null;
    const on = get().on;
    if (!on || (!on.playing && !on.speak)) return;
    const n = nextBeat(nav(on.d), on.at);
    if (!n) {
      if (on.playing) set({ on: { ...on, playing: false } });
      void show();
      return;
    }
    if (n.step === on.at.step) {
      move(n);
      void show();
      return sayBeat();
    }
    if (!on.playing) return; // stepping: the step's beats are read, then it waits for you
    timer = setTimeout(() => {
      move(n);
      void show().then((ok) => ok && sayBeat());
    }, 900 + Math.min(2000, stepChars(on.d, on.at.step) * 3));
  };
  onSpeechEnd((id) => {
    if (id === saying) beatDone();
  });
  const go = (at: Playing | null, o: { stop?: boolean } = {}) => {
    const on = get().on;
    if (!on || !at) return;
    hush();
    set({ on: { ...on, at, ...(o.stop ? { playing: false } : {}) } });
    void show().then((ok) => ok && sayBeat());
  };

  return {
    lists: {},
    ...loadSeen(),
    markSeen(ids) {
      const fresh = ids.filter((id) => !get().seen[id]);
      if (!fresh.length) return;
      const seen = { ...get().seen, ...Object.fromEntries(fresh.map((id) => [id, true as const])) };
      set({ seen });
      saveSeen(seen, get().since);
    },
    on: null,
    needsIde: null,
    asking: {},
    async askFor(sessionId, depth) {
      const at = Date.now();
      const r = await sendToSession(sessionId, DEBRIEF_ASK(depth));
      if (!r.ok) return { ok: false, error: r.error };
      set((s) => ({ asking: { ...s.asking, [sessionId]: { depth, at } } }));
      // its turn ending with no debrief made: say so (it answered in words, or couldn't write one)
      const check = () => {
        const a = get().asking[sessionId];
        if (!a || a.at !== at) return true;
        if (askProgress(sessionEvents(sessionId), at) !== 'ended') return false;
        // the debrief comes in during the turn; give its list a moment to land first
        setTimeout(() => {
          const still = get().asking[sessionId];
          if (still?.at === at && !still.missed) set((s) => ({ asking: { ...s.asking, [sessionId]: { ...still, missed: true } } }));
        }, 3000);
        return true;
      };
      if (!check()) {
        const unsub = useBrain.subscribe((s, prev) => s.versions[sessionId] !== prev.versions[sessionId] && check() && (unsub(), clearTimeout(giveUp)));
        const giveUp = setTimeout(() => unsub(), 30 * 60_000);
      }
      return { ok: true };
    },
    dismissAsk(sessionId) {
      set((s) => {
        const { [sessionId]: _a, ...rest } = s.asking;
        return { asking: rest };
      });
    },
    async load(sessionId) {
      const r = await fetch(`/api/debriefs/${encodeURIComponent(sessionId)}`).catch(() => null);
      const j = r?.ok ? ((await r.json()) as { list: DebriefSummary[] }) : null;
      if (j) set((s) => ({ lists: { ...s.lists, [sessionId]: j.list } }));
    },
    apply(m) {
      set((s) => {
        // the debrief asked for has come: the ask is done
        const a = s.asking[m.sessionId];
        const came = !!a && m.list.some((x) => x.createdAt >= a.at - 2000);
        const { [m.sessionId]: _a, ...rest } = s.asking;
        return { lists: { ...s.lists, [m.sessionId]: m.list }, ...(came ? { asking: rest } : {}) };
      });
    },
    async start(sessionId, id) {
      const [r, cfg] = await Promise.all([fetch(`/api/debriefs/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`).catch(() => null), fetch('/api/settings').then((x) => (x.ok ? (x.json() as Promise<Settings>) : null)).catch(() => null)]);
      if (!r?.ok) return;
      const d = (await r.json()) as Debrief;
      const was = get().on;
      hush();
      if (was && was.sessionId !== sessionId) void post('/api/ide/debrief/show', { sessionId: was.sessionId, end: true });
      set({ on: { sessionId, d, at: { step: 0, beat: 0 }, playing: false, speak: !!cfg?.debrief?.speak } });
      if (await show()) sayBeat();
    },
    next() {
      const on = get().on;
      if (on) go(nextStep(nav(on.d), on.at));
    },
    back() {
      const on = get().on;
      if (on) go(prevStep(nav(on.d), on.at), { stop: true });
    },
    play() {
      const on = get().on;
      if (!on) return;
      hush();
      // from the end: from the start again
      const at = !nextBeat(nav(on.d), on.at) ? { step: 0, beat: 0 } : on.at;
      set({ on: { ...on, at, playing: true } });
      void show().then((ok) => ok && sayBeat());
    },
    pause() {
      const on = get().on;
      if (!on) return;
      hush();
      set({ on: { ...on, playing: false } });
      void show();
    },
    toggleSpeak() {
      const on = get().on;
      if (!on) return;
      const speakOn = !on.speak;
      if (!speakOn) hush();
      set({ on: { ...on, speak: speakOn } });
      void show().then((ok) => ok && speakOn && !on.playing && sayBeat());
    },
    async ask(text) {
      const on = get().on;
      const q = text.trim();
      if (!on || !q) return;
      hush();
      if (on.playing) set({ on: { ...on, playing: false } });
      void show();
      const asked = `[Debrief ${debriefPlace(on.d, on.at)}] ${q}`;
      const since = Date.now();
      const sent = await sendToSession(on.sessionId, asked);
      const reply = (t: string) => void post('/api/ide/debrief/reply', { sessionId: on.sessionId, text: t });
      if (!sent.ok) return reply(`*Couldn't ask: ${sent.error}*`);
      // its answer, when that turn ends (it may wait in the queue behind what it's doing)
      const sid = on.sessionId;
      const check = () => {
        const t = replyOf(sessionEvents(sid), asked, since);
        if (t == null) return false;
        reply(t);
        const now = get().on;
        if (now?.sessionId === sid && now.speak && voiceReady()) void speak(`debrief-reply:${since}`, t, 1500, false, sid, { now: true });
        return true;
      };
      if (check()) return;
      const giveUp = setTimeout(() => unsub(), 15 * 60_000);
      const unsub = useBrain.subscribe((s, prev) => {
        if (s.versions[sid] !== prev.versions[sid] && check()) {
          clearTimeout(giveUp);
          unsub();
        }
      });
    },
    end() {
      const on = get().on;
      hush();
      clearInterval(ideWait);
      ideWait = undefined;
      set({ on: null, needsIde: null });
      if (on) void post('/api/ide/debrief/show', { sessionId: on.sessionId, end: true });
    },
  };
});


/** A debrief as markdown, from the server (a PR description, a ticket comment). */
export async function debriefMarkdownOf(sessionId: string, id: string): Promise<string | null> {
  const r = await fetch(`/api/debriefs/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}/markdown`).catch(() => null);
  return r?.ok ? r.text() : null;
}
