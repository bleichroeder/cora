import { useEffect, useState } from 'react';
import { PROJECT_COLORS, WAKE_LIMIT, type Project, type SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { answerWake, archiveAsking, projectBoard, updateProject, useProject, useProjects, wrapUpProject } from '../state/projects';
import { launchTerminal } from '../state/ws';
import { sessionName } from '../lib/format';
import { LiveBoard } from './LiveBoard';
import { builderEntry } from './board/TeamPanel';
import { draftInProgress, openBuilder, useProjectDraft } from '../state/builder';
import { Icon } from './Icon';
import './projects.css';

/** The wake limits a project without a team may choose (per session, per hour), and none. */
export const WAKE_LIMITS: Array<number | 'none'> = [3, 6, 12, 30, 'none'];
/** The choice as the project keeps it: the default is unset (WAKE_LIMIT, as before). */
export const wakeLimitOf = (v: string): number | 'none' | null => (v === 'none' ? 'none' : Number(v) === WAKE_LIMIT ? null : Number(v));
/** Wake each other, in words: what it does here (a team's routes, or the project's limit). */
export function wakeTitle(p: Pick<Project, 'autoWake' | 'wakeLimit' | 'team'>): string {
  if (!p.autoWake) return 'A handoff or question to an idle session asks you first. On: they wake each other on their own';
  if (p.team) return "Its sessions wake each other on their own: for its seats, the team's routes say (auto, ask or never), and their own limits hold them back";
  const n = p.wakeLimit ?? WAKE_LIMIT;
  return n === 'none' ? 'Its sessions wake each other on their own, as often as they like' : `Its sessions wake each other on their own (${n} times an hour each at most; back to asking you if two keep at it)`;
}

/**
 * The header's line after the name: how many sessions, and the folders they work in, the first few and "+N" (all of
 * them in its title). A project with many members never pushes its name and buttons out of view.
 */
export function headerMeta(members: Array<{ cwd: string }>, most = 3): { text: string; title: string } {
  const repos = [...new Set(members.map((s) => s.cwd.split(/[\\/]/).filter(Boolean).pop()))].filter((x): x is string => !!x);
  const count = `${members.length} session${members.length === 1 ? '' : 's'}`;
  const shown = repos.length > most ? `${repos.slice(0, most).join(', ')} +${repos.length - most}` : repos.join(', ');
  return { text: shown ? `${count} · ${shown}` : count, title: repos.length ? `${count} · ${repos.join(', ')}` : count };
}

/**
 * A project open in the main area: its header (name, colour, coordination, a new session in it, Resume all, Wrap up,
 * archive) over its own board.
 */
export function ProjectView({ id }: { id: string }) {
  const p = useProject(id);
  const sessions = useBrain((s) => s.sessions);
  const [name, setName] = useState(p?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // a team draft in progress: said here, so leaving the builder never looks like losing the work
  const draft = draftInProgress(useProjectDraft(p?.id), p?.team);
  useEffect(() => setName(p?.name ?? ''), [p?.name]);
  // gone (archived, or deleted elsewhere): back to where you were
  useEffect(() => {
    if (!p || p.archivedAt) useBrain.getState().openProject(null);
  }, [p]);
  if (!p) return null;
  const members = p.sessions.map((sid) => sessions[sid]).filter((s): s is SessionInfo => !!s);
  const ended = members.filter((s) => s.state === 'ended');
  const live = members.filter((s) => s.state !== 'ended');
  const meta = headerMeta(members);
  const rename = () => {
    if (name.trim() && name.trim() !== p.name) void updateProject(p.id, { name: name.trim() });
    else setName(p.name);
  };
  const nextColor = () => void updateProject(p.id, { color: PROJECT_COLORS[(PROJECT_COLORS.indexOf(p.color) + 1) % PROJECT_COLORS.length] });
  // every ended member back, each where it worked
  const resumeAll = async () => {
    setBusy('resume');
    for (const s of ended) await launchTerminal({ mode: 'resume', sessionId: s.id, cwd: s.wd || s.cwd }).catch(() => null);
    setBusy(null);
    useBrain.getState().openProject(p.id);
  };
  // end the live ones (as their End session would), then the project's note
  const wrapUp = async () => {
    if (live.length && !window.confirm(`Wrap up "${p.name}"? This ends ${live.map(sessionName).join(', ')}, and writes a note of what each did.`)) return;
    setBusy('wrap');
    for (const s of live) await fetch(`/api/sessions/${encodeURIComponent(s.id)}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    await wrapUpProject(p.id);
    setBusy(null);
  };
  const newSession = () => {
    useProjects.setState({ joining: p.id });
    useBrain.getState().setModal('new-session');
  };
  return (
    <div className="pjv" style={{ ['--pc' as any]: p.color }}>
      <div className="pjv-h">
        <button className="pj-sq" style={{ border: 0, cursor: 'pointer', padding: 0 }} title="Its colour (click for the next)" onClick={nextColor} />
        <input className="pjv-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Project name" />
        <span className="pjv-meta" title={meta.title}>
          {meta.text}
        </span>
        <span className="sp" />
        <button className={`pjv-sw${p.coordination ? ' on' : ''}`} onClick={() => void updateProject(p.id, { coordination: !p.coordination })} title={p.coordination ? 'Its sessions hear what you set for each (Members)' : 'Off: organisation only (no tokens spent). On: its sessions can share the brief, decisions and thread'}>
          <i /> Coordination
        </button>
        {p.coordination ? (
          <button className={`pjv-sw${p.autoWake ? ' on' : ''}`} onClick={() => void updateProject(p.id, { autoWake: !p.autoWake })} title={wakeTitle(p)}>
            <i /> Wake each other
          </button>
        ) : null}
        {/* a project without a team: how often each may be woken (a team's routes decide for its seats) */}
        {p.coordination && p.autoWake && !p.team ? (
          <select className="pjv-limit" value={String(p.wakeLimit ?? WAKE_LIMIT)} onChange={(e) => void updateProject(p.id, { wakeLimit: wakeLimitOf(e.target.value) })} title="Wake limit: how many times an hour each session may be woken by the others before it asks you again" aria-label="Wake limit">
            {WAKE_LIMITS.map((n) => (
              <option key={n} value={String(n)}>
                {n === 'none' ? 'No wake limit' : `Wake limit: ${n} an hour`}
              </option>
            ))}
          </select>
        ) : null}
        {p.coordination ? (
          <button className={`pjv-sw${p.coraRoutes ? ' on' : ''}`} onClick={() => void updateProject(p.id, { coraRoutes: !p.coraRoutes })} title={p.coraRoutes ? 'Cora routes its work on standing orders: she posts, opens and assigns incidents within its brief and decisions without asking you' : 'Cora asks you (a card) before she posts or changes its incidents. On: she routes its work on standing orders'}>
            <i /> Cora may route
          </button>
        ) : null}
        <button className={`dl-btn${draft ? ' pjv-drafting' : ''}`} onClick={() => openBuilder(p.id)} title={draft ? draft.line : builderEntry(p).title}>
          <Icon name="Network" size={13} />
          <span className="bt-l">{draft ? draft.label : p.team ? 'Edit team' : 'Build a team'}</span>
        </button>
        <button className="dl-btn" onClick={newSession} title="Start a new session in this project">
          <Icon name="Plus" size={13} />
          <span className="bt-l">Session</span>
        </button>
        {ended.length ? (
          <button className="dl-btn" disabled={!!busy} onClick={() => void resumeAll()} title={`Bring back ${ended.map(sessionName).join(', ')}`}>
            <Icon name="Play" size={13} />
            <span className="bt-l">{busy === 'resume' ? 'Resuming…' : `Resume all (${ended.length})`}</span>
          </button>
        ) : null}
        <button className="dl-btn" disabled={!!busy || !members.length} onClick={() => void wrapUp()} title="End its sessions, and keep a note of what each did">
          <Icon name="PackageCheck" size={13} />
          <span className="bt-l">{busy === 'wrap' ? 'Wrapping up…' : 'Wrap up'}</span>
        </button>
        <span className="pjv-menu">
          <button className="dl-btn" onClick={() => setMenu(!menu)} aria-label="More" title="More">
            <Icon name="Ellipsis" size={14} />
          </button>
          {menu ? (
            <div className="session-menu" style={{ position: 'absolute', right: 0, top: 34, zIndex: 90, width: 220 }} onMouseLeave={() => setMenu(false)}>
              <button className="sm-row" onClick={() => (setMenu(false), void archiveAsking(p))}>
                <Icon name="Archive" size={14} /> Archive project
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {draft ? (
        <div className="pjv-draft">
          <i />
          <span>{draft.line}</span>
          <button className="dl-btn" onClick={() => openBuilder(p.id)}>
            Continue
          </button>
        </div>
      ) : null}
      <div className="pjv-body">
        <LiveBoard sessionId={projectBoard(p.id)} />
      </div>
    </div>
  );
}

/** A session asking to wake another (a handoff or a question to an idle one): yours to allow. */
export function ProjectWakes() {
  const wakes = useProjects((s) => s.wakes);
  const projects = useProjects((s) => s.projects);
  const sessions = useBrain((s) => s.sessions);
  if (!wakes.length) return null;
  const nm = (sid: string) => (sessions[sid] ? sessionName(sessions[sid]) : 'a session');
  return (
    <div className="pj-wakes">
      {wakes.map((w) => (
        <div key={w.id} className="pj-wake" style={{ ['--pc' as any]: projects.find((p) => p.id === w.project)?.color ?? 'var(--cora)' }}>
          <span>
            <b>{nm(w.from)}</b> wants to wake <b>{nm(w.to)}</b>: “{w.text.length > 140 ? `${w.text.slice(0, 139)}…` : w.text}”
          </span>
          <span className="btns">
            <button className="no" onClick={() => void answerWake(w.id, false)}>
              Not now
            </button>
            <button className="yes" onClick={() => void answerWake(w.id, true)}>
              Wake it
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
