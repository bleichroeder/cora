import { useEffect, useMemo, useState } from 'react';
import type { HistoryItem } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { fetchHistory, useOlder } from '../../state/ws';
import { ago, prettyModel, tokens } from '../../lib/format';
import { Markdown } from '../Markdown';
import type { BoardData } from '../LiveBoard';
import { PlanUsage } from '../AccountUsage';
import { Icon } from '../Icon';
import { openUsage, useAccountUsage, useWatchUsage } from '../../state/accountUsage';

/* ------------------------------------------------------------------ Context */

/**
 * How full the context window is: the share used (green, amber, then red as it fills), the tokens, when it last
 * compacted, a line of how it filled over the session, and at the rate of the last ten minutes, about when it fills.
 */
export function ContextPanel({ sessionId, data }: { sessionId: string; data: BoardData }) {
  const ctx = data.d.context;
  const model = useBrain((s) => s.sessions[sessionId]?.model);
  const version = useBrain((s) => s.versions[sessionId]);
  // main's usage over the session, from each turn's tokens; compactions drop it
  const points = useMemo(() => {
    const out: Array<{ ts: number; used: number }> = [];
    for (const e of sessionEvents(sessionId)) {
      if (e.agentId !== 'main') continue;
      if (e.tokens) out.push({ ts: e.ts, used: e.tokens.in + e.tokens.out });
      else if (e.kind === 'compact') out.push({ ts: e.ts, used: 0 });
    }
    return out;
  }, [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx) return <div className="lb-empty">No context use read yet.</div>;
  const share = Math.min(1, ctx.used / ctx.max);
  const color = share < 0.6 ? 'var(--work)' : share < 0.8 ? 'var(--think)' : 'var(--need)';
  // the rate over the last ten minutes (since the last compaction), for "about when it fills"
  const since = Math.max(data.now - 10 * 60_000, ctx.compactedAt ?? 0);
  const recent = points.filter((p) => p.ts >= since && p.used > 0);
  const rate = recent.length > 1 ? (recent[recent.length - 1].used - recent[0].used) / Math.max(1, recent[recent.length - 1].ts - recent[0].ts) : 0;
  const left = rate > 0 ? (ctx.max - ctx.used) / rate : null;
  const pm = prettyModel(model);
  return (
    <div className="lb-ctx" style={{ ['--c' as string]: color }}>
      <div className="big">
        <b>{Math.round(share * 100)}%</b>
        <span>
          {tokens(ctx.used)} of {tokens(ctx.max)} tokens{pm ? ` · ${pm.name}` : ''}
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${share * 100}%` }} />
      </div>
      <div className="facts">
        <span>{ctx.compactedAt ? `compacted ${ago(ctx.compactedAt, data.now)} ago` : 'not compacted yet'}</span>
        {left != null && left < 6 * 3600_000 ? <span>at this rate, full in about {left < 60_000 ? 'a minute' : `${Math.round(left / 60_000)} min`}</span> : null}
      </div>
      <Spark points={points} max={ctx.max} />
    </div>
  );
}

function Spark({ points, max }: { points: Array<{ ts: number; used: number }>; max: number }) {
  if (points.length < 2) return null;
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const W = 300;
  const H = 60;
  const x = (ts: number) => ((ts - t0) / Math.max(1, t1 - t0)) * W;
  const y = (u: number) => H - (Math.min(u, max) / max) * H;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.used).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Context use over the session">
      <line x1="0" x2={W} y1={y(max * 0.8)} y2={y(max * 0.8)} className="warn" />
      <path d={`${d} L${W},${H} L0,${H} Z`} className="fill" />
      <path d={d} className="line" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Usage */

/** Your plan's limits and extra usage (the same for every session), with the fuller view a click away. */
export function UsagePanel() {
  useWatchUsage();
  const u = useAccountUsage((a) => a.u);
  return (
    <div className="lb-usage">
      <PlanUsage u={u} />
      <button className="lb-pop" onClick={() => openUsage()}>
        <Icon name="Gauge" size={11} /> All usage
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ Goal */

/** What the session was asked first (from its history if the start isn't loaded), and the latest ask. */
export function GoalPanel({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const s = useBrain((st) => st.sessions[sessionId]);
  const older = useOlder((o) => !!o[sessionId]);
  const prompts = useMemo(
    () =>
      sessionEvents(sessionId)
        .filter((e) => e.kind === 'prompt' && e.agentId === 'main' && !e.queue && !e.midTurn && e.text)
        .sort((a, b) => a.ts - b.ts),
    [sessionId, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // the first prompt isn't loaded: the session history has it
  const [hist, setHist] = useState<HistoryItem | null>(null);
  useEffect(() => {
    if (!older) return;
    let on = true;
    void fetchHistory().then((h) => on && setHist(h.find((x) => x.sessionId === sessionId) ?? null));
    return () => void (on = false);
  }, [older, sessionId]);
  const first = older ? (hist?.firstPrompt ?? null) : (prompts[0]?.text ?? null);
  const latest = prompts.at(-1);
  const [more, setMore] = useState(false);
  if (!first && !latest) return <div className="lb-empty">No prompt yet.</div>;
  return (
    <div className="lb-goal">
      {s?.title ? <div className="ttl">{s.title}</div> : null}
      <div className="lb-gh">Asked{prompts[0] && !older ? ` · ${ago(prompts[0].ts)}` : ''}</div>
      <div className={`ask${more ? ' open' : ''}`}>
        <Markdown text={first ?? '…'} />
      </div>
      {(first?.length ?? 0) > 280 ? (
        <button className="more" onClick={() => setMore(!more)}>
          {more ? 'less' : 'more'}
        </button>
      ) : null}
      {latest && latest.text !== first && prompts.length > 1 ? (
        <>
          <div className="lb-gh">
            Latest · {ago(latest.ts)} · {prompts.length} prompts{older ? ' loaded' : ''}
          </div>
          <div className="ask last">
            <Markdown text={latest.text ?? ''} />
          </div>
        </>
      ) : null}
    </div>
  );
}
