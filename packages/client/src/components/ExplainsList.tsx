import { useEffect, useMemo, useState } from 'react';
import type { BrainEvent } from '@cora/shared';
import { useBrain } from '../state/store';
import { ago, clock, sessionColor, sessionName } from '../lib/format';
import { explainFrom } from './Viewer';
import { latestByTitle } from '../lib/explainVersions';
import { Icon } from './Icon';

/** A day's label: Today, Yesterday, or the date. */
function dayOf(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

async function fetchExplains(sessionId?: string): Promise<BrainEvent[]> {
  const r = await fetch(`/api/explains?limit=300${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`);
  return r.ok ? (await r.json()).explains : [];
}

/** Every explain Claude created: this session, or all sessions. */
export function ExplainsList({ sessionId }: { sessionId: string }) {
  const [scope, setScope] = useState<'session' | 'all'>('session');
  const [items, setItems] = useState<BrainEvent[] | null>(null);
  const version = useBrain((s) => (scope === 'session' ? s.versions[sessionId] : s.lastSeq));
  const sessions = useBrain((s) => s.sessions);
  const viewer = useBrain((s) => s.viewer);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => void fetchExplains(scope === 'session' ? sessionId : undefined).then((x) => live && setItems(x)), 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [scope, sessionId, version]);

  // grouped by day, newest first; one row per explain (a title written again is a new version of it)
  const groups = useMemo(() => {
    const out: Array<[string, BrainEvent[]]> = [];
    const newest = new Set(latestByTitle((items ?? []).flatMap((e) => (explainFrom(e) ? [{ id: e.id, sessionId: e.sessionId, title: explainFrom(e)!.title, ts: e.ts }] : []))).map((x) => x.id));
    for (const e of items ?? []) {
      if (!explainFrom(e) || !newest.has(e.id)) continue;
      const d = dayOf(e.ts);
      const g = out.find((x) => x[0] === d);
      if (g) g[1].push(e);
      else out.push([d, [e]]);
    }
    return out;
  }, [items]);

  const open = (e: BrainEvent) => {
    const p = explainFrom(e);
    if (!p) return;
    // another session's explain opens right here (its session may be dismissed, so focus can't follow it)
    const st = useBrain.getState();
    st.setViewer(st.focus === e.sessionId ? p : { ...p, pinned: true });
  };

  return (
    <div className="explains">
      <div className="ex-scope">
        <button className={`chip${scope === 'session' ? ' on' : ''}`} onClick={() => setScope('session')}>This session</button>
        <button className={`chip${scope === 'all' ? ' on' : ''}`} onClick={() => setScope('all')}>All sessions</button>
      </div>
      <div className="ex-list">
        {items === null ? <div className="dim pad">loading…</div> : null}
        {items?.length === 0 ? (
          <div className="empty">No explains yet. In sessions started from Cora, Claude creates explains for tables, reports and charts; they collect here.</div>
        ) : null}
        {groups.map(([day, list]) => (
          <section key={day}>
            <div className="ex-gh">
              <span>{day}</span>
              <span className="ex-n">{list.length}</span>
              <span className="ex-rule" />
            </div>
            {list.map((e) => {
              const p = explainFrom(e);
              if (!p) return null;
              const s = sessions[e.sessionId];
              const html = p.format === 'html';
              return (
                <button key={e.id} className={`ex-row${viewer?.toolUseId === p.toolUseId ? ' on' : ''}${html ? ' html' : ''}`} onClick={() => open(e)} title={p.title}>
                  <span className="ex-tile">
                    <Icon name={html ? 'Monitor' : 'FileText'} size={14} />
                  </span>
                  <span className="ex-main">
                    <span className="ex-t">
                      {p.title}
                      {/* live: its session is still working on it */}
                      {p.live && s && s.state !== 'ended' && s.state !== 'idle' ? <i className="ex-live" title="Live: updating as its session works" /> : null}
                    </span>
                    <span className="ex-l2">
                      {scope === 'all' && s ? (
                        <span className="ex-s">
                          <i style={{ background: sessionColor(s) }} />
                          {sessionName(s)}
                        </span>
                      ) : null}
                      <span>{p.live ? 'live' : html ? 'HTML' : 'markdown'} · {dayOf(e.ts) === 'Today' ? `${p.live ? 'updated ' : ''}${ago(e.ts)} ago` : clock(e.ts)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
