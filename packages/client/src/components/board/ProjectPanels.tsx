import { useEffect, useMemo, useRef, useState } from 'react';
import type { Post, PostKind, Project, ProjectHears, SessionInfo } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { editDecision, leaveProject, postToProject, projectOfBoard, setMember, updateProject, useProject, useProjectOfSession } from '../../state/projects';
import type { CoraState } from '../../state/orchestrator';
import { sessionColor, sessionName } from '../../lib/format';
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

/** The members' orbs together; a new post streaks from its writer to the ones that hear it. */
export function ConstellationPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
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
      return { s, x: 50 + Math.cos(a) * (n === 2 ? 24 : 30), y: 52 + Math.sin(a) * (n === 2 ? 0 : 24) };
    });
  }, [members]);
  // the thread's newest post, as light: from its writer to who hears it
  const last = p?.thread.at(-1);
  const [streak, setStreak] = useState<Post | null>(null);
  const seen = useRef(last?.id);
  useEffect(() => {
    if (!last || last.id === seen.current) return;
    seen.current = last.id;
    setStreak(last);
    const t = setTimeout(() => setStreak(null), 1800);
    return () => clearTimeout(t);
  }, [last]);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  const size = Math.max(40, Math.min(84, Math.round(w / Math.max(3, members.length + 1))));
  const from = streak ? at.find((a) => a.s.id === streak.by) : undefined;
  const to = streak ? at.filter((a) => a.s.id !== streak.by && (streak.to?.length ? streak.to.includes(a.s.id) : p.coordination && p.members[a.s.id]?.hears === 'everything')) : [];
  return (
    <div className="pp-sky" ref={box} style={{ ['--pc' as any]: p.color }}>
      {from && to.length ? (
        <svg className="links" viewBox="0 0 100 100" preserveAspectRatio="none">
          {to.map((t) => (
            <path key={t.s.id + streak!.id} className="streak" d={`M${from.x},${from.y} L${t.x},${t.y}`} stroke={KIND_COLOR[streak!.kind]} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      ) : null}
      {at.map(({ s, x, y }) => (
        <button key={s.id} className={`pp-star${s.state === 'needs-you' ? ' need' : ''}${s.state === 'ended' ? ' ended' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => open(s.id)} title={`${sessionName(s)}: open it`}>
          <CoraOrb state={orbState(s)} size={size} agent={s.id} color={sessionColor(s)} />
          <b>{sessionName(s)}</b>
          <small>{STATE_WORD[s.state] ?? s.state}</small>
        </button>
      ))}
    </div>
  );
}

/** Each member: its state, what it needs; with coordination on, what it hears and may do. */
export function MembersPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  return (
    <div className="pp-mem">
      {members.map((s) => {
        const m = p.members[s.id];
        return (
          <div key={s.id} className={`pp-m${s.state === 'needs-you' ? ' need' : ''}`} onClick={() => open(s.id)}>
            <span className="pp-av" style={{ ['--sc' as any]: sessionColor(s), width: 28, height: 28 }}>
              {sessionName(s)[0]?.toUpperCase()}
            </span>
            <span className="t">
              <b>{sessionName(s)}</b>
              <span>
                {STATE_WORD[s.state] ?? s.state} · {s.cwd.split(/[\\/]/).filter(Boolean).pop()}
                {s.ticket ? ` · ${s.ticket.key}` : ''}
              </span>
            </span>
            <span className="acts">
              <button className="pp-x" title="Take it out of the project (the session carries on)" onClick={(e) => (e.stopPropagation(), void leaveProject(p.id, s.id))}>
                <Icon name="X" size={13} />
              </button>
            </span>
            {p.coordination && m ? (
              <div className="pp-set" onClick={(e) => e.stopPropagation()}>
                <span className="lab">Hears</span>
                <span className="pp-seg">
                  {(['nothing', 'brief', 'everything'] as ProjectHears[]).map((h) => (
                    <button key={h} className={m.hears === h ? 'on' : ''} onClick={() => void setMember(p.id, s.id, { hears: h })} title={h === 'nothing' ? 'Nothing of the project' : h === 'brief' ? 'The brief and decisions, when they change' : 'That, and the others’ posts on its next turn'}>
                      {h === 'brief' ? 'Brief' : h === 'nothing' ? 'Nothing' : 'Everything'}
                    </button>
                  ))}
                </span>
                <button className={`pp-tg${m.canPost ? ' on' : ''}`} onClick={() => void setMember(p.id, s.id, { canPost: !m.canPost })} title="It may post to the thread (project_post)">
                  <Icon name="Send" size={11} /> Can post
                </button>
                <button className={`pp-tg${m.wakes ? ' on' : ''}`} onClick={() => void setMember(p.id, s.id, { wakes: !m.wakes })} title="Idle, a handoff or question to it may wake it: each one asks you first">
                  <Icon name="AlarmClock" size={11} /> Wakes on handoffs
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The project's conversation: the sessions' posts and yours. */
export function ThreadPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId) ?? null;
  return p ? <Thread p={p} /> : null;
}
function Thread({ p, compact }: { p: Project; compact?: boolean }) {
  const sessions = useBrain((s) => s.sessions);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PostKind>('note');
  const list = useRef<HTMLDivElement>(null);
  const posts = compact ? p.thread.slice(-30) : p.thread.slice(-200);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [posts.length]);
  const who = (by: string) => (by === 'you' ? { name: 'You', color: '#f472b6' } : by === 'cora' ? { name: 'Cora', color: 'var(--cora)' } : sessions[by] ? { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) } : { name: 'A session', color: 'var(--ink3)' });
  const send = async () => {
    if (!text.trim()) return;
    const r = await postToProject(p.id, kind, text.trim());
    if (r.ok) setText('');
  };
  return (
    <div className="pp-thread">
      {!p.coordination && !compact ? <div className="pp-off">Coordination is off: the sessions don't hear this thread. Turn it on in the project's header when they should work together.</div> : null}
      <div className="pp-posts" ref={list}>
        {posts.length ? (
          posts.map((x) => {
            const w = who(x.by);
            return (
              <div key={x.id} className="pp-post">
                <span className="pp-av" style={{ ['--sc' as any]: w.color }}>
                  {w.name[0]?.toUpperCase()}
                </span>
                <div>
                  <span className="who">
                    <b>{w.name}</b>
                    {x.kind !== 'note' ? (
                      <span className="pp-kind" style={{ ['--kc' as any]: KIND_COLOR[x.kind] }}>
                        {x.kind}
                      </span>
                    ) : null}
                    {x.to?.length ? <span className="pp-kind" style={{ ['--kc' as any]: 'var(--ink3)' }}>to {x.to.map((t) => who(t).name).join(', ')}</span> : null}
                    <time>{new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
                  </span>
                  <p>{x.text}</p>
                </div>
              </div>
            );
          })
        ) : (
          <div className="pp-empty">Nothing yet. Sessions that may post write here; so can you.</div>
        )}
      </div>
      <div className="pp-compose">
        <select value={kind} onChange={(e) => setKind(e.target.value as PostKind)} title="A note, or a decision for the project's memory">
          <option value="note">Note</option>
          <option value="decision">Decision</option>
        </select>
        <input value={text} placeholder={kind === 'decision' ? 'A decision the project keeps…' : 'Write to the project…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
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
