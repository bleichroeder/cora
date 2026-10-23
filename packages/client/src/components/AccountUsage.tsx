import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccountUsage, UsageLimit } from '@cora/shared';
import { openUsage, useAccountUsage, useWatchUsage } from '../state/accountUsage';
import { useBrain } from '../state/store';
import { isDismissed, sessionColor, sessionName, tokens } from '../lib/format';
import { Icon } from './Icon';
import './accountUsage.css';

/** When a limit resets: "7 pm" today, "Tue 4 am" later; and how long until. */
export function resetText(at: number | undefined, now = Date.now()): string {
  if (!at) return '';
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  const left = at - now;
  const inText = left <= 0 ? 'now' : left < 3600_000 ? `${Math.max(1, Math.round(left / 60_000))}m` : left < 86_400_000 ? `${Math.floor(left / 3600_000)}h ${Math.round((left % 3600_000) / 60_000)}m` : `${Math.round(left / 86_400_000)}d`;
  return `resets ${today ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`} · in ${inText}`;
}
/** A share as the meter's colour: green, then amber, then red as it fills. */
export const levelColor = (pct: number) => (pct < 60 ? 'var(--work)' : pct < 85 ? 'var(--think)' : 'var(--need)');
const money = (n: number, cur: string) => n.toLocaleString(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 });

function Limit({ l, big }: { l: UsageLimit; big?: boolean }) {
  return (
    <div className={`au-l${big ? ' big' : ''}`} style={{ ['--c' as string]: levelColor(l.percent) }}>
      <div className="h">
        <span className="n">{l.label}</span>
        <b>{Math.round(l.percent)}%</b>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.min(100, l.percent)}%` }} />
      </div>
      {l.resetsAt ? <div className="r">{resetText(l.resetsAt)}</div> : null}
    </div>
  );
}

/** The plan's limits and extra usage, as rows with bars (`compact`: the session and the week only). */
export function PlanUsage({ u, compact }: { u: AccountUsage | null; compact?: boolean }) {
  if (!u) return <div className="au-msg">Reading your usage…</div>;
  if (u.state !== 'ok') return <div className="au-msg">{u.message ?? "Your usage couldn't be read."}</div>;
  const limits = compact ? u.limits.filter((l) => l.kind === 'session' || l.kind === 'weekly_all') : u.limits;
  return (
    <div className={`au${compact ? ' compact' : ''}`}>
      {limits.map((l) => (
        <Limit key={l.kind + l.label} l={l} big={!compact} />
      ))}
      {u.extra && !compact ? (
        <div className="au-l big" style={{ ['--c' as string]: levelColor(u.extra.percent) }}>
          <div className="h">
            <span className="n">Extra usage this month</span>
            <b>
              {money(u.extra.used, u.extra.currency)} <span className="of">of {money(u.extra.limit, u.extra.currency)}</span>
            </b>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.min(100, u.extra.percent)}%` }} />
          </div>
        </div>
      ) : u.extra ? (
        <div className="au-x">
          Extra usage {money(u.extra.used, u.extra.currency)} of {money(u.extra.limit, u.extra.currency)}
        </div>
      ) : null}
    </div>
  );
}

type Tokens = { days: Array<{ day: string; out: number; in: number; cached: number; sessions: number }>; today: { out: number; in: number; cached: number; calls: number; turns: number; sessions: number }; sessions: Array<{ sessionId: string; out: number }> };

/** The fuller view: your plan's limits and extra usage, and what Cora saw your sessions use today and this week. */
export function UsageView() {
  const open = useAccountUsage((s) => s.open);
  if (!open) return null;
  return <UsageDialog />;
}

function UsageDialog() {
  useWatchUsage();
  const u = useAccountUsage((s) => s.u);
  const sessions = useBrain((s) => s.sessions);
  const [t, setT] = useState<Tokens | null>(null);
  useEffect(() => {
    void fetch('/api/usage?days=7')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setT(j))
      .catch(() => {});
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && openUsage(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const peak = Math.max(1, ...(t?.days.map((d) => d.out) ?? [1]));
  return createPortal(
    <div className="modal-bg" onMouseDown={() => openUsage(false)}>
      <div className="modal dlg usage-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span className="dlg-t">
            <Icon name="Gauge" size={15} /> Usage{u?.plan ? <span className="au-plan">{u.plan} plan</span> : null}
          </span>
          <span style={{ flex: 1 }} />
          <button className="dlg-x" onClick={() => openUsage(false)} title="Close (Esc)">
            <Icon name="X" size={14} />
          </button>
        </div>
        <div className="dlg-b">
          <div className="dlg-gl">Your plan</div>
          <PlanUsage u={u} />
          {t ? (
            <>
              <div className="dlg-gl">What your sessions used · seen by Cora</div>
              <div className="au-days">
                {t.days.map((d) => (
                  <div key={d.day} className="d" title={`${d.day}: ${tokens(d.out)} out, ${tokens(d.in)} in, ${d.sessions} session${d.sessions === 1 ? '' : 's'}`}>
                    <i style={{ height: `${Math.max(3, (100 * d.out) / peak)}%` }} />
                    <span>{new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short' })}</span>
                  </div>
                ))}
              </div>
              <div className="au-today">
                Today: <b>{tokens(t.today.out)}</b> out · <b>{tokens(t.today.in)}</b> in ({t.today.in ? Math.round((100 * t.today.cached) / t.today.in) : 0}% from cache) · {t.today.turns} turns · {t.today.sessions} session{t.today.sessions === 1 ? '' : 's'}
              </div>
              {t.sessions.length ? (
                <div className="au-ses">
                  {t.sessions.slice(0, 6).map((x) => {
                    const s = sessions[x.sessionId];
                    if (!s || isDismissed(s)) return null;
                    return (
                      <div key={x.sessionId} className="s">
                        <i style={{ background: sessionColor(s) }} />
                        <span>{sessionName(s)}</span>
                        <b>{tokens(x.out)}</b>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
          <div className="au-note">Your plan's numbers are what Claude Code's /usage shows, read with its login about once a minute.</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
