import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { FIX_W, NODE_H, NODE_W, PAD, depthOf, dispatchText, snap, type Endpoint, type Pos, type Route, type Seat, type Team, type TeamLayout } from '@cora/shared';
import { contentBounds, curve, dropTarget, epBox, fitText, fitView, groupBoxes, ports, routeGeom, seatsUnder, seatSub, textWidth, toWorld, zoomAt, type Box, type Flash, type Marks, type ProposalMarks, type RouteGeom, type View } from './geometry';
import { isTyping, type Sel } from './draftOps';

export type SeatState = 'work' | 'idle' | 'down' | 'none';
export type TraceMarks = { routes: Set<string>; seats: Set<string>; groups: Set<string>; from: string | null; blocked?: { from: Endpoint; to: Endpoint } };
export type CanvasProps = {
  team: Team;
  look: TeamLayout;
  sel: Sel;
  hov: Marks | null;
  flash: Flash | null;
  trace: TraceMarks | null;
  marks: ProposalMarks | null;
  stateOf(id: string): SeatState;
  /** bumped to frame everything */
  fitKey: number;
  /** a dot travelling the route a trace took */
  dot: { route: string; from: number; key: number } | null;
  /** Cora is changing the draft */
  busy: boolean;
  /** a sheet or the tour is open: the canvas doesn't take the pointer */
  locked: boolean;
  onSelect(s: Sel): void;
  onLink(from: Endpoint, to: Endpoint): void;
  onMove(look: TeamLayout, done: boolean): void;
  onDrop(id: string, drop: { into: string } | { out: true }): void;
  onAddSeat(at?: Pos): void;
  onGroupThem(): void;
};

const HAND = 'M3.6 6.6V2.9a.75.75 0 0 1 1.5 0V5.6M5.1 5.4V2.2a.75.75 0 0 1 1.5 0v3.2M6.6 5.4V2.6a.75.75 0 0 1 1.5 0v3.1M8.1 5.9V3.9a.75.75 0 0 1 1.5 0v3c0 1.9-1.3 3.3-3.2 3.3H5.9c-.9 0-1.6-.4-2.1-1.1L2.4 7.1a.75.75 0 0 1 1.2-.9l.5.6';
type Drag =
  | { type: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; click: boolean }
  | { type: 'seat'; id: string; ids: string[]; start: Pos; orig: Record<string, Pos>; moved: boolean; shift: boolean; gb: Record<string, Box | null>; drop: { into: string } | { out: true } | null }
  | { type: 'group'; id: string; ids: string[]; start: Pos; orig: Record<string, Pos>; moved: boolean }
  | { type: 'link'; from: Endpoint; x: number; y: number; over: Endpoint | null };
const epOf = (kind: string, id: string): Endpoint => (kind === 'seat' ? `seat:${id}` : kind === 'group' ? `group:${id}` : (id as Endpoint));
const scVar = (c: string, more: CSSProperties = {}) => ({ ['--sc' as string]: c, ...more }) as CSSProperties;

function SeatNode({ s, look, cls, st, style, leads = false }: { s: Seat; look: TeamLayout; cls: string; st: SeatState; style?: CSSProperties; leads?: boolean }) {
  const p = look.pos[s.id];
  if (!p) return null;
  return (
    <g className={`node seat s-${st}${cls}`} data-kind="seat" data-id={s.id} transform={`translate(${p.x} ${p.y})`} style={scVar(look.color?.[s.id] ?? '#94a3b8', style)}>
      <rect className="bg" width={NODE_W} height={NODE_H} rx={10} />
      <rect className="tile" x={9} y={9} width={28} height={28} rx={8} />
      <text className="ini" x={23} y={27.4} textAnchor="middle">
        {(s.name || '?').trim()[0]?.toUpperCase() || '?'}
      </text>
      {st !== 'none' ? (
        <>
          <circle className="ring" cx={35} cy={35} r={7.5} />
          <circle className="dot" cx={35} cy={35} r={st === 'down' ? 4.25 : 5} />
        </>
      ) : null}
      <text className="nm" x={47} y={21}>
        {fitText(s.name || 'Unnamed seat', 'name', NODE_W - 59)}
      </text>
      <text className="sub" x={47} y={35.5}>
        {fitText(seatSub(s, leads), 'sub', NODE_W - 59)}
      </text>
      {cls.includes('m-chg') ? <circle className="mdot" cx={NODE_W - 10} cy={10} r={4} /> : null}
      {cls.includes('gone') || cls.includes('tb-fout') ? null : <circle className="handle" cx={NODE_W} cy={NODE_H / 2} r={4.5} />}
    </g>
  );
}

function RouteEl({ r, G, cls, style }: { r: Route; G: RouteGeom; cls: string; style?: CSSProperties }) {
  const { legs, trunk, T, chip, cs } = G;
  const x0 = chip ? chip.x - cs.w / 2 : 0;
  const y0 = chip ? chip.y - cs.h / 2 : 0;
  return (
    <g className={`route w-${r.wake}${cls}`} data-kind="route" data-id={r.id} style={style}>
      {legs.map((l, i) => (
        <g key={i}>
          <path className="hit" d={l.d} />
          <path className="ln" d={l.d} opacity={l.ghost ? 0.35 : undefined} />
        </g>
      ))}
      {trunk ? (
        <>
          <path className="hit" d={trunk} />
          <path className="ln" d={trunk} />
        </>
      ) : null}
      <path className="ah" d={`M${T.x - 6} ${T.y - 3.5} L${T.x} ${T.y} L${T.x - 6} ${T.y + 3.5}`} />
      {chip ? (
        <g className="chip">
          <rect x={x0} y={y0} width={cs.w} height={cs.h} rx={5} />
          {r.wake === 'ask' ? (
            <g transform={`translate(${x0 + 4} ${chip.y - 6})`}>
              <path className="hand" fill="none" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" d={HAND} />
            </g>
          ) : null}
          {cs.lines.map((l, i) => (
            <text key={i} x={x0 + 6 + (r.wake === 'ask' ? 16 : 0)} y={y0 + 11.5 + i * 12}>
              {l}
            </text>
          ))}
        </g>
      ) : null}
      {chip && cls.includes('m-chg') ? <circle className="mdot" cx={x0 + cs.w} cy={y0} r={4} /> : null}
    </g>
  );
}

function FixedNode({ e, look }: { e: 'user' | 'cora'; look: TeamLayout }) {
  const p = look.pos[`@${e}`];
  if (!p) return null;
  return (
    <g className="node fixed" data-kind="fixed" data-id={e} transform={`translate(${p.x} ${p.y})`} style={scVar(e === 'user' ? 'var(--ink2)' : 'var(--cora)')}>
      <rect className="bg" width={FIX_W} height={NODE_H} rx={10} />
      <rect className="tile" x={9} y={9} width={28} height={28} rx={8} />
      <text className="ini" x={23} y={27.4} textAnchor="middle">
        {e === 'user' ? 'Y' : 'C'}
      </text>
      <text className="nm" x={47} y={21}>
        {e === 'user' ? 'You' : 'Cora'}
      </text>
      <text className="sub" x={47} y={35.5}>
        messages anyone
      </text>
    </g>
  );
}

/** Space held to pan: down (not while typing, nor under a sheet), up, or the window losing focus (its keyup never comes). Null: no change. */
export function spaceHeld(kind: 'keydown' | 'keyup' | 'blur', code: string, o: { typing: boolean; locked: boolean }): boolean | null {
  if (kind === 'blur') return false;
  if (code !== 'Space') return null;
  if (kind === 'keyup') return false;
  return o.typing || o.locked ? null : true;
}

/** The team as a picture: plain SVG, no graph library. */
export function Canvas(p: CanvasProps) {
  const { team: t, look } = p;
  const wrap = useRef<HTMLElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [space, setSpace] = useState(false);
  const [dotAt, setDotAt] = useState<Pos | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const gone = p.marks?.goneSeats.map((s) => s.id) ?? [];

  // Fit frames everything (on request: things never move on their own)
  useLayoutEffect(() => {
    const r = svg.current?.getBoundingClientRect();
    if (r?.width) setView(fitView(r, contentBounds(t, look, gone)));
  }, [p.fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // wheel pans; ctrl-wheel zooms (a native listener: React's wheel listener can't prevent the page scrolling)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if ((e.target as Element).closest('.tools')) return;
      e.preventDefault();
      const r = svg.current!.getBoundingClientRect();
      setView((v) => (e.ctrlKey || e.metaKey ? zoomAt(v, e.clientX - r.left, e.clientY - r.top, e.deltaY) : { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []);
  // space-drag pans
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (spaceHeld('keydown', e.code, { typing: isTyping(document.activeElement), locked: !!p.locked })) {
        setSpace(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => spaceHeld('keyup', e.code, { typing: false, locked: false }) === false && setSpace(false);
    // away from the window with Space down: its keyup never comes, so it's let go
    const blur = () => spaceHeld('blur', '', { typing: false, locked: false }) === false && setSpace(false);
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [p.locked]);
  // a dot travels the route a trace took
  useEffect(() => {
    if (!p.dot) return;
    const path = document.getElementById(`tbfp-${p.dot.route}-${p.dot.from}`) as SVGPathElement | null;
    if (!path) return;
    const L = path.getTotalLength();
    const pts = Array.from({ length: 41 }, (_, i) => path.getPointAtLength((L * i) / 40));
    const t0 = performance.now();
    let raf = 0;
    let clear = 0;
    const step = (now: number) => {
      const q = Math.min(1, (now - t0) / 620);
      const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
      const pt = pts[Math.round(e * 40)];
      setDotAt({ x: pt.x, y: pt.y });
      if (q < 1) raf = requestAnimationFrame(step);
      else clear = window.setTimeout(() => setDotAt(null), 380);
    };
    raf = requestAnimationFrame(step);
    return () => (cancelAnimationFrame(raf), clearTimeout(clear));
  }, [p.dot?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const worldOf = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return toWorld(view, e.clientX - r.left, e.clientY - r.top);
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button === 2 || p.locked) return;
    const w = worldOf(e);
    const target = e.target as Element;
    const k = target.closest('[data-kind]') as SVGElement | null;
    const kind = k?.dataset.kind ?? '';
    const id = k?.dataset.id ?? '';
    svg.current!.setPointerCapture(e.pointerId);
    if (e.button === 1 || space) {
      e.preventDefault();
      return setDrag({ type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: true, click: false });
    }
    if (target.closest('.handle') && k && !k.classList.contains('gone') && (kind === 'seat' || kind === 'group')) return setDrag({ type: 'link', from: epOf(kind, id), x: w.x, y: w.y, over: null });
    if (kind === 'seat') {
      const ids = p.sel?.kind === 'seat' && p.sel.ids.includes(id) && p.sel.ids.length > 1 && !e.shiftKey ? p.sel.ids : [id];
      return setDrag({ type: 'seat', id, ids, start: w, orig: Object.fromEntries(ids.map((i) => [i, { ...look.pos[i] }])), moved: false, shift: e.shiftKey, gb: groupBoxes(t, look), drop: null });
    }
    if (kind === 'group') {
      const ids = seatsUnder(t, id).filter((i) => look.pos[i]);
      return setDrag({ type: 'group', id, ids, start: w, orig: Object.fromEntries(ids.map((i) => [i, { ...look.pos[i] }])), moved: false });
    }
    if (kind === 'route') {
      p.onSelect({ kind: 'route', ids: [id] });
      return setDrag(null);
    }
    if (kind === 'fixed') return setDrag(null);
    setDrag({ type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, click: true });
  };
  const onMoveP = (e: RPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const w = worldOf(e);
    if (d.type === 'pan') {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      const moved = d.moved || Math.abs(dx) + Math.abs(dy) > 3;
      if (moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      if (moved !== d.moved) setDrag({ ...d, moved });
      return;
    }
    if (d.type === 'seat' || d.type === 'group') {
      const dx = w.x - d.start.x;
      const dy = w.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * view.k < 3) return;
      const pos = { ...look.pos };
      for (const i of d.ids) pos[i] = { x: snap(d.orig[i].x + dx), y: snap(d.orig[i].y + dy) };
      p.onMove({ ...look, pos }, false);
      if (d.type === 'seat') setDrag({ ...d, moved: true, drop: d.ids.length === 1 ? dropTarget(t, d.gb, d.id, { x: pos[d.id].x + NODE_W / 2, y: pos[d.id].y + NODE_H / 2 }) : null });
      else setDrag({ ...d, moved: true });
      return;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-kind]') as SVGElement | null;
    const kind = el?.dataset.kind ?? '';
    const ep = el && (kind === 'seat' || kind === 'group') && !el.classList.contains('gone') ? epOf(kind, el.dataset.id ?? '') : null;
    setDrag({ ...d, x: w.x, y: w.y, over: ep && (ep !== d.from || ep.startsWith('group:')) ? ep : null });
  };
  const onUp = () => {
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    if (d.type === 'pan' && d.click && !d.moved) p.onSelect(null);
    if (d.type === 'seat') {
      if (d.moved) {
        p.onMove(look, true);
        if (d.drop) p.onDrop(d.id, d.drop);
      } else if (d.shift && p.sel?.kind === 'seat') {
        const ids = p.sel.ids.includes(d.id) ? p.sel.ids.filter((x) => x !== d.id) : [...p.sel.ids, d.id];
        p.onSelect(ids.length ? { kind: 'seat', ids } : null);
      } else p.onSelect({ kind: 'seat', ids: [d.id] });
    }
    if (d.type === 'group') {
      if (d.moved) p.onMove(look, true);
      else p.onSelect({ kind: 'group', ids: [d.id] });
    }
    if (d.type === 'link' && d.over) p.onLink(d.from, d.over);
  };
  const onDbl = (e: RMouseEvent<SVGSVGElement>) => {
    if (!(e.target as Element).closest('[data-kind]') && !p.locked) p.onAddSeat(worldOf(e));
  };
  const centre = (): Pos => {
    const r = svg.current?.getBoundingClientRect();
    return r ? toWorld(view, r.width / 2, r.height / 2) : { x: 0, y: 0 };
  };

  // classes: hover from In words, selection, drop targets, a trace, a proposal's marks, Cora's live changes
  const isSel = (kind: 'seat' | 'group' | 'route', id: string) => !!p.sel && p.sel.kind === kind && p.sel.ids.includes(id);
  const hv = (kind: keyof Marks, id: string) => (p.hov?.[kind].has(id) ? ' hov' : '');
  const delay = p.flash ? `${-Math.round(performance.now() - p.flash.t0)}ms` : '0ms';
  const fl = (kind: keyof Marks, id: string): [string, CSSProperties | undefined] => {
    if (!p.flash) return ['', undefined];
    if (p.flash.add[kind].has(id)) return [' m-add tb-fin', { animationDelay: delay }];
    return p.flash.chg[kind].has(id) ? [' m-chg', undefined] : ['', undefined];
  };
  const gb = groupBoxes(t, look);
  const P = ports([...t.routes, ...(p.marks?.goneRoutes ?? [])]);
  const tm = p.trace;
  const regions = [...t.groups].sort((a, b) => depthOf(t, a.id) - depthOf(t, b.id));
  const linkFrom = drag?.type === 'link' ? epBox(t, look, drag.from, gb) : null;
  const blocked = tm?.blocked ? [epBox(t, look, tm.blocked.from, gb), epBox(t, look, tm.blocked.to, gb)] : null;

  return (
    <section ref={wrap} data-tour="canvas" className={`cv${drag?.type === 'pan' && drag.moved ? ' panning' : ''}${space ? ' grab' : ''}${drag?.type === 'link' ? ' linking' : ''}${p.busy ? ' busy' : ''}`} style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${16 * view.k}px ${16 * view.k}px` }}>
      {p.busy ? (
        <div className="drafting">
          <i className="spin" />
          Cora is drafting…
        </div>
      ) : null}
      <svg ref={svg} className="canvas" onPointerDown={onDown} onPointerMove={onMoveP} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDbl}>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {regions.map((g) => {
            const b = gb[g.id];
            if (!b) return null;
            const mc = p.marks?.group[g.id];
            const [fc, fd] = fl('group', g.id);
            const drop = (drag?.type === 'seat' && drag.drop && 'into' in drag.drop && drag.drop.into === g.id) || (drag?.type === 'link' && drag.over === `group:${g.id}`);
            const cls = `${fc}${hv('group', g.id)}${isSel('group', g.id) ? ' sel' : ''}${drop ? ' drop' : ''}${tm?.groups.has(g.id) ? ' hl' : ''}${mc ? ` m-${mc}` : ''}`;
            const nameW = textWidth(g.name.toUpperCase(), 'label');
            return (
              <g key={g.id} className={`region${cls}`} data-kind="group" data-id={g.id} style={fd}>
                <rect className="rg" x={b.x} y={b.y} width={b.w} height={b.h} rx={14} />
                <text className="rl" x={b.x + PAD} y={b.y + 17}>
                  {g.name.toUpperCase()}
                </text>
                <text className="rd" x={b.x + PAD + nameW + 8} y={b.y + 17}>
                  {dispatchText(g)}
                </text>
                {mc === 'chg' ? <circle className="mdot" cx={b.x + b.w - 12} cy={b.y + 13} r={4} /> : null}
                <circle className="handle" cx={b.x + b.w} cy={b.y + b.h / 2} r={4.5} />
              </g>
            );
          })}
          {t.routes.map((r) => {
            const mc = p.marks?.route[r.id];
            const G = routeGeom(t, look, r, gb, P);
            if (!G) return null;
            const [fc, fd] = fl('route', r.id);
            return <RouteEl key={r.id} r={r} G={G} cls={`${fc}${hv('route', r.id)}${isSel('route', r.id) ? ' sel' : ''}${tm?.routes.has(r.id) ? ' trace' : ''}${mc ? ` m-${mc}` : ''}`} style={fd} />;
          })}
          {p.flash?.goneRoutes.map((r) => {
            const G = routeGeom(p.flash!.prev, look, r, groupBoxes(p.flash!.prev, look), ports(p.flash!.prev.routes));
            return G ? <RouteEl key={`fo-${r.id}`} r={r} G={G} cls=" tb-fout" style={{ animationDelay: delay }} /> : null;
          })}
          {p.marks?.goneRoutes.map((r) => {
            const G = routeGeom(t, look, r, gb, P);
            return G ? <RouteEl key={`gone-${r.id}`} r={r} G={G} cls=" gone" /> : null;
          })}
          {t.routes.flatMap((r) => (routeGeom(t, look, r, gb, P)?.legs ?? []).filter((l) => l.i >= 0).map((l) => <path key={`fp-${r.id}-${l.i}`} className="fp" id={`tbfp-${r.id}-${l.i}`} d={l.full} />))}
          {t.seats.map((s) => {
            const mc = p.marks?.seat[s.id];
            const [fc, fd] = fl('seat', s.id);
            const cls = `${fc}${hv('seat', s.id)}${isSel('seat', s.id) ? ' sel' : ''}${drag?.type === 'link' && drag.over === `seat:${s.id}` ? ' drop' : ''}${tm?.seats.has(s.id) ? ' hl' : ''}${tm?.from === s.id ? ' from' : ''}${mc ? ` m-${mc}` : ''}`;
            return <SeatNode key={s.id} s={s} look={look} cls={cls} st={p.stateOf(s.id)} style={fd} leads={t.lead === s.id} />;
          })}
          {p.flash?.goneSeats.map((s) => <SeatNode key={`fo-${s.id}`} s={s} look={look} cls=" tb-fout" st="none" style={{ animationDelay: delay }} />)}
          {p.marks?.goneSeats.map((s) => <SeatNode key={`gone-${s.id}`} s={s} look={look} cls=" gone" st="none" />)}
          <FixedNode e="user" look={look} />
          <FixedNode e="cora" look={look} />
          {drag?.type === 'link' && linkFrom ? <path className="templine" d={curve({ x: linkFrom.x + linkFrom.w, y: linkFrom.y + linkFrom.h / 2 }, { x: drag.x, y: drag.y })} /> : null}
          {blocked?.[0] && blocked[1] ? <Blocked a={blocked[0]} b={blocked[1]} /> : null}
          {dotAt ? (
            <g>
              <circle className="tdot-halo" r={7} cx={dotAt.x} cy={dotAt.y} />
              <circle className="tdot" r={3.5} cx={dotAt.x} cy={dotAt.y} />
            </g>
          ) : null}
        </g>
      </svg>
      <div className="tools">
        <button className="btn sm" title="Add a seat (or double-click empty space)" onClick={() => p.onAddSeat(centre())}>
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M7 3v8M3 7h8" />
          </svg>
          Seat
        </button>
        <button className="btn sm" title="Shift-click seats, then group them" disabled={p.sel?.kind !== 'seat'} onClick={p.onGroupThem}>
          Group them
        </button>
        <span className="zoom">{Math.round(view.k * 100)}%</span>
      </div>
      <div className="legend">
        <span>
          <svg viewBox="0 0 26 10">
            <path d="M1 5h22" strokeWidth={1.25} />
            <path d="M19 2l4 3-4 3" strokeWidth={1.25} />
          </svg>
          auto
        </span>
        <span>
          <svg viewBox="0 0 26 10">
            <path d="M1 5h22" strokeWidth={1.25} strokeDasharray="5 4" />
            <path d="M19 2l4 3-4 3" strokeWidth={1.25} />
          </svg>
          ask (your OK)
        </span>
        <span>
          <svg viewBox="0 0 26 10" opacity={0.55}>
            <path d="M1 5h22" strokeWidth={1.6} strokeDasharray="0 4.5" strokeLinecap="round" />
            <path d="M19 2l4 3-4 3" strokeWidth={1.25} />
          </svg>
          never
        </span>
      </div>
    </section>
  );
}

/** A message no route allows: a dashed line that never arrives, crossed where it stops. */
function Blocked({ a, b }: { a: Box; b: Box }) {
  const p = { x: a.x + a.w, y: a.y + a.h / 2 };
  let d: string;
  let m: Pos;
  if (b.x - 3 > p.x + 40) {
    const q = { x: b.x - 3, y: b.y + b.h / 2 };
    d = `M${p.x} ${p.y} L${q.x} ${q.y}`;
    m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  } else {
    // not to its right: an arc out on the left, from its left edge into the target's
    const p2 = { x: a.x, y: a.y + a.h / 2 };
    const q = { x: b.x - 3, y: b.y + b.h / 2 };
    const bx = Math.min(p2.x, q.x) - 48;
    d = `M${p2.x} ${p2.y} C${bx} ${p2.y} ${bx} ${q.y} ${q.x} ${q.y}`;
    m = { x: (p2.x + 6 * bx + q.x) / 8, y: (p2.y + q.y) / 2 };
  }
  return (
    <g className="blocked">
      <path className="bl" d={d} />
      <circle cx={m.x} cy={m.y} r={7} />
      <path d={`M${m.x - 2.6} ${m.y - 2.6}L${m.x + 2.6} ${m.y + 2.6}M${m.x + 2.6} ${m.y - 2.6}L${m.x - 2.6} ${m.y + 2.6}`} />
    </g>
  );
}
