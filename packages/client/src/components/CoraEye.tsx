import { setWakeMuted, useWake } from '../lib/wake/controller';
import { useWorktrees } from '../state/worktrees';
import { useCoraLinksDriver, useReachHalo, useWidth } from './OrbReach';
import { useEffect, useMemo, useRef, useState } from 'react';
import { briefMe, setConsoleOpen, useCoraState, useOrch, type CoraState } from '../state/orchestrator';
import { sessionEvents, useBrain } from '../state/store';
import { coraReading, startListening, stopListening, useVoice, voiceLevels } from '../lib/voice';
import { isDismissed } from '../lib/format';
import { sortedSessions } from '../lib/sessionOrder';
import { openSettings } from './SettingsModal';
import { Icon } from './Icon';
import { CoraOrb } from './CoraOrb';
import './cora.css';

const LABEL: Record<CoraState, string> = {
  off: '',
  starting: 'waking up…',
  error: 'stopped',
  idle: 'standing by',
  listening: 'listening…',
  thinking: 'thinking…',
  'needs-you': 'waiting for you',
  autopilot: 'autopilot',
};

/** Cora's voice right now: what it hears while you talk, what it says while it speaks (0..1), or null when quiet. */
const level = (listening: boolean) => (listening ? Math.min(1, voiceLevels.listen * 1.6) : voiceLevels.speaking ? Math.min(1, voiceLevels.speak * 1.4) : null);

/** Follows Cora's voice frame by frame while `on`: calls `f` with the level (0 when it stops). */
function useVoiceFrames(on: boolean, listening: boolean, f: (lvl: number) => void) {
  const fn = useRef(f);
  fn.current = f;
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const tick = () => {
      fn.current(level(listening) ?? 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => (cancelAnimationFrame(raf), fn.current(0));
  }, [on, listening]);
}

/**
 * The lens: a brushed-metal bezel around dark glass with a glowing iris. Its colour, breath and ring say what Cora is
 * doing; the iris swells with your voice while it listens and with its own while it speaks.
 */
export function CoraLens({ state, size = 28, progress }: { state: CoraState; size?: number; progress?: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const speaking = useVoice((v) => coraReading(v.reading));
  const listening = state === 'listening';
  useVoiceFrames(listening || speaking, listening, (l) => el.current?.style.setProperty('--lvl', l.toFixed(3)));
  return (
    <span ref={el} className={`cora-lens st-${state}${speaking ? ' speaking' : ''}`} style={{ width: size, height: size, ['--p' as any]: Math.round((progress ?? 0) * 100) }} aria-hidden>
      {state === 'autopilot' ? <span className="cl-progress" /> : null}
      <span className="cl-glass" />
      <span className="cl-ring" />
      <span className="cl-iris" />
      <span className="cl-glint" />
    </span>
  );
}

const BARS = [0.55, 0.85, 1, 0.75, 0.5];

/**
 * Cora's eye wherever else it shows: the orb or the lens, as set in Settings › Scene. `live`: the live orb (command
 * mode's centrepiece); otherwise a still one (the console's header and its empty page), a glowing sphere in Cora's
 * colour that only breathes while it thinks and goes red while it needs you: no graphics engine for an icon.
 */
export function CoraMark({ state, size, progress, live }: { state: CoraState; size: number; progress?: number; live?: boolean }) {
  const orb = useBrain((s) => s.prefs.coraEye !== 'lens');
  const agent = useOrch((s) => s.status?.sessionId ?? null);
  if (!orb) return <CoraLens state={state} size={size} progress={progress} />;
  if (live) return <CoraOrb state={state} size={size} agent={agent} progress={progress} />;
  return <span className={`orb-glyph st-${state}`} style={{ width: size, height: size }} aria-hidden />;
}

/** A small meter of Cora's voice: while you talk to it, and while it speaks. */
function Wave({ listening }: { listening: boolean }) {
  const speaking = useVoice((v) => coraReading(v.reading));
  const on = listening || speaking;
  const bars = useRef<Array<HTMLElement | null>>([]);
  const t = useRef(0);
  useVoiceFrames(on, listening, (l) => {
    t.current += 1;
    bars.current.forEach((b, i) => {
      if (!b) return;
      const wobble = 0.65 + 0.35 * Math.sin(t.current / 4 + i * 1.7);
      b.style.height = `${Math.round(3 + l * 13 * BARS[i] * wobble)}px`;
    });
  });
  return (
    <span className={`ce-wave${on ? ' on' : ''}`} aria-hidden>
      {BARS.map((_, i) => (
        <i key={i} ref={(x) => void (bars.current[i] = x)} />
      ))}
    </span>
  );
}

/** Cora's words stay on its card this long, then clear. */
export const WORDS_MS = 90_000;

/** Cora's latest words (its last reply, flattened and clipped), for the bridge; null once they're WORDS_MS old. */
function useLatest(agent: string | null): string | null {
  const version = useBrain((s) => (agent ? s.versions[agent] : 0));
  const latest = useMemo(() => {
    if (!agent) return null;
    const evs = sessionEvents(agent);
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.agentId !== 'main' || e.kind !== 'say' || !e.text?.trim()) continue;
      const t = e.text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      return { text: t.length > 180 ? `${t.slice(0, 179)}…` : t, ts: e.ts };
    }
    return null;
  }, [agent, version]);
  // cleared when they're old: a re-render at that moment
  const [, setTick] = useState(0);
  const left = latest ? latest.ts + WORDS_MS - Date.now() : 0;
  useEffect(() => {
    if (!latest || left <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [latest, left > 0]);
  return latest && left > 0 ? latest.text : null;
}

const ORBIT_MAX = 12;
const DOT_STATE: Record<string, string> = { 'needs-you': 'n', working: 'w', thinking: 'w', idle: 'i' };

/** Your sessions, as dots circling the lens: green working, red waiting for you, grey idle. Click one to go to it. */
function Orbit() {
  const sessions = useBrain((s) => s.sessions);
  const setFocus = useBrain((s) => s.setFocus);
  const agent = useOrch((s) => s.status?.sessionId ?? null);
  const live = sortedSessions(sessions).filter((x) => x.id !== agent && x.state !== 'ended' && !isDismissed(x)).slice(0, ORBIT_MAX);
  return (
    <span className="cb-dots">
      {live.map((x, i) => (
        <button
          key={x.id}
          className={`cb-dot ${DOT_STATE[x.state] ?? 'i'}`}
          style={{ ['--a' as any]: `${-90 + (360 / Math.max(live.length, 1)) * i}deg` }}
          title={`${x.alias || x.autoName || x.title || x.project}: ${x.state === 'needs-you' ? 'needs you' : x.state}`}
          onClick={(e) => (e.stopPropagation(), setFocus(x.id))}
        />
      ))}
    </span>
  );
}

/**
 * Cora's bridge at the top of the left nav: its lens with your sessions circling it, what it's doing and its latest
 * words, and Talk, Brief and Goal. The lens (or the words) open its console. Collapsible to one row; off, it's one
 * "offline" row that takes you to its settings.
 */
export function CoraEye() {
  const enabled = useOrch((s) => !!s.status?.enabled);
  const open = useOrch((s) => s.open);
  const agent = useOrch((s) => (s.status?.enabled ? (s.status.sessionId ?? null) : null));
  const approvals = useOrch((s) => s.status?.approvals.length ?? 0);
  const goal = useOrch((s) => s.status?.goal ?? null);
  const control = useOrch((s) => !!s.status?.control);
  const running = useOrch((s) => !!s.status?.running);
  const state = useCoraState();
  const latest = useLatest(agent);
  const ptt = useVoice((v) => v.ptt);
  const voiceOn = useVoice((v) => v.settings.enabled && !!v.key?.set);
  const wakeOn = useVoice((v) => !!v.settings.wake);
  // its eye: a main agent's orb, or the lens (Settings › Scene; either way, with the 3D scene on or off)
  const orb = useBrain((s) => s.prefs.coraEye !== 'lens');
  const [err, setErr] = useState<string | null>(null);
  // hold the orb to talk to Cora (the click that ends the hold doesn't open the console)
  const held = useRef(false);
  // the card, for the orb's light on it
  const card = useRef<HTMLDivElement>(null);
  const holdTalk = (on: boolean) => {
    if (on) {
      if (!agent || !voiceOn) return;
      held.current = true;
      void startListening(agent);
    } else void stopListening();
  };

  // who Cora is reaching, and who's reaching it (its arm through the cards; a ring of a session's colour)
  useCoraLinksDriver();
  const cardW = useWidth(card);
  const halo = useReachHalo();
  const doneTrees = useWorktrees((w) => (w.repos ?? []).reduce((n, r) => n + r.trees.filter((t) => t.state === 'done').length, 0));

  if (!enabled)
    return (
      <button className="cora-bridge off small" onClick={() => openSettings('orchestrator')} title="The Cora Orchestrator is off: turn it on in Settings">
        <CoraLens state="off" size={26} />
        <b>CORA</b>
        <span className="cb-off">offline</span>
        <span className="cb-on">Turn on</span>
      </button>
    );

  const listening = (ptt.phase === 'listening' || ptt.phase === 'finishing') && !!agent && ptt.sessionId === agent;
  const label =
    state === 'needs-you' && approvals
      ? `${approvals} waiting for you`
      : state === 'needs-you' && goal?.state === 'blocked'
        ? 'blocked'
        : state === 'autopilot'
          ? `autopilot${goal?.progress != null ? ` · ${Math.round(goal.progress * 100)}%` : ''}`
          : control && state === 'idle'
            ? 'away mode'
            : LABEL[state];
  const toggle = () => setConsoleOpen(!open);
  const talk = () => {
    if (listening) return void stopListening();
    if (!agent) return;
    void startListening(agent, { hands: true });
  };


  return (
    <div ref={card} className={`cora-bridge st-${state}${open ? ' on' : ''}${orb ? ' orb-mode' : ''}`}>
      {orb ? (
        // with the orb: Brief and Goal in the corner, shown as you come near (holding the orb talks)
        <div className="cb-corner">
          <button className="cb-ib" disabled={!running} title="Brief me: what needs me, what happened" onClick={() => void briefMe('now').then((e) => (setErr(e), e ? undefined : setConsoleOpen(true)))}>
            <Icon name="Sunrise" size={13} />
          </button>
          <button className="cb-ib" title={goal && ['running', 'waiting', 'blocked'].includes(goal.state) ? "Cora's goal" : 'Give Cora a goal'} onClick={() => (useOrch.setState({ composeGoal: !(goal && ['running', 'waiting', 'blocked'].includes(goal.state)) }), setConsoleOpen(true))}>
            <Icon name="Rocket" size={13} />
          </button>
        </div>
      ) : null}
      <div className="cb-orbit" style={halo ? ({ ['--reach' as string]: halo } as React.CSSProperties) : undefined}>
        {orb && halo ? <span className="cb-reach" /> : null}
        <button className="cb-lens" onClick={() => (held.current ? (held.current = false) : toggle())} title={orb ? 'Cora: open its console (hold it, or Ctrl+Space, to talk)' : 'Cora: open its console (hold Ctrl+Space to talk)'}>
          {orb ? <CoraOrb state={state} size={104} agent={agent} away={control} onHold={holdTalk} glow={card} reach="cora" wide={cardW} master /> : <CoraLens state={state} size={64} progress={goal?.progress} />}
        </button>
        <Orbit />
        {/* with the orb: a goal's progress along the sessions' ring, out of the orb's way */}
        {orb && state === 'autopilot' && goal?.progress != null ? (
          <svg className="cb-progress" viewBox="0 0 100 100" aria-label={`Goal ${Math.round(goal.progress * 100)}% done`}>
            <title>{`Autopilot: the goal is about ${Math.round(goal.progress * 100)}% done`}</title>
            <circle cx="50" cy="50" r="48" pathLength={100} strokeDasharray={`${Math.round(goal.progress * 100)} 100`} />
          </svg>
        ) : null}
      </div>
      <button className="cb-t" onClick={toggle} title="Open Cora's console">
        <span className="cb-name">
          <b>CORA</b>
          <WakeGlyph />
          <Wave listening={state === 'listening'} />
          {approvals ? <span className="cb-badge">{approvals}</span> : null}
        </span>
        <span className="ce-st">{label}</span>
        {/* its words (or yours as it hears them): a three-line space under a hairline, centred; they clear after a while */}
        {listening ? (
          // what you're saying to Cora, as it hears it
          <span className="cb-words cb-heard">
            <span>
              {ptt.text || ptt.interim ? (
                <>
                  {ptt.text} <span className="interim">{ptt.interim}</span>
                </>
              ) : (
                <span className="interim">{ptt.phase === 'finishing' ? 'Sending…' : 'Listening…'}</span>
              )}
            </span>
          </span>
        ) : (
          <span className={`cb-words${err ?? latest ? '' : ' empty'}`}>
            <span key={err ?? latest ?? ''}>{err ?? latest ?? (!running ? 'Waking up…' : voiceOn ? (wakeOn ? 'Say "Hey Cora", or press Talk.' : 'Press Talk, or ask me anything.') : 'Ask me what your sessions are doing.')}</span>
          </span>
        )}
      </button>
      <div className="cb-acts">
        <button className={`cb-chip${listening ? ' on' : ''}`} disabled={!voiceOn || !agent} title={voiceOn ? 'Talk to Cora (or hold Ctrl+Space)' : 'Set up voice in Settings → Voice'} onClick={talk}>
          <Icon name={listening ? 'MicOff' : 'Mic'} size={12} /> {listening ? 'Stop' : 'Talk'}
        </button>
        <button className="cb-chip" disabled={!running} title="Brief me: what needs me, what happened" onClick={() => void briefMe('now').then((e) => (setErr(e), e ? undefined : setConsoleOpen(true)))}>
          <Icon name="Sunrise" size={12} /> Brief
        </button>
        <button className="cb-chip" title={goal && ['running', 'waiting', 'blocked'].includes(goal.state) ? "Cora's goal" : 'Give Cora a goal'} onClick={() => (useOrch.setState({ composeGoal: !(goal && ['running', 'waiting', 'blocked'].includes(goal.state)) }), setConsoleOpen(true))}>
          <Icon name="Rocket" size={12} /> Goal
        </button>
      </div>
      {doneTrees ? (
        // worktrees whose work is merged and that nobody uses: to Cora's board, where they're cleaned up
        <button className="cb-nudge" onClick={() => (useBrain.getState().setPrefs({ overviewStyle: 'grid' }), useBrain.getState().toggleOverview(true))} title="Merged, clean, nobody in them: clean them up on Cora's board">
          <i />
          {doneTrees} worktree{doneTrees === 1 ? '' : 's'} done
          <u>Clean up</u>
        </button>
      ) : null}
    </div>
  );
}

/** "Hey Cora" on Cora's card: listening for it (click to mute), muted, or waiting while something else is on. */
function WakeGlyph() {
  const on = useVoice((s) => !!s.settings.wake);
  const { state, muted } = useWake();
  if (!on || state === 'off') return null;
  const live = state === 'waiting';
  const title = muted ? 'Not listening for "Hey Cora": click to listen' : live ? 'Listening for "Hey Cora": click to mute' : '"Hey Cora" waits while something else is listening or speaking';
  return (
    <span
      role="button"
      tabIndex={0}
      className={`cb-wake${muted ? ' muted' : live ? ' live' : ''}`}
      title={title}
      onClick={(e) => (e.stopPropagation(), setWakeMuted(!muted))}
      onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), setWakeMuted(!muted))}
    >
      <Icon name={muted ? 'MicOff' : 'Mic'} size={11} />
    </span>
  );
}
