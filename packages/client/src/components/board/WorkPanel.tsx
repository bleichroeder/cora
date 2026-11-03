import { createContext, useContext, useState } from 'react';
import { TASK_STATES, byRank, itemOpen, type Project, type ProjectItem, type SessionInfo } from '@cora/shared';
import { useBrain } from '../../state/store';
import { itemOp, projectOfBoard, useProject } from '../../state/projects';
import { ago, sessionColor, sessionName } from '../../lib/format';
import { Icon } from '../Icon';
import '../projects.css';

/**
 * A project's work queue on its board: its tasks, one row each in rank order (title, owner, state, branch, when it last
 * changed), the details a click away; the done ones with their outcomes behind a toggle. You act as the user: you open,
 * rank, assign, move on and close them; the lead and the owners do it through their tools.
 */
type Props = { sessionId: string };

/** The state's colour, its one signal: in progress, or stuck; queued is plain. */
export const STATE_COLOR: Record<string, string> = { queued: 'var(--ink4)', building: 'var(--run)', review: 'var(--run)', testing: 'var(--run)', blocked: 'var(--need)', done: 'var(--work)' };

/** The project's open tasks in the queue's order (rank, then the oldest first). */
export const openTasks = (p: Project) => (p.items ?? []).filter((i) => i.kind === 'task' && itemOpen(i)).sort(byRank);
/** Its done tasks, the newest first. */
export const doneTasks = (p: Project) => (p.items ?? []).filter((i) => i.kind === 'task' && !itemOpen(i)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

/** A task's link, short: a branch as itself, a merge or pull request by its number, any other link by its last part. */
export function shortLink(link: string): string {
  const l = link.trim();
  if (!/^https?:\/\//i.test(l)) return l.length > 32 ? `${l.slice(0, 31)}…` : l;
  const mr = /\/merge_requests\/(\d+)/.exec(l) ?? /\/pull\/(\d+)/.exec(l);
  if (mr) return `${l.includes('/pull/') ? '#' : '!'}${mr[1]}`;
  const tree = /\/(?:-\/)?tree\/([^?#]+)/.exec(l);
  if (tree) return decodeURIComponent(tree[1]);
  const last = l.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? l;
  return last.length > 32 ? `${last.slice(0, 31)}…` : last;
}

/**
 * The ranks that move a task one place up or down the queue (`dir` -1 or 1), writing only what must change (each write
 * is a change to that task, its "last changed" too): two different ranks swap; tied with its neighbour, the moved task
 * alone takes a rank between its new neighbours. Only ranks missing altogether number the queue 1, 2, 3… again (the
 * ones that change). Nothing to move: [].
 */
export function moveRanks(tasks: ProjectItem[], id: string, dir: -1 | 1): Array<{ item: string; rank: number }> {
  const at = tasks.findIndex((t) => t.id === id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= tasks.length) return [];
  const [me, them] = [tasks[at], tasks[to]];
  if (me.rank !== undefined && them.rank !== undefined && me.rank !== them.rank)
    return [
      { item: me.id, rank: them.rank },
      { item: them.id, rank: me.rank },
    ];
  // tied: between the one it passes and the one beyond it (or a step past it, at the end of the queue)
  const beyond = tasks[to + dir];
  if (them.rank !== undefined) {
    if (!beyond) return [{ item: me.id, rank: them.rank + dir }];
    if (beyond.rank !== undefined && (beyond.rank - them.rank) * dir > 0) return [{ item: me.id, rank: (them.rank + beyond.rank) / 2 }];
  }
  const order = [...tasks];
  [order[at], order[to]] = [order[to], order[at]];
  return order.map((t, k) => ({ item: t.id, rank: k + 1 })).filter((x, k) => order[k].rank !== x.rank);
}

/** The sessions, as the panel was given them (WorkList: it renders without the stores in tests). */
const Sessions = createContext<Record<string, SessionInfo>>({});

function useWho(p: Project) {
  const sessions = useContext(Sessions);
  return (by?: string) => {
    if (!by) return { name: 'nobody', color: 'var(--ink4)' };
    if (by === 'you') return { name: 'You', color: 'var(--cora)' };
    if (by === 'cora') return { name: 'Cora', color: 'var(--cora)' };
    if (sessions[by]) return { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) };
    const g = p.team?.groups.find((x) => x.id === by);
    if (g) return { name: g.name, color: 'var(--ink3)' };
    return { name: 'a session', color: 'var(--ink3)' };
  };
}

/** Whom a task can go to: the project's sessions, then its team's groups (offered to one, a member claims it). */
function OwnerPick({ p, value, set, none = 'Nobody yet' }: { p: Project; value: string; set: (v: string) => void; none?: string }) {
  const sessions = useContext(Sessions);
  return (
    <select value={value} onChange={(e) => set(e.target.value)} title="Who has it">
      <option value="">{none}</option>
      {p.sessions
        .filter((sid) => sessions[sid])
        .map((sid) => (
          <option key={sid} value={sid}>
            {sessionName(sessions[sid])}
          </option>
        ))}
      {(p.team?.groups ?? []).map((g) => (
        <option key={g.id} value={g.id}>
          {g.name} (offered)
        </option>
      ))}
    </select>
  );
}

/** A task's owner and state, as the Work panel sets them (`act`: its itemOp change). */
function TaskSets({ p, i, act }: { p: Project; i: ProjectItem; act(op: 'change', f: Record<string, unknown>): Promise<boolean> }) {
  return (
    <>
      <span className="lab">Owner</span>
      <OwnerPick p={p} value={i.owner ?? ''} set={(v) => void act('change', { owner: v })} none="Nobody" />
      <span className="lab">State</span>
      <span className="pp-seg">
        {TASK_STATES.map((s) => (
          <button key={s} className={i.state === s ? 'on' : ''} onClick={() => void act('change', { state: s })}>
            {s}
          </button>
        ))}
      </span>
    </>
  );
}

/**
 * A task's controls anywhere else (the team map's member drawer): the Work panel's own owner and state, through its
 * itemOp, for these sessions; what went wrong under them.
 */
export function TaskControls({ p, i, sessions }: { p: Project; i: ProjectItem; sessions: Record<string, SessionInfo> }) {
  const [err, setErr] = useState('');
  const act = async (op: 'change', f: Record<string, unknown>) => {
    const r = await itemOp(p.id, op, { item: i.id, ...f });
    setErr(r.ok ? '' : (r.error ?? 'Not done.'));
    return r.ok;
  };
  return (
    <Sessions.Provider value={sessions}>
      <div className="row">
        <TaskSets p={p} i={i} act={act} />
      </div>
      {err ? <div className="pi-err">{err}</div> : null}
    </Sessions.Provider>
  );
}

export function WorkPanel({ sessionId }: Props) {
  const p = useProject(projectOfBoard(sessionId));
  const sessions = useBrain((s) => s.sessions);
  return p ? <WorkList p={p} sessions={sessions} /> : null;
}

/** The panel itself, for a project and its sessions. */
export function WorkList({ p, sessions }: { p: Project; sessions: Record<string, SessionInfo> }) {
  const [done, setDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const live = openTasks(p);
  const closed = doneTasks(p);
  const move = async (id: string, dir: -1 | 1) => {
    for (const x of moveRanks(live, id, dir)) {
      const r = await itemOp(p.id, 'change', x);
      if (!r.ok) return setErr(r.error ?? 'Not moved.');
    }
    setErr('');
  };
  return (
    <Sessions.Provider value={sessions}>
      <div className="pi pw">
        <div className="pi-head">
          <span className="pp-seg">
            <button className={!done ? 'on' : ''} onClick={() => setDone(false)}>
              Queue {live.length ? <b>{live.length}</b> : null}
            </button>
            <button className={done ? 'on' : ''} onClick={() => setDone(true)} title="Tasks done: their outcomes">
              Done {closed.length ? <b>{closed.length}</b> : null}
            </button>
          </span>
          <span className="sp" />
          {!done ? (
            <button className={`pp-tg${adding ? ' on' : ''}`} onClick={() => setAdding(!adding)} title="Open a task">
              <Icon name="Plus" size={11} /> Task
            </button>
          ) : null}
        </div>
        {adding && !done ? <NewTask p={p} done={() => setAdding(false)} /> : null}
        {err ? <div className="pi-err pw-err">{err}</div> : null}
        <div className="pi-rows">
          {done ? (
            closed.length ? closed.map((i) => <DoneTask key={i.id} p={p} i={i} />) : <div className="pp-empty">Nothing done yet. A task the lead closes lands here with its outcome.</div>
          ) : live.length ? (
            live.map((i, k) => <Task key={i.id} p={p} i={i} n={k + 1} first={k === 0} last={k === live.length - 1} open={open === i.id} toggle={() => setOpen(open === i.id ? null : i.id)} move={(dir) => void move(i.id, dir)} />)
          ) : (
            <div className="pp-empty">No work queued. The lead opens tasks (project_item, kind task), or you can, above.</div>
          )}
        </div>
      </div>
    </Sessions.Provider>
  );
}

function NewTask({ p, done }: { p: Project; done: () => void }) {
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    if (!title.trim()) return;
    const r = await itemOp(p.id, 'open', { kind: 'task', title: title.trim(), ...(owner ? { owner } : {}) });
    if (r.ok) done();
    else setErr(r.error ?? "Couldn't open it.");
  };
  return (
    <div className="pi-new">
      <input autoFocus value={title} placeholder="What the work is…" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} />
      <div className="row">
        <OwnerPick p={p} value={owner} set={setOwner} />
        <span className="sp" />
        <button className="pp-btn go" disabled={!title.trim()} onClick={() => void go()}>
          Open
        </button>
      </div>
      {err ? <div className="pi-err">{err}</div> : null}
    </div>
  );
}

function Task({ p, i, n, first, last, open, toggle, move }: { p: Project; i: ProjectItem; n: number; first: boolean; last: boolean; open: boolean; toggle: () => void; move: (dir: -1 | 1) => void }) {
  const who = useWho(p);
  const [next, setNext] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const o = who(i.owner);
  const act = async (op: Parameters<typeof itemOp>[1], f: Record<string, unknown>) => {
    const r = await itemOp(p.id, op, { item: i.id, ...f });
    setErr(r.ok ? '' : (r.error ?? 'Not done.'));
    return r.ok;
  };
  return (
    <div className={`pi-row pw-row${open ? ' open' : ''}`} style={{ ['--kc' as any]: STATE_COLOR[i.state] ?? 'var(--ink4)' }}>
      <div className="pw-line">
        <button className="pi-main pw-main" onClick={toggle} title={open ? 'Fold it' : 'Its details and what you can do'}>
          <span className="n">{n}</span>
          <b className="t">{i.title}</b>
          <span className="who">
            <span className="dot" style={{ ['--sc' as any]: o.color }} />
            {i.owner ? o.name : <em>unassigned</em>}
          </span>
          <span className="pp-kind">{i.state}</span>
          <span className="br" title={i.link ?? ''}>
            {i.link ? shortLink(i.link) : ''}
          </span>
          <span className="age" title={`Last changed ${new Date(i.updatedAt).toLocaleString()}`}>
            {ago(i.updatedAt)}
          </span>
        </button>
        <span className="pw-move">
          <button disabled={first} onClick={() => move(-1)} title="Up the queue" aria-label="Up the queue">
            <Icon name="ChevronUp" size={12} />
          </button>
          <button disabled={last} onClick={() => move(1)} title="Down the queue" aria-label="Down the queue">
            <Icon name="ChevronDown" size={12} />
          </button>
        </span>
      </div>
      {open ? (
        <div className="pi-more">
          {i.body ? <div className="pw-body">{i.body}</div> : null}
          <div className="row">
            <TaskSets p={p} i={i} act={act} />
            {i.link && /^https?:\/\//i.test(i.link) ? (
              <a className="pi-link" href={i.link} target="_blank" rel="noreferrer">
                <Icon name="ExternalLink" size={11} /> {shortLink(i.link)}
              </a>
            ) : null}
          </div>
          <input className="pi-in" value={next ?? i.next ?? ''} placeholder="The next step…" onChange={(e) => setNext(e.target.value)} onBlur={() => (next != null && next !== (i.next ?? '') ? void act('change', { next }) : null, setNext(null))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          {i.notes.length ? (
            <div className="pi-notes">
              {i.notes.slice(-6).map((x, k) => (
                <div key={k}>
                  <b style={{ color: who(x.by).color }}>{who(x.by).name}</b> <time>{ago(x.at)}</time> {x.text}
                </div>
              ))}
            </div>
          ) : null}
          <input className="pi-in" value={note} placeholder={i.owner && !p.team?.groups.some((g) => g.id === i.owner) ? 'Add a note (its owner is told)…' : 'Add a note…'} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && void act('annotate', { text: note.trim() }).then((ok) => ok && setNote(''))} />
          {closing != null ? (
            <div className="pi-close">
              <input autoFocus className="pi-in" value={closing} placeholder='Its outcome, in a line ("merged as abc1234")…' onChange={(e) => setClosing(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && closing.trim() && void act('close', { outcome: closing.trim() })} />
              <div className="row">
                <span className="sp" />
                <button className="pp-btn" onClick={() => setClosing(null)}>
                  Not yet
                </button>
                <button className="pp-btn go" disabled={!closing.trim()} onClick={() => void act('close', { outcome: closing.trim() })}>
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <span className="sp" />
              <button className="pp-btn" onClick={() => setClosing('')}>
                Close as done…
              </button>
            </div>
          )}
          {err ? <div className="pi-err">{err}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A done task: its outcome where an open one's details would be. */
export function DoneTask({ p, i }: { p: Project; i: ProjectItem }) {
  const who = useWho(p);
  return (
    <div className="pi-row pw-row done" style={{ ['--kc' as any]: STATE_COLOR.done }}>
      <div className="pi-main pw-main">
        <span className="n" />
        <b className="t">{i.title}</b>
        <span className="who">
          <span className="dot" style={{ ['--sc' as any]: who(i.owner).color }} />
          {i.owner ? who(i.owner).name : <em>unassigned</em>}
        </span>
        <span className="pp-kind">done</span>
        <span className="br" title={i.link ?? ''}>
          {i.link ? shortLink(i.link) : ''}
        </span>
        <span className="age">{i.closedAt ? ago(i.closedAt) : ''}</span>
        <span className="next">{i.outcome || '—'}</span>
      </div>
    </div>
  );
}
