import { useEffect, useState } from 'react';
import { useBrain } from '../state/store';
import { isDismissed, sessionColor, sessionName, tokens } from '../lib/format';
import './overview.css';

type Totals = { out: number; in: number; cached: number; calls: number; turns: number };
type Usage = { days: Array<Totals & { day: string; sessions: number }>; today: Totals & { day: string; sessions: number }; sessions: Array<Totals & { sessionId: string }> };

const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

/**
 * The overview's strip: today's numbers (the figure bright, its unit quiet), the week as seven bars, and on the
 * right what needs you and the sessions that used the most today.
 */
export function UsageStrip() {
  const [u, setU] = useState<Usage | null>(null);
  const sessions = useBrain((s) => s.sessions);
  useEffect(() => {
    let live = true;
    const load = () => void fetch('/api/usage?days=7').then((r) => (r.ok ? r.json() : null)).then((j) => live && j && setU(j)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const needs = Object.values(sessions).filter((s) => s.state === 'needs-you' && !isDismissed(s));
  const t = u?.today;
  const peak = Math.max(1, ...(u?.days.map((d) => d.out) ?? []));
  const cachedPct = t?.in ? Math.round((t.cached / t.in) * 100) : 0;
  return (
    <>
      {t ? (
        <div className="ov-stats">
          <span className="ov-sl">Today</span>
          <span className="ov-stat" title="Output tokens Claude generated today">
            <b>{tokens(t.out)}</b>out
          </span>
          <span className="ov-stat" title={`Input tokens processed today (whole prompts, including ${tokens(t.cached)} read from cache)`}>
            <b>{tokens(t.in)}</b>in{t.cached ? <span className="q">· {cachedPct}% cached</span> : null}
          </span>
          <span className="ov-stat">
            <b>{t.sessions}</b>session{t.sessions === 1 ? '' : 's'}
          </span>
          <span className="ov-stat">
            <b>{t.turns}</b>turn{t.turns === 1 ? '' : 's'}
          </span>
          <span className="ov-week" title="Output tokens per day, last 7 days">
            {u!.days.map((d) => (
              <i key={d.day} className={d.day === t.day ? 'today' : ''} style={{ height: `${Math.max(10, (d.out / peak) * 100)}%` }} title={`${weekday(d.day)} ${d.day}: ${tokens(d.out)} out · ${tokens(d.in)} in · ${d.sessions} sessions`} />
            ))}
          </span>
        </div>
      ) : null}
      <span className="ov-most">
        {needs.length ? (
          <button className="ov-need" title="Open the first one" onClick={() => useBrain.getState().setFocus(needs[0].id)}>
            <i />
            {needs.length} need{needs.length === 1 ? 's' : ''} you
          </button>
        ) : null}
        {u?.sessions.length ? <span className="ov-sl">Most today</span> : null}
        {u?.sessions.slice(0, 3).map((s) => {
          const info = sessions[s.sessionId];
          const name = info ? sessionName(info) : s.sessionId.slice(0, 8);
          return (
            <button key={s.sessionId} className="ov-top" title={`${tokens(s.out)} out today`} onClick={() => useBrain.getState().setFocus(s.sessionId)}>
              <span className="dl-tile" style={{ ['--sc' as any]: info ? sessionColor(info) : '#475569' }}>
                {(name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
              </span>
              {name}
              <span className="q">{tokens(s.out)}</span>
            </button>
          );
        })}
      </span>
    </>
  );
}
