import { FAM, recapText } from '@cora/shared';
import { useMemo } from 'react';
import type { Project, SessionInfo } from '@cora/shared';
import { useProjects } from '../state/projects';
import './projects.css';
import { sessionEvents, useBrain } from '../state/store';
import { agentColor, ago, currentAction, isDismissed, sessionColor, sessionName, shortCwd } from '../lib/format';
import { sortedSessions } from './SessionRail';
import { Icon } from './Icon';
import './overview.css';

const TILE_STATE: Record<string, string> = { working: 'work', thinking: 'think', 'needs-you': 'need' };
/** Where the agents sit in the well, by how many there are (main is on the left, at the middle). */
const ys = (n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? 50 : 18 + (64 * i) / (n - 1)));

/**
 * "Wall of minds": every live session as a card of one height. On top, the session as the nav shows it; in the
 * middle, main and its agents as dots on hairlines; below, what it's doing now and the last thing it said.
 * CSS and an SVG only, so dozens stay cheap.
 */
export function GridOverview() {
  const sessions = useBrain((s) => s.sessions);
  const agents = useBrain((s) => s.agents);
  const pending = useBrain((s) => s.pending);
  useBrain((s) => s.versions);
  const setFocus = useBrain((s) => s.setFocus);
  const list = sortedSessions(sessions).filter((s) => s.state !== 'ended' && !isDismissed(s)).slice(0, 24);
  // your projects first (each a header over its sessions' cards), then the sessions in none
  const projects = useProjects((p) => p.projects);
  const groups = useMemo(() => {
    const live = projects.filter((p) => !p.archivedAt);
    const placed = new Set<string>();
    const out: Array<{ p: Project | null; rows: SessionInfo[] }> = [];
    for (const p of live) {
      const rows = list.filter((s) => p.sessions.includes(s.id));
      rows.forEach((s) => placed.add(s.id));
      if (rows.length) out.push({ p, rows });
    }
    const rest = list.filter((s) => !placed.has(s.id));
    if (rest.length) out.push({ p: null, rows: rest });
    return out;
  }, [projects, list]);
  const grouped = groups.some((g) => g.p);
  let n = 0;

  return (
    <div className="grid-overview">
      {groups.map((g) => [
        grouped ? (
          g.p ? (
            <button key={`h-${g.p.id}`} className="ov-proj" style={{ ['--pc' as any]: g.p.color }} onClick={() => useBrain.getState().openProject(g.p!.id)} title="Its board">
              <span className="pj-sq" />
              <b>{g.p.name}</b>
              <span>
                {g.rows.length} session{g.rows.length === 1 ? '' : 's'}
              </span>
            </button>
          ) : (
            <div key="h-rest" className="ov-proj rest">
              <b>Other sessions</b>
            </div>
          )
        ) : null,
        ...g.rows.map((s) => card(s, n++)),
      ])}
      {!list.length ? <div className="empty">No live sessions.</div> : null}
    </div>
  );

  function card(s: SessionInfo, i: number) {
    {
        const events = sessionEvents(s.id);
        const subs = Object.values(agents)
          .filter((a) => a.sessionId === s.id && a.agentId !== 'main' && a.state !== 'done')
          .slice(0, 6);
        const action = currentAction(events);
        const lastSay = events.findLast((e) => e.kind === 'say');
        const live = s.state === 'working' || s.state === 'thinking';
        const name = sessionName(s);
        const at = ys(subs.length);
        const p = s.state === 'needs-you' ? pending.find((x) => x.sessionId === s.id) : undefined;
        const input = (p?.toolInput ?? {}) as { command?: unknown; file_path?: unknown };
        const waiting = p ? `${p.toolName}${typeof input.command === 'string' ? ` ${input.command}` : typeof input.file_path === 'string' ? ` ${input.file_path}` : ''}` : '';
        return (
          <button key={s.id} className={`ov-card st-${s.state}`} style={{ ['--i' as any]: i, ['--sc' as any]: sessionColor(s) }} onClick={() => setFocus(s.id)} title={`${name}\n${s.cwd}`}>
            <div className="oc-h">
              <span className={`dl-tile ${TILE_STATE[s.state] ?? ''}`}>
                {(name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
                <i />
              </span>
              <span className="oc-t">
                <b>{name}</b>
                <span>{shortCwd(s.cwd)}</span>
              </span>
              <span className="oc-n">
                {subs.length + 1} agent{subs.length ? 's' : ''}
              </span>
            </div>
            <div className="oc-well">
              <svg className="oc-lines" width="100%" height="100%" aria-hidden>
                {subs.map((a, j) => (
                  <line key={a.agentId} x1="26%" y1="50%" x2="62%" y2={`${at[j]}%`} stroke={agentColor(a)} strokeOpacity={0.38} strokeWidth={1} />
                ))}
              </svg>
              {subs.map((a, j) => (
                <span key={a.agentId} className={`oc-dot${live && a.state === 'working' ? ' live' : ''}`} style={{ ['--c' as any]: agentColor(a), left: '62%', top: `${at[j]}%` }} />
              ))}
              <span className={`oc-dot main${live ? ' live' : ''}`} style={{ ['--c' as any]: sessionColor(s), left: '26%', top: '50%' }} />
            </div>
            <div className="oc-f">
              {s.state === 'needs-you' ? (
                <span className="oc-act need">
                  <Icon name="ShieldAlert" size={12} />
                  <span>{waiting ? `Waiting for you: ${waiting}` : 'Waiting for you'}</span>
                </span>
              ) : live && action?.live && action.icon ? (
                <span className="oc-act" style={{ ['--f' as any]: FAM[action.icon.family].c }}>
                  <Icon name={action.icon.name} size={12} />
                  <span>{action.text}</span>
                </span>
              ) : (
                <span className="oc-act quiet">{s.state === 'idle' ? `Idle · ${ago(s.lastTs)}` : s.state === 'thinking' ? 'Thinking' : 'Working'}</span>
              )}
              <span className={`oc-say${s.recap ? ' recap' : ''}`} title={s.recap ? `Recap, ${ago(s.recap.at)} ago` : undefined}>{(s.recap ? recapText(s.recap.text) : "") || (lastSay?.text ?? s.title ?? shortCwd(s.cwd))}</span>
            </div>
          </button>
        );
    }
  }
}
