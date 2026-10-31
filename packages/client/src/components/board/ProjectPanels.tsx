import { useEffect, useMemo, useRef, useState } from 'react';
import { isOpenQuestion, type Post, type PostKind, type Project, type ProjectHears, type SessionInfo } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { answerWake, closeQuestion, editDecision, leaveProject, pinPost, postToProject, projectOfBoard, setMember, updateProject, useProject, useProjectOfSession, useProjects } from '../../state/projects';
import type { CoraState } from '../../state/orchestrator';
import { ago, sessionColor, sessionName } from '../../lib/format';
import { CoraOrb } from '../CoraOrb';
import { CiGlyph } from '../CiStrip';
import { Icon } from '../Icon';
import '../projects.css';

/**
 * A project's board panels: the Constellation, Members,
 * Thread, Brief & decisions, Across repos, Activity; and the Project panel on a member's own board.
 */
type Props = { sessionId: string };

function useBoardProject(owner: string): Project | undefined {
  return useProject(projectOfBoard(owner));
}
function useMembers(p?: Project): SessionInfo[] {
  const sessions = useBrain((s) => s.sessions);
  return useMemo(() => (p ? p.sessions.map((id) => sessions[id]).filter((s): s is SessionInfo => !!s) : []), [p, sessions]);
}
const orbState = (s: SessionInfo): CoraState => (s.state === 'needs-you' ? 'needs-you' : s.state === 'working' || s.state === 'thinking' ? 'thinking' : s.state === 'ended' ? 'off' : 'idle');
const STATE_WORD: Record<string, string> = { 'needs-you': 'needs you', working: 'working', thinking: 'thinking', idle: 'idle', ended: 'ended' };
const KIND_COLOR: Record<PostKind, string> = { note: 'var(--ink3)', change: '#60a5fa', question: '#fbbf24', handoff: '#3ddc97', decision: '#a78bfa' };
const NoMembers = () => <div className="pp-empty">No sessions in this project yet. Drag a session onto it in the nav, or start one from the project's header.</div>;
const open = (sid: string) => useBrain.getState().setFocus(sid);

/** What's waiting for each member (handoffs and questions not delivered yet, and wakes asking you). */
function useWaiting(p?: Project): Map<string, number> {
  const wakes = useProjects((s) => s.wakes);
  return useMemo(() => {
    const n = new Map<string, number>();
    if (!p) return n;
    const seen = new Set<string>();
    for (const w of p.waiting ?? []) (seen.add(`${w.post}|${w.to}`), n.set(w.to, (n.get(w.to) ?? 0) + 1));
    for (const w of wakes) if (w.project === p.id && !seen.has(`${w.post}|${w.to}`)) n.set(w.to, (n.get(w.to) ?? 0) + 1);
    return n;
  }, [p, wakes]);
}

/**
 * The members' orbs together: a post streaks from its writer to who it's for (by its kind's colour); a handoff or
 * question still waiting stays as a marching dashed line until it's delivered; a badge counts what waits for each.
 */
export function ConstellationPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  const doing = useProjects((s) => s.doing);
  const waiting = useWaiting(p);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(400);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.min(el.clientWidth, el.clientHeight * 1.6)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // where each sits: a ring (one in the middle; two side by side)
  const at = useMemo(() => {
    const n = members.length;
    return members.map((s, i) => {
      if (n === 1) return { s, x: 50, y: 50 };
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n === 2 ? Math.PI / 2 : 0);
      return { s, x: 50 + Math.cos(a) * (n === 2 ? 24 : 30), y: 50 + Math.sin(a) * (n === 2 ? 0 : 26) };
    });
  }, [members]);
  // the thread's newest post, as light: from its writer to who it's for (or all who hear it)
  const last = p?.thread.at(-1);
  const [streak, setStreak] = useState<Post | null>(null);
  const seen = useRef(last?.id);
  useEffect(() => {
    if (!last || last.id === seen.current) return;
    seen.current = last.id;
    setStreak(last);
    const t = setTimeout(() => setStreak(null), 2200);
    return () => clearTimeout(t);
  }, [last]);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  const size = Math.max(40, Math.min(84, Math.round(w / Math.max(3, members.length + 1))));
  const pos = (sid: string) => at.find((a) => a.s.id === sid);
  const from = streak ? pos(streak.by) : undefined;
  const to = streak ? at.filter((a) => a.s.id !== streak.by && (streak.to?.length ? streak.to.includes(a.s.id) : p.coordination && p.members[a.s.id]?.hears === 'everything')) : [];
  // waiting: from the post's writer to its member
  const lines = (p.waiting ?? []).flatMap((x) => {
    const post = p.thread.find((y) => y.id === x.post);
    const a = post ? pos(post.by) : undefined;
    const b = pos(x.to);
    return a && b ? [{ key: `${x.post}|${x.to}`, a, b, kind: post!.kind }] : [];
  });
  return (
    <div className="pp-sky" ref={box} style={{ ['--pc' as any]: p.color }}>
      <svg className="links" viewBox="0 0 100 100" preserveAspectRatio="none">
        {lines.map((l) => (
          <path key={l.key} className="wait" d={`M${l.a.x},${l.a.y} L${l.b.x},${l.b.y}`} stroke={KIND_COLOR[l.kind]} vectorEffect="non-scaling-stroke" />
        ))}
        {from && to.length
          ? to.map((t) => <path key={t.s.id + streak!.id} className="streak" d={`M${from.x},${from.y} L${t.x},${t.y}`} stroke={KIND_COLOR[streak!.kind]} vectorEffect="non-scaling-stroke" />)
          : null}
      </svg>
      {at.map(({ s, x, y }) => {
        const n = waiting.get(s.id) ?? 0;
        return (
          <button key={s.id} className={`pp-star${s.state === 'needs-you' ? ' need' : ''}${s.state === 'ended' ? ' ended' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => open(s.id)} title={`${sessionName(s)}${doing[s.id] ? `: ${doing[s.id]}` : ''}`}>
            <span className="orbw">
              <CoraOrb state={orbState(s)} size={size} agent={s.id} color={sessionColor(s)} />
              {n ? <span className="pp-badge" title={`${n} waiting for it`}>{n}</span> : null}
            </span>
            <b>{sessionName(s)}</b>
            <small>{STATE_WORD[s.state] ?? s.state}</small>
          </button>
        );
      })}
      {lines.length ? (
        <div className="pp-legend">
          <span style={{ ['--lc' as any]: KIND_COLOR.handoff }}>waiting to be delivered</span>
        </div>
      ) : null}
    </div>
  );
}

/** Who's on what: each member's state, what it's on, where, its ticket, what's waiting for it; its overrides behind ⋯. */
export function MembersPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  const doing = useProjects((s) => s.doing);
  const waiting = useWaiting(p);
  const [setting, setSetting] = useState<string | null>(null);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  return (
    <div className="pp-who">
      {members.map((s) => {
        const m = p.members[s.id];
        const n = waiting.get(s.id) ?? 0;
        const busy = s.state === 'working' || s.state === 'thinking';
        return (
          <div key={s.id} className={`pp-w${s.state === 'needs-you' ? ' need' : ''}${s.state === 'ended' ? ' ended' : ''}`}>
            <span className="dot" style={{ ['--sc' as any]: sessionColor(s) }} />
            <button className="n" onClick={() => open(s.id)} title="Open it">
              {sessionName(s)}
            </button>
            <span className={`st${busy ? ' busy' : s.state === 'needs-you' ? ' need' : ''}`}>{STATE_WORD[s.state] ?? s.state}</span>
            <button className="pp-x more" title="Its settings in this project" onClick={() => setSetting(setting === s.id ? null : s.id)}>
              <Icon name="Ellipsis" size={13} />
            </button>
            <span className="on">{doing[s.id] || <em>nothing said yet</em>}</span>
            <span className="meta">
              <span>{(s.wd || s.cwd).split(/[\\/]/).filter(Boolean).pop()}</span>
              {s.ticket ? <span>{s.ticket.key}</span> : null}
              {n ? <span className="w">{n} waiting for it</span> : null}
            </span>
            {setting === s.id ? (
              <div className="pp-set">
                {p.coordination && m ? (
                  <>
                    <span className="lab">Hears</span>
                    <span className="pp-seg">
                      {(['nothing', 'brief', 'everything'] as ProjectHears[]).map((h) => (
                        <button key={h} className={m.hears === h ? 'on' : ''} onClick={() => void setMember(p.id, s.id, { hears: h })} title={h === 'nothing' ? 'Nothing of the project' : h === 'brief' ? 'Its card (brief, decisions, who is who), not the thread' : 'Its card, and what is new on each prompt'}>
                          {h === 'brief' ? 'Card' : h === 'nothing' ? 'Nothing' : 'Everything'}
                        </button>
                      ))}
                    </span>
                    <button className={`pp-tg${m.canPost ? ' on' : ''}`} onClick={() => void setMember(p.id, s.id, { canPost: !m.canPost })} title="It may post to the project (project_post)">
                      <Icon name="Send" size={11} /> Posts
                    </button>
                    <button className={`pp-tg${m.wakes ? ' on' : ''}`} onClick={() => void setMember(p.id, s.id, { wakes: !m.wakes })} title="A handoff or question to it may wake it when it's idle: each one asks you first">
                      <Icon name="AlarmClock" size={11} /> May be woken
                    </button>
                  </>
                ) : null}
                <button className="pp-tg" onClick={() => void leaveProject(p.id, s.id)} title="Take it out of the project (the session carries on)">
                  <Icon name="LogOut" size={11} /> Take out
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Open loops: what's unresolved: questions to you (answer here), other open questions, what waits to be delivered, changes some haven't heard. */
export function LoopsPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const sessions = useBrain((s) => s.sessions);
  const wakes = useProjects((s) => s.wakes);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  if (!p) return null;
  const who = (by: string) => (by === 'you' || by === 'user' ? 'you' : by === 'cora' ? 'Cora' : sessions[by] ? sessionName(sessions[by]) : 'a session');
  const questions = p.thread.filter((x) => isOpenQuestion(p, x)).reverse();
  const myWakes = wakes.filter((w) => w.project === p.id);
  const waits = (p.waiting ?? []).filter((x) => !myWakes.some((w) => w.post === x.post && w.to === x.to));
  // a change (or decision) some members haven't heard yet (they hear it on their next prompt)
  const unheard = p.thread
    .filter((x) => (x.kind === 'change' || x.kind === 'decision') && Date.now() - x.at < 3 * 86_400_000)
    .map((x) => ({ x, not: p.sessions.filter((sid) => sid !== x.by && (p.members[sid]?.hears ?? 'nothing') !== 'nothing' && (p.members[sid]?.heardTo ?? 0) < x.at) }))
    .filter((u) => u.not.length)
    .reverse()
    .slice(0, 6);
  const n = questions.length + myWakes.length + waits.length + unheard.length;
  if (!n) return <div className="pp-empty">Nothing open: no questions waiting for an answer, no handoffs waiting to be delivered.</div>;
  const send = async (q: Post) => {
    const t = answer[q.id]?.trim();
    if (!t) return;
    const r = await postToProject(p.id, 'note', t, { re: q.id, to: q.by !== 'you' && q.by !== 'cora' ? [q.by] : [] });
    if (r.ok) setAnswer((a) => ({ ...a, [q.id]: '' }));
  };
  return (
    <div className="pp-loops">
      {myWakes.map((w) => (
        <div key={w.id} className="pp-loop" style={{ ['--kc' as any]: KIND_COLOR.handoff }}>
          <span className="k">
            <Icon name="ArrowRight" size={11} />
          </span>
          <div className="t">
            <b>
              {who(w.from)} → {who(w.to)}
            </b>
            : {w.text} <em>· {who(w.to)} is idle</em>
          </div>
          <div className="acts">
            <button className="pp-btn go" onClick={() => void answerWake(w.id, true)}>
              Deliver now
            </button>
            <button className="pp-btn" onClick={() => void answerWake(w.id, false)} title="It reaches the session on its next prompt from you">
              Let it wait
            </button>
          </div>
        </div>
      ))}
      {waits.map((x) => {
        const post = p.thread.find((y) => y.id === x.post);
        if (!post) return null;
        return (
          <div key={`${x.post}|${x.to}`} className="pp-loop" style={{ ['--kc' as any]: KIND_COLOR[post.kind] }}>
            <span className="k">
              <Icon name="Hourglass" size={11} />
            </span>
            <div className="t">
              <b>
                {who(post.by)} → {who(x.to)}
              </b>
              : {post.text} <em>· waiting {ago(x.since)}: {who(x.to)} is busy; you'll be asked when its turn ends</em>
            </div>
          </div>
        );
      })}
      {questions.map((q) => {
        const mine = q.to?.includes('user');
        return (
          <div key={q.id} className={`pp-loop${mine ? ' mine' : ''}`} style={{ ['--kc' as any]: KIND_COLOR.question }}>
            <span className="k">?</span>
            <div className="t">
              <b>
                {who(q.by)} → {q.to?.length ? q.to.map(who).join(', ') : 'the project'}
              </b>
              : {q.text} <em>· {ago(q.at)}</em>
            </div>
            {mine ? (
              <div className="ans">
                <input value={answer[q.id] ?? ''} placeholder="Answer as you…" onChange={(e) => setAnswer((a) => ({ ...a, [q.id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && void send(q)} />
                <button className="pp-btn go" disabled={!answer[q.id]?.trim()} onClick={() => void send(q)}>
                  Send
                </button>
                <button className="pp-btn" onClick={() => void closeQuestion(p.id, q.id)} title="Nobody needs to answer it">
                  Close
                </button>
              </div>
            ) : (
              <div className="acts">
                <button className="pp-btn" onClick={() => void closeQuestion(p.id, q.id)} title="Nobody needs to answer it">
                  Close
                </button>
              </div>
            )}
          </div>
        );
      })}
      {unheard.map(({ x, not }) => (
        <div key={x.id} className="pp-loop" style={{ ['--kc' as any]: KIND_COLOR[x.kind] }}>
          <span className="k">!</span>
          <div className="t">
            <b>
              {who(x.by)}'s {x.kind}
            </b>
            : {x.text.slice(0, 140)} <em>· {not.map(who).join(', ')} {not.length === 1 ? "hasn't" : "haven't"} heard it yet (on the next prompt)</em>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Shared notes: the project's notes as a pinboard; pinned ones join every member's card. */
export function NotesBoardPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const sessions = useBrain((s) => s.sessions);
  const [q, setQ] = useState('');
  if (!p) return null;
  const who = (by: string) => (by === 'you' ? { name: 'You', color: YOU } : by === 'cora' ? { name: 'Cora', color: 'var(--cora)' } : sessions[by] ? { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) } : { name: 'A session', color: 'var(--ink3)' });
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const notes = p.thread
    .filter((x) => x.kind === 'note' && !x.re && words.every((w) => `${x.text} ${who(x.by).name}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at)
    .slice(0, 60);
  return (
    <div className="pp-notes">
      <input className="pp-search" value={q} placeholder="Search notes…" onChange={(e) => setQ(e.target.value)} />
      {notes.length ? (
        <div className="pp-board">
          {notes.map((x) => {
            const w = who(x.by);
            return (
              <div key={x.id} className={`pp-note${x.pinned ? ' pinned' : ''}`} style={{ ['--sc' as any]: w.color }}>
                <span className="by">
                  {w.name}
                  <time>{ago(x.at)}</time>
                </span>
                <p>{x.text}</p>
                <button className="pin" title={x.pinned ? 'Unpin it' : 'Pin it: it joins every member’s project card'} onClick={() => void pinPost(p.id, x.id, !x.pinned)}>
                  <Icon name={x.pinned ? 'PinOff' : 'Pin'} size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pp-empty">{q ? 'No note matches.' : 'No notes yet. Sessions share findings here (a note), and so can you.'}</div>
      )}
    </div>
  );
}

/** The project's conversation: every post, filtered by kind, answers under their question; compose to the project or one member. */
export function ThreadPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  return p ? <Thread p={p} /> : null;
}
const FILTERS: Array<{ k: 'all' | PostKind | 'you'; label: string }> = [
  { k: 'all', label: 'All' },
  { k: 'note', label: 'notes' },
  { k: 'question', label: 'questions' },
  { k: 'handoff', label: 'handoffs' },
  { k: 'change', label: 'changes' },
  { k: 'decision', label: 'decisions' },
  { k: 'you', label: 'to you' },
];
const YOU = '#f472b6';
function Thread({ p, compact }: { p: Project; compact?: boolean }) {
  const sessions = useBrain((s) => s.sessions);
  const wakes = useProjects((s) => s.wakes);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PostKind>('note');
  const [to, setTo] = useState('');
  const [re, setRe] = useState<Post | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['k']>('all');
  const list = useRef<HTMLDivElement>(null);
  const who = (by: string) => (by === 'you' || by === 'user' ? { name: by === 'user' ? 'you' : 'You', color: YOU } : by === 'cora' ? { name: 'Cora', color: 'var(--cora)' } : sessions[by] ? { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) } : { name: 'A session', color: 'var(--ink3)' });
  const answers = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const x of p.thread) if (x.re) m.set(x.re, [...(m.get(x.re) ?? []), x]);
    return m;
  }, [p.thread]);
  const shown = p.thread
    .filter((x) => !x.re || !p.thread.some((y) => y.id === x.re))
    .filter((x) => filter === 'all' || (filter === 'you' ? x.to?.includes('user') : x.kind === filter))
    .slice(compact ? -30 : -200);
  const count = (k: PostKind) => p.thread.filter((x) => x.kind === k && (k !== 'question' || isOpenQuestion(p, x))).length;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [shown.length, filter]);
  const state = (x: Post) => {
    if (x.kind === 'question') return x.closed ? { t: 'closed', c: '' } : answers.has(x.id) ? { t: 'answered', c: '' } : { t: 'open', c: 'open' };
    if (x.kind === 'handoff' && x.to?.length) {
      const w = (p.waiting ?? []).some((y) => y.post === x.id) || wakes.some((y) => y.post === x.id);
      return w ? { t: 'waiting', c: 'wait' } : { t: 'delivered', c: '' };
    }
    return null;
  };
  const send = async () => {
    if (!text.trim()) return;
    const r = await postToProject(p.id, re ? 'note' : kind, text.trim(), { ...(to ? { to: [to] } : re && re.by !== 'you' && re.by !== 'cora' ? { to: [re.by] } : {}), ...(re ? { re: re.id } : {}) });
    if (r.ok) (setText(''), setRe(null));
  };
  const one = (x: Post, nested = false) => {
    const w = who(x.by);
    const st = nested ? null : state(x);
    return (
      <div key={x.id} className={`pp-post${x.to?.includes('user') && !nested ? ' you' : ''}${nested ? ' re' : ''}`}>
        <span className="pp-av" style={{ ['--sc' as any]: w.color }}>
          {w.name[0]?.toUpperCase()}
        </span>
        <div>
          <span className="who">
            <b>{w.name}</b>
            {nested ? (
              <span className="pp-kind" style={{ ['--kc' as any]: 'var(--ink3)' }}>
                answer
              </span>
            ) : x.kind !== 'note' ? (
              <span className="pp-kind" style={{ ['--kc' as any]: KIND_COLOR[x.kind] }}>
                {x.kind}
              </span>
            ) : null}
            {x.to?.length && !nested ? <span className="to">to {x.to.map((t) => who(t).name).join(', ')}</span> : null}
            {st ? <span className={`state ${st.c}`}>{st.t}</span> : null}
            {x.pinned ? <Icon name="Pin" size={10} className="pinned" /> : null}
            <time>{new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            {!compact && !nested && x.kind === 'question' && !x.closed ? (
              <button className="reply" onClick={() => (setRe(x), setTo(''))} title="Answer it">
                Answer
              </button>
            ) : null}
          </span>
          <p>{x.text}</p>
          {!nested ? answers.get(x.id)?.map((y) => one(y, true)) : null}
        </div>
      </div>
    );
  };
  return (
    <div className="pp-thread">
      {!p.coordination && !compact ? <div className="pp-off">Coordination is off: the sessions don't hear this project. Turn it on in the project's header when they should talk.</div> : null}
      {!compact ? (
        <div className="pp-chips">
          {FILTERS.map((f) => {
            const n = f.k === 'question' ? count('question') : 0;
            return (
              <button key={f.k} className={`pp-chip${filter === f.k ? ' on' : ''}`} style={f.k !== 'all' && f.k !== 'you' ? { ['--kc' as any]: KIND_COLOR[f.k] } : undefined} onClick={() => setFilter(f.k)}>
                {f.k !== 'all' && f.k !== 'you' ? <i /> : null}
                {f.label}
                {n ? <b>{n}</b> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="pp-posts" ref={list}>
        {shown.length ? shown.map((x) => one(x)) : <div className="pp-empty">{filter === 'all' ? 'Nothing yet. Sessions post here when it matters to another; so can you.' : 'Nothing of that kind.'}</div>}
      </div>
      <div className="pp-compose">
        {re ? (
          <button className="pp-re" onClick={() => setRe(null)} title="Not an answer after all">
            Answering {who(re.by).name} <Icon name="X" size={10} />
          </button>
        ) : (
          <select value={kind} onChange={(e) => setKind(e.target.value as PostKind)} title="What it is">
            <option value="note">Note</option>
            <option value="question">Question</option>
            <option value="handoff">Handoff</option>
            <option value="decision">Decision</option>
          </select>
        )}
        {!compact && !re ? (
          <select value={to} onChange={(e) => setTo(e.target.value)} title="Who it's for">
            <option value="">To the project</option>
            {p.sessions
              .filter((sid) => sessions[sid])
              .map((sid) => (
                <option key={sid} value={sid}>
                  To {sessionName(sessions[sid])}
                </option>
              ))}
          </select>
        ) : null}
        <input value={text} placeholder={re ? 'Your answer…' : kind === 'decision' ? 'A decision the project keeps…' : 'Write to the project…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
      </div>
    </div>
  );
}

/** The brief (edited in place) and the decisions the project keeps. */
export function BriefPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const [draft, setDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  if (!p) return null;
  const save = () => {
    if (draft != null && draft !== p.brief) void updateProject(p.id, { brief: draft });
    setDraft(null);
  };
  return (
    <div className="pp-brief">
      <textarea value={draft ?? p.brief} placeholder={'The goal, the repos, when it’s done, what not to touch…'} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
      {p.decisions.map((x) => (
        <div key={x.id} className="pp-dec">
          <Icon name="Check" size={12} />
          <span>{x.text}</span>
          <small>{new Date(x.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</small>
          <button className="pp-x" style={{ width: 20, height: 20 }} title="Take it back" onClick={() => void editDecision(p.id, x.id, null)}>
            <Icon name="X" size={11} />
          </button>
        </div>
      ))}
      <div className="pp-compose" style={{ padding: 0, border: 0 }}>
        <input
          value={adding}
          placeholder="Add a decision…"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) void postToProject(p.id, 'decision', adding.trim()).then(() => setAdding(''));
          }}
        />
      </div>
    </div>
  );
}

/** Every member's repo, worktree, ticket and pipeline in one list. */
export function ReposPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  return (
    <div className="pp-list">
      {members.map((s) => {
        const repo = s.cwd.split(/[\\/]/).filter(Boolean).pop();
        const wt = s.wd && s.wd !== s.cwd ? s.wd.split(/[\\/]/).filter(Boolean).pop() : null;
        return (
          <div key={s.id} className="pp-li" style={{ ['--sc' as any]: sessionColor(s) }} onClick={() => open(s.id)}>
            <span className="pp-dot" />
            <span className="a">
              <code>{repo}</code>
              {wt ? <> · worktree <code>{wt}</code></> : null}
              {s.ticket ? <> · {s.ticket.key}</> : null}
              {' '}
              <span style={{ color: 'var(--ink4)' }}>({sessionName(s)})</span>
            </span>
            <CiGlyph sessionId={s.id} />
          </div>
        );
      })}
    </div>
  );
}

/** What the members did lately, together: their prompts, replies and tools, newest first. */
export function ActivityPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  const versions = useBrain((s) => s.versions);
  const items = useMemo(() => {
    const all = members.flatMap((s) =>
      sessionEvents(s.id)
        .filter((e) => e.agentId === 'main' && (e.kind === 'prompt' || e.kind === 'say' || (e.kind === 'tool' && e.phase !== 'start')))
        .slice(-40)
        .map((e) => ({ e, s })),
    );
    return all.sort((a, b) => b.e.ts - a.e.ts).slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, members.map((s) => versions[s.id]).join()]);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  if (!items.length) return <div className="pp-empty">Nothing yet: what the sessions do shows here.</div>;
  return (
    <div className="pp-list">
      {items.map(({ e, s }) => (
        <div key={e.id} className="pp-li" style={{ ['--sc' as any]: sessionColor(s) }} onClick={() => open(s.id)}>
          <span className="pp-dot" />
          <span className="a">
            {e.kind === 'prompt' ? 'Asked: ' : e.kind === 'say' ? '' : `${e.tool?.name ?? 'Tool'}: `}
            {(e.kind === 'tool' ? e.tool?.summary : e.text)?.replace(/\s+/g, ' ').slice(0, 160)}
          </span>
          <small>
            {sessionName(s).slice(0, 18)} · {new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </small>
        </div>
      ))}
    </div>
  );
}

/** On a member's own board: its project, compact (the brief, and the thread). */
export function ProjectPanel({ sessionId }: Props) {
  const p = useProjectOfSession(sessionId);
  if (!p) return <div className="pp-empty">This session isn't in a project. Its menu (right-click it in the nav) adds it to one.</div>;
  return (
    <div className="pp-thread" style={{ ['--pc' as any]: p.color }}>
      <div className="pp-off" style={{ cursor: 'pointer' }} onClick={() => useBrain.getState().openProject(p.id)} title="Open the project's board">
        <span className="pj-sq sm" /> <b style={{ color: 'var(--ink)' }}>{p.name}</b>
        {p.brief.trim() ? ` · ${p.brief.trim().split('\n')[0].slice(0, 140)}` : ''}
      </div>
      <Thread p={p} compact />
    </div>
  );
}
