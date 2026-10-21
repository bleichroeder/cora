import { create } from 'zustand';
import { WAKE_THRESHOLDS } from '@cora/shared';
import { WORKLET, cancelPtt, coraLine, isFrontLine, onSpeechEnd, startListening, useVoice, voiceLevels } from '../voice';
import { agentId, useOrch } from '../../state/orchestrator';

export type WakeState = 'off' | 'starting' | 'waiting' | 'paused' | 'muted' | 'capturing' | 'followup' | 'error';
export type WakeWorkerLike = { post(m: unknown): void; onMessage(cb: (m: any) => void): void };
export type WakeDeps = {
  enabled(): boolean;
  /** why it can't run now (Cora off, no speech-to-text, mic blocked), or null */
  canRun(): string | null;
  /** something else is listening or speaking */
  busy(): boolean;
  startMic(onPcm: (pcm: Int16Array) => void): Promise<() => void>;
  worker(): WakeWorkerLike;
  /** start Cora's hands-free capture (a follow-up: ends quietly if you don't speak) */
  listen(followUp: boolean): void;
  stopListen(): void;
  isCoraLine(id: string, sessionId?: string): boolean;
  followUp(): boolean;
  chime(): void;
  threshold(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
};

const MUTED = 'cora.wake.muted';
const readMuted = () => {
  try {
    return localStorage.getItem(MUTED) === '1';
  } catch {
    return false;
  }
};
export const useWake = create<{ state: WakeState; muted: boolean; why?: string; level: number }>(() => ({ state: 'off', muted: readMuted(), level: 0 }));
export function setWakeMuted(on: boolean): void {
  try {
    localStorage.setItem(MUTED, on ? '1' : '0');
  } catch {
    /* not kept */
  }
  useWake.setState({ muted: on });
}

/** How long a follow-up waits for you to start talking. */
export const FOLLOW_UP_MS = 6000;

/**
 * "Hey Cora": while it's on and nothing else is listening or speaking, the mic streams to the wake worker; a hit
 * chimes and starts Cora's capture. When Cora's spoken answer ends, a follow-up capture opens for a few seconds.
 */
export class WakeController {
  private closeMic: (() => void) | null = null;
  private opening = false;
  private followTimer: unknown = null;
  private ready = false;

  constructor(private d: WakeDeps) {
    d.worker().onMessage((m) => {
      if (m.t === 'ready') this.ready = true;
      else if (m.t === 'hit') this.hit();
      else if (m.t === 'level') useWake.setState({ level: m.score });
      else if (m.t === 'error') this.set('error', m.message);
    });
  }

  private set(state: WakeState, why?: string) {
    const s = useWake.getState();
    if (s.state !== state || s.why !== why) useWake.setState({ state, ...(why ? { why } : { why: undefined }) });
  }

  /** Look again: should the mic be open for the wake word? */
  sync(): void {
    const s = useWake.getState().state;
    if (s === 'capturing' || s === 'followup') return;
    const why = this.d.enabled() ? this.d.canRun() : null;
    const want = !this.d.enabled() ? 'off' : why ? 'paused' : useWake.getState().muted ? 'muted' : this.d.busy() ? 'paused' : 'waiting';
    if (want !== 'waiting') {
      this.mic(false);
      return this.set(want, why ?? undefined);
    }
    this.d.worker().post({ t: 'threshold', value: this.d.threshold() });
    this.mic(true);
    this.set('waiting');
  }

  private mic(on: boolean) {
    if (!on) {
      this.closeMic?.();
      this.closeMic = null;
      return;
    }
    if (this.closeMic || this.opening) return;
    this.opening = true;
    void this.d
      .startMic((pcm) => this.d.worker().post({ t: 'audio', pcm }))
      .then((close) => {
        this.opening = false;
        if (useWake.getState().state !== 'waiting') return close();
        this.closeMic = close;
      })
      .catch((e) => ((this.opening = false), this.set('error', String((e as Error)?.message ?? e))));
  }

  /** The wake word: a chime, the mic handed to Cora's capture. */
  hit(): void {
    if (useWake.getState().state !== 'waiting') return;
    this.mic(false);
    this.d.chime();
    this.set('capturing');
    this.d.listen(false);
  }

  /** A capture finished (sent, cancelled or empty): back to waiting. */
  captureEnded(): void {
    if (this.followTimer) this.d.clearTimer(this.followTimer);
    this.followTimer = null;
    this.set('paused');
    this.d.worker().post({ t: 'reset' });
    this.sync();
  }

  /** A spoken line finished: after Cora's, a follow-up (if that's on and it was a conversation). */
  speechEnded(id: string, sessionId?: string): void {
    if (!this.d.enabled() || !this.d.followUp() || !this.d.isCoraLine(id, sessionId) || useWake.getState().muted || this.d.canRun()) return this.sync();
    this.mic(false);
    this.set('followup');
    this.d.listen(true);
    this.followTimer = this.d.setTimer(() => {
      this.followTimer = null;
      if (useWake.getState().state === 'followup') {
        this.d.stopListen();
        this.captureEnded();
      }
    }, FOLLOW_UP_MS);
  }

  /** You started talking in a follow-up: it's a capture now (no timeout). */
  speaking(): void {
    if (useWake.getState().state !== 'followup') return;
    if (this.followTimer) this.d.clearTimer(this.followTimer);
    this.followTimer = null;
    this.set('capturing');
  }

  stop(): void {
    this.mic(false);
    this.set('off');
  }
}

// ---------------------------------------------------------------- the app's wake word

/** The mic at 16 kHz, as int16 in 80 ms blocks (the wake worker's food). Returns how to close it. */
async function openMic(onPcm: (pcm: Int16Array) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).catch((e) => {
    // said the way push-to-talk says it
    throw new Error(e?.name === 'NotAllowedError' ? 'the microphone is blocked (Windows Settings → Privacy → Microphone)' : `no microphone (${e?.message ?? e})`);
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'ab-pcm');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  let buf: number[] = [];
  node.port.onmessage = (e) => {
    const f = e.data as Float32Array;
    for (let i = 0; i < f.length; i++) buf.push(Math.max(-1, Math.min(1, f[i])) * 0x7fff);
    while (buf.length >= 1280) onPcm(Int16Array.from(buf.splice(0, 1280)));
  };
  return () => {
    node.port.onmessage = null;
    buf = [];
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };
}

/** Two short soft tones: it heard you. */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const g = ctx.createGain();
    g.gain.value = 0.06;
    g.connect(ctx.destination);
    [880, 1320].forEach((hz, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.connect(g);
      o.start(ctx.currentTime + i * 0.08);
      o.stop(ctx.currentTime + i * 0.08 + 0.07);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 500);
  } catch {
    /* no sound: still listening */
  }
}

/** The worker, made the first time it's needed (its models load only when "Hey Cora" is on). */
function lazyWorker(threshold: () => number): WakeWorkerLike {
  let w: Worker | null = null;
  const subs: Array<(m: any) => void> = [];
  return {
    post(m) {
      if (!w) {
        w = new Worker(new URL('./wakeWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e) => subs.forEach((cb) => cb(e.data));
        w.onerror = (e) => subs.forEach((cb) => cb({ t: 'error', message: e.message || 'the wake word stopped' }));
        w.postMessage({ t: 'init', base: import.meta.env.BASE_URL, model: 'hey_cora.onnx', threshold: threshold() });
      }
      if (m && (m as { t: string }).t === 'audio') w.postMessage(m, [(m as { pcm: Int16Array }).pcm.buffer]);
      else w.postMessage(m);
    },
    onMessage(cb) {
      subs.push(cb);
    },
  };
}

/** "Hey Cora", for the app: the controller with the real mic, worker, voice and Cora. Returns how to stop it. */
export function startWake(): () => void {
  const threshold = () => WAKE_THRESHOLDS[useVoice.getState().settings.wakeSensitivity ?? 'balanced'];
  const worker = lazyWorker(threshold);
  const c = new WakeController({
    enabled: () => !!useVoice.getState().settings.wake,
    canRun: () => {
      const v = useVoice.getState();
      if (!v.settings.enabled) return 'Voice is off';
      if (v.key && !v.key.set) return 'Add an ElevenLabs key in Settings → Voice';
      if (v.key?.perms?.stt === false) return "Your ElevenLabs key can't transcribe";
      if (!useOrch.getState().status?.running) return 'Cora is off';
      return null;
    },
    busy: () => voiceLevels.speaking || !!useVoice.getState().reading || useVoice.getState().ptt.phase !== 'idle',
    startMic: openMic,
    worker: () => worker,
    listen: () => {
      const id = agentId();
      if (id) void startListening(id, { hands: true });
    },
    stopListen: () => cancelPtt(),
    isCoraLine: coraLine,
    followUp: () => useVoice.getState().settings.wakeFollowUp !== false,
    chime,
    threshold,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  const unVoice = useVoice.subscribe((st, prev) => {
    const w = useWake.getState().state;
    const phase = st.ptt.phase;
    if (w === 'capturing' || w === 'followup') {
      // you started talking in a follow-up: it's a capture now
      if (w === 'followup' && (st.ptt.text || st.ptt.interim)) c.speaking();
      // the capture is over (sent, cancelled, or left to review)
      const was = prev.ptt.phase;
      if (phase !== was && (phase === 'idle' || phase === 'review') && (was === 'listening' || was === 'finishing')) c.captureEnded();
      return;
    }
    if (st.settings !== prev.settings || phase !== prev.ptt.phase || st.reading !== prev.reading || st.key !== prev.key) c.sync();
  });
  const unOrch = useOrch.subscribe((st, prev) => void (st.status?.running !== prev.status?.running && c.sync()));
  const unWake = useWake.subscribe((st, prev) => void (st.muted !== prev.muted && c.sync()));
  // the quick line said when you spoke isn't Cora's answer: no follow-up listening after it
  const unEnd = onSpeechEnd((id, sid) => (isFrontLine(id) ? c.sync() : c.speechEnded(id, sid)));
  c.sync();
  return () => {
    unVoice();
    unOrch();
    unWake();
    unEnd();
    c.stop();
  };
}
