import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrainEvent, PendingRequest, SessionInfo } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { briefMe, goalLive, isAgent, sayToCora, setCommandOpen, setControl, standDown, useCoraState, useOrch } from '../state/orchestrator';
import { startListening, stopListening, useVoice } from '../lib/voice';
import { ApprovalCard, FollowUpsRow, GoalBar, Talks } from './CoraConsole';
import { CoraSentInline } from './SlackOutbox';
import { JiraAlertsInline, JiraStartCard } from './JiraAlerts';
import { DeployCards } from './Deploys';
import { CoraMark } from './CoraEye';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { sessionColor, shortCwd } from '../lib/format';
import './console.css';
import './cora.css';

const STATE_LINE: Record<string, string> = {
  starting: 'waking up',
  error: 'stopped',
  idle: 'standing by',
  listening: 'listening',
  thinking: 'thinking',
  'needs-you': 'waiting for you',
  autopilot: 'on autopilot',
};

/** The latest exchange: what you said last, Cora's reply to it, and what it did in between. */
function lastExchange(evs: BrainEvent[]): { you?: string; reply?: string; acts: string[] } {
  let you: string | undefined;
  let reply: string | undefined;
  const acts: string[] = [];
  for (const e of evs.slice(-300)) {
    if (e.agentId !== 'main') continue;
    if (e.kind === 'prompt' && !e.queue && e.text) {
      you = e.text;
      reply = undefined;
      acts.length = 0;
    } else if (e.kind === 'say' && e.text?.trim()) reply = e.text;
    else if (e.kind === 'tool' && e.phase === 'start' && e.tool) acts.push(`${e.tool.name.replace(/^mcp__cora__/, '')}${e.tool.summary ? ` · ${e.tool.summary}` : ''}`);
  }
  return { you, reply, acts: acts.slice(-4) };
}

const nameOf = (s: SessionInfo | undefined, id: string) => s?.alias || s?.autoName || s?.title || s?.project || id.slice(0, 8);

/** What a held prompt is about, in a few words. */
function promptWhat(p: PendingRequest): string {
  const i = (p.toolInput ?? {}) as Record<string, unknown>;
  if (p.kind === 'question') return String((i.questions as Array<{ question?: string }> | undefined)?.[0]?.question ?? 'a question');
  const d = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : '';
  return `${p.toolName}${d ? ` · ${d}` : ''}`;
}

const STATE_ORDER: Record<string, number> = { 'needs-you': 0, working: 1, thinking: 1, idle: 2, ended: 3 };

/**
 * Command mode: Cora, full screen. Its lens in the middle with the latest exchange; what needs you on the left; your
 * sessions and its goal on the right; talk or type below. Esc (or a session you pick) takes you back.
 */
export function CoraCommand() {
  const open = useOrch((s) => s.command);
  const status = useOrch((s) => s.status);
  const agent = status?.sessionId ?? null;
  const version = useBrain((s) => (agent ? s.versions[agent] : 0));
  const sessions = useBrain((s) => s.sessions);
  const pending = useBrain((s) => s.pending);
  const setFocus = useBrain((s) => s.setFocus);
  const state = useCoraState();
  const ptt = useVoice((v) => v.ptt);
  const voiceOn = useVoice((v) => v.settings.enabled && !!v.key?.set);
  const listening = (ptt.phase === 'listening' || ptt.phase === 'finishing') && ptt.sessionId === agent;
  const text = useOrch((s) => s.cmdDraft);
  const setText = (t: string) => useOrch.setState({ cmdDraft: t });
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const ex = useMemo(() => (agent ? lastExchange(sessionEvents(agent)) : { acts: [] as string[] }), [agent, version]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => ta.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setCommandOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || !status?.enabled) return null;

  const others = Object.values(sessions).filter((s) => !isAgent(s.id) && s.state !== 'ended' && !(s.dismissedAt != null && s.dismissedAt >= s.lastTs));
  others.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || b.lastTs - a.lastTs);
  const waiting = pending.filter((p) => !isAgent(p.sessionId));
  const go = (sid: string) => {
    setFocus(sid);
    setCommandOpen(false);
  };
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setErr(null);
    setText('');
    const e = await sayToCora(t);
    if (e) (setErr(e), setText(t));
  };
  const progress = status.goal?.progress;

  return (
    <div className={`cora-cmd st-${state}`} role="dialog" aria-label="Cora, command mode">
      <header className="cm-h">
        <b>CORA</b>
        <span className="cm-tag">command</span>
        <span className="spacer" />
        <button className="cm-btn" disabled={!status.running} onClick={() => void briefMe('now').then(setErr)}>
          <Icon name="Sunrise" size={13} /> Brief me
        </button>
        <button className="cm-btn" disabled={!status.running} onClick={() => void briefMe('wrap').then(setErr)}>
          <Icon name="Sunset" size={13} /> Wrap up
        </button>
        <button
          className={`cc-away cm-away${status.control ? ' on' : ''}`}
          role="switch"
          aria-checked={status.control}
          title="Away mode: Cora answers your sessions' permission prompts within its mandate; anything else still waits for you"
          onClick={() => void setControl(!status.control)}
        >
          <i className="cc-knob" /> Away mode
        </button>
        {goalLive(status) ? (
          <button className="cm-btn stand" onClick={() => void standDown()}>
            <Icon name="OctagonX" size={13} /> Stand down
          </button>
        ) : null}
        <button className="cm-btn ghost" title="Back to the dashboard (Esc)" onClick={() => setCommandOpen(false)}>
          <Icon name="Minimize2" size={13} /> Esc
        </button>
      </header>

      <main className="cm-main">
        <section className="cm-col">
          <h3>
            Needs you <span>{status.approvals.length + waiting.length || ''}</span>
          </h3>
          {status.approvals.map((a) => (a.ticket ? <JiraStartCard key={a.id} a={a} inline /> : <ApprovalCard key={a.id} a={a} />))}
          {waiting.map((p) => (
            <button key={p.id} className="cm-row needs" onClick={() => go(p.sessionId)}>
              <Icon name={p.kind === 'question' ? 'MessageCircleQuestion' : 'ShieldAlert'} size={14} />
              <span className="cm-row-t">
                <b>{nameOf(sessions[p.sessionId], p.sessionId)}</b>
                <span>{promptWhat(p)}</span>
              </span>
            </button>
          ))}
          {!status.approvals.length && !waiting.length ? <p className="cm-quiet">Nothing is waiting on you.</p> : null}
        </section>

        <section className="cm-center">
          <div className="cm-lens">
            <div className="cm-rings" aria-hidden>
              <i />
              <i />
              <i />
            </div>
            <CoraMark state={state} size={150} progress={progress} live />
          </div>
          <div className="cm-state">
            {STATE_LINE[state] ?? state}
            {state === 'autopilot' && progress != null ? ` · ${Math.round(progress * 100)}%` : ''}
          </div>
          {ex.you ? <div className="cm-you">{ex.you}</div> : null}
          {ex.acts.length ? (
            <div className="cm-acts">
              {ex.acts.map((a, i) => (
                <span key={i}>
                  <Icon name="Dot" size={12} />
                  {a}
                </span>
              ))}
            </div>
          ) : null}
          <div className="cm-reply">{ex.reply ? <Markdown text={ex.reply} /> : <p className="cm-quiet">Ask me anything about your work, or give me a goal.</p>}</div>
          <JiraAlertsInline />
          <DeployCards inline />
          <CoraSentInline />
        </section>

        <section className="cm-col">
          <h3>Autopilot</h3>
          <GoalBar goal={status.goal} />
          <Talks talks={status.talks ?? []} />
          <FollowUpsRow items={status.followUps ?? []} />
          <h3>
            Sessions <span>{others.length || ''}</span>
          </h3>
          {others.slice(0, 14).map((s) => (
            <button key={s.id} className={`cm-row st-${s.state}`} onClick={() => go(s.id)} title={`${nameOf(s, s.id)}\n${s.cwd}`}>
              <span className={`dl-tile ${s.state === 'needs-you' ? 'need' : s.state === 'working' ? 'work' : s.state === 'thinking' ? 'think' : ''}`} style={{ ['--sc' as any]: sessionColor(s) }}>
                {(nameOf(s, s.id).match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
                <i />
              </span>
              <span className="cm-row-t">
                <b>{nameOf(s, s.id)}</b>
                <span>{shortCwd(s.cwd)}</span>
              </span>
            </button>
          ))}
          {!others.length ? <p className="cm-quiet">No sessions running.</p> : null}
        </section>
      </main>

      <footer className="cm-in">
        {err ? <div className="cc-inerr">{err}</div> : null}
        <div className="cm-input">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={listening ? 'Listening…' : 'Tell Cora what you need…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className={`cc-mic${listening ? ' on' : ''}`} title={voiceOn ? (listening ? 'Stop listening' : 'Talk (or hold Ctrl+Space)') : 'Set up voice in Settings → Voice'} disabled={!voiceOn} onClick={() => (listening ? void stopListening() : agent && void startListening(agent, { hands: true }))}>
            <Icon name={listening ? 'MicOff' : 'Mic'} size={16} />
          </button>
          <button className="cc-send" title="Send (Enter)" disabled={!text.trim()} onClick={() => void send()}>
            <Icon name="ArrowUp" size={16} />
          </button>
        </div>
        <div className="cm-hint">Hold Ctrl+Space to talk · Ctrl+Shift+Enter or Esc to leave</div>
      </footer>
    </div>
  );
}
