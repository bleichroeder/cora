import { useEffect, useMemo, useRef } from 'react';
import { dockSpotlight } from '../../state/boardDock';
import { ciActive } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { useDeploys } from '../../state/deploys';
import { choose, spotKey, spotName, ASKABLE, type Spot, type SpotKind, type SpotSignals } from '../../lib/spotlight';
import { TEST_CMD, testCounts } from '../../lib/testRuns';
import type { BoardItem } from '../../lib/boardLayout';
import { useFollowed } from '../CiStrip';
import { Icon } from '../Icon';
import type { BoardData } from '../LiveBoard';

/**
 * The Spotlight panel: whatever matters in the session now (lib/spotlight decides), shown with the panel it is, a word
 * on why, and a pin to keep it. It reads the session as it goes: approvals waiting, test runs, the pipeline, a deploy
 * rolling, live explains, the web, edits, background commands, and Claude's asks (the spotlight tool).
 */
export function SpotlightPanel({ sessionId, data, item, onPage, onPin, render }: { sessionId: string; data: BoardData; item: BoardItem; onPage: Set<string>; onPin(pin?: string): void; render(spot: Spot): React.ReactNode }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const needs = useBrain((s) => s.pending.filter((p) => p.sessionId === sessionId).length);
  const recapAt = useBrain((s) => s.sessions[sessionId]?.recap?.at);
  const f = useFollowed(sessionId, 3600_000);
  const rolling = useDeploys((d) => {
    const j = d.s.journeys.find((x) => x.sessionId === sessionId);
    return !!j && d.s.bumps.some((b) => b.project === j.project && b.state === 'rolling');
  });
  const tick = Math.floor(data.now / 5000);
  // while it's up, explains land here rather than opening over the board
  useEffect(() => dockSpotlight(sessionId), [sessionId]);
  const seen = useMemo(() => {
    let asked: SpotSignals['asked'];
    let editAt: number | undefined;
    let testsFailedAt: number | undefined;
    const tests = new Map<string, boolean>();
    for (const e of sessionEvents(sessionId)) {
      if (e.kind !== 'tool' || !e.tool) continue;
      const name = e.tool.name;
      if (e.phase === 'start') {
        if (/__spotlight$/.test(name)) {
          const i = (e.tool.input ?? {}) as { panel?: string; explain?: string; reason?: string };
          if (ASKABLE.includes(i.panel as SpotKind)) asked = { k: i.panel as SpotKind, ...(i.explain ? { title: i.explain } : {}), ...(i.reason ? { why: i.reason } : {}), at: e.ts };
        }
        if ((name === 'Bash' || name === 'PowerShell') && e.toolUseId && TEST_CMD.test(String((e.tool.input as { command?: unknown } | undefined)?.command ?? e.tool.summary ?? ''))) tests.set(e.toolUseId, true);
      } else {
        if (e.tool.change && !e.tool.failed) editAt = e.ts;
        if (e.toolUseId && tests.has(e.toolUseId)) {
          tests.set(e.toolUseId, false);
          if (e.tool.failed || (testCounts(String(e.tool.preview ?? ''))?.fail ?? 0) > 0) testsFailedAt = e.ts;
          else testsFailedAt = undefined;
        }
      }
    }
    return { asked, editAt, testsFailedAt, testsRunning: [...tests.values()].some(Boolean) };
  }, [sessionId, version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = data.explains.filter((x) => x.live).sort((a, b) => b.ts - a.ts)[0];
  // an explain Claude wrote is Claude's pick too: the newer of it and the last spotlight ask
  const wrote = data.explains[0];
  const asked = wrote && (!seen.asked || wrote.ts > seen.asked.at) ? { k: 'explain' as const, title: wrote.title, why: 'Claude wrote this', at: wrote.ts } : seen.asked;
  const signals: SpotSignals = {
    now: data.now,
    needs,
    ...seen,
    ...(asked ? { asked } : {}),
    ...(f ? { pipeline: { active: ciActive(f.p.status), ...(f.p.status === 'failed' && f.p.finishedAt ? { failedAt: f.p.finishedAt } : {}) } } : {}),
    deployRolling: rolling,
    ...(live ? { live: { title: live.title, at: live.ts } } : {}),
    background: data.d.tasks.filter((t) => t.status === 'running').length,
    ...(recapAt ? { recapAt } : {}),
  };
  // what it shows, and since when (kept while the panel is up)
  const cur = useRef<{ spot: Spot; since: number } | null>(null);
  const spot = choose(signals, cur.current, onPage, item.pin);
  if (!cur.current || spotKey(cur.current.spot) !== spotKey(spot)) cur.current = { spot, since: data.now };
  else cur.current.spot = spot;
  const key = spotKey(spot);
  return (
    <div className="lb-spot">
      <div className="lb-spot-h">
        <span className={`dot${spot.prio >= 60 ? ' hot' : ''}`} />
        <b>{spotName(spot)}</b>
        <span className="why">{spot.why}</span>
        <span className="sp" />
        <button className={`ib${item.pin ? ' on' : ''}`} title={item.pin ? 'Unpin: follow what happens again' : 'Pin: keep showing this'} onClick={() => onPin(item.pin ? undefined : key)}>
          <Icon name={item.pin ? 'PinOff' : 'Pin'} size={12} />
        </button>
      </div>
      <div key={key} className="lb-spot-b">
        {render(spot)}
      </div>
    </div>
  );
}
