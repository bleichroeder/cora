import { useEffect, useMemo, useRef, useState } from 'react';
import { FAM, shortToolName } from '@cora/shared';
import { agentKey, sessionEvents, useBrain } from '../state/store';
import { agentColor, clock } from '../lib/format';
import { blocksFrom, cluster, cursorAt, cursorLabel, fracOf, stackRows, ticks, type Block, type View } from '../lib/timeline';
import { markersFrom, MARKER_RANK, type Marker, type MarkerKind } from '../lib/markers';
import { ciMarkers } from '../lib/ci';
import { useCi } from '../state/ci';
import { loadOlder, useOlder } from '../state/ws';
import { openChanges, turnsFor } from '../lib/changes';
import { explainFrom } from './Viewer';
import './strip.css';
import { Icon } from './Icon';

const WINDOWS = [
  { label: '30s', ms: 30_000 },
  { label: '2m', ms: 120_000 },
  { label: '10m', ms: 600_000 },
];
/** the lane names' column and the right margin (px): the axis, markers and lanes all share this span */
const LEFT = 128;
const RIGHT = 14;
/** markers closer than this (px) share a pin */
const MARKER_PX = 16;
/** a press that moves less than this (px) is a click */
const CLICK_PX = 4;
const CARD_W = 300;
const CARD_ITEMS = 6;

export const MARKER_COLOR: Record<MarkerKind, string> = { needs: '#f87171', fail: '#fb923c', prompt: '#7dd3fc', explain: '#f0abfc', edit: '#fbbf24', task: '#a78bfa', compact: '#e2e8f0', ci: '#60a5fa' };
const markerColor = (m: Marker) => ((m.kind === 'task' && m.key.startsWith('bg-end:')) || (m.kind === 'ci' && m.key.startsWith('ci-end:')) ? (m.bad ? '#f87171' : '#4ade80') : MARKER_COLOR[m.kind]);
const pct = (f: number) => `${f * 100}%`;

type Pin = { x: number; items: Array<Marker & { x: number }>; top: Marker & { x: number } };
/** a press on the strip: scrubbing the playhead, or on a lane (a click, or a drag that pans); `blk`: the block it began on */
type Press = { mode: 'scrub' | 'lanes' | 'pan'; x0: number; off0: number; blk?: string };

/**
 * The timeline under the scene: a lane per agent (its tool calls and thinking), markers for the moments worth finding
 * again, and a playhead. Drag the playhead (or click the axis, a lane or a marker) to rewind the scene and the
 * transcript to that moment; drag a lane sideways to pan; back to live with the button or by dropping the playhead at
 * the right edge.
 */
export function Strip({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const agents = useBrain((s) => s.agents);
  const allWaits = useBrain((s) => s.waits);
  const cursor = useBrain((s) => (s.cursor?.sessionId === sessionId ? s.cursor : null));
  const [win, setWin] = useState(WINDOWS[0]);
  const [offset, setOffset] = useState(0); // ms into the past
  const [now, setNow] = useState(Date.now());
  const [width, setWidth] = useState(600);
  const [pressing, setPressing] = useState<Press['mode'] | null>(null);
  const [card, setCard] = useState<Pin | null>(null);
  const [more, setMore] = useState(false);
  const press = useRef<Press | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const lanesEl = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setOffset(0);
    setCard(null);
  }, [sessionId]);
  useEffect(() => {
    const el = ruler.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view: View = { end: now - offset, span: win.ms };
  const start = view.end - view.span;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // a long session's earlier events, loaded when asked for
  const older = useOlder((o) => !!o[sessionId]);
  const [fetching, setFetching] = useState(false);
  const blocks = useMemo(() => blocksFrom(sessionEvents(sessionId), now), [version, sessionId]);
  // the session's GitLab pipelines: when each started and how it ended
  const ciLink = useCi((c) => c.links[sessionId]);
  const ciPipes = useCi((c) => c.pipelines);
  const markers = useMemo(
    () => [...markersFrom(sessionEvents(sessionId), allWaits.filter((w) => w.sessionId === sessionId)), ...ciMarkers(ciLink, ciPipes)].sort((a, b) => a.ts - b.ts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, sessionId, allWaits, ciLink, ciPipes],
  );
  const visible = blocks.filter((b) => (b.to ?? now) >= start && b.from <= view.end);
  const waits = markers.filter((m) => m.kind === 'needs' && m.to !== undefined && (m.to ?? now) >= start && m.ts <= view.end);
  const laneIds = useMemo(() => {
    const ids = new Set([...visible, ...waits].map((b) => b.agentId));
    for (const a of Object.values(agents)) if (a.sessionId === sessionId && (a.state === 'working' || a.state === 'thinking')) ids.add(a.agentId);
    return [...ids].sort((x, y) => (x === 'main' ? -1 : y === 'main' ? 1 : (agents[agentKey(sessionId, x)]?.startedAt ?? 0) - (agents[agentKey(sessionId, y)]?.startedAt ?? 0)));
  }, [visible, waits, agents, sessionId]);
  const pins: Pin[] = cluster(
    markers.filter((m) => m.ts >= start && m.ts <= view.end).map((m) => ({ ...m, x: fracOf(m.ts, view) * width })),
    MARKER_PX,
  ).map((c) => ({ ...c, top: [...c.items].sort((a, b) => MARKER_RANK[a.kind] - MARKER_RANK[b.kind])[0] }));
  const tickList = ticks(view, now, width);

  // more lanes than fit: the list fades out at the bottom
  useEffect(() => {
    const el = lanesEl.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, [laneIds.length]);

  const jump = (m: Marker) => {
    useBrain.getState().setCursor({ sessionId, ts: Math.min(m.ts, Date.now()), ...(m.eventId ? { eventId: m.eventId } : {}), ...(m.toolUseId ? { toolUseId: m.toolUseId } : {}) });
    useBrain.getState().setRightTab('transcript');
  };
  const live = () => {
    useBrain.getState().setCursor(null);
    setOffset(0);
  };
  const xOf = (clientX: number) => clientX - (ruler.current?.getBoundingClientRect().left ?? 0);
  const scrubTo = (clientX: number) => {
    const ts = cursorAt(xOf(clientX), width, view, Date.now());
    useBrain.getState().setCursor(ts == null ? null : { sessionId, ts });
  };

  const onDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    const mode = t.closest('.tl-ruler, .tl-knob') ? 'scrub' : t.closest('.tl-lanes') ? 'lanes' : null;
    if (!mode) return;
    // the root captures the pointer, so later events no longer say what was under it: remember the block now
    press.current = { mode, x0: ev.clientX, off0: offset, blk: t.closest<HTMLElement>('[data-blk]')?.dataset.blk };
    setPressing(mode);
    setCard(null);
    root.current?.setPointerCapture(ev.pointerId);
    if (mode === 'scrub') scrubTo(ev.clientX);
  };
  const onMove = (ev: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (p.mode === 'scrub') return scrubTo(ev.clientX);
    // dragging a lane sideways pans through time
    if (p.mode === 'lanes' && Math.abs(ev.clientX - p.x0) > CLICK_PX) (p.mode = 'pan'), setPressing('pan');
    if (p.mode === 'pan') setOffset(Math.max(0, p.off0 + ((ev.clientX - p.x0) / Math.max(1, width)) * win.ms));
  };
  const onUp = (ev: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    setPressing(null);
    // on the lane names: nothing to rewind to
    if (p?.mode !== 'lanes' || xOf(ev.clientX) < 0) return;
    // a click on a lane: a block rewinds to its start (and its row in the transcript), elsewhere to that moment
    const b = p.blk ? blocks.find((x) => x.key === p.blk) : undefined;
    if (b) {
      useBrain.getState().setCursor({ sessionId, ts: b.from, ...(b.kind === 'tool' ? { toolUseId: b.key } : { eventId: b.e.id }) });
      useBrain.getState().setRightTab('transcript');
    } else scrubTo(ev.clientX);
  };
  const onWheel = (ev: React.WheelEvent) => {
    // sideways (or shift+wheel) pans; up/down scrolls the lanes
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.shiftKey ? ev.deltaY : 0;
    if (d) setOffset((o) => Math.max(0, o - (d / Math.max(1, width)) * win.ms));
  };

  const openCard = (p: Pin) => {
    clearTimeout(closing.current);
    if (!press.current) setCard(p);
  };
  const closeCard = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setCard(null), 300);
  };
  useEffect(() => () => clearTimeout(closing.current), []);

  const head = cursor ? cursor.ts : now;
  const headF = fracOf(head, view);
  const showHead = cursor ? true : offset === 0;
  const after = (ts: number) => cursor != null && ts > cursor.ts;
  const stripW = root.current?.clientWidth ?? LEFT + width + RIGHT;
  // the open card follows its pin as time moves it along. Once the pin has slid out of view (or merged), the card
  // goes too: the pointer can't leave a pin that's gone, so nothing else would close it (it hung over the scene).
  const pin = card ? (pins.find((p) => p.top.key === card.top.key) ?? null) : null;
  useEffect(() => {
    if (card && !pin) setCard(null);
  }, [card, pin]);

  return (
    <div
      ref={root}
      className={`strip${cursor ? ' replay' : ''}${pressing ? ` pressing ${pressing}` : ''}`}
      style={{ ['--tl-l' as any]: `${LEFT}px`, ['--tl-r' as any]: `${RIGHT}px` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onWheel={onWheel}
    >
      <div className="tl-head">
        <div className="tl-state">
          {older ? (
            <button
              className="tl-older"
              disabled={fetching}
              title={fetching ? 'Loading earlier events…' : 'A long session: only its newest events are loaded. Click to load the ones before them.'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setFetching(true);
                void loadOlder(sessionId).finally(() => setFetching(false));
              }}
            >
              <Icon name={fetching ? 'LoaderCircle' : 'History'} size={12} />
            </button>
          ) : null}
          {cursor || offset > 0 ? (
            <button className="tl-live-btn" title="Back to now" onPointerDown={(e) => e.stopPropagation()} onClick={live}>
              <Icon name="Radio" size={11} /> live
            </button>
          ) : (
            <span className="tl-live" title="Showing now: drag the playhead to rewind">
              <i /> live
            </span>
          )}
        </div>
        <div className="tl-ruler" ref={ruler} title="Click or drag to rewind">
          {tickList.map((t) => (
            <div key={t.label} className="tl-tick" style={{ left: pct(t.frac) }}>
              <span>{t.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="tl-marks">
        <div className="tl-zoom" onPointerDown={(e) => e.stopPropagation()}>
          {WINDOWS.map((w) => (
            <button key={w.label} className={w === win ? 'on' : ''} onClick={() => setWin(w)}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="tl-pins">
          {pins.map((p) => (
            <button
              key={p.top.key}
              className={`tl-pin ${p.top.kind}${p.top.kind === 'needs' && p.top.to === null ? ' open' : ''}${after(p.top.ts) ? ' after' : ''}${card?.top.key === p.top.key ? ' on' : ''}`}
              style={{ left: p.x, ['--c' as any]: markerColor(p.top) }}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerEnter={() => openCard(p)}
              onPointerLeave={closeCard}
              onClick={() => jump(p.top)}
            >
              <Icon name={p.top.icon} size={9} />
              {p.items.length > 1 ? <span className="n">{p.items.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div ref={lanesEl} className={`tl-lanes${more ? ' has-more' : ''}`} onScroll={(e) => setMore(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight > 2)}>
        {laneIds.map((aid) => {
          const a = agents[agentKey(sessionId, aid)];
          const color = agentColor(a ?? { agentId: aid, colorIdx: 0, sessionId });
          const active = a?.state === 'working' || a?.state === 'thinking';
          return (
            <div className="tl-lane" key={aid} style={{ ['--a' as any]: color }}>
              <div className="tl-name">
                <i className={active ? 'on' : ''} />
                {aid === 'main' ? 'main' : a?.label ?? aid.slice(0, 7)}
              </div>
              <div className="tl-track">
                {waits
                  .filter((w) => w.agentId === aid)
                  .map((w) => {
                    const l = Math.max(0, fracOf(w.ts, view));
                    const r = Math.min(1, fracOf(w.to ?? now, view));
                    return <div key={w.key} className={`tl-wait${w.to == null ? ' open' : ''}`} style={{ left: pct(l), width: pct(Math.max(0.002, r - l)) }} />;
                  })}
                {(() => {
                  // parallel calls on one lane share it in rows instead of drawing over each other
                  const mine = visible.filter((b) => b.agentId === aid);
                  const rows = stackRows(mine, now);
                  return mine.map((b) => <BlockView key={b.key} b={b} view={view} now={now} width={width} after={after(b.from)} stack={rows.get(b.key)} />);
                })()}
              </div>
            </div>
          );
        })}
        {!laneIds.length ? <div className="tl-empty">nothing in the last {win.label}</div> : null}
      </div>

      <div className="tl-over">
        {offset === 0 ? <div className="tl-now" /> : null}
        {pin ? <div className="tl-hair" style={{ left: pin.x, ['--c' as any]: markerColor(pin.top) }} /> : null}
        {showHead ? (
          <div className={`tl-head-line${cursor ? '' : ' live'}${headF < 0 ? ' off' : ''}`} style={{ left: pct(Math.max(0, Math.min(1, headF))) }}>
            <div className="tl-knob" title={cursor ? 'Drag to scrub · drop at the right edge for live' : 'Drag back to rewind'} />
            {cursor ? <div className={`tl-tag${headF > 0.72 ? ' flip' : ''}`}>{cursorLabel(cursor.ts, now, clock)}</div> : null}
          </div>
        ) : null}
      </div>

      {pin ? (
        <div
          className="tl-card"
          style={{ left: Math.max(6, Math.min(stripW - CARD_W - 6, LEFT + pin.x - CARD_W / 2)), width: CARD_W }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={() => clearTimeout(closing.current)}
          onPointerLeave={closeCard}
        >
          {pin.items.slice(0, CARD_ITEMS).map((m) => (
            <MarkerRow key={m.key} m={m} sessionId={sessionId} after={after(m.ts)} onJump={() => jump(m)} />
          ))}
          {pin.items.length > CARD_ITEMS ? <div className="tl-card-more">+{pin.items.length - CARD_ITEMS} more here · zoom in to tell them apart</div> : null}
          <div className="tl-card-hint">click one to rewind to it</div>
        </div>
      ) : null}
    </div>
  );
}

/** A lane block's height (styles.css .tl-blk). */
const LANE_H = 13;

/** A tool call or a stretch of thinking: soft and tinted (its tool family's colour, or the agent's for thinking). */
function BlockView({ b, view, now, width, after, stack }: { b: Block; view: View; now: number; width: number; after: boolean; stack?: { row: number; rows: number } }) {
  const l = Math.max(0, fracOf(b.from, view));
  const r = Math.min(1, fracOf(b.to ?? now, view));
  const px = (r - l) * width;
  const isTool = b.kind === 'tool';
  const name = isTool ? shortToolName(b.e.tool?.name ?? '') : 'thinking';
  // a lane's 13px split between overlapping rows (1px apart); rows too thin for text show colour only
  const rows = stack?.rows ?? 1;
  const h = (LANE_H - (rows - 1)) / rows;
  const roomy = h >= 9;
  return (
    <div
      data-blk={b.key}
      className={`tl-blk ${b.kind}${b.to == null ? ' live' : ''}${b.failed ? ' fail' : ''}${after ? ' after' : ''}`}
      style={{ left: pct(l), width: `max(3px, calc(${pct(r - l)} - 1px))`, ...(rows > 1 ? { top: (stack?.row ?? 0) * (h + 1), height: h, lineHeight: `${h}px` } : {}), ...(isTool ? { ['--c' as any]: FAM[b.e.icon.family].c } : {}) }}
      title={isTool ? `${b.e.tool?.name} ${b.e.tool?.summary ?? ''}${b.failed ? ' (failed)' : ''}\nclick to rewind to it` : 'thinking'}
    >
      {isTool && roomy && px > 18 ? <Icon name={b.failed ? 'TriangleAlert' : b.e.icon.name} size={10} /> : null}
      {roomy && px > 56 ? <span>{name}</span> : null}
    </div>
  );
}

/** One marker in the hover card: what it was, when and who; click to rewind to it, plus its diff or explain. */
function MarkerRow({ m, sessionId, after, onJump }: { m: Marker; sessionId: string; after: boolean; onJump: () => void }) {
  const a = useBrain((s) => s.agents[agentKey(sessionId, m.agentId)]);
  const who = m.agentId === 'main' ? 'main' : a?.label ?? m.agentId.slice(0, 7);
  return (
    <div className={`tl-ci${after ? ' after' : ''}`} style={{ ['--c' as any]: markerColor(m) }}>
      <button className="tl-ci-main" onClick={onJump}>
        <span className="ic">
          <Icon name={m.icon} size={12} />
        </span>
        <span className="tx">
          <b>{m.title}</b>
          {m.detail ? <span className="dt">{m.detail}</span> : null}
          <span className="tm">
            {clock(m.ts)} · <span style={{ color: agentColor(a ?? { agentId: m.agentId, colorIdx: 0, sessionId }) }}>{who}</span>
          </span>
        </span>
      </button>
      {m.path ? (
        <button
          className="tl-act"
          title="Open what this edit changed"
          onClick={() => {
            const t = turnsFor(sessionId).find((x) => x.from <= m.ts && (x.to == null || x.to > m.ts));
            openChanges(sessionId, m.path!, { ...(t ? { from: t.from, to: t.to } : {}), ...(m.toolUseId ? { toolUseId: m.toolUseId } : {}) });
          }}
        >
          <Icon name="FileDiff" size={11} /> diff
        </button>
      ) : null}
      {m.explain ? (
        <button
          className="tl-act"
          title="Open the explain"
          onClick={() => {
            const p = explainFrom(m.explain!);
            if (p) useBrain.getState().setViewer(p);
          }}
        >
          <Icon name="Presentation" size={11} /> open
        </button>
      ) : null}
    </div>
  );
}
