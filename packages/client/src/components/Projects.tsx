import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { PROJECT_COLORS } from '@cora/shared';
import { addToProject, archiveProject, createProject, deleteProject, leaveProject, reorderProjects, shadesOf, updateProject, useProjects } from '../state/projects';
import { MAIN_COLORS, isDismissed, sessionName } from '../lib/format';
import { Icon } from './Icon';
import './projects.css';

/**
 * Projects in the nav: a section above Working / Idle / Ended.
 * A project is one row (its colour, name, its members' states); open, its members' rows under it. Nothing reorders on
 * its own: projects in the order you made them, members in the order you added them.
 */
const FOLDED = 'cora.projects.folded';
const readFolded = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(FOLDED) ?? '{}');
  } catch {
    return {};
  }
};
/** a session's state, as its dot's colour */
/** Start a new session in a project (the New session dialog; it joins the project when it starts). */
const newIn = (pid: string) => {
  useProjects.setState({ joining: pid });
  useBrain.getState().setModal('new-session');
};
export const stateColor = (s?: SessionInfo) => (!s ? 'var(--ink4)' : s.state === 'needs-you' ? 'var(--need)' : s.state === 'working' || s.state === 'thinking' ? 'var(--run, #3ddc97)' : s.state === 'idle' ? 'var(--ink3)' : 'var(--ink4)');

export function ProjectsSection({ entry, dragging, onDropped }: { entry(s: SessionInfo, project?: { id: string; members: string[] }): React.ReactNode; dragging: string | null; onDropped(): void }) {
  const allProjects = useProjects((p) => p.projects);
  const projects = useMemo(() => allProjects.filter((x) => !x.archivedAt), [allProjects]);
  const [folded, setFolded] = useState(readFolded);
  const [adding, setAdding] = useState(false);
  // a project being dragged (to put it elsewhere in the list), and where it would go
  const [moving, setMoving] = useState<{ id: string; over?: { id: string; below: boolean } } | null>(null);
  const [menu, setMenu] = useState<{ p: Project; x: number; y: number } | null>(null);
  const drop = () => {
    if (!moving?.over || moving.over.id === moving.id) return setMoving(null);
    const ids = projects.map((p) => p.id).filter((x) => x !== moving.id);
    const at = ids.indexOf(moving.over.id) + (moving.over.below ? 1 : 0);
    ids.splice(at, 0, moving.id);
    setMoving(null);
    void reorderProjects(ids);
  };
  const fold = (id: string) => {
    const next = { ...folded, [id]: !folded[id] };
    setFolded(next);
    try {
      localStorage.setItem(FOLDED, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  if (!projects.length && !adding)
    return (
      <div className="pj-sec empty">
        <button className="pj-new-quiet" onClick={() => setAdding(true)} title="Group sessions that belong to one piece of work">
          <Icon name="FolderPlus" size={12} /> New project
        </button>
      </div>
    );
  return (
    <section className="pj-sec">
      <div className="ses-h pj-h">
        <span>Projects</span>
        <span className="ses-n">{projects.length}</span>
        <span className="ses-rule" />
        <button className="pj-add" onClick={() => setAdding(true)} title="New project">
          <Icon name="Plus" size={11} />
        </button>
      </div>
      {adding ? <NewProject onDone={() => setAdding(false)} /> : null}
      {projects.map((p) => (
        <ProjectRow key={p.id} p={p} folded={!!folded[p.id]} onFold={() => fold(p.id)} entry={entry} dragging={dragging} onDropped={onDropped} moving={moving} setMoving={setMoving} onMove={drop} onMenu={(e) => (e.preventDefault(), setMenu({ p, x: e.clientX, y: e.clientY }))} />
      ))}
      {menu ? <ProjectMenu p={projects.find((x) => x.id === menu.p.id) ?? menu.p} x={menu.x} y={menu.y} index={projects.findIndex((x) => x.id === menu.p.id)} all={projects} onClose={() => setMenu(null)} /> : null}
    </section>
  );
}

type Moving = { id: string; over?: { id: string; below: boolean } } | null;
function ProjectRow({ p, folded, onFold, entry, dragging, onDropped, moving, setMoving, onMove, onMenu }: { p: Project; folded: boolean; onFold(): void; entry(s: SessionInfo, project?: { id: string; members: string[] }): React.ReactNode; dragging: string | null; onDropped(): void; moving: Moving; setMoving(m: Moving): void; onMove(): void; onMenu(e: React.MouseEvent): void }) {
  const sessions = useBrain((s) => s.sessions);
  const open = useBrain((s) => s.projectOpen === p.id);
  // a session you removed from the list is off it here too (it's still the project's: its page keeps it)
  const members = p.sessions.map((id) => sessions[id]).filter((s): s is SessionInfo => !!s && !isDismissed(s));
  const needs = members.filter((s) => s.state === 'needs-you').length;
  const [over, setOver] = useState(false);
  return (
    <div className="pj" style={{ ['--pc' as any]: p.color }}>
      <button
        data-ping={`pj:${p.id}`}
        className={`pj-row${open ? ' on' : ''}${over ? ' over' : ''}${moving?.id === p.id ? ' dragging' : ''}${moving?.over?.id === p.id && moving.id !== p.id ? (moving.over.below ? ' drop-below' : ' drop-above') : ''}`}
        onClick={() => useBrain.getState().openProject(p.id)}
        onContextMenu={onMenu}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `project:${p.id}`);
          setMoving({ id: p.id });
        }}
        onDragEnd={() => setMoving(null)}
        onDragOver={(e) => {
          // another project: before or after this one
          if (moving) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const below = e.clientY > r.top + r.height / 2;
            if (moving.over?.id !== p.id || moving.over.below !== below) setMoving({ id: moving.id, over: { id: p.id, below } });
            return;
          }
          // a session: into this project
          if (!dragging || p.sessions.includes(dragging)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          if (moving) return onMove();
          setOver(false);
          if (dragging) void addToProject(p.id, dragging);
          onDropped();
        }}
        title={`${p.name}: its board (right-click: name, colour, order)`}
      >
        <span
          className={`pj-chev${folded ? ' closed' : ''}`}
          role="button"
          aria-label={folded ? 'Show its sessions' : 'Hide its sessions'}
          onClick={(e) => (e.stopPropagation(), onFold())}
        >
          <Icon name="ChevronDown" size={11} />
        </span>
        <span className="pj-sq" />
        <span className="pj-nm">{p.name}</span>
        <span className="pj-dots">
          {members.slice(0, 6).map((s) => (
            <i key={s.id} style={{ background: stateColor(s) }} />
          ))}
        </span>
        {needs ? <b className="pj-need">{needs}</b> : null}
        <span className="pj-more pj-add" role="button" aria-label="New session in this project" title="Start a new session in this project" onClick={(e) => (e.stopPropagation(), newIn(p.id))}>
          <Icon name="Plus" size={13} />
        </span>
        <span className="pj-more" role="button" aria-label="Name, colour, order" title="Name, colour, order" onClick={(e) => (e.stopPropagation(), onMenu(e))}>
          <Icon name="Ellipsis" size={13} />
        </span>
      </button>
      {folded ? null : (
        <div className="pj-members">
          {members.length ? members.map((s) => entry(s, { id: p.id, members: p.sessions })) : <div className="pj-empty">Drag sessions here, or start one in it from its board.</div>}
        </div>
      )}
    </div>
  );
}

/**
 * A project's menu (right-click its row, or its ⋯): its name, its colour, shades of it for its sessions, its place in the
 * list, archiving. The session menu's look.
 */
function ProjectMenu({ p, x, y, index, all, onClose }: { p: Project; x: number; y: number; index: number; all: Project[]; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const sessions = useBrain((b) => b.sessions);
  const [name, setName] = useState(p.name);
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => (window.removeEventListener('mousedown', down), window.removeEventListener('keydown', key));
  }, [onClose]);
  const save = () => name.trim() && name.trim() !== p.name && void updateProject(p.id, { name: name.trim() });
  const members = p.sessions.filter((id) => sessions[id]);
  const shades = shadesOf(p.color, members.length);
  const move = (dir: -1 | 1) => {
    const ids = all.map((x) => x.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    void reorderProjects(ids);
  };
  const colors = [...new Set([...PROJECT_COLORS, ...MAIN_COLORS])].slice(0, 14);
  return (
    <div className="session-menu" ref={box} style={{ left: Math.min(x, window.innerWidth - 290), top: Math.min(y, window.innerHeight - 440) }}>
      <div className="sm-h" style={{ ['--pc' as any]: p.color }}>
        <span className="pj-sq" style={{ width: 14, height: 14, margin: '0 7px' }} />
        <span className="sm-t">
          <b>{p.name}</b>
          <span>
            {members.length} session{members.length === 1 ? '' : 's'}
            {p.coordination ? ' · coordination on' : ''}
          </span>
        </span>
      </div>
      <div className="sm-gl">Name</div>
      <div className="sm-name">
        <input
          value={name}
          maxLength={60}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              save();
              onClose();
            }
          }}
        />
      </div>
      <div className="sm-gl">Colour</div>
      <div className="swatches">
        {colors.map((c) => (
          <button key={c} className={`swatch${c === p.color ? ' on' : ''}`} style={{ background: c }} onClick={() => void updateProject(p.id, { color: c })} title={c} />
        ))}
        <input type="color" value={p.color} onChange={(e) => void updateProject(p.id, { color: e.target.value })} title="Custom colour" />
      </div>
      {members.length ? (
        <button
          className={`sm-row pj-shade${p.shade ? ' on' : ''}`}
          role="switch"
          aria-checked={!!p.shade}
          title={p.shade ? "On: each of its sessions wears its own shade of the project's colour, new ones too. Click to stop (they keep their colours)" : "Give each of its sessions its own shade of the project's colour, and keep doing it as sessions join"}
          onClick={() => void updateProject(p.id, { shade: !p.shade })}
        >
          <Icon name={p.shade ? 'SquareCheck' : 'Square'} size={14} /> Shade its sessions
          <span className="pj-shades">
            {shades.map((c, i) => (
              <i key={i} style={{ background: c }} title={sessions[members[i]] ? sessionName(sessions[members[i]]) : ''} />
            ))}
          </span>
        </button>
      ) : null}
      <div className="sm-sep" />
      {([-1, 1] as const).map((dir) => (
        <button key={dir} className="sm-row" disabled={index + dir < 0 || index + dir >= all.length} title="Or drag it in the list" onClick={() => (move(dir), onClose())}>
          <Icon name={dir < 0 ? 'ChevronUp' : 'ChevronDown'} size={14} /> Move {dir < 0 ? 'up' : 'down'}
        </button>
      ))}
      <button className="sm-row" onClick={() => (newIn(p.id), onClose())}>
        <Icon name="Plus" size={14} /> New session in it
      </button>
      <button className="sm-row" onClick={() => (useBrain.getState().openProject(p.id), onClose())}>
        <Icon name="LayoutDashboard" size={14} /> Open its board
      </button>
      <div className="sm-sep" />
      <button className="sm-row bad" onClick={() => (void archiveProject(p.id, true), onClose())}>
        <Icon name="Archive" size={14} /> Archive project
      </button>
    </div>
  );
}

/** Resume's archived projects: bring one back (to the nav, as it was), or delete it for good. */
export function ArchivedProjects({ q, onDone }: { q: string; onDone(): void }) {
  const all = useProjects((p) => p.projects);
  const list = useMemo(() => all.filter((p) => p.archivedAt && (!q || p.name.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)), [all, q]);
  const [sure, setSure] = useState<string | null>(null);
  if (!list.length) return null;
  return (
    <div>
      <div className="dlg-gl">
        Archived projects <span className="n">{list.length}</span>
      </div>
      {list.map((p) => (
        <div key={p.id} className="hs-proj" style={{ ['--pc' as any]: p.color }}>
          <span className="pj-sq" />
          <span className="t">
            <b>{p.name}</b>
            <span>
              {p.sessions.length} session{p.sessions.length === 1 ? '' : 's'} · archived {new Date(p.archivedAt!).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              {p.thread.length ? ` · ${p.thread.length} posts` : ''}
            </span>
          </span>
          <button
            className="btn ghost"
            onClick={() =>
              void archiveProject(p.id, false).then(() => {
                useBrain.getState().openProject(p.id);
                onDone();
              })
            }
            title="Back in the nav, with its sessions, brief, decisions and thread"
          >
            <Icon name="ArchiveRestore" size={12} /> Bring back
          </button>
          {sure === p.id ? (
            <button className="btn ghost" style={{ color: '#ffb3b3' }} onClick={() => void deleteProject(p.id).then(() => setSure(null))} onMouseLeave={() => setSure(null)}>
              Delete for good
            </button>
          ) : (
            <button className="btn ghost" onClick={() => setSure(p.id)} title="Its brief, decisions and thread go; its sessions stay">
              <Icon name="Trash2" size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** A new project's name (Enter makes it; Esc, or nothing typed, doesn't). `sessionId`: it starts with that session. */
export function NewProject({ onDone, sessionId }: { onDone(p?: Project | null): void; sessionId?: string }) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const go = async () => {
    if (!name.trim()) return onDone();
    const p = await createProject(name.trim(), sessionId);
    onDone(p);
    if (p && !sessionId) useBrain.getState().openProject(p.id);
  };
  return (
    <div className="pj-newrow">
      <input
        ref={ref}
        value={name}
        placeholder="Project name"
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void go();
          if (e.key === 'Escape') onDone();
        }}
        onBlur={() => !name.trim() && onDone()}
      />
    </div>
  );
}

/**
 * "Add to <project>?": a session not in a project, on the same ticket as a member or in a member's worktree. Cora only
 * suggests: one click adds it, the × lets it be (for this session, for good).
 */
const NO_SUGGEST = 'cora.projects.nosuggest';
export function ProjectSuggest({ s }: { s: SessionInfo }) {
  const projects = useProjects((p) => p.projects);
  const sessions = useBrain((b) => b.sessions);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return (JSON.parse(localStorage.getItem(NO_SUGGEST) ?? '[]') as string[]).includes(s.id);
    } catch {
      return false;
    }
  });
  if (dismissed || s.state === 'ended') return null;
  const live = projects.filter((p) => !p.archivedAt);
  if (live.some((p) => p.sessions.includes(s.id))) return null;
  const match = live.find((p) =>
    p.sessions.some((id) => {
      const m = sessions[id];
      return !!m && ((!!s.ticket && m.ticket?.key === s.ticket.key) || (!!s.wd && s.wd !== s.cwd && m.wd === s.wd));
    }),
  );
  if (!match) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      const was = JSON.parse(localStorage.getItem(NO_SUGGEST) ?? '[]') as string[];
      localStorage.setItem(NO_SUGGEST, JSON.stringify([...was, s.id].slice(-200)));
    } catch {
      /* ignore */
    }
  };
  return (
    <span className="pj-suggest" style={{ ['--pc' as any]: match.color }}>
      <button onClick={() => void addToProject(match.id, s.id)} title={`It looks like part of ${match.name}: add it`}>
        <span className="pj-sq sm" /> Add to {match.name}?
      </button>
      <button className="x" onClick={dismiss} aria-label="No" title="Not this one">
        <Icon name="X" size={11} />
      </button>
    </span>
  );
}

/** The session menu's Project part: which project it's in, moving it, a new project with it. */
export function ProjectMenuRows({ s, onDone }: { s: SessionInfo; onDone(): void }) {
  const allProjects = useProjects((p) => p.projects);
  const projects = useMemo(() => allProjects.filter((x) => !x.archivedAt), [allProjects]);
  const mine = projects.find((p) => p.sessions.includes(s.id));
  const others = projects.filter((p) => p !== mine);
  const [naming, setNaming] = useState(false);
  return (
    <>
      <div className="sm-gl">Project</div>
      {mine ? (
        <>
          <button className="sm-row" onClick={() => (useBrain.getState().openProject(mine.id), onDone())}>
            <span className="pj-sq sm" style={{ ['--pc' as any]: mine.color }} /> {mine.name}
          </button>
          <button className="sm-row" onClick={() => void leaveProject(mine.id, s.id).then(onDone)}>
            <Icon name="FolderMinus" size={14} /> Take out of {mine.name}
          </button>
        </>
      ) : null}
      {others.slice(0, 6).map((p) => (
        <button key={p.id} className="sm-row" onClick={() => void addToProject(p.id, s.id).then(onDone)}>
          <span className="pj-sq sm" style={{ ['--pc' as any]: p.color }} /> {mine ? 'Move to' : 'Add to'} {p.name}
        </button>
      ))}
      {naming ? (
        <div className="sm-name">
          <NewProject sessionId={s.id} onDone={(p) => (setNaming(false), p && onDone())} />
        </div>
      ) : (
        <button className="sm-row" onClick={() => setNaming(true)}>
          <Icon name="FolderPlus" size={14} /> New project with this session…
        </button>
      )}
    </>
  );
}
