import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PAD, byRank, depthOf, dispatchText, endpointName, itemOpen, type Post, type Project, type ProjectItem, type Route, type SessionInfo, type Team } from '@cora/shared';
import { useBrain } from '../../state/store';
import { projectOfBoard, useProject, useProjects } from '../../state/projects';
import { useWorktrees } from '../../state/worktrees';
import { draftInProgress, useProjectDraft } from '../../state/builder';
import { showPanel } from '../../state/boardDock';
import { liveTerminal } from '../../state/composer';
import { launchTerminal } from '../../state/ws';
import { restartTeamSeats } from '../../state/projects';
import { usePalette } from '../Palette';
import { CrewCompose, CrewMenuPanel } from './ProjectPanels';
import { TeamHead, teamActOutcome, useTeamLive, type TeamAct, type TeamLive } from './TeamPanel';
import { TaskControls } from './WorkPanel';
import { ago, sessionColor, sessionName } from '../../lib/format';
import { canvasMeasure, curve, fitView, groupBoxes, ports, routeGeom, setMeasure, textWidth, union, withColors, withPositions, type Box, type RouteGeom, type View } from '../builder/geometry';
import { FREE_H, FREE_W, HEAD_H, flowOrder, isCompact, litLabel, litLines, litRoutes, mapLook, memberState, nextFade, railEvents, railOpens, railTargets, turnTime, type LitRoute, type RailEvent, popoverLeft, postEdges, routeCounts, routeLines, routePosts, seatLines, seatState, taskBadges, tileHeight, unseated, type Badge, type Edge, type MemberLine, type MemberState, type Tile, type Unseated } from './teamMapModel';
import '../builder/builder.css';
import './teamMap.css';

/**
 * The live team map (a project's board): its team as the builder draws it, read-only. Each seat a tile with a row per
 * live member (its state, what it's on, its branch), the members without a seat beside You, each message as it arrives
 * a pulse along the route it took (a refused one flashes red where it tried), each route's count of the last hour, the
 * open tasks on their owners. The tiles are HTML (real text, cut with an ellipsis, the whole of it on hover) over an SVG
 * layer of regions, routes and pulses. A narrow panel gets the compact map: the seats as sections, read top to bottom,
 * their routes as lines under them. Calm: nothing moves unless something just happened.
 */
type Props = { sessionId: string };

const open = (sid: string) => useBrain.getState().setFocus(sid);
/** A member's branch: the worktree it works in (its repo's main checkout too). */
function branchOf(repos: ReturnType<typeof useWorktrees.getState>['repos'], sid: string): string | null {
  for (const r of repos ?? []) for (const t of r.trees) if (t.who.includes(sid)) return t.branch;
  return null;
}
/** A message on its way: its edge, when it started; `d` the path it travels. */
type Pulse = { key: string; edge: Edge; d: string; at: number };
/** Who a message just lit (the compact map: their rows, a moment): its writer and recipients, refused or not. */
type Lit = { key: string; sids: string[]; route: string | null; refused: boolean; at: number };
const PULSE_MS = 700;
const FLASH_MS = 1400;
/** At most this many messages travel at once: a burst shows its latest. */
const MAX_PULSES = 6;
const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const STATE_WORD: Record<MemberState, string> = { need: 'needs you', work: 'working', idle: 'idle', down: 'not running' };
const BADGE_COLOR: Record<string, string> = { queued: 'var(--ink3)', building: 'var(--run)', review: 'var(--run)', testing: 'var(--run)', blocked: 'var(--need)' };

export function TeamMapPanel({ sessionId }: Props) {
  const p = useProject(projectOfBoard(sessionId));
  const sessions = useBrain((s) => s.sessions);
  const doing = useProjects((s) => s.doing);
  const repos = useWorktrees((s) => s.repos);
  useEffect(() => {
    if (!useWorktrees.getState().repos) void useWorktrees.getState().load();
  }, []);
  // (one function while the worktrees stay the same: the layout isn't worked out again on every render)
  const branch = useCallback((sid: string) => branchOf(repos, sid), [repos]);
  const { live, refresh } = useTeamLive(p);
  const pending = useBrain((s) => s.pending);
  // (one function while the approvals stay the same: the layout isn't worked out again on every render)
  const asks = useCallback((sid: string) => pending.some((x) => x.sessionId === sid), [pending]);
  const draft = draftInProgress(useProjectDraft(p?.id), p?.team);
  if (!p) return null;
  if (!p.team) return <div className="pp-empty">This project has no team yet: build one in the Team panel, and its map shows here.</div>;
  return <TeamMap p={p} team={p.team} sessions={sessions} doing={doing} branch={branch} live={live} refresh={refresh} draft={!!draft} asks={asks} board={sessionId} />;
}

/**
 * The map itself, for a project, its team and its sessions (rendered without the stores in tests). `size`: the panel's
 * (tests); otherwise measured.
 */
export function TeamMap(props: {
  p: Project;
  team: Team;
  sessions: Record<string, SessionInfo>;
  doing: Record<string, string>;
  branch(sid: string): string | null;
  now?: number;
  size?: { width: number; height: number };
  /** the team's live state (TeamPanel's useTeamLive): the header's offers */
  live?: TeamLive | null;
  refresh?(): void;
  /** a team draft in progress (the header's Edit says Continue draft) */
  draft?: boolean;
  /** a member has an approval waiting for you */
  asks?(sid: string): boolean;
  /** the board it's on (its owner: `project:<id>`), for "N unassigned" to show the Work panel there */
  board?: string;
  /** a member's drawer open from the start (tests) */
  drawer?: string;
}) {
  const { p, team, sessions, doing, branch, now: nowProp, size: sizeProp } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState<string | null>(props.drawer ?? null);
  const [measured, setSize] = useState<{ width: number; height: number } | null>(null);
  const size = sizeProp ?? measured;
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [flashes, setFlashes] = useState<Array<{ key: string; edge: Edge; at: number }>>([]);
  const [lit, setLit] = useState<Lit[]>([]);
  const [pop, setPop] = useState<string | null>(null);
  useEffect(() => {
    const m = canvasMeasure();
    if (m) setMeasure(m);
  }, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = useMemo(() => layoutOf(p, team, sessions, doing, branch, props.asks), [p, team, sessions, doing, branch, props.asks]);
  // the map's clock: it moves only while something counts (a working member's timer, every 30s) and once at the next
  // change (a lit route going out, a message leaving the last hour's count); nothing happening, nothing loops
  const [tick, setTick] = useState(0);
  const now = nowProp ?? Date.now();
  const working = Object.values(m.lines).some((ls) => ls.some((l) => !!turnTime(l, now)));
  const next = nextChange(p, now);
  useEffect(() => {
    if (nowProp !== undefined) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    if (working) timers.push(setInterval(() => setTick((x) => x + 1), 30_000));
    if (next !== null) timers.push(setTimeout(() => setTick((x) => x + 1), Math.max(250, next - Date.now() + 50)));
    return () => timers.forEach((t) => clearTimeout(t));
  }, [working, next, nowProp]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => routeCounts(p, team, now), [p.thread, team, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const talk = useMemo(() => litRoutes(p, team, now), [p.thread, team, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const talkLines = useMemo(() => litLines(p, team, now), [p.thread, team, tick]);
  const who = (x: string) => (x === 'you' || x === 'user' ? 'You' : x === 'cora' ? 'Cora' : sessions[x] ? sessionName(sessions[x]) : (team.groups.find((g) => g.id === x)?.name ?? 'a session'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const events = useMemo(() => railEvents(p, team, sessions, who), [p.thread, p.items, p.sessions, sessions, team, tick]);
  // the rail open or folded, kept per board
  const railKey = `cora.tmRail.${props.board ?? p.id}`;
  const [folded, setFolded] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(railKey) === '1';
    } catch {
      return false;
    }
  });
  const fold = (on: boolean) => {
    setFolded(on);
    try {
      localStorage.setItem(railKey, on ? '1' : '0');
    } catch {
      /* not kept: it still folds */
    }
  };
  // what a hovered rail entry lights on the map
  const [hl, setHl] = useState<{ sids: Set<string>; route: string | null } | null>(null);
  const view: View = size?.width ? fitView(size, m.bounds) : { x: 0, y: 0, k: 1 };
  const compact = !!size?.width && isCompact(size.width, view.k);

  // a post that has just arrived (the project comes through the hub): a pulse along its route (the compact map: its
  // rows lit a moment), a flash where one was refused
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(p.thread.map((x) => x.id));
    if (!seen.current) return void (seen.current = ids);
    const fresh = p.thread.filter((x) => !seen.current!.has(x.id));
    seen.current = ids;
    if (!fresh.length) return;
    const t0 = performance.now();
    const go: Pulse[] = [];
    const fl: Array<{ key: string; edge: Edge; at: number }> = [];
    const li: Lit[] = [];
    for (const post of fresh) {
      const edges = postEdges(p, team, post);
      // (a post to the user lights You: its card goes by 'you')
      if (edges.length) li.push({ key: post.id, sids: litSids(post), route: edges.find((e) => e.route)?.route?.id ?? null, refused: !!post.blocked, at: t0 });
      edges.forEach((e, k) => {
        const key = `${post.id}:${k}`;
        if (e.blocked) fl.push({ key, edge: e, at: t0 });
        else {
          const d = pathOf(m, e);
          if (d) go.push({ key, edge: e, d, at: t0 });
        }
      });
    }
    if (fl.length) setFlashes((f) => [...f, ...fl]);
    if (li.length) setLit((l) => [...l, ...li]);
    if (go.length && !reduced()) setPulses((ps) => [...ps, ...go].slice(-MAX_PULSES));
  }, [p.thread]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flashes.length && !lit.length) return;
    const t = setTimeout(() => {
      const t1 = performance.now();
      setFlashes((f) => f.filter((x) => t1 - x.at < FLASH_MS));
      setLit((l) => l.filter((x) => t1 - x.at < FLASH_MS));
    }, FLASH_MS + 50);
    return () => clearTimeout(t);
  }, [flashes, lit]);

  const litOf = (sid: string): '' | ' lit' | ' lit refused' => {
    const l = lit.filter((x) => x.sids.includes(sid));
    return !l.length ? '' : l.some((x) => x.refused) ? ' lit refused' : ' lit';
  };
  const close = () => setPop(null);
  // a click anywhere outside the popover (on the map or elsewhere on the board) closes it
  useEffect(() => {
    if (!pop) return;
    const away = (e: MouseEvent) => outsidePop(e.target as Element | null) && setPop(null);
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [pop]);
  const pick = (sid: string) => (setPop(null), setDrawer(sid));
  // a member that needs you: its drawer (an approval there to answer), or its session (a question in its terminal)
  const needs = (sid: string) => (props.asks?.(sid) ? pick(sid) : open(sid));
  const live = { now, talk, talkLines, hl, needs };
  const rail = (
    <Rail
      events={events}
      folded={folded}
      fold={fold}
      compact={compact}
      now={now}
      hover={(e) => setHl(e ? railTargets(e) : null)}
      choose={(e) => {
        const o = railOpens(e, p.sessions);
        if (!o) return;
        if ('route' in o) (setDrawer(null), setPop(o.route));
        else pick(o.member);
      }}
    />
  );
  return (
    <div className={`tb tm${compact ? ' compact' : ''}`}>
      <MapHead p={p} team={team} live={props.live ?? null} refresh={props.refresh} draft={!!props.draft} board={props.board} />
      {compact ? rail : null}
      <div className="tm-main">
        <div className="tm-body" ref={wrap}>
          {compact ? (
            <CompactMap p={p} team={team} m={m} counts={counts} sessions={sessions} litOf={litOf} lit={lit} pop={pop} setPop={setPop} close={close} pick={pick} live={live} />
          ) : (
            <WideMap p={p} team={team} m={m} view={view} width={size?.width ?? 0} counts={counts} sessions={sessions} pulses={pulses} setPulses={setPulses} flashes={flashes} pop={pop} setPop={setPop} close={close} pick={pick} live={live} />
          )}
          {drawer && sessions[drawer] ? <MemberDrawer p={p} team={team} s={sessions[drawer]} sessions={sessions} asks={!!props.asks?.(drawer)} full={compact} close={() => setDrawer(null)} /> : null}
        </div>
        {compact ? null : rail}
      </div>
    </div>
  );
}

/** What the map shows as it happens: the clock, the lit routes and lines, what a rail entry lights, a Needs you click. */
type Live = { now: number; talk: Record<string, LitRoute>; talkLines: Array<{ key: string; edge: Edge; at: number }>; hl: { sids: Set<string>; route: string | null } | null; needs(sid: string): void };

/** When the map must look again on its own: the next lit route or line going out, or the next message leaving the hour's count. */
export function nextChange(p: Project, now: number): number | null {
  const fade = nextFade(p, now);
  let hour: number | null = null;
  for (const x of p.thread) if (!x.blocked && x.at <= now && now - x.at < 3_600_000) hour = Math.min(hour ?? Infinity, x.at + 3_600_000);
  return fade === null ? hour : hour === null ? fade : Math.min(fade, hour);
}

/** The activity rail: the project's last events, newest first; hovering one lights its members or route, a click opens them. */
function Rail({ events, folded, fold, compact, now, hover, choose }: { events: RailEvent[]; folded: boolean; fold(on: boolean): void; compact: boolean; now: number; hover(e: RailEvent | null): void; choose(e: RailEvent): void }) {
  return (
    <aside className={`tm-rail${compact ? ' strip' : ''}${folded ? ' folded' : ''}`} aria-label="What happened lately">
      <button className="rh" onClick={() => fold(!folded)} title={folded ? 'Show what happened lately' : 'Fold it away'} aria-expanded={!folded}>
        <span>Activity</span>
        {events.length ? <b>{events.length}</b> : null}
        <i className="chev">{folded ? (compact ? '▾' : '‹') : compact ? '▴' : '›'}</i>
      </button>
      {folded ? null : (
        <ol className="rl" onMouseLeave={() => hover(null)}>
          {events.length ? (
            events.map((e) => (
              <li key={e.key}>
                <button className={`re k-${e.kind}`} onMouseEnter={() => hover(e)} onFocus={() => hover(e)} onBlur={() => hover(null)} onClick={() => choose(e)} title={e.text}>
                  <time>{ago(e.at, now)}</time>
                  <span>{e.text}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="none">Nothing yet.</li>
          )}
        </ol>
      )}
    </aside>
  );
}

/**
 * An Escape for the map's popover or drawer: it closes it and is consumed (caught first, in the capture phase, and
 * marked handled), so the board's own Escape (leaving Fill the area) never also fires. Whether it was one.
 */
export function ownEscape(e: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>, close: () => void): boolean {
  if (e.key !== 'Escape') return false;
  e.preventDefault();
  e.stopPropagation();
  close();
  return true;
}
/** A click outside the popover (and its route, or its compact line): anywhere else on the board or the page. */
export const outsidePop = (t: { closest?(sel: string): unknown } | null) => !t?.closest?.('.tm-pop, .route, .tm-rl');

/** Who a post lights on the compact map: its writer and its recipients, the user as You ('you'). */
export const litSids = (post: Pick<Post, 'by' | 'to'>) => [post.by, ...(post.to ?? [])].map((x) => (x === 'user' ? 'you' : x));

/** The team's open tasks nobody has: a count in the map's header. */
export const unassigned = (p: Project) => (p.items ?? []).filter((i) => i.kind === 'task' && itemOpen(i) && !i.owner).length;

/** The map's header: the Team panel's own row (state, version, Bring up, Stand down, Restart to apply, Edit), and how much work nobody has. */
function MapHead({ p, team, live, refresh, draft, board }: { p: Project; team: Team; live: TeamLive | null; refresh?(): void; draft: boolean; board?: string }) {
  const [problems, setProblems] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const act = async (f: TeamAct) => {
    setErr('');
    const o = await teamActOutcome(f);
    setProblems(o.problems);
    setErr(o.error);
    refresh?.();
  };
  const n = unassigned(p);
  return (
    <div className="tm-top-bar">
      <TeamHead p={p} team={team} live={live} draft={draft} act={act}>
        {n ? (
          <button className="tm-unassigned" title="Open tasks nobody has: the Work panel shows them" onClick={() => board && showPanel(board, 'work')}>
            {n} unassigned
          </button>
        ) : null}
      </TeamHead>
      {problems.length || err ? <div className="tm-bad">{[...problems, err].filter(Boolean).join(' ')}</div> : null}
    </div>
  );
}

/**
 * A member's drawer (a click on its row or tile): talk to it (Crew's own reply line, and Open session), its settings
 * (Crew's own menu: the same component, so the two never differ), its work (the Work panel's own controls) and its last
 * posts, and its lifecycle (resume it, end it, restart its seat). From the right on the wide map, over all of it on the
 * compact one; Escape or a click outside closes it (its Escape is its own: the board's never also fires).
 */
export function MemberDrawer({ p, team, s, sessions, asks, full, close }: { p: Project; team: Team; s: SessionInfo; sessions: Record<string, SessionInfo>; asks: boolean; full: boolean; close(): void }) {
  const box = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => void ownEscape(e, () => closeRef.current());
    // (another member's row opens its own drawer: not a click away)
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element | null)?.closest?.('.tm-row, .tm-free, .pc-menu') && closeRef.current();
    document.addEventListener('keydown', esc, true);
    document.addEventListener('mousedown', away, true);
    return () => {
      document.removeEventListener('keydown', esc, true);
      document.removeEventListener('mousedown', away, true);
    };
  }, []);
  const m = p.members[s.id];
  const seat = team.seats.find((x) => x.id === m?.seat);
  const what = seat ? `${seat.name}${seat.count.max > 1 && m?.instance ? ` ${m.instance}` : ''}` : p.lead === s.id ? 'lead' : m?.role?.trim() || 'member';
  const st = memberState(s, asks);
  const running = !!liveTerminal(s.id);
  const work = drawerWork(p, s.id);
  const posts = drawerPosts(p, s.id);
  const [note, setNote] = useState('');
  const resume = async () => {
    const r = await launchTerminal({ mode: 'resume', sessionId: s.id, cwd: s.cwd });
    setNote(r.ok ? '' : r.error);
  };
  const restart = async () => {
    if (!seat) return;
    const o = await teamActOutcome(() => restartTeamSeats(p.id, [seat.id]));
    setNote([...o.problems, o.error].filter(Boolean).join(' '));
  };
  return (
    <aside ref={box} className={`tm-drawer${full ? ' full' : ''}`} role="dialog" aria-label={`${sessionName(s)} in ${p.name}`}>
      <div className="dh" style={{ ['--sc' as string]: sessionColor(s) } as CSSProperties}>
        <span className={`tile s-${st}`}>
          {sessionName(s).trim()[0]?.toUpperCase() || '?'}
          <i />
        </span>
        <span className="hn">
          <b title={sessionName(s)}>{sessionName(s)}</b>
          <span className="hs">
            {what} · {STATE_WORD[st]}
          </span>
        </span>
        <button className="x" onClick={close} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>
      <div className="db">
        <div className="lab">Talk</div>
        <CrewCompose s={s} asks={asks} members={[s]} field={field} onPick={() => {}} onType={() => {}} onSent={() => {}} />
        <div className="acts">
          <button className="pp-btn" onClick={() => open(s.id)}>
            Open session
          </button>
          {/* End…: the drawer closes as the End dialog opens (its own Escape would otherwise take the dialog's) */}
          {!running ? (
            <button className="pp-btn go" onClick={() => void resume()} title="Bring it back here, as itself (its memory)">
              Resume
            </button>
          ) : (
            <button className="pp-btn bad" onClick={() => (close(), usePalette.setState({ ending: s.id }))} title="End it (you're asked first)">
              End…
            </button>
          )}
          {seat ? (
            <button className="pp-btn" onClick={() => void restart()} title={`Stand ${seat.name} down and bring it up again, on its current definition`}>
              Restart {seat.name}
            </button>
          ) : null}
        </div>
        {note ? <div className="pi-err">{note}</div> : null}
        <div className="lab">Settings</div>
        <CrewMenuPanel p={p} s={s} onClose={close} />
        <div className="lab">
          Its work <b>{work.length}</b>
        </div>
        {work.length ? (
          work.map((i) => (
            <div key={i.id} className="tw">
              <div className="tt">
                <span className="n">{i.n}</span>
                <b title={i.title}>{i.title}</b>
              </div>
              <TaskControls p={p} i={i} sessions={sessions} />
            </div>
          ))
        ) : (
          <div className="none">No open tasks.</div>
        )}
        <div className="lab">
          Last posts <b>{posts.length}</b>
        </div>
        {posts.length ? (
          posts.map((x) => (
            <div key={x.id} className={`tm-post${x.blocked ? ' refused' : ''}`}>
              <span className="k">{x.blocked ? 'refused' : x.kind}</span> <time>{ago(x.at)}</time>
              <p title={x.text}>{x.text.replace(/\s+/g, ' ').slice(0, 200)}</p>
            </div>
          ))
        ) : (
          <div className="none">Nothing posted yet.</div>
        )}
      </div>
    </aside>
  );
}

/** A member's open tasks, in the queue's order, each with its place in it (as the Work panel numbers it). */
export function drawerWork(p: Project, sid: string): Array<ProjectItem & { n: number }> {
  return (p.items ?? [])
    .filter((i) => i.kind === 'task' && itemOpen(i))
    .sort(byRank)
    .map((i, k) => ({ ...i, n: k + 1 }))
    .filter((i) => i.owner === sid);
}
/** A member's last 5 posts, newest first. */
export const drawerPosts = (p: Project, sid: string) => p.thread.filter((x) => x.by === sid).slice(-5).reverse();

/** Everything the map draws, placed: the seats' rows and tiles, regions, routes, the free members, the badges, the bounds. */
export function layoutOf(p: Project, team: Team, sessions: Record<string, SessionInfo>, doing: Record<string, string>, branch: (sid: string) => string | null, asking?: (sid: string) => boolean) {
  const base = withColors(withPositions(p.teamLayout ?? { pos: {} }, team), team);
  const deps = { name: sessionName, doing: (sid: string) => doing[sid], branch, ...(asking ? { asking } : {}) };
  const lines: Record<string, MemberLine[]> = Object.fromEntries(team.seats.map((s) => [s.id, seatLines(p, s.id, sessions, deps)]));
  const heights: Record<string, number> = Object.fromEntries(team.seats.map((s) => [s.id, tileHeight(lines[s.id].length)]));
  const free = unseated(p, team, sessions, { name: sessionName, ...(asking ? { asking } : {}) });
  const { look, freeBoxes } = mapLook(team, base, heights, free.length);
  const gb = groupBoxes(team, look);
  const P = ports(team.routes);
  const geoms: Record<string, RouteGeom | null> = Object.fromEntries(team.routes.map((r) => [r.id, routeGeom(team, look, r, gb, P)]));
  const cora = !!look.pos['@cora'];
  const boxOf = (t: Tile): Box | null => {
    if (t.startsWith('seat:')) {
      const id = t.slice(5);
      return look.pos[id] && look.size?.[id] ? { ...look.pos[id], ...look.size[id] } : null;
    }
    if (t.startsWith('m:')) {
      const k = free.findIndex((u) => u.sid === t.slice(2));
      return k >= 0 ? freeBoxes[k] : null;
    }
    if (t.startsWith('group:')) return gb[t.slice(6)] ?? null;
    const at = look.pos[`@${t}`];
    return at ? { x: at.x, y: at.y, w: FREE_W, h: FREE_H } : null;
  };
  let bounds: Box | null = null;
  const add = (b: Box | null | undefined) => b && (bounds = bounds ? union(bounds, b) : { ...b });
  for (const s of team.seats) add(boxOf(`seat:${s.id}`));
  Object.values(gb).forEach(add);
  freeBoxes.forEach(add);
  add(boxOf('user'));
  if (cora) add(boxOf('cora'));
  Object.values(geoms).forEach((g) => add(g?.ext));
  return { look, lines, heights, gb, geoms, free, freeBoxes, cora, boxOf, order: flowOrder(team, base), badges: taskBadges(p, team), bounds: bounds ?? { x: 0, y: 0, w: 400, h: 200 } };
}
type MapLayout = ReturnType<typeof layoutOf>;

/** The path a message travels: its route's leg from its sender, or a short line between the two tiles (header to header). */
export function pathOf(m: Pick<MapLayout, 'geoms' | 'boxOf'>, e: Edge): string | null {
  if (e.route) {
    const leg = m.geoms[e.route.id]?.legs.find((l) => l.i === e.route!.leg);
    if (leg) return leg.full;
  }
  const a = m.boxOf(e.from);
  const b = m.boxOf(e.to);
  if (!a || !b) return null;
  const ay = a.y + Math.min(a.h, HEAD_H) / 2;
  const by = b.y + Math.min(b.h, HEAD_H) / 2;
  // always from the sender to its recipient (a pulse travels it from its start)
  if (b.x >= a.x + a.w) return curve({ x: a.x + a.w, y: ay }, { x: b.x - 3, y: by });
  if (b.x + b.w <= a.x) {
    const dx = Math.max(24, (a.x - (b.x + b.w)) / 2);
    return `M${a.x} ${ay} C${a.x - dx} ${ay} ${b.x + b.w + dx} ${by} ${b.x + b.w + 3} ${by}`;
  }
  // one above the other: a bow out on their right
  const r = Math.max(a.x + a.w, b.x + b.w);
  return `M${a.x + a.w} ${ay} C${r + 40} ${ay} ${r + 40} ${by} ${b.x + b.w + 3} ${by}`;
}

/* ---------------------------------------------------------------- the wide map: the builder's layout */

function WideMap(props: { p: Project; team: Team; m: MapLayout; view: View; width: number; counts: Record<string, number>; sessions: Record<string, SessionInfo>; pulses: Pulse[]; setPulses(f: (ps: Pulse[]) => Pulse[]): void; flashes: Array<{ key: string; edge: Edge; at: number }>; pop: string | null; setPop(r: string | null): void; close(): void; pick(sid: string): void; live: Live }) {
  const { p, team, m, view, counts, sessions, pulses, flashes, pop, setPop, live } = props;
  const hl = (sid: string) => (live.hl?.sids.has(sid) ? ' hl' : '');
  const refused = new Set(flashes.map((f) => f.edge.route?.id).filter((x): x is string => !!x));
  const loose = flashes.filter((f) => !f.edge.route);
  const regions = [...team.groups].sort((a, b) => depthOf(team, a.id) - depthOf(team, b.id));
  const popRoute = pop ? team.routes.find((r) => r.id === pop) : undefined;
  const popAt = popRoute ? m.geoms[popRoute.id]?.chip : null;
  const at = (b: Box): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h });
  return (
    <section className="cv">
      <svg className="canvas">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {regions.map((g) => {
            const b = m.gb[g.id];
            if (!b) return null;
            const nameW = textWidth(g.name.toUpperCase(), 'label');
            return (
              <g key={g.id} className="region" data-tile={`group:${g.id}`}>
                <rect className="rg" x={b.x} y={b.y} width={b.w} height={b.h} rx={14} />
                <text className="rl" x={b.x + PAD} y={b.y + 17}>
                  {g.name.toUpperCase()}
                </text>
                <text className="rd" x={b.x + PAD + nameW + 8} y={b.y + 17}>
                  {dispatchText(g)}
                </text>
              </g>
            );
          })}
          {team.routes.map((r) => {
            const G = m.geoms[r.id];
            const talk = live.talk[r.id];
            return G ? <RouteEl key={r.id} r={r} G={G} count={counts[r.id] ?? 0} talk={talk} cls={`${refused.has(r.id) ? ' refused' : ''}${talk ? ' talking' : ''}${live.hl?.route === r.id ? ' hl' : ''}${pop === r.id ? ' sel' : ''}`} onClick={() => setPop(pop === r.id ? null : r.id)} /> : null;
          })}
          {loose.map((f) => {
            const d = pathOf(m, f.edge);
            return d ? <path key={f.key} className="tm-line refused" d={d} /> : null;
          })}
          {/* a message to or from a member without a seat: its line stays as long as a lit route */}
          {live.talkLines.map((f) => {
            const d = pathOf(m, f.edge);
            return d ? <path key={`t-${f.key}`} className="tm-line talk" d={d} /> : null;
          })}
          {pulses.map((x) => (
            <PulseDot key={x.key} pulse={x} done={() => props.setPulses((ps) => ps.filter((y) => y.key !== x.key))} />
          ))}
        </g>
      </svg>
      {/* the tiles: HTML at the layout's places, moved and scaled with the routes under them */}
      <div className="tm-tiles" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {team.groups.map((g) => {
          const b = m.gb[g.id];
          const mine = m.badges.filter((x) => x.tile === `group:${g.id}`);
          return b && mine.length ? (
            <div key={g.id} className="tm-gbadges" style={{ left: b.x + b.w - 8, top: b.y + 6 }}>
              <Badges list={mine} />
            </div>
          ) : null;
        })}
        {team.seats.map((s) => {
          const b = m.boxOf(`seat:${s.id}`);
          return b ? <SeatCard key={s.id} p={p} team={team} seatId={s.id} color={m.look.color?.[s.id] ?? '#94a3b8'} lines={m.lines[s.id] ?? []} badges={m.badges.filter((x) => x.tile === `seat:${s.id}`)} style={{ ...at(b), position: 'absolute' }} pick={props.pick} live={live} /> : null;
        })}
        {m.free.map((u, k) => (
          <FreeCard key={u.sid} u={u} color={sessionColor(sessions[u.sid])} badges={m.badges.filter((x) => x.tile === `m:${u.sid}`)} style={{ ...at(m.freeBoxes[k]), position: 'absolute' }} pick={props.pick} cls={hl(u.sid)} />
        ))}
        <FixedCard e="user" badges={m.badges.filter((x) => x.tile === 'user')} style={{ ...at(m.boxOf('user')!), position: 'absolute' }} cls={hl('you')} />
        {m.cora ? <FixedCard e="cora" badges={[]} style={{ ...at(m.boxOf('cora')!), position: 'absolute' }} /> : null}
      </div>
      {popRoute && popAt ? <RoutePop p={p} team={team} r={popRoute} at={{ x: popoverLeft(popAt.x * view.k + view.x, props.width), y: popAt.y * view.k + view.y }} close={props.close} /> : null}
    </section>
  );
}

/* ---------------------------------------------------------------- the compact map: a narrow panel */

function CompactMap(props: { p: Project; team: Team; m: MapLayout; counts: Record<string, number>; sessions: Record<string, SessionInfo>; litOf(sid: string): string; lit: Lit[]; pop: string | null; setPop(r: string | null): void; close(): void; pick(sid: string): void; live: Live }) {
  const { p, team, m, counts, sessions, lit, pop, setPop, live } = props;
  const litOf = (sid: string) => `${props.litOf(sid)}${live.hl?.sids.has(sid) ? ' hl' : ''}`;
  const name = (e: Parameters<typeof endpointName>[1]) => (e === 'user' ? 'You' : endpointName(team, e));
  const litRoute = new Map(lit.filter((x) => x.route).map((x) => [x.route!, x.refused]));
  let group = '';
  return (
    <div className="tm-list">
      <section className="tm-sec tm-top">
        <FixedCard e="user" badges={m.badges.filter((x) => x.tile === 'user')} cls={litOf('you')} />
        {m.free.map((u) => (
          <FreeCard key={u.sid} u={u} color={sessionColor(sessions[u.sid])} badges={m.badges.filter((x) => x.tile === `m:${u.sid}`)} cls={litOf(u.sid)} pick={props.pick} />
        ))}
        {m.cora ? <FixedCard e="cora" badges={[]} cls={litOf('cora')} /> : null}
      </section>
      {m.order.map((id) => {
        const s = team.seats.find((x) => x.id === id)!;
        // a group's name where its seats begin
        const g = team.groups.find((x) => x.members.includes(id));
        const head = g && g.id !== group ? g : null;
        group = g?.id ?? '';
        const gbad = head ? m.badges.filter((x) => x.tile === `group:${head.id}`) : [];
        return (
          <section key={id} className="tm-sec">
            {head ? (
              <div className="tm-glab">
                {head.name} <span>{dispatchText(head)}</span>
                <Badges list={gbad} />
              </div>
            ) : null}
            <SeatCard p={p} team={team} seatId={id} color={m.look.color?.[id] ?? '#94a3b8'} lines={m.lines[id] ?? []} badges={m.badges.filter((x) => x.tile === `seat:${id}`)} litOf={litOf} pick={props.pick} live={live} />
            {routeLines(team, s.id, counts, name).map((r) => {
              const route = team.routes.find((x) => x.id === r.id)!;
              const lr = litRoute.get(r.id);
              const talk = live.talk[r.id];
              return (
                <div key={r.id} className="tm-rlw">
                  <button className={`tm-rl w-${r.wake}${lr === undefined ? '' : lr ? ' lit refused' : ' lit'}${talk ? ' talking' : ''}${live.hl?.route === r.id ? ' hl' : ''}${pop === r.id ? ' sel' : ''}`} onClick={() => setPop(pop === r.id ? null : r.id)} title="Its last posts">
                    <span className="ar">→</span> <b>{r.to}</b> · {r.kinds}
                    {talk ? <span className="last">{` · ${talk.kind} ${talk.ago}`}</span> : null}
                    {r.count ? <span className="n"> · {r.count} this hour</span> : null}
                  </button>
                  {pop === r.id ? <RoutePop p={p} team={team} r={route} inline close={props.close} /> : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- tiles */

/** Open tasks as small badges: their place in the queue, coloured by their state; the title on hover. */
function Badges({ list }: { list: Badge[] }) {
  return (
    <>
      {list.map((b) => (
        <span key={b.id} className="tm-badge" title={`#${b.n} ${b.title} (${b.state})`} style={{ ['--bc' as string]: BADGE_COLOR[b.state] ?? 'var(--ink3)' } as CSSProperties}>
          {b.n}
        </span>
      ))}
    </>
  );
}

/** A seat: its header (icon, name, state; a pool's live of max) and a row per live member. */
export function SeatCard({ p, team, seatId, color, lines, badges, style, litOf, pick = open, live }: { p: Project; team: Team; seatId: string; color: string; lines: MemberLine[]; badges: Badge[]; style?: CSSProperties; litOf?(sid: string): string; pick?(sid: string): void; live?: Pick<Live, 'now' | 'hl' | 'needs'> }) {
  const s = team.seats.find((x) => x.id === seatId)!;
  const st = seatState(lines);
  const pool = s.count.max > 1 ? `${lines.length} of ${s.count.max}` : '';
  const lead = team.lead === seatId ? 'leads' : '';
  // (its state is the tile's corner, one signal: said in words only when nobody is running)
  const sub = [st === 'down' ? 'not running' : '', pool, lead, s.agent.model ?? ''].filter(Boolean).join(' · ') || 'running';
  const now = live?.now ?? Date.now();
  const orphan = badges.filter((b) => !lines.some((l) => l.sid === b.sid));
  return (
    <div className={`tm-card tm-seatc s-${st}`} data-tile={`seat:${seatId}`} style={{ ['--sc' as string]: color, ...style } as CSSProperties}>
      <div className="tm-head">
        <span className="tile">
          {(s.name || '?').trim()[0]?.toUpperCase() || '?'}
          <i />
        </span>
        <span className="hn">
          <b title={s.name}>{s.name}</b>
          <span className="hs" title={sub}>
            {sub}
          </span>
        </span>
        {orphan.length ? (
          <span className="hb">
            <Badges list={orphan} />
          </span>
        ) : null}
      </div>
      {lines.length ? (
        lines.map((l) => (
          <button key={l.sid} className={`tm-row m-${l.state}${litOf?.(l.sid) ?? ''}${!litOf && live?.hl?.sids.has(l.sid) ? ' hl' : ''}`} data-sid={l.sid} onClick={() => pick(l.sid)} title={`${l.name}: talk to it, its settings and its work`}>
            <span className="l1">
              <i className="md" />
              <span className="nm" title={l.name}>
                {l.name}
              </span>
              {/* working: how long its turn has run (its dot breathes); needing you: a chip to see to it */}
              {turnTime(l, now) ? <span className="tt">{turnTime(l, now)}</span> : null}
              {l.state === 'need' ? (
                <span
                  className="need"
                  role="button"
                  tabIndex={0}
                  title={l.asking ? 'An approval of its waits for you: open its drawer' : 'It asks you something in its session: open it'}
                  onClick={(e) => (e.stopPropagation(), (live?.needs ?? open)(l.sid))}
                  onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), e.preventDefault(), (live?.needs ?? open)(l.sid))}
                >
                  Needs you
                </span>
              ) : null}
              <Badges list={badges.filter((b) => b.sid === l.sid)} />
            </span>
            <span className="l2" title={l.doing || undefined}>
              {l.doing || <em>nothing said yet</em>}
            </span>
            <span className="l3">{l.branch ? <code title={l.branch}>{l.branch}</code> : <em>no branch</em>}</span>
          </button>
        ))
      ) : (
        <div className="tm-empty">nobody running</div>
      )}
    </div>
  );
}

function FreeCard({ u, color, badges, style, cls = '', pick = open }: { u: Unseated; color: string; badges: Badge[]; style?: CSSProperties; cls?: string; pick?(sid: string): void }) {
  return (
    <button className={`tm-card tm-free s-${u.state}${cls}`} data-tile={`m:${u.sid}`} style={{ ['--sc' as string]: color, ...style } as CSSProperties} onClick={() => pick(u.sid)} title={`${u.name}: talk to it, its settings and its work`}>
      <span className="tile">
        {u.name.trim()[0]?.toUpperCase() || '?'}
        <i />
      </span>
      <span className="hn">
        <b title={u.name}>{u.name}</b>
        <span className="hs">
          {u.role}
          {u.state === 'need' ? ' · needs you' : ''}
        </span>
      </span>
      {badges.length ? (
        <span className="hb">
          <Badges list={badges} />
        </span>
      ) : null}
    </button>
  );
}

function FixedCard({ e, badges, style, cls = '' }: { e: 'user' | 'cora'; badges: Badge[]; style?: CSSProperties; cls?: string }) {
  return (
    <div className={`tm-card tm-fixed${cls}`} data-tile={e} style={{ ['--sc' as string]: e === 'user' ? 'var(--ink2)' : 'var(--cora)', ...style } as CSSProperties}>
      <span className="tile">{e === 'user' ? 'Y' : 'C'}</span>
      <span className="hn">
        <b>{e === 'user' ? 'You' : 'Cora'}</b>
        <span className="hs">{e === 'user' ? 'the user' : 'Cora'}</span>
      </span>
      {badges.length ? (
        <span className="hb">
          <Badges list={badges} />
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- routes and messages */

function RouteEl({ r, G, cls, count, talk, onClick }: { r: Route; G: RouteGeom; cls: string; count: number; talk?: LitRoute; onClick(): void }) {
  const { legs, trunk, T, chip, cs } = G;
  const x0 = chip ? chip.x - cs.w / 2 : 0;
  const y0 = chip ? chip.y - cs.h / 2 : 0;
  return (
    <g className={`route w-${r.wake}${cls}`} data-route={r.id} onClick={onClick}>
      {legs.map((l, i) => (
        <g key={i}>
          <path className="hit" d={l.d} />
          {/* lit: the leg its last message came by, solid */}
          <path className={`ln${talk?.leg === l.i ? ' on' : ''}`} d={l.d} />
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
          {cs.lines.map((l, i) => (
            <text key={i} x={x0 + 6} y={y0 + 11.5 + i * 12}>
              {l}
            </text>
          ))}
          {talk ? (
            // lit: its last kind, how long ago and its count, on a pill under the chip (off the line, clear of tiles)
            <LitLabel chip={chip} cs={cs} talk={talk} count={count} />
          ) : count ? (
            <text className="tm-count" x={x0 + cs.w + 5} y={y0 + 11.5}>
              {count}
            </text>
          ) : null}
        </g>
      ) : null}
    </g>
  );
}

function LitLabel({ chip, cs, talk, count }: { chip: { x: number; y: number }; cs: { h: number }; talk: LitRoute; count: number }) {
  const last = `${talk.kind} · ${talk.ago}`;
  const L = litLabel(chip, cs, textWidth(`${last}${count ? ` · ${count}` : ''}`, 'chip'));
  return (
    <g className="tm-lit">
      <rect className="pill" x={L.x} y={L.y} width={L.w} height={L.h} rx={L.h / 2} />
      <text className="tm-count" x={L.tx} y={L.ty} textAnchor="middle">
        <tspan className="last">{last}</tspan>
        {count ? ' · ' : ''}
        {count || ''}
      </text>
    </g>
  );
}

/** A message travelling its path once (eased), then gone. */
function PulseDot({ pulse, done }: { pulse: Pulse; done(): void }) {
  const ref = useRef<SVGPathElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const path = ref.current;
    if (!path?.getTotalLength) return done();
    const L = path.getTotalLength();
    let raf = 0;
    const step = (t: number) => {
      const q = Math.min(1, (t - pulse.at) / PULSE_MS);
      const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
      const pt = path.getPointAtLength(L * e);
      setAt({ x: pt.x, y: pt.y });
      if (q < 1) raf = requestAnimationFrame(step);
      else done();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <g>
      <path ref={ref} className={pulse.edge.route ? 'fp' : 'tm-line'} d={pulse.d} />
      {at ? (
        <>
          <circle className="tdot-halo" r={7} cx={at.x} cy={at.y} />
          <circle className="tdot" r={3.5} cx={at.x} cy={at.y} />
        </>
      ) : null}
    </g>
  );
}

/** A route's last few posts: a small card by its chip (or, `inline`, under its line on the compact map). */
function RoutePop({ p, team, r, at, inline, close }: { p: Project; team: Team; r: Route; at?: { x: number; y: number }; inline?: boolean; close(): void }) {
  const sessions = useBrain((s) => s.sessions);
  const posts = routePosts(p, team, r.id);
  const who = (by: string) => (by === 'you' ? 'You' : by === 'cora' ? 'Cora' : sessions[by] ? sessionName(sessions[by]) : 'a session');
  // its Escape is its own: caught first and consumed, so the board's (leaving Fill the area) never also fires
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const k = (e: KeyboardEvent) => void ownEscape(e, () => closeRef.current());
    document.addEventListener('keydown', k, true);
    return () => document.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div className={`tm-pop${inline ? ' inline' : ''}`} style={at ? { left: at.x, top: at.y + 14 } : undefined}>
      {posts.length ? (
        posts.map((x: Post) => (
          <div key={x.id} className={`tm-post${x.blocked ? ' refused' : ''}`}>
            <b>{who(x.by)}</b> <span className="k">{x.blocked ? 'refused' : x.kind}</span> <time>{ago(x.at)}</time>
            <p title={x.text}>{x.text.replace(/\s+/g, ' ').slice(0, 160)}</p>
          </div>
        ))
      ) : (
        <div className="tm-post none">Nothing on this route yet.</div>
      )}
    </div>
  );
}
