import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Approval, BrainEvent, Goal } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { composerInbox } from '../state/composer';
import { briefMe, newCora, coraKey, decideApproval, endTalk, goalLive, restartCora, sayToCora, setCommandOpen, setConsoleOpen, setControl, standDown, startGoal, stopGoal, useCoraState, useOrch } from '../state/orchestrator';
import { useBrain as useBrainStore } from '../state/store';
import { speak, startListening, stopListening, useVoice } from '../lib/voice';
import { voiceCues } from '../lib/voiceAuto';
import { openSettings } from './SettingsModal';
import { desktop } from '../lib/desktop';
import { Markdown } from './Markdown';
import { CoraLens } from './CoraEye';
import { Icon } from './Icon';
import { CoraSentInline } from './SlackOutbox';
import { JiraAlertsInline, JiraStartCard } from './JiraAlerts';
import { DeployCards } from './Deploys';
import { NeedsYou } from './NeedsYou';
import './cora.css';
import './console.css';

const KIND_ICON: Record<Approval['kind'], string> = { start: 'Play', send: 'SendHorizontal', end: 'Square', ask: 'CircleHelp' };

/** The conversation from the agent's events: your prompts, its replies, and what it did in between. */
type Line = { id: string; kind: 'you' | 'cora' | 'act'; text: string; failed?: boolean };
function linesOf(evs: BrainEvent[]): Line[] {
  const out: Line[] = [];
  for (const e of evs.slice(-400)) {
    if (e.agentId !== 'main') continue;
    if (e.kind === 'prompt' && !e.queue && e.text) out.push({ id: e.id, kind: 'you', text: e.text });
    else if (e.kind === 'say' && e.text?.trim()) out.push({ id: e.id, kind: 'cora', text: e.text });
    else if (e.kind === 'tool' && e.phase === 'start' && e.tool) out.push({ id: e.id, kind: 'act', text: `${e.tool.name.replace(/^mcp__cora__/, '')}${e.tool.summary ? ` · ${e.tool.summary}` : ''}` });
    else if (e.kind === 'tool' && e.phase === 'end' && e.tool?.failed) out.push({ id: e.id, kind: 'act', text: `${e.tool.name.replace(/^mcp__cora__/, '')} failed`, failed: true });
  }
  return out.slice(-160);
}

/**
 * The Cora console: talk to Cora (type, or hold the mic), see what it did, and answer what it asks before it acts.
 * It opens over the scene from the left nav; its conversation is Cora's own session (kept out of the session list).
 */
export function CoraConsole() {
  const status = useOrch((s) => s.status);
  const open = useOrch((s) => s.open);
  const agent = status?.sessionId ?? null;
  const version = useBrain((s) => (agent ? s.versions[agent] : 0));
  const state = useCoraState();
  const ptt = useVoice((v) => v.ptt);
  const voiceOn = useVoice((v) => v.settings.enabled && !!v.key?.set);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // autopilot: the Goal button (or, while a goal runs, its pill) opens the goal card over the conversation
  const [goalOpen, setGoalOpen] = useState(false);
  const wantGoal = useOrch((s) => s.composeGoal);
  useEffect(() => {
    if (wantGoal) setGoalOpen(true);
  }, [wantGoal]);
  const body = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const lines = useMemo(() => (agent ? linesOf(sessionEvents(agent)) : []), [agent, version]);
  const listening = (ptt.phase === 'listening' || ptt.phase === 'finishing') && ptt.sessionId === agent;

  // newest at the bottom
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, open, status?.approvals.length]);

  // what you said by voice comes here to review (or goes straight to Cora, as your voice settings say)
  useEffect(() => {
    if (!agent) return;
    const take = (words: string) => {
      if (useOrch.getState().command) {
        useOrch.setState((s) => ({ cmdDraft: s.cmdDraft.trim() ? `${s.cmdDraft.replace(/\s+$/, '')} ${words}` : words }));
        return;
      }
      setConsoleOpen(true);
      setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')} ${words}` : words));
      requestAnimationFrame(() => ta.current?.focus());
    };
    composerInbox.set(agent, take);
    return () => void (composerInbox.get(agent) === take && composerInbox.delete(agent));
  }, [agent]);

  // its replies' spoken lines, said aloud (only what it says from now on)
  const since = useRef(Date.now());
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!agent) return;
    const cues = voiceCues(sessionEvents(agent), since.current, seen.current);
    if (!status?.speak || !voiceOn) return;
    for (const c of cues) if (c.kind === 'said') void speak(`cora:${c.id}`, c.text, 600, true);
  }, [agent, version]);

  // Ctrl+Space: talk to Cora (hold, then let go), from anywhere in the app
  useEffect(() => {
    if (!agent || !status?.enabled) return;
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || held) return;
      held = true;
      // Cora listens where it is (its card shows your words); the console isn't opened for it
      void startListening(agent);
    };
    const up = (e: KeyboardEvent) => {
      if (!held || (e.code !== 'Space' && e.key !== 'Control')) return;
      held = false;
      e.preventDefault();
      void stopListening();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [agent, status?.enabled]);

  // Ctrl+Alt+Space from anywhere (the desktop app): Cora comes up and listens; again to stop
  useEffect(() => {
    if (!agent || !status?.enabled || !desktop?.setCoraHotkey) return;
    desktop.setCoraHotkey(true);
    const off = desktop.onCoraPtt?.(() => {
      const p = useVoice.getState().ptt;
      if ((p.phase === 'listening' || p.phase === 'finishing') && p.sessionId === agent) void stopListening();
      else void startListening(agent, { hands: true });
    });
    return () => {
      off?.();
      desktop?.setCoraHotkey?.(false);
    };
  }, [agent, status?.enabled]);

  // Ctrl+Shift+Enter: command mode (Cora, full screen), and back
  useEffect(() => {
    if (!status?.enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.ctrlKey || !e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setCommandOpen(!useOrch.getState().command);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [status?.enabled]);

  // Ctrl+Alt+Backspace: stand down (from anywhere in the app; the desktop app also listens globally)
  useEffect(() => {
    if (!status?.enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' || !e.ctrlKey || !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      void standDown();
    };
    window.addEventListener('keydown', onKey, true);
    const off = desktop?.onCoraStandDown?.(() => void standDown());
    return () => {
      window.removeEventListener('keydown', onKey, true);
      off?.();
    };
  }, [status?.enabled]);

  // Esc closes it (not while typing in it)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || useOrch.getState().command || useBrain.getState().inbox) return;
      if ((e.target as HTMLElement | null)?.closest?.('.cora-console textarea')) return;
      setConsoleOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    if (open) requestAnimationFrame(() => ta.current?.focus());
  }, [open]);
  // Ask Cora (from the Inbox): the item in the box, the cursor after it for your question
  const prefill = useOrch((s) => s.prefill);
  useEffect(() => {
    if (prefill == null) return;
    setText(prefill);
    useOrch.setState({ prefill: null });
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(prefill.length, prefill.length);
      if (ta.current) ta.current.scrollTop = ta.current.scrollHeight;
    });
  }, [prefill]);

  if (!status?.enabled) return null;

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setErr(null);
    setText('');
    const e = await sayToCora(t);
    if (e) {
      setErr(e);
      setText(t);
    }
  };
  const mic = () => (listening ? void stopListening() : agent && void startListening(agent, { hands: true }));

  return (
    <div className={`cora-console${open ? ' on' : ''}`} aria-hidden={!open}>
      <div className="cc-h">
        <CoraLens state={state} size={22} />
        <b>CORA</b>
        <span className="cc-st">{status.error ? 'stopped' : state === 'thinking' ? 'thinking…' : state === 'listening' ? 'listening…' : state === 'starting' ? 'waking up…' : status.model}</span>
        <span className="spacer" />
        <GoalPill goal={status.goal} open={goalOpen} onToggle={() => setGoalOpen(!goalOpen)} />
        <button
          className={`cc-away${status.control ? ' on' : ''}`}
          role="switch"
          aria-checked={status.control}
          title={status.control ? "Away mode is on: Cora answers your sessions' permission prompts within its mandate (anything else still waits for you). Click to turn it off." : "Away mode: while you're away, Cora answers your sessions' permission prompts within its mandate; anything else still waits for you."}
          onClick={() => void setControl(!status.control)}
        >
          <i className="cc-knob" /> Away
        </button>
        {goalLive(status) ? (
          <button className="cc-stand" title="Stand down: stop the goal, turn away mode off, stop Cora (Ctrl+Alt+Backspace)" onClick={() => void standDown()}>
            <Icon name="OctagonX" size={12} /> Stand down
          </button>
        ) : null}
        <button className="icon-btn" title="Command mode: Cora, full screen (Ctrl+Shift+Enter)" onClick={() => setCommandOpen(true)}>
          <Icon name="Maximize2" size={13} />
        </button>
        <span className="cc-more">
          <button className={`icon-btn${menu ? ' on' : ''}`} title="More" onClick={() => setMenu(!menu)}>
            <Icon name="Ellipsis" size={15} />
          </button>
          {menu ? (
            <span className="cc-menu" onMouseLeave={() => setMenu(false)}>
              <button disabled={!status.running} onClick={() => (setMenu(false), void briefMe('now').then((e) => setErr(e)))}>
                <Icon name="Sunrise" size={14} /> Brief me <span className="cc-mk">what changed</span>
              </button>
              <button disabled={!status.running} onClick={() => (setMenu(false), void briefMe('wrap').then((e) => setErr(e)))}>
                <Icon name="Sunset" size={14} /> Wrap up <span className="cc-mk">today</span>
              </button>
              <i />
              <button
                disabled={!status.enabled}
                onClick={() => {
                  setMenu(false);
                  if (window.confirm('Start a new conversation with Cora? It keeps what it remembers, your instructions, its goals and the Slack threads it watches.')) void newCora().then((e) => setErr(e));
                }}
              >
                <Icon name="MessageSquarePlus" size={14} /> New conversation <span className="cc-mk">fresh start</span>
              </button>
              <button onClick={() => (setMenu(false), openSettings('orchestrator'))}>
                <Icon name="Settings2" size={14} /> Cora's settings
              </button>
            </span>
          ) : null}
        </span>
        <button className="icon-btn" title="Close (Esc)" onClick={() => setConsoleOpen(false)}>
          <Icon name="X" size={14} />
        </button>
      </div>
      {status.error ? (
        <div className="cc-err">
          <Icon name="TriangleAlert" size={13} /> <span>{status.error}</span>
          <button className="btn" onClick={() => void restartCora()}>
            Start again
          </button>
        </div>
      ) : null}
      <GoalLine goal={status.goal} onOpen={() => setGoalOpen(true)} />
      {goalOpen ? <GoalPop goal={status.goal} onClose={() => setGoalOpen(false)} /> : null}
      <Talks talks={status.talks ?? []} />
      <div className="cc-body" ref={body}>
        {!lines.length ? (
          <div className="cc-empty">
            <CoraLens state={state} size={64} />
            <p>
              Ask me what your sessions are doing, to start one on a ticket, to show you something, or to tell a session what to do next. I'll ask before I act.
            </p>
            <p className="dim">Type below, or hold Ctrl+Space and talk.</p>
          </div>
        ) : (
          lines.map((l, i) =>
            l.kind === 'you' ? (
              <div key={l.id} className="cc-you">
                <span className="cc-l">you</span>
                {l.text}
              </div>
            ) : (
              <Fragment key={l.id}>
                {/* Cora's turn opens with its head, like a step in the transcript */}
                {i === 0 || lines[i - 1].kind === 'you' ? (
                  <div className="cc-sh">
                    <i />
                    CORA
                    <span className="cc-rule" />
                  </div>
                ) : null}
                {l.kind === 'cora' ? (
                  <div className="cc-cora">
                    <Markdown text={l.text} />
                  </div>
                ) : (
                  <div className={`cc-act${l.failed ? ' failed' : ''}`}>
                    <Icon name={l.failed ? 'TriangleAlert' : 'CornerDownRight'} size={12} />
                    <span>{l.text}</span>
                  </div>
                )}
              </Fragment>
            ),
          )
        )}
        {state === 'thinking' ? (
          <div className="cc-think">
            <span className="cc-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : null}
      </div>
      <JiraAlertsInline />
      <DeployCards inline />
          <CoraSentInline />
      {/* its own permission prompts, answered here (audit B8): Cora's card says "answer it in Cora's console" */}
      {agent ? (
        <div className="cc-needs">
          <NeedsYou sessionId={agent} />
        </div>
      ) : null}
      {status.asking?.length ? <Asking lines={status.asking} /> : null}
      {status.approvals.length ? (
        <div className="cc-approvals">
          {status.approvals.map((a) => (a.ticket ? <JiraStartCard key={a.id} a={a} inline /> : <ApprovalCard key={a.id} a={a} />))}
        </div>
      ) : null}
      <div className="cc-in">
        {err ? <div className="cc-inerr">{err}</div> : null}
        {listening ? (
          <div className="cc-heard" role="status">
            <span className="cc-heard-to">
              <Icon name="Mic" size={12} /> To Cora
            </span>
            <span className="cc-heard-t">
              {ptt.text || ptt.interim ? (
                <>
                  {ptt.text} <span className="interim">{ptt.interim}</span>
                </>
              ) : (
                <span className="interim">{ptt.phase === 'finishing' ? 'Sending…' : 'Listening…'}</span>
              )}
            </span>
          </div>
        ) : null}
        <div className="cc-row">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={listening ? 'Listening…' : 'Talk to Cora…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === 'Escape') setConsoleOpen(false);
            }}
          />
          <button className={`cc-mic${listening ? ' on' : ''}`} title={voiceOn ? (listening ? 'Stop listening' : 'Talk (or hold Ctrl+Space)') : 'Set up voice in Settings → Voice'} disabled={!voiceOn} onClick={mic}>
            <Icon name={listening ? 'MicOff' : 'Mic'} size={15} />
          </button>
          <button className="cc-send" title="Send (Enter)" disabled={!text.trim()} onClick={() => void send()}>
            <Icon name="ArrowUp" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Something Cora wants to do: OK it (as is, or with your changes to its text), or say no. */
export function ApprovalCard({ a }: { a: Approval }) {
  const [text, setText] = useState(a.text ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (ok: boolean, with_?: string) => {
    setBusy(true);
    setErr(null);
    const e = await decideApproval(a.id, ok, with_ !== undefined ? with_ : a.text !== undefined ? text : undefined);
    setBusy(false);
    if (e) setErr(e);
  };
  const answer = (o: string) => decide(true, o);
  return (
    <div className={`cc-card k-${a.kind}`}>
      <div className="cc-card-h">
        <Icon name={KIND_ICON[a.kind]} size={13} />
        <b>{a.title}</b>
        {!a.waiting ? <span className="cc-later">Cora moved on</span> : null}
      </div>
      {a.detail ? <div className="cc-card-d">{a.detail}</div> : null}
      {a.kind === 'ask' && a.options?.length ? (
        <div className="cc-opts">
          {a.options.map((o) => (
            <button key={o} className="btn" disabled={busy} onClick={() => void answer(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : null}
      {a.text !== undefined ? (
        <textarea
          className="cc-card-t"
          placeholder={a.kind === 'ask' ? 'Or answer in your own words…' : undefined}
          value={text}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void decide(true);
            }
          }}
        />
      ) : null}
      {err ? <div className="cc-inerr">{err}</div> : null}
      <div className="cc-card-a">
        <button className="btn allow" disabled={busy || (a.kind === 'ask' && !text.trim())} onClick={() => void decide(true)} title="Ctrl+Enter">
          {a.kind === 'start' ? 'Start it' : a.kind === 'send' ? 'Send it' : a.kind === 'ask' ? 'Answer' : 'End it'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void decide(false)}>
          {a.kind === 'ask' ? 'Dismiss' : 'No'}
        </button>
      </div>
    </div>
  );
}

/** Cora's own terminal is asking something (the first start: whether to trust its folder): answer it here. */
function Asking({ lines }: { lines: string[] }) {
  const options = lines.flatMap((l) => {
    const m = /^[❯›]?\s*(\d)\.\s+(.+)$/u.exec(l.trim());
    return m ? [{ key: m[1], label: m[2] }] : [];
  });
  const question = lines.filter((l) => !/^[❯›]?\s*\d\.\s/u.test(l.trim()));
  return (
    <div className="cc-ask">
      <div className="cc-ask-h">
        <Icon name="CircleHelp" size={13} /> Cora&apos;s Claude Code is asking
      </div>
      <pre>{question.join('\n')}</pre>
      <div className="cc-ask-a">
        {options.map((o) => (
          <button key={o.key} className={`btn${o.key === '1' ? ' allow' : ' ghost'}`} onClick={() => void coraKey(o.key)}>
            {o.label}
          </button>
        ))}
        {!options.length ? (
          <button className="btn" onClick={() => void coraKey('enter')}>
            Enter
          </button>
        ) : null}
        <button className="btn ghost" onClick={() => void coraKey('esc')}>
          Esc
        </button>
      </div>
    </div>
  );
}

const BUDGETS: Array<[number, string]> = [
  [1_000_000, '1M tokens'],
  [5_000_000, '5M tokens'],
  [20_000_000, '20M tokens'],
  [50_000_000, '50M tokens'],
];
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(n / 1000)}k`);
const STATE_LABEL: Record<Goal['state'], string> = { running: 'running', waiting: 'waiting for you', blocked: 'blocked', done: 'done', stopped: 'stopped' };

/** Autopilot: the goal Cora is on (its progress, budget, workers; stop it), or a way to give it one. */
export function GoalBar({ goal, compose = false, onClose }: { goal: Goal | null; /** open on the goal box */ compose?: boolean; /** the box was used or cancelled */ onClose?: () => void }) {
  const [composing, setComposing] = useState(compose);
  // the bridge's Goal button: open the goal box
  const want = useOrch((s) => s.composeGoal);
  useEffect(() => {
    if (!want) return;
    setComposing(true);
    useOrch.setState({ composeGoal: false });
  }, [want]);
  const [text, setText] = useState('');
  const [budget, setBudget] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const sessions = useBrainStore((s) => s.sessions);
  const live = !!goal && ['running', 'waiting', 'blocked'].includes(goal.state);
  if (live) {
    const pct = Math.round((goal.progress ?? 0) * 100);
    const spent = Math.min(1, goal.budget ? goal.spent / goal.budget : 0);
    return (
      <div className={`cc-goal st-${goal.state}`}>
        <div className="cg-h">
          <span className="cg-tag">AUTOPILOT</span>
          <span className="cg-state">{STATE_LABEL[goal.state]}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => void stopGoal()} title="Stop the goal (workers are left as they are)">
            Stop
          </button>
        </div>
        <div className="cg-text">{goal.text}</div>
        <div className="cg-bar" title={`${pct}% (as Cora reports it)`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="cg-meta">
          <span title="Tokens used by the goal's sessions (output plus uncached input)" className={spent > 0.9 ? 'warn' : ''}>
            {fmt(goal.spent)} / {fmt(goal.budget)}
          </span>
          {goal.workers.length ? (
            <span className="cg-workers">
              {goal.workers.map((w) => (
                <button key={w} className="linkish" onClick={() => useBrainStore.getState().setFocus(w)}>
                  {sessions[w]?.alias || sessions[w]?.autoName || sessions[w]?.project || w.slice(0, 8)}
                </button>
              ))}
            </span>
          ) : (
            <span className="dim">no workers yet</span>
          )}
        </div>
        {goal.note ? <div className="cg-note">{goal.note}</div> : null}
      </div>
    );
  }
  if (!composing)
    return (
      <div className="cc-goal idle">
        <span className="cg-ico">
          <Icon name="Rocket" size={15} />
        </span>
        <span className="cg-idle-t">
          <b>Autopilot</b>
          <span className="dim" title={goal?.text}>
            {goal ? `last goal: ${STATE_LABEL[goal.state]}${goal.note ? ` · ${goal.note}` : ''}` : 'Give Cora a goal and it gets it done in your mandate’s repos, asking you only when it must.'}
          </span>
        </span>
        <button className="cg-start" onClick={() => setComposing(true)}>
          Give Cora a goal
        </button>
      </div>
    );
  const go = async () => {
    if (starting) return;
    setStarting(true);
    setErr(null);
    const e = await startGoal(text.trim(), budget ?? undefined).finally(() => setStarting(false));
    if (e) return setErr(e);
    setText('');
    setComposing(false);
    onClose?.();
  };
  const cancel = () => {
    setComposing(false);
    onClose?.();
  };
  return (
    <div className="cc-goal compose">
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="What should Cora get done? e.g. Fix PROJ-123 in my-service, get the tests and pipeline green, and push a branch for review."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) void go();
          if (e.key === 'Escape') cancel();
        }}
      />
      <div className="cg-row">
        <select value={budget ?? ''} onChange={(e) => setBudget(e.target.value ? Number(e.target.value) : null)} title="The goal's token budget">
          <option value="">default budget</option>
          {BUDGETS.map(([n, l]) => (
            <option key={n} value={n}>
              {l}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="btn ghost" onClick={cancel}>
          Cancel
        </button>
        <button className="btn allow" disabled={!text.trim() || starting} onClick={() => void go()} title="Ctrl+Enter">
          <Icon name="Rocket" size={12} /> Start
        </button>
      </div>
      {err ? <div className="cc-inerr">{err}</div> : null}
    </div>
  );
}

/** The sessions Cora is talking with (you OKed a conversation): it messages them without asking until the time runs out. */
export function Talks({ talks }: { talks: Array<{ sessionId: string; until: number }> }) {
  const sessions = useBrainStore((s) => s.sessions);
  const setFocus = useBrainStore((s) => s.setFocus);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!talks.length) return;
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [talks.length]);
  const now = Date.now();
  const live = talks.filter((t) => t.until > now);
  if (!live.length) return null;
  return (
    <div className="cc-talks" title="Cora may message these sessions without asking you again until the time runs out">
      <Icon name="MessagesSquare" size={12} />
      <span className="dim">Talking with</span>
      {live.map((t) => {
        const s = sessions[t.sessionId];
        return (
          <span key={t.sessionId} className="cc-talk">
            <button className="ct-name" onClick={() => s && setFocus(t.sessionId)}>
              {s?.alias || s?.autoName || s?.project || t.sessionId.slice(0, 8)}
            </button>
            <span className="ct-left">{Math.max(1, Math.round((t.until - now) / 60_000))}m</span>
            <button className="ct-end" title="End the conversation: Cora asks you before its next message to this session" onClick={() => void endTalk(t.sessionId)}>
              <Icon name="X" size={10} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

const goalIsLive = (g: Goal | null): g is Goal => !!g && ['running', 'waiting', 'blocked'].includes(g.state);

/** The console header's autopilot: a Goal button, or while a goal runs, a pill with its progress. */
function GoalPill({ goal, open, onToggle }: { goal: Goal | null; open: boolean; onToggle: () => void }) {
  if (!goalIsLive(goal))
    return (
      <button className={`cc-gpill${open ? ' on' : ''}`} data-goalpill onClick={onToggle} title="Give Cora a goal: it gets it done in your mandate's repos, asking you only when it must">
        <Icon name="Rocket" size={12} /> Goal
      </button>
    );
  const pct = Math.round((goal.progress ?? 0) * 100);
  return (
    <button className={`cc-gpill live st-${goal.state}${open ? ' on' : ''}`} data-goalpill onClick={onToggle} title={`Autopilot ${STATE_LABEL[goal.state]}: ${goal.text}`}>
      <i className="cc-ring" style={{ ['--p' as string]: pct }} /> {pct}%
    </button>
  );
}

/** While a goal runs: one quiet line under the header saying what it's on (click: the whole card). */
function GoalLine({ goal, onOpen }: { goal: Goal | null; onOpen: () => void }) {
  if (!goalIsLive(goal)) return null;
  const pct = Math.round((goal.progress ?? 0) * 100);
  return (
    <button className={`cc-gline st-${goal.state}`} onClick={onOpen} title="The goal: progress, workers, Cora's note">
      {goal.state !== 'running' ? <span className="cc-gst">{STATE_LABEL[goal.state]}</span> : null}
      <b>{goal.text}</b>
      <span className="cg-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="cc-gm">
        {fmt(goal.spent)} / {fmt(goal.budget)}
      </span>
    </button>
  );
}

/** The goal card, over the conversation: the running goal, or the box to give one. Esc or a click outside closes it. */
function GoalPop({ goal, onClose }: { goal: Goal | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // under the pill (kept inside the console)
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const pop = ref.current;
    const pill = pop?.parentElement?.querySelector<HTMLElement>('[data-goalpill]');
    if (!pop || !pill || !pop.parentElement) return;
    const room = pop.parentElement.clientWidth - pop.offsetWidth - 12;
    setLeft(Math.max(12, Math.min(room, pill.offsetLeft)));
  }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest('[data-goalpill]')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [onClose]);
  return (
    <div className="cc-goalpop" ref={ref} style={left != null ? { left } : { visibility: 'hidden' }}>
      <GoalBar goal={goal} compose={!goalIsLive(goal)} onClose={onClose} />
    </div>
  );
}
