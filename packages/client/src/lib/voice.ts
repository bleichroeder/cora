import { create } from 'zustand';
import { DEFAULT_VOICE, type VoiceKeyInfo, type VoiceSettings } from '@cora/shared';
import { sentenceAt, sentences, speakable } from './speakable';
import { sessionEvents, useBrain } from '../state/store';
import { fileOf } from '../scene/derive';
import { desktop } from './desktop';
import { composerInbox } from '../state/composer';
import { sessionName } from './format';

/**
 * Live levels for the 3D scene, read every frame (no React), and whose they are: the session being read aloud or
 * talked to (only that session's main orb shows it).
 */
export const voiceLevels = { listen: 0, speak: 0, listening: false, speaking: false, speakFor: null as string | null, listenFor: null as string | null };

export type PttPhase = 'idle' | 'listening' | 'finishing' | 'review';
type Ptt = { phase: PttPhase; text: string; interim: string; error: string | null; sessionId: string | null };
type VoiceState = {
  settings: VoiceSettings;
  key: VoiceKeyInfo | null;
  /** what's being read aloud: a transcript step key (or "announce"), the sentence, how far through */
  /** what's being read aloud (and, when it's a session's, which one: its row shows it) */
  reading: { id: string; sentence: string; progress: number; sessionId?: string } | null;
  ptt: Ptt;
  /** a short message about the last voice problem (shown near the mic) */
  notice: string | null;
};
const IDLE: Ptt = { phase: 'idle', text: '', interim: '', error: null, sessionId: null };
export const useVoice = create<VoiceState>(() => ({ settings: DEFAULT_VOICE, key: null, reading: null, ptt: IDLE, notice: null }));
const setPtt = (p: Partial<Ptt>) => useVoice.setState((s) => ({ ptt: { ...s.ptt, ...p } }));
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notice(text: string | null) {
  clearTimeout(noticeTimer);
  useVoice.setState({ notice: text });
  if (text) noticeTimer = setTimeout(() => useVoice.setState({ notice: null }), 6000);
}

export async function loadVoice(): Promise<void> {
  const [s, k] = await Promise.all([
    fetch('/api/settings').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/voice').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  useVoice.setState({ settings: { ...DEFAULT_VOICE, ...(s?.voice ?? {}) }, key: k });
}

// ---------------------------------------------------------------- speaking
let audio: HTMLAudioElement | null = null;
let outCtx: AudioContext | null = null;
let outAn: AnalyserNode | null = null;
let readSeq = 0;

function player(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    outCtx = new AudioContext();
    outAn = outCtx.createAnalyser();
    outAn.fftSize = 512;
    outCtx.createMediaElementSource(audio).connect(outAn);
    outAn.connect(outCtx.destination);
  }
  return audio;
}

/** Gives up on a line that never starts, or plays on far longer than it should: nothing may block the queue for good. */
let watchdog: ReturnType<typeof setTimeout> | undefined;

export function stopSpeaking(): void {
  readSeq++;
  clearTimeout(watchdog);
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  voiceLevels.speaking = false;
  voiceLevels.speakFor = null;
  if (useVoice.getState().reading) useVoice.setState({ reading: null });
}

/**
 * Read aloud. `id` marks what's being read (a transcript step's key) so its button shows stop and its line
 * follows along. Markdown is made speakable and capped unless `raw`.
 */
/** Is it Cora speaking (its console's lines and notes have `cora` ids; its own session is known to the orchestrator)? */
let coraSession: (sessionId: string) => boolean = () => false;
export function setCoraSession(f: (sessionId: string) => boolean): void {
  coraSession = f;
}
/** How Cora sends what you said (marks it as yours, as typing in its console does); `said`: what its quick line already said aloud. */
type CoraSend = (text: string, said?: string) => Promise<string | null>;
let coraSend: CoraSend | null = null;
export function setCoraSend(f: CoraSend): void {
  coraSend = f;
}

/**
 * Click-to-talk: has the speaker finished? They've said something (the mic was loud, or the words grew), and since
 * then it's been quiet for `quietMs`. Before they start, nothing ends it (until `noSpeechMs` passes with no words).
 */
export function finishedSpeaking(o: { heard: boolean; lastSpeech: number; started: number; now: number; quietMs: number; noSpeechMs?: number }): boolean {
  if (o.heard) return o.now - o.lastSpeech >= o.quietMs;
  return o.now - o.started >= (o.noSpeechMs ?? NO_SPEECH_MS);
}

/** Is this line Cora's (its console, its notes, its own session)? */
export const coraLine = (id: string, sessionId?: string) => id.startsWith('cora') || (!!sessionId && coraSession(sessionId));
/** Is what's being read aloud Cora's own (so its lens moves), not a session's? */
export const coraReading = (r: VoiceState['reading']) => !!r && coraLine(r.id, r.sessionId);
/** The voice for a line: Cora's own, when it has one and it's Cora speaking; else the sessions' (the server's default). */
export function voiceFor(id: string, sessionId?: string): string | undefined {
  const own = useVoice.getState().settings.coraVoiceId;
  return own && coraLine(id, sessionId) ? own : undefined;
}

/** A spoken line finished on its own (not stopped): who wants to know (the wake word's follow-up). */
const endListeners = new Set<(id: string, sessionId?: string) => void>();
export function onSpeechEnd(cb: (id: string, sessionId?: string) => void): () => void {
  endListeners.add(cb);
  return () => void endListeners.delete(cb);
}

export async function speak(id: string, markdown: string, cap = 4800, raw = false, sessionId?: string): Promise<void> {
  // the quick line said when you spoke finishes first (it's short) rather than being cut off by the answer
  if (!isFrontLine(id) && isFrontLine(useVoice.getState().reading?.id)) await frontSaid(5000);
  stopSpeaking();
  const my = readSeq;
  const text = (raw ? markdown : speakable(markdown, cap)).slice(0, 5000);
  if (!text) return;
  const list = sentences(text);
  useVoice.setState({ reading: { id, sentence: list[0], progress: 0, ...(sessionId ? { sessionId } : {}) } });
  const est = text.length / (15 * useVoice.getState().settings.speed);
  // not started within 10s (the speech request hanging, or the browser holding sound back): give up on it
  watchdog = setTimeout(() => my === readSeq && stopSpeaking(), 10_000);
  try {
    const voiceId = voiceFor(id, sessionId);
    const r = await fetch('/api/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(voiceId ? { voiceId } : {}), ...(coraLine(id, sessionId) ? { cora: true } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `speech failed (${r.status})`);
    if (my !== readSeq) return;
    const a = player();
    await outCtx!.resume();
    // replaced or stopped while waiting: a stale call must never touch the shared player (that played lines twice)
    if (my !== readSeq) return;
    // streamed audio has no duration until it has all arrived: estimated from the text meanwhile
    a.ontimeupdate = () => {
      if (my !== readSeq) return;
      const frac = Math.min(1, a.currentTime / (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : est));
      const sentence = list[sentenceAt(list, frac)];
      useVoice.setState({ reading: { id, sentence, progress: frac, ...(sessionId ? { sessionId } : {}) } });
    };
    a.onended = () => {
      if (my !== readSeq) return;
      stopSpeaking();
      for (const cb of endListeners) cb(id, sessionId);
    };
    a.onerror = () => {
      if (my !== readSeq) return;
      stopSpeaking();
      notice("Couldn't play the reply: check your ElevenLabs key and voice in Settings → Voice");
    };
    a.onplaying = () => {
      if (my !== readSeq) return;
      // playing: now it only has to end in reasonable time
      clearTimeout(watchdog);
      watchdog = setTimeout(() => my === readSeq && stopSpeaking(), (est * 1.6 + 15) * 1000);
    };
    a.src = j.url;
    voiceLevels.speaking = true;
    voiceLevels.speakFor = sessionId ?? null;
    await a.play();
  } catch (e) {
    if (my !== readSeq) return;
    stopSpeaking();
    notice((e as Error).message);
  }
}

// ---------------------------------------------------------------- listening: the mic streamed to ElevenLabs Scribe
let mic: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let micAn: AnalyserNode | null = null;
let ws: WebSocket | null = null;
let committed = '';
let onCommitted: (() => void) | null = null;
/** click-to-talk: watches for you to stop talking */
let quietTimer: ReturnType<typeof setInterval> | null = null;
/** How long quiet ends click-to-talk when the setting says nothing (ms). */
export const SILENCE_MS = 1200;
/** Give up waiting for you to start talking after this long (ms). */
const NO_SPEECH_MS = 10_000;
let listenSeq = 0;
export const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('ab-pcm',P)`;

const b64 = (pcm: Int16Array) => {
  const u = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Words Scribe should expect in this session: the files it touched and the project name (Scribe keyterms). */
export function keytermsFor(sessionId: string): string[] {
  const out = new Set<string>();
  const s = useBrain.getState().sessions[sessionId];
  if (s?.project) out.add(s.project);
  const evs = sessionEvents(sessionId);
  for (let i = evs.length - 1; i >= 0 && out.size < 50; i--) {
    const f = fileOf(evs[i]);
    if (f && f.name.length >= 3 && f.name.length <= 20) out.add(f.name);
  }
  return [...out].slice(0, 50);
}

function teardownMic() {
  if (quietTimer) clearInterval(quietTimer);
  quietTimer = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  void micCtx?.close().catch(() => {});
  micCtx = null;
  micAn = null;
  voiceLevels.listening = false;
  voiceLevels.listenFor = null;
}

/** Start push-to-talk for a session: the mic streams to Scribe and words appear as they're recognised. */
export async function startListening(sessionId: string, opts: { /** click-to-talk: it stops once you've finished speaking (holding a key: when you let go) */ hands?: boolean } = {}): Promise<void> {
  const st = useVoice.getState();
  if (!st.settings.enabled || st.ptt.phase === 'listening' || st.ptt.phase === 'finishing') return;
  stopSpeaking(); // talking over Claude stops it
  if (!st.key?.set) return void notice('Add an ElevenLabs key in Settings → Voice to talk');
  if (st.key.perms.stt === false) return void notice("Your ElevenLabs key can't transcribe (Speech to Text is off for it). Use /voice in the terminal, or allow it on the key.");
  const my = ++listenSeq;
  committed = '';
  setPtt({ phase: 'listening', text: '', interim: '', error: null, sessionId });
  voiceLevels.listening = true;
  voiceLevels.listenFor = sessionId;
  try {
    const token = fetch('/api/voice/stt-token', { method: 'POST' }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'no transcription token');
      return j.token as string;
    });
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).catch((e) => {
      throw new Error(e?.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in Windows Settings → Privacy → Microphone.' : `No microphone (${e?.message ?? e})`);
    });
    if (my !== listenSeq) return teardownMic();
    // a 16 kHz context: the browser resamples the mic, so frames go to Scribe as pcm_16000 as they are
    micCtx = new AudioContext({ sampleRate: 16000 });
    const src = micCtx.createMediaStreamSource(mic);
    micAn = micCtx.createAnalyser();
    micAn.fftSize = 512;
    src.connect(micAn);
    await micCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    const node = new AudioWorkletNode(micCtx, 'ab-pcm');
    const mute = micCtx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(micCtx.destination);
    const q = new URLSearchParams({ model_id: 'scribe_v2_realtime', token: await token, audio_format: 'pcm_16000', commit_strategy: 'manual' });
    for (const k of keytermsFor(sessionId)) q.append('keyterms', k);
    if (my !== listenSeq) return teardownMic();
    const sock = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q}`);
    ws = sock;
    let buf: number[] = [];
    const flush = (commit = false) => {
      if (sock.readyState !== WebSocket.OPEN || (!buf.length && !commit)) return;
      const pcm = Int16Array.from(buf);
      buf = [];
      sock.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64(pcm), commit, sample_rate: 16000 }));
    };
    // hands-free: you've said something, then it's quiet a moment: stop (and review or send, as for a release)
    const quietMs = st.settings.endOnSilence ?? SILENCE_MS;
    const hear = { heard: false, lastSpeech: 0, started: Date.now(), floor: 0.004, loud: 0 };
    const words = { last: '' };
    if (opts.hands && quietMs > 0) {
      quietTimer = setInterval(() => {
        if (my !== listenSeq) return;
        if (finishedSpeaking({ ...hear, now: Date.now(), quietMs })) void stopListening();
      }, 100);
    }
    node.port.onmessage = (e) => {
      const f = e.data as Float32Array;
      let sum = 0;
      for (let i = 0; i < f.length; i++) {
        buf.push(Math.max(-1, Math.min(1, f[i])) * 0x7fff);
        sum += f[i] * f[i];
      }
      // loud next to the room's own level (which it follows while it's quiet) counts as talking
      const rms = Math.sqrt(sum / Math.max(1, f.length));
      if (rms > Math.max(0.015, hear.floor * 3)) {
        hear.lastSpeech = Date.now();
        // a moment of it (not a click or a knock)
        if (++hear.loud >= 4) hear.heard = true;
      } else {
        hear.floor = hear.floor * 0.97 + rms * 0.03;
        hear.loud = 0;
      }
      if (buf.length >= 1600) flush(); // every ~100 ms
    };
    (sock as WebSocket & { flushFinal?: () => void }).flushFinal = () => flush(true);
    sock.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.message_type === 'partial_transcript') {
        // the words growing is talking, whatever the mic level says
        const t = String(d.text ?? '');
        if (t.trim() && t !== words.last) (hear.heard = true), (hear.lastSpeech = Date.now());
        words.last = t;
        setPtt({ interim: t });
      }
      else if (d.message_type === 'committed_transcript') {
        committed = `${committed} ${d.text ?? ''}`.trim();
        setPtt({ text: committed, interim: '' });
        onCommitted?.();
      } else if (d.error && d.message_type !== 'insufficient_audio_activity') setPtt({ error: `${d.message_type}: ${d.error}` });
    };
    sock.onerror = () => setPtt({ error: "Couldn't reach ElevenLabs transcription" });
  } catch (e) {
    teardownMic();
    if (my === listenSeq) setPtt({ phase: 'idle' }), notice((e as Error).message);
  }
}

/** Release push-to-talk: commit what was said, then review it (in the session's composer when it has one) or send it straight away. */
export async function stopListening(): Promise<void> {
  if (useVoice.getState().ptt.phase !== 'listening') return;
  const my = listenSeq;
  setPtt({ phase: 'finishing' });
  teardownMic();
  const sock = ws;
  ws = null;
  if (sock && sock.readyState === WebSocket.OPEN) {
    const done = new Promise<void>((res) => {
      onCommitted = res;
      setTimeout(res, 2000);
    });
    (sock as WebSocket & { flushFinal?: () => void }).flushFinal?.();
    await done;
    onCommitted = null;
  }
  sock?.close();
  if (my !== listenSeq) return;
  const p = useVoice.getState().ptt;
  const text = `${committed} ${p.interim}`.replace(/\s+/g, ' ').trim();
  if (!text) return void setPtt(p.error ? { phase: 'review', text: '' } : IDLE);
  const v = useVoice.getState().settings;
  // talking to Cora is a conversation: what you said goes to it at once (unless you'd rather check it first)
  if (p.sessionId && coraSession(p.sessionId) && (v.coraAfter ?? 'send') === 'send' && coraSend) {
    setPtt(IDLE);
    heardYou();
    // the quick line first (half a second), so Cora's agent hears what was already said and carries on from it
    const at = Date.now();
    const line = await askFront(p.sessionId, text, CORA_FRONT_WAIT_MS);
    if (line) sayFront(p.sessionId, line, at);
    const err = await coraSend(text, line ?? undefined);
    if (err) {
      // Cora couldn't take it: the words go to its console (or the clipboard), never into whichever session's review
      // box is showing, where Enter would send them to that session (audit B7)
      const cora = composerInbox.get(p.sessionId);
      if (cora) cora(text);
      else if (desktop?.writeClipboard) desktop.writeClipboard(text);
      else void navigator.clipboard?.writeText(text).catch(() => {});
      notice(`Cora didn't get that (${err}): your words are ${cora ? "in Cora's console" : 'on the clipboard'}`);
    }
    return;
  }
  if (v.after === 'send' && p.sessionId && !coraSession(p.sessionId)) return void sendPrompt(p.sessionId, text, true);
  // the session's composer is open: review the words there (edit, add files, send as usual)
  const inbox = p.sessionId ? composerInbox.get(p.sessionId) : undefined;
  if (inbox) return void (setPtt(IDLE), inbox(text));
  setPtt({ phase: 'review', text, interim: '' });
}

export function cancelPtt(): void {
  listenSeq++;
  teardownMic();
  ws?.close();
  ws = null;
  setPtt(IDLE);
}

/** Type the words into the session's hosted terminal and press Enter (or copy them when it isn't hosted here). */
export async function sendPrompt(sessionId: string, text: string, spoken = false): Promise<void> {
  const t = useBrain.getState().terminals.find((x) => x.sessionId === sessionId && x.alive);
  setPtt(IDLE);
  if (!t) {
    if (desktop?.writeClipboard) desktop.writeClipboard(text);
    else void navigator.clipboard?.writeText(text).catch(() => {});
    return void notice("This session isn't running in Cora, so your words were copied to the clipboard");
  }
  if (spoken) heardYou();
  const r = await fetch(`/api/terminals/${encodeURIComponent(t.terminalId)}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, submit: true, ...(spoken ? { spoken: true } : {}) }) });
  if (!r.ok) notice(`Couldn't send it: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
  else if (spoken) void frontLine(sessionId, text);
}

// ---------------------------------------------------------------- after a spoken prompt: no silence
let cueCtx: AudioContext | null = null;
/** A soft two-note "heard you", the moment what you said goes out. */
export function heardYou(): void {
  try {
    cueCtx ??= new AudioContext();
    const c = cueCtx;
    void c.resume();
    const t0 = c.currentTime + 0.01;
    for (const [i, f] of [660, 880].entries()) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + 0.18);
    }
  } catch {
    /* no sound: the words still went */
  }
}

let frontSeq = 0;
/** Is this one of the voice front's lines? (The real answer waits for it rather than cutting it off.) */
export const isFrontLine = (id?: string | null) => !!id && /(^|:)front:/.test(id);

/** Talking to Cora, its agent waits at most this long for the quick line (then goes without it). */
const CORA_FRONT_WAIT_MS = 1500;

/**
 * A spoken prompt went out: Cora's quick line for it ("Checking the webapi pipeline now."), from a warm Haiku on the
 * server, said as soon as it comes, unless the real answer got there first or you're talking again. Small talk gets
 * no line (the answer is quick, and the line would only repeat it).
 */
export async function frontLine(sid: string, text: string): Promise<void> {
  const at = Date.now();
  const line = await askFront(sid, text);
  if (line) sayFront(sid, line, at);
}

/** The quick line for what you said, or null (off, small talk, too slow, or a newer one asked for). */
async function askFront(sid: string, text: string, waitMs = 3000): Promise<string | null> {
  const v = useVoice.getState().settings;
  if (!v.enabled || v.front === false) return null;
  const seq = ++frontSeq;
  const toCora = coraSession(sid);
  const b = useBrain.getState();
  const s = toCora ? (b.focus ? b.sessions[b.focus] : null) : b.sessions[sid];
  const looking = s ? sessionName(s) : toCora ? 'the Overview' : undefined;
  const ask = fetch('/api/voice/front', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, toCora, ...(looking ? { looking } : {}) }) })
    .then((x) => (x.ok ? x.json() : null))
    .catch(() => null);
  const r = await Promise.race([ask, new Promise<null>((res) => setTimeout(() => res(null), waitMs))]);
  const line = typeof r?.line === 'string' ? r.line : '';
  return line && seq === frontSeq ? line : null;
}

/** Say the quick line, unless the real answer (asked for at `at`) got there first or you're talking again. */
function sayFront(sid: string, line: string, at: number): void {
  const answered = sessionEvents(sid).some((e) => e.agentId === 'main' && e.ts >= at - 1000 && (e.kind === 'turn_end' || (e.kind === 'say' && !!e.said)));
  const now = useVoice.getState();
  if (answered || now.ptt.phase !== 'idle' || now.reading) return;
  void speak(`front:${frontSeq}`, line, 300, true, sid);
}

/** Resolves when the voice front's line has been said (or after `ms`). */
function frontSaid(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(() => (off(), res()), ms);
    const off = useVoice.subscribe((st) => {
      if (isFrontLine(st.reading?.id)) return;
      clearTimeout(t);
      off();
      res();
    });
  });
}

// ---------------------------------------------------------------- levels for the scene
const rms = (an: AnalyserNode) => {
  const b = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(b);
  let s = 0;
  for (const v of b) s += ((v - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(s / b.length) * 4);
};
setInterval(() => {
  voiceLevels.listen = micAn && voiceLevels.listening ? voiceLevels.listen * 0.4 + rms(micAn) * 0.6 : voiceLevels.listen * 0.6;
  voiceLevels.speak = outAn && voiceLevels.speaking ? voiceLevels.speak * 0.45 + rms(outAn) * 0.55 : voiceLevels.speak * 0.6;
}, 33);

/** Voice updates off (or on again): nothing said on its own while off (Settings › Voice says what's said when on). */
export async function setMuted(muted: boolean): Promise<string | null> {
  useVoice.setState({ settings: { ...useVoice.getState().settings, muted } });
  if (muted) stopSpeaking();
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: { muted } }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok) return j.error ?? "Couldn't change it";
  if (j.voice) useVoice.setState({ settings: { ...DEFAULT_VOICE, ...j.voice } });
  return null;
}

