import { useEffect, useState } from 'react';
import { PROJECT_COLORS, type SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { answerWake, archiveProject, projectBoard, updateProject, useProject, useProjects, wrapUpProject } from '../state/projects';
import { launchTerminal } from '../state/ws';
import { sessionName } from '../lib/format';
import { LiveBoard } from './LiveBoard';
import { Icon } from './Icon';
import './projects.css';

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
  useEffect(() => setName(p?.name ?? ''), [p?.name]);
  // gone (archived, or deleted elsewhere): back to where you were
  useEffect(() => {
    if (!p || p.archivedAt) useBrain.getState().openProject(null);
  }, [p]);
  if (!p) return null;
  const members = p.sessions.map((sid) => sessions[sid]).filter((s): s is SessionInfo => !!s);
  const ended = members.filter((s) => s.state === 'ended');
  const live = members.filter((s) => s.state !== 'ended');
  const repos = [...new Set(members.map((s) => s.cwd.split(/[\\/]/).filter(Boolean).pop()))].filter(Boolean);
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
        <span className="pjv-meta">
          {members.length} session{members.length === 1 ? '' : 's'}
          {repos.length ? ` · ${repos.join(', ')}` : ''}
        </span>
        <span className="sp" />
        <button className={`pjv-sw${p.coordination ? ' on' : ''}`} onClick={() => void updateProject(p.id, { coordination: !p.coordination })} title={p.coordination ? 'Its sessions hear what you set for each (Members)' : 'Off: organisation only (no tokens spent). On: its sessions can share the brief, decisions and thread'}>
          <i /> Coordination
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
              <button className="sm-row" onClick={() => (setMenu(false), void archiveProject(p.id, true))}>
                <Icon name="Archive" size={14} /> Archive project
              </button>
            </div>
          ) : null}
        </span>
      </div>
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
