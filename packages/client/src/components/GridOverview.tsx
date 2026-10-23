import { FAM, recapText } from '@cora/shared';
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

  return (
    <div className="grid-overview">
      {list.map((s, i) => {
        const events = sessionEvents(s.id);
        const subs = Object.values(agents)
          .filter((a) => a.sessionId === s.id && a.agentId !== 'main' && a.state !== 'done')
          .slice(0, 6);
        const action = currentAction(events);
        const lastSay = [...events].reverse().find((e) => e.kind === 'say');
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
      })}
      {!list.length ? <div className="empty">No live sessions.</div> : null}
    </div>
  );
}
