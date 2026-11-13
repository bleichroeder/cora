import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { sessionEvents, useBrain } from '../state/store';
import { buildSteps } from '../lib/steps';
import { buildTurns } from '../lib/turns';
import { agentColor } from '../lib/format';
import { Icon } from './Icon';
import { LiveBlock } from './LiveBlock';
import { useCursorStep } from '../lib/replay';
import { Follow } from '../lib/follow';
import { FoldView, StepView } from './StepView';
import { TurnView } from './TurnView';

export function Transcript({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const agents = useBrain((s) => s.agents);
  const filter = useBrain((s) => s.agentFilter);
  const setFilter = useBrain((s) => s.setAgentFilter);
  const hosted = useBrain((s) => s.prefs.collapseHosted && s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  useBrain((s) => s.sessions[sessionId]?.color); // re-render when main's colour changes
  const [q, setQ] = useState('');
  // the scene asks for a search when you click a file satellite
  useEffect(() => {
    const on = (e: Event) => setQ(String((e as CustomEvent).detail ?? ''));
    window.addEventListener('cora:search', on);
    return () => window.removeEventListener('cora:search', on);
  }, []);
  const events = sessionEvents(sessionId);

  const sessionAgents = useMemo(
    () => Object.values(agents).filter((a) => a.sessionId === sessionId).sort((a, b) => (a.agentId === 'main' ? -1 : b.agentId === 'main' ? 1 : a.startedAt - b.startedAt)),
    [agents, sessionId],
  );
  // which subagent each spawn started: rebuilt (and the steps with it) only when that changes, not on every agent update
  const spawnSig = sessionAgents.filter((a) => a.parentToolUseId).map((a) => `${a.parentToolUseId}>${a.agentId}`).join('|');
  const childBySpawn = useMemo(() => new Map(spawnSig ? spawnSig.split('|').map((x) => x.split('>') as [string, string]) : []), [spawnSig]);
  const steps = useMemo(() => {
    const all = buildSteps(events, filter, childBySpawn);
    if (!q.trim()) return all;
    const needle = q.toLowerCase();
    return all.filter((s) =>
      [s.text, s.prompt, ...s.items.map((i) => (i.kind === 'tool' ? `${(i.start ?? i.end)?.tool?.name} ${(i.start ?? i.end)?.tool?.summary}` : 'e' in i ? i.e.text ?? i.e.notice?.text : ''))]
        .filter(Boolean)
        .some((t) => t!.toLowerCase().includes(needle)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filter, childBySpawn, q]);
  // "All", not searching: the transcript as turns (a prompt, its work as one line, the answer); an agent's own tab and a
  // search keep the steps
  const live = useBrain((st) => ['working', 'thinking', 'needs-you'].includes(st.sessions[sessionId]?.state ?? ''));
  const asTurns = filter === 'all' && !q.trim();
  const turns = useMemo(() => (asTurns ? buildTurns(steps, live) : []), [steps, live, asTurns]);
  const count = asTurns ? turns.length : steps.length;
  const rowKey = (i: number) => (asTurns ? turns[i]?.key : steps[i]?.key) ?? i;

  const [searching, setSearching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  // whether we keep the newest activity in view (lib/follow); `follow` mirrors it for rendering the button
  const [fol] = useState(() => new Follow());
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(false);
  // Row heights are cached per step, not per index: steps shift when events land mid-list or the filter changes.
  // No virt.measure() on expand: it clears every cached height, and only rows that resize get measured again (the
  // rest fall back to the estimate and overlap). The ResizeObserver behind measureElement re-measures changed rows.
  const virt = useVirtualizer({ count, getScrollElement: () => scroller.current, estimateSize: () => (asTurns ? 160 : 90), overscan: 6, getItemKey: rowKey });
  // the timeline's playhead: scroll to the step at it and mark it
  const turnOf = (i: number) => (asTurns ? Math.max(0, turns.findIndex((t) => t.stepKeys.includes(steps[i]?.key))) : i);
  const atCursor = useCursorStep(sessionId, steps, (i) => virt.scrollToIndex(turnOf(i), { align: asTurns ? 'start' : 'center' }));

  // New activity, or another session / agent: a new view starts following here, in the same effect that scrolls,
  // so it lands at its end even when the last view was scrolled up.
  const view = `${sessionId}\n${filter}`;
  useEffect(() => {
    if (fol.setView(view)) {
      setFollow(true);
      setUnseen(false);
    }
    if (!count) return;
    if (fol.following) virt.scrollToIndex(count - 1, { align: 'end' });
    else setUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, version, view]);
  // The feed getting shorter (the terminal opening a dialog, live-activity rows) or rows growing after they were
  // measured fire no scroll event and bring no new event: keep the end in view while following.
  useEffect(() => {
    const el = scroller.current;
    const inner = sizer.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => fol.resized(el));
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [fol]);

  const onScroll = () => {
    const atBottom = fol.scrolled(scroller.current!);
    setFollow(atBottom);
    if (atBottom) setUnseen(false);
  };

  return (
    <aside className="journal">
      {!searching && !q && !sessionAgents.some((a) => a.agentId !== 'main') ? (
        <button className="jfind jfloat" title="Search the transcript" onClick={() => setSearching(true)}>
          <Icon name="Search" size={13} />
        </button>
      ) : (
      <div className="jhead">
        {searching || q ? (
          <div className="jsearch">
            <Icon name="Search" size={13} />
            <input autoFocus placeholder="Search the transcript…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setSearching(false))} />
            <button className="jx" title="Close the search (Esc)" onClick={() => (setQ(''), setSearching(false))}>
              <Icon name="X" size={12} />
            </button>
          </div>
        ) : (
          <div className="chips">
            <div className="chips-scroll" onWheel={(e) => e.deltaY && (e.currentTarget.scrollLeft += e.deltaY)}>
            <button className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            {sessionAgents.map((a) => (
              <button key={a.agentId} className={`chip${filter === a.agentId ? ' on' : ''}${a.state === 'done' ? ' done' : ''}`} title={a.state === 'done' ? 'done' : a.state === 'idle' ? 'idle' : 'live'} onClick={() => setFilter(a.agentId)}>
                <i style={{ background: agentColor(a) }} />
                {a.agentId === 'main' ? 'main' : a.label}
                {a.state !== 'done' && a.state !== 'idle' ? <span className="cl" /> : null}
              </button>
            ))}
            </div>
            <button className="jfind" title="Search the transcript" onClick={() => setSearching(true)}>
              <Icon name="Search" size={13} />
            </button>
          </div>
        )}
      </div>
      )}
      <div className={`feed${filter !== 'all' ? ' single' : ''}`} ref={scroller} onScroll={onScroll}>
        <div ref={sizer} style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const t = asTurns ? turns[vi.index] : undefined;
            const st = asTurns ? undefined : steps[vi.index];
            const here = t ? !!atCursor && t.stepKeys.includes(atCursor) : st?.key === atCursor;
            return (
              <div key={rowKey(vi.index)} data-index={vi.index} ref={virt.measureElement} className={here ? 'at-cursor' : undefined} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
                {t ? <TurnView turn={t} sessionId={sessionId} hosted={hosted} /> : st?.fold ? <FoldView step={st} sessionId={sessionId} hosted={hosted} /> : st ? <StepView step={st} sessionId={sessionId} hosted={hosted} /> : null}
              </div>
            );
          })}
        </div>
        {!steps.length ? <div className="empty">{q ? 'No matches.' : 'Nothing yet.'}</div> : null}
      </div>
      <LiveBlock sessionId={sessionId} />
      {unseen && !follow ? (
        <button
          className="more"
          onClick={() => {
            fol.resume(scroller.current!);
            setFollow(true);
            setUnseen(false);
            virt.scrollToIndex(count - 1, { align: 'end' });
          }}
        >
          ↓ new activity
        </button>
      ) : null}
    </aside>
  );
}
