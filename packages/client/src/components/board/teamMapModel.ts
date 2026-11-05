import { LABEL_H, NODE_W, PAD, byRank, endpointsOf, itemOpen, layersOf, parentsOf, routeAllows, type Endpoint, type MsgKind, type Post, type Project, type ProjectItem, type SessionInfo, type Team, type TeamLayout } from '@cora/shared';
import { type Box, type SizedLayout } from '../builder/geometry';
import { seatMembers } from './TeamPanel';
import { shortAge } from '../../lib/navRow';

/**
 * The live team map's computed parts (a board panel: the team as the builder draws it, read-only, with its members,
 * their messages and their work on it). Everything here is plain data from the project, its sessions and its posts; the
 * view (TeamMap.tsx) draws it.
 */

/** A member's state, as Crew says it: needs you, working, idle; ended is down. */
export type MemberState = 'need' | 'work' | 'idle' | 'down';
export const memberState = (s: SessionInfo | undefined, asking = false): MemberState =>
  !s || s.state === 'ended' ? 'down' : asking || s.state === 'needs-you' || s.needsYou > 0 ? 'need' : s.state === 'working' || s.state === 'thinking' ? 'work' : 'idle';

/** One member's line on its seat's tile: its name, state, what it's on (its "doing" status) and its branch. */
/** `turnAt`: when a working member's current turn began (its timer); `asking`: an approval of its waits for the user. */
export type MemberLine = { sid: string; name: string; state: MemberState; doing: string; branch: string | null; instance?: number; turnAt?: number; asking?: true };
/** What the lines are made from: the session's name, what it's doing, its branch, whether it's asking the user. */
export type LineDeps = { name(s: SessionInfo): string; doing(sid: string): string | undefined; branch(sid: string): string | null; asking?(sid: string): boolean };

/** A seat's live members (not ended), lowest instance first: a line each. */
export function seatLines(p: Project, seatId: string, sessions: Record<string, SessionInfo>, d: LineDeps): MemberLine[] {
  return seatMembers(p, seatId)
    .map((sid) => ({ sid, s: sessions[sid], instance: p.members[sid]?.instance }))
    .filter((x): x is { sid: string; s: SessionInfo; instance: number | undefined } => !!x.s && x.s.state !== 'ended')
    .sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1))
    .map(({ sid, s, instance }) => {
      const state = memberState(s, d.asking?.(sid));
      return { sid, name: d.name(s), state, doing: (d.doing(sid) ?? '').replace(/\s+/g, ' ').trim(), branch: d.branch(sid), ...(instance !== undefined ? { instance } : {}), ...(state === 'work' && s.turnAt ? { turnAt: s.turnAt } : {}), ...(d.asking?.(sid) ? { asking: true as const } : {}) };
    });
}

/** A seat's state on its tile's corner: a member needing you first, then working, then idle; nobody running is down. */
export function seatState(lines: MemberLine[]): MemberState {
  if (!lines.length) return 'down';
  return lines.some((l) => l.state === 'need') ? 'need' : lines.some((l) => l.state === 'work') ? 'work' : 'idle';
}

/** A member without a seat (the lead, a helper): a tile of its own, named by its role. */
export type Unseated = { sid: string; name: string; role: string; state: MemberState };
/** The project's members that have no seat in its team (and haven't ended), the lead first. */
export function unseated(p: Project, team: Team, sessions: Record<string, SessionInfo>, d: Pick<LineDeps, 'name' | 'asking'>): Unseated[] {
  const seats = new Set(team.seats.map((s) => s.id));
  return p.sessions
    .filter((sid) => !seats.has(p.members[sid]?.seat ?? '') && sessions[sid] && sessions[sid].state !== 'ended')
    .map((sid) => ({ sid, name: d.name(sessions[sid]), role: p.lead === sid ? 'lead' : p.members[sid]?.role?.trim() || 'member', state: memberState(sessions[sid], d.asking?.(sid)) }))
    .sort((a, b) => (a.role === 'lead' ? 0 : 1) - (b.role === 'lead' ? 0 : 1));
}

/** Where something sits on the map: a seat's tile, a member's own tile (no seat), a group's region, You or Cora. */
export type Tile = `seat:${string}` | `m:${string}` | `group:${string}` | 'user' | 'cora';
/** The tile a post's writer or recipient (a session id, 'you', 'user', 'cora', or a team group's id) is on; null: none. */
export function tileOf(p: Project, team: Team, who: string): Tile | null {
  if (who === 'you' || who === 'user') return 'user';
  if (who === 'cora') return 'cora';
  const seat = p.members[who]?.seat;
  if (seat && team.seats.some((s) => s.id === seat)) return `seat:${seat}`;
  if (p.sessions.includes(who)) return `m:${who}`;
  if (team.groups.some((g) => g.id === who)) return `group:${who}`;
  return null;
}
/** A tile as a route's endpoint (a member's own tile is on no route). */
const endpointOf = (t: Tile): Endpoint | null => (t.startsWith('m:') ? null : (t as Endpoint));

/**
 * Where a message goes on the map: from one tile to another, along a route of the team's (its leg from the sender) or,
 * with none, a short-lived line between them. `blocked`: the team's routes refused it (it flashes red where it tried).
 */
export type Edge = { from: Tile; to: Tile; route: { id: string; leg: number } | null; blocked: boolean };

/** The route a message from one endpoint to another takes: the one that allows it, else any between them (what it tried). */
function routeBetween(team: Team, from: Endpoint, to: Endpoint, kind: MsgKind, labels?: Record<string, string>): { id: string; leg: number } | null {
  const fromSet = endpointsOf(team, from);
  const toSet = endpointsOf(team, to);
  const leg = (r: Team['routes'][number]) => r.from.findIndex((f) => fromSet.includes(f));
  const ok = routeAllows(team, from, to, kind, labels, false);
  const allowed = ok.ok && ok.route.id !== 'implicit' ? ok.route : undefined;
  const r = allowed ?? team.routes.find((x) => toSet.includes(x.to) && leg(x) >= 0);
  return r && leg(r) >= 0 ? { id: r.id, leg: leg(r) } : null;
}

/** A post's kind, as a route's kinds name it. */
const asKind = (k: Post['kind']): MsgKind => k as MsgKind;

/** A post's edges on the map: one per recipient that has a tile (a post to everyone, or to nobody on the map, has none). */
export function postEdges(p: Project, team: Team, post: Post): Edge[] {
  const from = tileOf(p, team, post.by);
  if (!from) return [];
  const out: Edge[] = [];
  for (const to of post.to ?? []) {
    const tt = tileOf(p, team, to);
    if (!tt || tt === from) continue;
    const a = endpointOf(from);
    const b = endpointOf(tt);
    const route = a && b ? routeBetween(team, a, b, asKind(post.kind), post.labels) : null;
    out.push({ from, to: tt, route, blocked: !!post.blocked });
  }
  return out;
}

const HOUR = 3_600_000;
/** Each route's messages in the last hour (refused ones aren't counted: they never went). */
export function routeCounts(p: Project, team: Team, now: number): Record<string, number> {
  const n: Record<string, number> = {};
  for (const post of p.thread) {
    if (post.blocked || now - post.at > HOUR || post.at > now) continue;
    for (const e of postEdges(p, team, post)) if (e.route) n[e.route.id] = (n[e.route.id] ?? 0) + 1;
  }
  return n;
}

/** A route's last few posts (newest first), for its popover. */
export function routePosts(p: Project, team: Team, routeId: string, max = 5): Post[] {
  return p.thread.filter((x) => postEdges(p, team, x).some((e) => e.route?.id === routeId)).slice(-max).reverse();
}

/** An open task on its owner's tile: its place in the queue (as the Work panel numbers it) and its state. */
export type Badge = { id: string; title: string; n: number; state: string; tile: Tile; sid?: string };
/** The open tasks, each on its owner's tile (a seated owner's own line on its seat, a group's region, You); unowned: none. */
export function taskBadges(p: Project, team: Team): Badge[] {
  const open = (p.items ?? []).filter((i): i is ProjectItem => i.kind === 'task' && itemOpen(i)).sort(byRank);
  const out: Badge[] = [];
  open.forEach((i, k) => {
    if (!i.owner) return;
    const tile = tileOf(p, team, i.owner);
    if (!tile) return;
    out.push({ id: i.id, title: i.title, n: k + 1, state: i.state, tile, ...(tile.startsWith('seat:') ? { sid: i.owner } : {}) });
  });
  return out;
}

/* ---------------------------------------------------------------- sizes: fixed rows, so the layout is exact */

/** A seat tile's width (names fit), its header, a member's row (name, what it's doing, its branch), an empty seat's row. */
export const TILE_W = 252;
export const HEAD_H = 44;
export const ROW_H = 60;
export const EMPTY_H = 28;
const TILE_PAD = 6;
/** A seat tile's height: its header and a row per live member (a quiet row when none is running). */
export const tileHeight = (rows: number) => HEAD_H + (rows ? rows * ROW_H : EMPTY_H) + TILE_PAD;
/** A member without a seat's tile, and You's (and Cora's). */
export const FREE_W = 200;
export const FREE_H = 52;
/** Between the tiles of a column, and between columns (more when the builder had more: room for the routes' chips). */
const GAP = 14;
const COL_GAP = 132;

/** A seat's groups, outermost first. */
function chainOf(team: Team, id: string): string[] {
  const c: string[] = [];
  let g = parentsOf(team, id)[0];
  const seen = new Set<string>();
  while (g && !seen.has(g.id)) {
    seen.add(g.id);
    c.unshift(g.id);
    g = parentsOf(team, g.id)[0];
  }
  return c;
}

/** The seats in the order work flows (the builder's layers, first to last), a group's seats together. */
export function flowOrder(team: Team, look: TeamLayout): string[] {
  const { layer } = layersOf(team);
  const under = (gid: string): string[] => (team.groups.find((g) => g.id === gid)?.members ?? []).flatMap((m) => (team.groups.some((g) => g.id === m) ? under(m) : [m]));
  const groupRank = (gid: string) => Math.min(...under(gid).map((s) => layer[s] ?? 0)) * 1000 + team.groups.findIndex((g) => g.id === gid);
  const idx = (id: string) => team.seats.findIndex((s) => s.id === id);
  // a seat in no group sits among the groups of its layer, after them
  const key = (id: string): number[] => {
    const c = chainOf(team, id);
    return [...(c.length ? c.map(groupRank) : [(layer[id] ?? 0) * 1000 + 999]), layer[id] ?? 0, look.pos[id]?.y ?? 0, idx(id)];
  };
  const cmp = (a: number[], b: number[]) => {
    for (let k = 0; k < Math.max(a.length, b.length); k++) if ((a[k] ?? -1) !== (b[k] ?? -1)) return (a[k] ?? -1) - (b[k] ?? -1);
    return 0;
  };
  return team.seats.map((s) => s.id).sort((a, b) => cmp(key(a), key(b)));
}

/** Where a column's seats go down it: a group's label and padding where a group starts or ends, centred on 0. */
function stack(team: Team, ids: string[], heights: Record<string, number>): number[] {
  const ys: number[] = [];
  let y = 0;
  let prev: { chain: string[]; h: number } | null = null;
  for (const id of ids) {
    const c = chainOf(team, id);
    if (!prev) y = LABEL_H * c.length;
    else {
      let common = 0;
      while (common < prev.chain.length && common < c.length && prev.chain[common] === c[common]) common++;
      y += prev.h + (prev.chain.length === common && c.length === common ? GAP : PAD * (prev.chain.length - common) + LABEL_H * (c.length - common) + GAP);
    }
    ys.push(y);
    prev = { chain: c, h: heights[id] };
  }
  const end = ids.length ? ys[ys.length - 1] + heights[ids[ids.length - 1]] : 0;
  return ys.map((v) => v - end / 2);
}

/**
 * The map's layout from the builder's: the same columns, left to right (seats that overlap across are one), in the same
 * order down each (a group's seats together), the gap between two columns at least what the builder had; each seat a
 * tile as tall as its rows. Above the team, a row: You, the members without a seat, and Cora when a route uses her.
 */
export function mapLook(team: Team, look: TeamLayout, heights: Record<string, number>, free: number): { look: SizedLayout; freeBoxes: Box[] } {
  const ids = team.seats.map((s) => s.id).filter((id) => look.pos[id]).sort((a, b) => look.pos[a].x - look.pos[b].x || look.pos[a].y - look.pos[b].y);
  const cols: Array<{ x: number; ids: string[] }> = [];
  for (const id of ids) {
    const c = cols[cols.length - 1];
    if (c && look.pos[id].x - c.x < NODE_W) c.ids.push(id);
    else cols.push({ x: look.pos[id].x, ids: [id] });
  }
  const order = flowOrder(team, look);
  const pos: SizedLayout['pos'] = {};
  const size: NonNullable<SizedLayout['size']> = {};
  let x = 0;
  cols.forEach((c, k) => {
    if (k) x += TILE_W + Math.max(COL_GAP, c.x - cols[k - 1].x - NODE_W);
    // down the column as the builder had it, a group's seats kept together
    const down = [...c.ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    stack(team, down, heights).forEach((y, j) => {
      pos[down[j]] = { x, y };
      size[down[j]] = { w: TILE_W, h: heights[down[j]] };
    });
  });
  const top = Math.min(0, ...Object.entries(pos).map(([id, p]) => p.y - LABEL_H * chainOf(team, id).length));
  const rowY = top - FREE_H - 48;
  pos['@user'] = { x: 0, y: rowY };
  const freeBoxes = Array.from({ length: free }, (_, k) => ({ x: (FREE_W + 14) * (k + 1), y: rowY, w: FREE_W, h: FREE_H }));
  if (team.routes.some((r) => r.to === 'cora' || r.from.includes('cora'))) pos['@cora'] = { x: (FREE_W + 14) * (free + 1), y: rowY };
  return { look: { ...look, pos, size }, freeBoxes };
}

/**
 * The compact map (a narrow panel)? Below `NARROW` wide, or wherever the map would read under 80% of its size.
 */
export const NARROW = 520;
export const isCompact = (width: number, k: number) => width < NARROW || k < 0.8;

/** A route as the compact map says it, under its sender: whom it goes to, its kinds, its count of the last hour. */
export type RouteLine = { id: string; to: string; kinds: string; count: number; wake: Team['routes'][number]['wake'] };
/** The routes a seat sends on (its own, or a group's it's in), as lines under it. */
export function routeLines(team: Team, seatId: string, counts: Record<string, number>, name: (e: Endpoint) => string): RouteLine[] {
  const mine = endpointsOf(team, `seat:${seatId}`);
  return team.routes
    .filter((r) => r.from.some((f) => mine.includes(f)))
    .map((r) => ({ id: r.id, to: name(r.to), kinds: r.kinds === 'any' ? 'any message' : r.kinds.join(', '), count: counts[r.id] ?? 0, wake: r.wake }));
}

/* ---------------------------------------------------------------- live: what's running, what just happened */

/** How long a working member's current turn has run ("4m"), from when it began (the session's turnAt); else none. */
export const turnTime = (l: Pick<MemberLine, 'state' | 'turnAt'>, now: number): string | null => (l.state === 'work' && l.turnAt ? shortAge(Math.max(0, now - l.turnAt)) : null);

/** How long a route stays lit after a message (and a message with no route keeps its line). */
export const LIT_MS = 5 * 60_000;
/** A route lit by its last message: its kind, when, the leg it came by (its sender's), how long ago in words. */
export type LitRoute = { kind: Post['kind']; at: number; leg: number; ago: string };
/** The routes that carried a message in the last five minutes (refused ones never went), each by its latest. */
export function litRoutes(p: Project, team: Team, now: number): Record<string, LitRoute> {
  const out: Record<string, LitRoute> = {};
  for (const post of p.thread) {
    if (post.blocked || post.at > now || now - post.at >= LIT_MS) continue;
    for (const e of postEdges(p, team, post)) if (e.route && (out[e.route.id]?.at ?? -1) <= post.at) out[e.route.id] = { kind: post.kind, at: post.at, leg: e.route.leg, ago: shortAge(now - post.at) };
  }
  return out;
}
/** The messages of the last five minutes that went by no route (to or from a member without a seat): their lines stay as long. */
export function litLines(p: Project, team: Team, now: number): Array<{ key: string; edge: Edge; at: number }> {
  const out: Array<{ key: string; edge: Edge; at: number }> = [];
  for (const post of p.thread) {
    if (post.blocked || post.at > now || now - post.at >= LIT_MS) continue;
    postEdges(p, team, post).forEach((e, k) => !e.route && out.push({ key: `${post.id}:${k}`, edge: e, at: post.at }));
  }
  return out;
}
/** When the next lit route or line goes out (the map draws itself again then, never on a loop); none lit: null. */
export function nextFade(p: Project, now: number): number | null {
  let next: number | null = null;
  for (const post of p.thread) if (!post.blocked && post.at <= now && now - post.at < LIT_MS) next = Math.min(next ?? Infinity, post.at + LIT_MS);
  return next;
}

/**
 * Where a lit route's label ("question · 3m · 1") goes: on a pill centred just under its chip, off the route's line
 * (which runs through the chip, and would run through the text beside it) and so clear of the tiles at its ends.
 * `textW`: the label's width. The pill's box, and where its text is centred.
 */
export function litLabel(chip: { x: number; y: number }, cs: { h: number }, textW: number): { x: number; y: number; w: number; h: number; tx: number; ty: number } {
  const w = Math.ceil(textW) + 12;
  const h = 14;
  const y = chip.y + cs.h / 2 + 3;
  return { x: chip.x - w / 2, y, w, h, tx: chip.x, ty: y + 10 };
}

/** One line of the activity rail: when, what (a post, a refused one, a task's move, a member starting or stopping), whom it lights. */
export type RailEvent = { key: string; at: number; kind: 'post' | 'refused' | 'task' | 'member'; text: string; who: string[]; route: string | null; item?: string };
const first = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/**
 * The activity rail: the project's last events, newest first. Posts (who → who, kind, first words; refused ones as
 * such), task moves (opened, then each move it kept: every assignment and state, done with its outcome; one from before
 * moves were kept says its last of each), members starting and stopping (their session's start, and its end). `name`: a writer's or
 * recipient's name (a session id, 'you', 'user', 'cora', a group's id).
 */
export function railEvents(p: Project, team: Team, sessions: Record<string, SessionInfo>, name: (who: string) => string, max = 30): RailEvent[] {
  const out: RailEvent[] = [];
  const you = (x: string) => (x === 'user' ? 'you' : x);
  for (const post of p.thread) {
    const to = (post.to ?? []).filter((x) => x !== post.by);
    const route = postEdges(p, team, post).find((e) => e.route)?.route?.id ?? null;
    const head = `${name(post.by)}${to.length ? ` → ${to.map(name).join(', ')}` : ''}`;
    out.push({ key: `p:${post.id}`, at: post.at, kind: post.blocked ? 'refused' : 'post', text: `${head} · ${post.blocked ? 'refused' : post.kind}: ${first(post.text)}`, who: [post.by, ...to].map(you), route });
  }
  for (const i of p.items ?? []) {
    if (i.kind !== 'task') continue;
    out.push({ key: `t:${i.id}:open`, at: i.openedAt, kind: 'task', text: `Task opened: ${first(i.title, 50)}`, who: [you(i.openedBy)], route: null, item: i.id });
    const done = () => `${first(i.title, 40)} done${i.outcome ? `: ${first(i.outcome, 40)}` : ''}`;
    if (i.moves?.length) {
      // every step it took: each assignment, each state (building, review, testing), done
      let owner = i.moves.find((m) => m.field === 'owner')?.from;
      i.moves.forEach((m, k) => {
        if (m.field === 'owner') owner = m.to;
        const lights = owner ? [you(owner)] : [];
        const text = m.field === 'owner' ? `${first(i.title, 40)} → ${m.to ? name(m.to) : 'nobody'}` : m.to === 'done' ? done() : `${first(i.title, 40)}: ${m.to ?? '?'}`;
        out.push({ key: `t:${i.id}:m${k}`, at: m.at, kind: 'task', text, who: lights, route: null, item: i.id });
      });
      continue;
    }
    // one from before moves were kept: its last of each
    if (i.owner && i.ownedAt) out.push({ key: `t:${i.id}:own`, at: i.ownedAt, kind: 'task', text: `${first(i.title, 40)} → ${name(i.owner)}`, who: [you(i.owner)], route: null, item: i.id });
    if (itemOpen(i) && i.updatedAt > Math.max(i.openedAt, i.ownedAt ?? 0)) out.push({ key: `t:${i.id}:state`, at: i.updatedAt, kind: 'task', text: `${first(i.title, 40)}: ${i.state}`, who: i.owner ? [you(i.owner)] : [], route: null, item: i.id });
    if (!itemOpen(i) && i.closedAt) out.push({ key: `t:${i.id}:done`, at: i.closedAt, kind: 'task', text: done(), who: i.owner ? [you(i.owner)] : [], route: null, item: i.id });
  }
  for (const sid of p.sessions) {
    const s = sessions[sid];
    if (!s) continue;
    out.push({ key: `m:${sid}:start`, at: s.startedAt, kind: 'member', text: `${name(sid)} started`, who: [sid], route: null });
    if (s.state === 'ended') out.push({ key: `m:${sid}:end`, at: s.lastTs, kind: 'member', text: `${name(sid)} stopped`, who: [sid], route: null });
  }
  // at one moment, the later of two things first (a task assigned as it's opened: its assignment above its opening)
  const seq = new Map(out.map((e, k) => [e, k]));
  return out.sort((a, b) => b.at - a.at || seq.get(b)! - seq.get(a)!).slice(0, max);
}

/** What a rail entry lights on the map while hovered: its members' rows and tiles, its route. */
export const railTargets = (e: Pick<RailEvent, 'who' | 'route'>): { sids: Set<string>; route: string | null } => ({ sids: new Set(e.who), route: e.route });
/** What a click on a rail entry opens: its route's popover, else the first member's drawer (never You's). */
export function railOpens(e: Pick<RailEvent, 'who' | 'route'>, members: string[]): { route: string } | { member: string } | null {
  if (e.route) return { route: e.route };
  const m = e.who.find((x) => members.includes(x));
  return m ? { member: m } : null;
}

/** Where a popover of `half` its width goes, centred on `x` but kept inside a panel `width` wide (12px from its edges). */
export function popoverLeft(x: number, width: number, half = 140): number {
  const h = Math.min(half, Math.max(0, (width - 24) / 2));
  return Math.max(12 + h, Math.min(width - 12 - h, x));
}
