import { useEffect, useMemo, useState } from 'react';
import { iconFor, shortToolName, type PendingRequest, type SessionInfo } from '@cora/shared';
import { answerOpen, useOpenAsks, type OpenAsk } from '../state/openTab';
import { dismissOops, useOops } from '../state/oops';
import { agentKey, useBrain } from '../state/store';
import { decide, jump, releasePending } from '../state/ws';
import { maskSecrets } from '../lib/mask';
import { Icon, Tile } from './Icon';
import { MiniDiff } from './DiffView';
import { proposedChange } from '../lib/proposed';
import { askAnswer, formCheck, wantsTo } from '../lib/asks';
import { sessionColor, sessionName } from '../lib/format';
import './needs.css';

function Countdown({ from, until }: { from: number; until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  const left = until > from ? Math.max(0, Math.min(1, (until - now) / (until - from))) : 0;
  return (
    <span className={`countdown${s <= 15 ? ' soon' : ''}`} title={`Goes back to the terminal in ${s}s`} style={{ ['--left' as any]: `${left * 100}%` }}>
      <i />
      {s >= 120 ? `${Math.round(s / 60)}m` : `${s}s`}
    </span>
  );
}

/** Who asked and in which session: "main · canvas". */
function From({ p, agent }: { p: PendingRequest; agent?: string }) {
  const s = useBrain((st) => st.sessions[p.sessionId]);
  return (
    <span className="ny-from">
      {p.agentId === 'main' ? 'main' : (agent ?? p.agentId)}
      {s ? ` · ${sessionName(s)}` : ''}
    </span>
  );
}

export function JumpButton({ sessionId, short }: { sessionId: string; short?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="jump">
      <button
        className="btn ghost"
        title="Jump to its terminal window"
        onClick={async () => {
          const r = await jump(sessionId);
          if (r.ok) setMsg('switched');
          else if (r.fallback) {
            await navigator.clipboard?.writeText(r.fallback).catch(() => {});
            setMsg(`couldn't find the window (${r.reason}); resume command copied`);
          } else setMsg(r.reason ? `couldn't jump: ${r.reason}` : "couldn't find its window");
          setTimeout(() => setMsg(null), 4000);
        }}
      >
        <Icon name="SquareArrowOutUpRight" size={12} /><span className="bt-l"> {short ? 'Jump' : 'Jump to terminal'}</span>
      </button>
      {msg ? <span className="dim"> {msg}</span> : null}
    </span>
  );
}

function inputText(input: unknown): { text: string; isCommand: boolean } {
  if (input && typeof input === 'object' && typeof (input as any).command === 'string') return { text: (input as any).command, isCommand: true };
  return { text: JSON.stringify(input, null, 2), isCommand: false };
}

function PermissionCard({ p }: { p: PendingRequest }) {
  const agent = useBrain((s) => s.agents[agentKey(p.sessionId, p.agentId)]);
  const { text, isCommand } = inputText(p.toolInput);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [reveal, setReveal] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const icon = iconFor(p.toolName, p.toolInput);
  // an Edit/Write: show the change itself, not its JSON
  const proposed = useMemo(() => proposedChange(p.toolName, p.toolInput), [p.toolName, p.toolInput]);
  const [showInput, setShowInput] = useState(false);
  const masked = maskSecrets(text);

  const send = async (d: Parameters<typeof decide>[1]) => {
    const r = await decide(p.id, d);
    if (!r.ok) setErr(r.error ?? 'failed');
  };
  const allowEdited = () => {
    let updatedInput: unknown;
    try {
      updatedInput = isCommand ? { ...(p.toolInput as object), command: draft } : JSON.parse(draft);
    } catch {
      setErr('edited input is not valid JSON');
      return;
    }
    void send({ decision: 'allow', updatedInput });
  };

  return (
    <div className="ny-card">
      <div className="ny-h">
        <Tile name={icon.name} family={icon.family} size={28} />
        <div className="ny-t">
          <b>
            {shortToolName(p.toolName)} {wantsTo(p.toolName)}
          </b>
          <From p={p} agent={agent?.label} />
        </div>
        <Countdown from={p.createdAt} until={p.expiresAt} />
        <CloseCard id={p.id} />
      </div>
      {proposed && !editing && !showInput ? (
        <div className="ny-diff">
          <div className="ny-diff-h">
            <span title={proposed.path}>{proposed.path.split(/[\\/]/).pop()}</span>
            {proposed.note ? <span className="dim"> · {proposed.note}</span> : null}
            <span className="spacer" />
            <button className="reveal" onClick={() => setShowInput(true)}>raw input</button>
          </div>
          <MiniDiff hunks={proposed.hunks} path={proposed.path} />
        </div>
      ) : editing ? (
        <textarea className="ny-edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={isCommand ? 3 : 8} spellCheck={false} />
      ) : (
        <pre className="ny-input">
          {reveal ? text : masked.text}
          {masked.masked ? (
            <button className="reveal" onClick={() => setReveal(!reveal)}>
              {reveal ? 'hide' : 'reveal'}
            </button>
          ) : null}
        </pre>
      )}
      {denying ? <input className="ny-reason" placeholder="reason (optional, the agent will see it)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /> : null}
      <div className="ny-actions">
        {editing ? (
          <>
            <button className="btn allow" onClick={allowEdited}>Allow edited</button>
            <button className="btn ghost" onClick={() => { setEditing(false); setDraft(text); }}>Cancel edit</button>
          </>
        ) : denying ? (
          <>
            <button className="btn deny" onClick={() => send({ decision: 'deny', message: reason || undefined })}>Deny</button>
            <button className="btn ghost" onClick={() => setDenying(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="btn allow" onClick={() => send({ decision: 'allow' })}><Icon name="Check" size={13} /> Allow</button>
            <button className="btn ghost" onClick={() => setEditing(true)}><Icon name="Pencil" size={12} /> Allow + edit</button>
            <button className="btn ghost no" onClick={() => setDenying(true)}><Icon name="X" size={13} /> Deny…</button>
          </>
        )}
        <span className="spacer" />
        <JumpButton sessionId={p.sessionId} />
      </div>
      {err ? <div className="ny-err">{err}</div> : null}
    </div>
  );
}

type Question = { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> };

function QuestionCard({ p }: { p: PendingRequest }) {
  const qs = ((p.toolInput as any)?.questions ?? []) as Question[];
  // per question: the options picked, and your own words under Other (open once you click it)
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string | undefined>>({});
  const [err, setErr] = useState<string | null>(null);
  const answers = Object.fromEntries(qs.map((q) => [q.question, askAnswer(picked[q.question] ?? [], other[q.question] ?? '', !!q.multiSelect)]));
  const complete = qs.every((q) => answers[q.question]);
  const pick = (q: Question, label: string) => {
    const now = picked[q.question] ?? [];
    if (q.multiSelect) return setPicked({ ...picked, [q.question]: now.includes(label) ? now.filter((l) => l !== label) : [...now, label] });
    setPicked({ ...picked, [q.question]: [label] });
    setOther({ ...other, [q.question]: undefined });
  };
  const own = (q: Question) => {
    if (other[q.question] !== undefined) return setOther({ ...other, [q.question]: undefined });
    setOther({ ...other, [q.question]: '' });
    if (!q.multiSelect) setPicked({ ...picked, [q.question]: [] });
  };
  return (
    <div className="ny-card ask">
      <div className="ny-h">
        <Tile name="MessageCircleQuestion" family="human" size={28} />
        <div className="ny-t">
          <b>Claude is asking you</b>
          {!p.canAnswer ? <span className="ny-from">Answer in the terminal (answering from Cora is turned off)</span> : <From p={p} />}
        </div>
        <Countdown from={p.createdAt} until={p.expiresAt} />
        <CloseCard id={p.id} />
      </div>
      {qs.map((q) => (
        <div key={q.question} className="ny-q">
          <div className="ny-qt">
            {q.question}
            {q.multiSelect ? <span className="ny-multi"> · pick any</span> : null}
          </div>
          <div className="ny-opts">
            {(q.options ?? []).map((o) => (
              <button key={o.label} disabled={!p.canAnswer} className={`opt${picked[q.question]?.includes(o.label) ? ' on' : ''}`} title={o.description} onClick={() => pick(q, o.label)}>
                {o.label}
              </button>
            ))}
            <button disabled={!p.canAnswer} className={`opt${other[q.question] !== undefined ? ' on' : ''}`} title="Answer in your own words" onClick={() => own(q)}>
              Other…
            </button>
          </div>
          {other[q.question] !== undefined ? (
            <input
              className="ny-other"
              autoFocus
              placeholder={q.multiSelect ? 'Add your own…' : 'Your answer…'}
              value={other[q.question]}
              maxLength={2000}
              onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
            />
          ) : null}
        </div>
      ))}
      <div className="ny-actions">
        {p.canAnswer ? (
          <button className="btn allow" disabled={!complete} onClick={async () => { const r = await decide(p.id, { decision: 'allow', answers }); if (!r.ok) setErr(r.error ?? "Couldn't send it: answer in the terminal"); }}>
            Send answer
          </button>
        ) : null}
        <span className="spacer" />
        <JumpButton sessionId={p.sessionId} />
      </div>
      {err ? <div className="ny-err">{err}</div> : null}
    </div>
  );
}

function ElicitationCard({ p }: { p: PendingRequest }) {
  const schema = (p.elicitation?.schema ?? {}) as { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[] }>; required?: string[] };
  const props = Object.entries(schema.properties ?? {});
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState<string | null>(null);
  const { missing, content } = formCheck(schema, vals);
  const send = async (decision: 'accept' | 'decline' | 'cancel') => {
    const r = await decide(p.id, { decision, ...(decision === 'accept' ? { content } : {}) });
    if (!r.ok) setErr(r.error ?? "Couldn't send it: answer in the terminal");
  };
  return (
    <div className="ny-card">
      <div className="ny-h">
        <Tile name="Plug" family="mcp" size={28} />
        <div className="ny-t">
          <b>{p.elicitation?.server} needs input</b>
          <span className="ny-from">{p.elicitation?.message}</span>
        </div>
        <Countdown from={p.createdAt} until={p.expiresAt} />
        <CloseCard id={p.id} />
      </div>
      {props.map(([k, s]) => (
        <label key={k} className="ny-field" title={s.description}>
          <span>{s.title ?? k}{schema.required?.includes(k) ? ' *' : ''}</span>
          {s.enum ? (
            <select onChange={(e) => setVals({ ...vals, [k]: e.target.value })} defaultValue="">
              <option value="" disabled>choose…</option>
              {s.enum.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : s.type === 'boolean' ? (
            <input type="checkbox" onChange={(e) => setVals({ ...vals, [k]: e.target.checked })} />
          ) : (
            <input type={s.type === 'number' || s.type === 'integer' ? 'number' : 'text'} step={s.type === 'integer' ? 1 : undefined} placeholder={s.description} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="ny-actions">
        <button className="btn allow" disabled={missing.length > 0} title={missing.length ? `Still needed: ${missing.join(', ')}` : undefined} onClick={() => void send('accept')}>Accept</button>
        <button className="btn ghost no" onClick={() => void send('decline')}>Decline</button>
        <button className="btn ghost" onClick={() => void send('cancel')}>Cancel</button>
      </div>
      {err ? <div className="ny-err">{err}</div> : null}
    </div>
  );
}

/** Out of the way: hands it back to the terminal, where the same prompt is waiting. */
function CloseCard({ id }: { id: string }) {
  return (
    <button className="ny-x" title="Close (answer in the terminal instead)" onClick={() => void releasePending(id)}>
      <Icon name="X" size={13} />
    </button>
  );
}

export function NeedsYou({ sessionId }: { sessionId: string }) {
  const pending = useBrain((s) => s.pending).filter((p) => p.sessionId === sessionId);
  if (!pending.length) return null;
  return (
    <div className="needs-you">
      {pending.map((p) =>
        p.kind === 'question' ? <QuestionCard key={p.id} p={p} /> : p.kind === 'elicitation' ? <ElicitationCard key={p.id} p={p} /> : <PermissionCard key={p.id} p={p} />,
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useBrain((s) => s.toasts);
  const sessions = useBrain((s) => s.sessions);
  const setFocus = useBrain((s) => s.setFocus);
  const dismiss = useBrain((s) => s.dismissToast);
  const asks = useOpenAsks((s) => s.asks);
  const oopses = useOops((s) => s.list);
  return (
    <div className="toasts">
      {oopses.map((o) => (
        <div key={o.id} className="toast ask oops" role="alert">
          <span className="dl-tile">
            <Icon name="TriangleAlert" size={14} />
          </span>
          <span className="toast-t">
            <b>{o.title}</b>
            {o.detail ? <span title={o.detail}>{o.detail}</span> : null}
          </span>
          <span className="toast-acts">
            <button className="x" title="Close" onClick={() => dismissOops(o.id)}>
              <Icon name="X" size={13} />
            </button>
          </span>
        </div>
      ))}
      {asks.map((a) => (
        <OpenAskRow key={a.id} a={a} s={sessions[a.sessionId]} />
      ))}
      {toasts.map((t) => (
        <ToastRow key={t.id} t={t} s={sessions[t.sessionId]} onOpen={() => setFocus(t.sessionId)} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

/** A session wants to open a site Cora doesn't know yet (its open_tab): Open, or Not now. */
function OpenAskRow({ a, s }: { a: OpenAsk; s?: SessionInfo }) {
  const name = s ? sessionName(s) : 'A session';
  return (
    <div className="toast ask" title={a.url}>
      <span className="dl-tile" style={{ ['--sc' as any]: s ? sessionColor(s) : '#475569' }}>
        <Icon name="Globe" size={14} />
      </span>
      <span className="toast-t">
        <b>{name} wants to open a site</b>
        <span>{a.host}</span>
      </span>
      <span className="toast-acts">
        <button className="btn allow" onClick={() => answerOpen(a.id, true)}>
          Open
        </button>
        <button className="x" title="Not now" onClick={() => answerOpen(a.id, false)}>
          <Icon name="X" size={13} />
        </button>
      </span>
    </div>
  );
}

function ToastRow({ t, s, onOpen, onDismiss }: { t: { id: string; text: string }; s?: SessionInfo; onOpen(): void; onDismiss(): void }) {
  const name = s ? sessionName(s) : 'A session';
  return (
    <div className="toast" role="button" onClick={onOpen} title="Open it">
      <span className="dl-tile need" style={{ ['--sc' as any]: s ? sessionColor(s) : '#475569' }}>
        {(name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
        <i />
      </span>
      <span className="toast-t">
        <b>{name} needs you</b>
        <span>{t.text}</span>
      </span>
      <button
        className="x"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        <Icon name="X" size={13} />
      </button>
    </div>
  );
}
