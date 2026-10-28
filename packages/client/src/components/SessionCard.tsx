import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shortToolName } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { decide } from '../state/ws';
import { useCi } from '../state/ci';
import { sessionColor, sessionName, prettyModel } from '../lib/format';
import { sessionNow } from '../lib/sessionNow';
import { useSessionVoices, useVoiceList, voiceOf, voicePool, type Voice } from '../lib/sessionVoices';
import { speak, startListening, stopListening, useVoice } from '../lib/voice';
import { wantsTo } from '../lib/asks';
import { openSettings } from './SettingsModal';
import { CoraOrb } from './CoraOrb';
import { useWidth } from './OrbReach';
import { webChangeText } from '@cora/shared';
import { webChangeLink } from '../state/webChanges';
import { useWeb } from '../state/web';
import type { CoraState } from '../state/orchestrator';
import { DebriefAsk } from './DebriefAsk';
import { Icon } from './Icon';
import './sessionCard.css';

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const age = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m` : `${Math.round(ms / 86_400_000)}d`);
/** A cell around the orb: a small label over its value. */
type Cell = { k: string; v: ReactNode; title?: string };
/** A pipeline's status in a word, and its colour. */
const PIPE: Partial<Record<string, [string, string]>> = { success: ['passed', 'ok'], failed: ['failed', 'bad'], running: ['running', 'run'], pending: ['pending', 'run'], created: ['pending', 'run'], preparing: ['pending', 'run'], waiting_for_resource: ['waiting', 'run'], manual: ['manual', 'idle'], canceled: ['canceled', 'idle'], skipped: ['skipped', 'idle'], scheduled: ['scheduled', 'idle'] };
const at = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The session's own card, above its Transcript, Explains and Changes: its orb (Cora's, in the session's colour, with
 * all its moves: thinking, working, waiting on you, speaking in the session's own voice), and around it what it's doing
 * this second, what it's waiting on, what it's saying, and a few things about it. Hold the orb to talk to it.
 */
export function SessionCard({ sessionId }: { sessionId: string }) {
  const s = useBrain((st) => st.sessions[sessionId]);
  const version = useBrain((st) => st.versions[sessionId]);
  // (the store's list as it is: a filtered copy would be new every time and redraw without end)
  const allPending = useBrain((st) => st.pending);
  const pending = useMemo(() => allPending.filter((p) => p.sessionId === sessionId), [allPending, sessionId]);
  const hosted = useBrain((st) => st.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const branch = useCi((c) => c.links[sessionId]?.repo?.branch);
  const pipe = useCi((c) => {
    const l = c.links[sessionId]?.pipelines;
    const k = l?.length ? l.reduce((a, b) => (b.at > a.at ? b : a)).key : null;
    return k ? c.pipelines[k] : undefined;
  });
  const agents = useBrain((st) => Object.values(st.agents).filter((a) => a.sessionId === sessionId && a.agentId !== 'main' && !a.endedAt).length);
  const voice = useVoice((v) => v.settings);
  const reading = useVoice((v) => (v.reading?.sessionId === sessionId && !v.reading.id.startsWith('cora') ? v.reading : null));
  const listening = useVoice((v) => v.ptt.sessionId === sessionId && (v.ptt.phase === 'listening' || v.ptt.phase === 'finishing'));
  const kept = useSessionVoices((v) => v.by);
  const voiceList = useVoiceList((v) => v.list);
  const [voices, setVoices] = useState(false);
  // the voice menu stays while you move about it: it goes on a pick, a click anywhere else, or Esc (as the Board's do)
  const voiceBox = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!voices) return;
    const away = (e: MouseEvent) => !voiceBox.current?.contains(e.target as Node) && setVoices(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setVoices(false));
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [voices]);
  const [, tick] = useState(0);
  const glow = useRef<HTMLDivElement>(null);
  const cardW = useWidth(glow);
  // the clocks move between events
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const now = useMemo(() => sessionNow(sessionEvents(sessionId), s?.model), [sessionId, version, s?.model]); // eslint-disable-line react-hooks/exhaustive-deps
  // its latest change on the web
  const webLast = useMemo(() => sessionEvents(sessionId).findLast((e) => e.kind === 'tool' && e.phase === 'end' && !!e.tool?.web), [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const ask = pending[0];
  const color = sessionColor(s);
  const orbState: CoraState = listening ? 'listening' : ask || s.state === 'needs-you' ? 'needs-you' : s.state === 'thinking' ? 'thinking' : s.state === 'ended' ? 'off' : 'idle';
  const stateWord = listening ? 'listening' : reading ? 'speaking' : ask || s.state === 'needs-you' ? 'needs you' : s.state === 'ended' ? 'ended' : now.doing ? 'working' : s.state === 'thinking' ? 'thinking' : 'idle';
  const stateCls = listening || reading ? 's' : stateWord === 'needs you' ? 'n' : stateWord === 'working' ? 'w' : stateWord === 'thinking' ? 't' : 'i';
  const t = Date.now();
  const line = ask
    ? { text: `${shortToolName(ask.toolName)} ${wantsTo(ask.toolName)}`, time: `waiting ${clock(t - ask.createdAt)}` }
    : now.doing
      ? { text: now.doing.label, time: clock(t - now.doing.since) }
      : s.state === 'thinking'
        ? { text: 'Thinking…', time: '' }
        : s.state === 'ended'
          ? { text: 'Ended', time: at(s.lastTs) }
          : { text: now.restedAt ? `Idle since ${at(now.restedAt)}` : 'Idle', time: '' };
  // its voice: the one you picked on this card, else one from your set (Settings › Voice), else the sessions' one
  const pool = voicePool(voice);
  const open = () => Object.values(useBrain.getState().sessions).filter((x) => x.state !== 'ended').map((x) => x.id);
  const mine = voiceOf(sessionId, voice, kept, open());
  const voiceName = mine?.name || voice.voiceName;
  const picked = !!mine && !mine.auto;
  const pickVoice = (v: Voice | null) => {
    useSessionVoices.getState().set(sessionId, v);
    setVoices(false);
    void speak(`voice-preview:${sessionId}`, `This is ${v?.name ?? 'my voice'}, for ${sessionName(s)}.`, 5000, true, sessionId, { now: true });
  };
  const pm = prettyModel(s.model);
  const talk = voice.enabled ? (on: boolean) => void (on ? startListening(sessionId) : stopListening()) : undefined;
  const command = (ask?.toolInput as { command?: unknown } | undefined)?.command;
  // (its canvas the card's width: Cora reaching it, or it reaching Cora, the arm goes to the card's edge)
  const orb = (size: number) => <CoraOrb state={orbState} size={size} agent={sessionId} color={color} speaking={!!reading} onHold={talk} glow={glow} reach="session" wide={size > 40 ? cardW : undefined} />;

  // around its orb, what it is: where (branch, ticket, pipeline) on the left, how (context, model, its turn) on the right
  const pipeWord = pipe ? (PIPE[pipe.status] ?? pipe.status) : null;
  const left = ([
    branch ? { k: 'branch', v: branch } : null,
    s.ticket ? { k: 'ticket', v: s.ticket.key, title: s.ticket.summary ?? undefined } : s.issue ? { k: 'issue', v: `#${s.issue.iid}` } : null,
    pipe && pipeWord ? { k: 'pipeline', v: <><i className={`sc-dot ${pipeWord[1]}`} />{pipeWord[0]}</>, title: pipe.url } : null,
    !hosted && s.state !== 'ended' ? { k: 'runs in', v: 'another terminal' } : null,
  ] as (Cell | null)[]).filter((c): c is Cell => !!c);
  const ctxCls = now.ctx ? (now.ctx.share < 0.6 ? 'ok' : now.ctx.share < 0.8 ? 'mid' : 'hi') : '';
  const right = ([
    now.ctx
      ? {
          k: 'context',
          v: (
            <>
              {Math.round(now.ctx.share * 100)}%<span className={`sc-bar ${ctxCls}`}><i style={{ width: `${now.ctx.share * 100}%` }} /></span>
            </>
          ),
          title: `Context: ${Math.round(now.ctx.used / 1000)}k of ${Math.round(now.ctx.max / 1000)}k tokens`,
        }
      : null,
    pm ? { k: 'model', v: pm.name } : null,
    now.turn ? { k: now.turn.until ? 'last turn' : 'turn', v: clock((now.turn.until ?? t) - now.turn.since), title: `Since your prompt at ${at(now.turn.since)}` } : null,
  ] as (Cell | null)[]).filter((c): c is Cell => !!c);
  // one side empty and the other with a few: share them, so the orb stays in the middle of something
  if (!left.length !== !right.length && left.length + right.length > 1) {
    const all = [...left, ...right];
    left.splice(0, left.length, ...all.slice(0, Math.ceil(all.length / 2)));
    right.splice(0, right.length, ...all.slice(Math.ceil(all.length / 2)));
  }
  // under it, how far it has come: what it changed, and for how long it's been going
  const ch = now.changed;
  const webLink = webLast ? webChangeLink(webLast) : null;
  const foot = ([
    { k: 'changed', v: ch.files ? `${ch.files} file${ch.files === 1 ? '' : 's'}` : 'nothing yet' },
    ch.files ? { k: 'lines', v: <><span className="add">+{ch.add}</span> <span className="del">−{ch.del}</span></> } : null,
    agents ? { k: 'agents', v: `${agents} at work` } : null,
    webLast && t - webLast.ts < 30 * 60_000
      ? {
          k: 'on the web',
          v: (
            <button className="sc-web" disabled={!webLink} title={webLink ?? undefined} onClick={() => webLink && (useWeb.getState().open(sessionId, webLink, { reload: true }), useWeb.getState().setShown(sessionId, true))}>
              {webChangeText(webLast.tool!.web!)}
            </button>
          ),
        }
      : null,
    { k: 'up', v: age(t - s.startedAt) },
    // it changed something: it can walk you through it (Quick or Teach me), in the IDE panel
    ch.files && hosted && s.state !== 'ended' ? { k: 'debrief', v: <DebriefAsk sessionId={sessionId} inline /> } : null,
  ] as (Cell | null)[]).filter((c): c is Cell => !!c);
  const cells = (cs: Cell[], cls: string) => (
    <div className={`sc-cells ${cls}`}>
      {cs.map((c) => (
        <span className="sc-cell" key={c.k} title={c.title}>
          <small>{c.k}</small>
          <span className="v">{c.v}</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="scard" ref={glow} style={{ ['--sc' as string]: color }}>
      {voice.enabled ? (
        <span className="sc-vw" ref={voiceBox}>
          <button
            className={`sc-ib sc-voice${voices ? ' on' : ''}${picked ? ' own' : ''}`}
            title={`Its voice: ${voiceName}${picked ? '' : mine ? ' (given from your set)' : " (the sessions' voice)"}. Change it`}
            onClick={() => (voices ? setVoices(false) : (useVoiceList.getState().load(), setVoices(true)))}
          >
            <Icon name="AudioLines" size={13} />
          </button>
          {voices ? (
            <span className="sc-vmenu">
              {/* automatic: from your set (the least in use), or the sessions' voice */}
              <button className={picked ? '' : 'on'} onClick={() => pickVoice(null)} title={pool.length ? 'A voice from your set in Settings › Voice' : "The sessions' voice (Settings › Voice)"}>
                <span>
                  Automatic <small>{picked ? (pool.length ? 'from your set' : voice.voiceName) : voiceName}</small>
                </span>
                {picked ? null : <Icon name="Check" size={12} />}
              </button>
              {(() => {
                const all = voiceList ?? pool;
                const row = (o: Voice) => (
                  <button key={o.id} className={picked && o.id === mine?.id ? 'on' : ''} onClick={() => pickVoice(o)}>
                    {o.name}
                    {picked && o.id === mine?.id ? <Icon name="Check" size={12} /> : null}
                  </button>
                );
                const inSet = pool.filter((p) => p.id !== voice.coraVoiceId);
                const rest = all.filter((o) => o.id !== voice.coraVoiceId && !pool.some((p) => p.id === o.id));
                return (
                  <>
                    {inSet.length ? <span className="head">Your set</span> : null}
                    {inSet.map(row)}
                    <span className="head">{inSet.length ? 'All voices' : 'Your voices'}</span>
                    {voiceList == null ? <span className="note">Loading…</span> : rest.map(row)}
                  </>
                );
              })()}
            </span>
          ) : null}
        </span>
      ) : null}
      <div className="sc-top">
        {cells(left, 'l')}
        <div className="sc-orb" title={talk ? 'Hold to talk to this session' : undefined}>
          {orb(84)}
        </div>
        {cells(right, 'r')}
      </div>
      <b className="sc-name" title={sessionName(s)}>
        {sessionName(s)}
      </b>
      <span className={`sc-st ${stateCls}`}>
        {stateWord}
        {line.time && (now.doing || ask) ? <em>{ask ? clock(t - ask.createdAt) : line.time}</em> : null}
      </span>
      {/* waiting on you: what it wants, and your answer (the rest of its words are in the transcript below) */}
      {ask ? (
        <div className="sc-ask">
          <span className="q">{typeof command === 'string' ? <code>{command.slice(0, 160)}</code> : line.text}</span>
          {ask.kind === 'permission' ? (
            <span className="sc-yn">
              <button className="sc-no" onClick={() => void decide(ask.id, { decision: 'deny' })}>
                Deny
              </button>
              <button className="sc-ok" onClick={() => void decide(ask.id, { decision: 'allow' })}>
                Allow
              </button>
            </span>
          ) : null}
        </div>
      ) : (
        cells(foot, 'f')
      )}
    </div>
  );
}
