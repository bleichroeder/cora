import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Post, Project, ProjectItem, SessionInfo, Team } from '@cora/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TeamMap, drawerPosts, drawerWork, layoutOf, litSids, nextChange, outsidePop, ownEscape, pathOf, unassigned } from '../src/components/board/TeamMap';
import { endKey } from '../src/components/EndSession';
import type { TeamLive } from '../src/components/board/TeamPanel';
import { EMPTY_H, HEAD_H, LIT_MS, ROW_H, TILE_W, flowOrder, litLines, litRoutes, nextFade, railEvents, railOpens, railTargets, turnTime, isCompact, mapLook, memberState, popoverLeft, postEdges, routeCounts, routeLines, routePosts, seatLines, seatState, taskBadges, tileHeight, tileOf, unseated } from '../src/components/board/teamMapModel';

const S = (id: string, alias: string, more: Partial<SessionInfo> = {}) => ({ id, alias, state: 'idle', needsYou: 0, startedAt: 1, lastTs: 10, cwd: 'C:/w', ...more }) as SessionInfo;
const seat = (id: string, name: string, count = { min: 1, max: 1 }) => ({ id, name, instructions: '', agent: {}, skills: [], folder: { path: 'C:/w' }, count, startup: {} });
const TEAM: Team = {
  version: 1,
  seats: [seat('eng', 'Engineer', { min: 1, max: 3 }), seat('rev', 'Reviewer'), seat('test', 'Tester')],
  groups: [{ id: 'builders', name: 'Builders', members: ['eng'], dispatch: 'claim' }],
  labels: [],
  routes: [
    { id: 'r1', from: ['seat:eng'], to: 'seat:rev', kinds: ['handoff'], wake: 'auto' },
    { id: 'r2', from: ['seat:rev', 'group:builders'], to: 'seat:test', kinds: ['handoff', 'note'], wake: 'auto' },
    { id: 'r3', from: ['seat:test'], to: 'user', kinds: 'any', wake: 'auto' },
  ],
  fallback: 'user',
  escalation: [],
};
const post = (id: string, by: string, to: string[], o: Partial<Post> = {}): Post => ({ id, by, kind: 'handoff', text: `post ${id}`, at: 1_000_000, to, ...o });
const task = (id: string, o: Partial<ProjectItem> = {}): ProjectItem => ({ id, kind: 'task', title: `Task ${id}`, state: 'queued', openedBy: 'you', openedAt: 1, updatedBy: 'you', updatedAt: 1, notes: [], ...o });
/** eng-1, eng-2 (an ended eng-3), rev, test, and the lead with no seat */
const project = (o: Partial<Project> = {}): Project =>
  ({
    id: 'p1', name: 'Dev', brief: '', briefAt: 0, decisions: [], thread: [], items: [], lead: 'lead',
    sessions: ['e1', 'e2', 'e3', 'r', 't', 'lead', 'helper'],
    members: { e1: { seat: 'eng', instance: 1 }, e2: { seat: 'eng', instance: 2 }, e3: { seat: 'eng', instance: 3 }, r: { seat: 'rev' }, t: { seat: 'test' }, lead: {}, helper: { role: 'docs' } },
    team: TEAM,
    ...o,
  }) as unknown as Project;
const SESSIONS: Record<string, SessionInfo> = {
  e1: S('e1', 'Engineer 1', { state: 'working' }),
  e2: S('e2', 'Engineer 2', { state: 'needs-you' }),
  e3: S('e3', 'Engineer 3', { state: 'ended' }),
  r: S('r', 'Reviewer'),
  t: S('t', 'Tester'),
  lead: S('lead', 'Tech Lead'),
  helper: S('helper', 'Docs'),
};
const deps = { name: (s: SessionInfo) => s.alias ?? s.id, doing: (sid: string) => ({ e1: 'Building the  map', r: 'Reviewing fix/x' })[sid], branch: (sid: string) => ({ e1: 'feat/team-map', e2: 'fix/y' })[sid] ?? null };

describe("a seat's member rows", () => {
  it("one per live member, lowest instance first: its name, state, what it's on (one line) and its branch; ended ones none", () => {
    const lines = seatLines(project(), 'eng', SESSIONS, deps);
    expect(lines).toEqual([
      { sid: 'e1', name: 'Engineer 1', state: 'work', doing: 'Building the map', branch: 'feat/team-map', instance: 1 },
      { sid: 'e2', name: 'Engineer 2', state: 'need', doing: '', branch: 'fix/y', instance: 2 },
    ]);
    expect(seatState(lines)).toBe('need');
    expect(seatLines(project(), 'rev', SESSIONS, deps)).toEqual([{ sid: 'r', name: 'Reviewer', state: 'idle', doing: 'Reviewing fix/x', branch: null }]);
    // nobody running: no rows, the seat is down
    expect(seatState(seatLines(project(), 'test', { ...SESSIONS, t: S('t', 'Tester', { state: 'ended' }) }, deps))).toBe('down');
    // a member asking the user (an approval waiting) needs you, whatever its state
    expect(memberState(S('x', 'X'), true)).toBe('need');
    expect(memberState(S('x', 'X', { needsYou: 1 }))).toBe('need');
    expect(memberState(S('x', 'X', { state: 'thinking' }))).toBe('work');
  });

  it('a pool of two, both live (as this project has its Engineers): two rows, the lower instance first, whatever the order of the sessions', () => {
    const p = project({ sessions: ['e2', 'r', 'e1'], members: { e1: { seat: 'eng', instance: 1 }, e2: { seat: 'eng', instance: 2 }, r: { seat: 'rev' } } } as never);
    const both = { e1: S('e1', 'Engineer 1', { state: 'working' }), e2: S('e2', 'Engineer 2', { state: 'working' }), r: S('r', 'Reviewer') };
    expect(seatLines(p, 'eng', both, deps).map((l) => [l.sid, l.state])).toEqual([
      ['e1', 'work'],
      ['e2', 'work'],
    ]);
  });

  it('members without a seat get tiles of their own, named by their role, the lead first', () => {
    expect(unseated(project(), TEAM, SESSIONS, deps).map((u) => [u.sid, u.role, u.state])).toEqual([
      ['lead', 'lead', 'idle'],
      ['helper', 'docs', 'idle'],
    ]);
    // ended: no tile
    expect(unseated(project(), TEAM, { ...SESSIONS, helper: S('helper', 'Docs', { state: 'ended' }) }, deps).map((u) => u.sid)).toEqual(['lead']);
  });
});

describe('which edge a post animates on', () => {
  it("a seat to a seat: along the route that allows it, from the sender's leg", () => {
    expect(postEdges(project(), TEAM, post('a', 'e1', ['r']))).toEqual([{ from: 'seat:eng', to: 'seat:rev', route: { id: 'r1', leg: 0 }, blocked: false }]);
    // a pool member through its group's leg of a route
    expect(postEdges(project(), TEAM, post('b', 'e2', ['t']))).toEqual([{ from: 'seat:eng', to: 'seat:test', route: { id: 'r2', leg: 1 }, blocked: false }]);
    expect(postEdges(project(), TEAM, post('c', 'r', ['t']))[0].route).toEqual({ id: 'r2', leg: 0 });
    // to the user, on the team's route to You
    expect(postEdges(project(), TEAM, post('d', 't', ['user']))).toEqual([{ from: 'seat:test', to: 'user', route: { id: 'r3', leg: 0 }, blocked: false }]);
  });

  it('to and from a member without a seat (the lead), or with no route: a short-lived line (no route)', () => {
    expect(postEdges(project(), TEAM, post('a', 'lead', ['e1', 'r']))).toEqual([
      { from: 'm:lead', to: 'seat:eng', route: null, blocked: false },
      { from: 'm:lead', to: 'seat:rev', route: null, blocked: false },
    ]);
    expect(postEdges(project(), TEAM, post('b', 'r', ['e1']))).toEqual([{ from: 'seat:rev', to: 'seat:eng', route: null, blocked: false }]);
    // to everyone, or to itself: nothing travels
    expect(postEdges(project(), TEAM, post('c', 'e1', []))).toEqual([]);
    expect(postEdges(project(), TEAM, post('d', 'e1', ['e2']))).toEqual([]);
  });

  it('a refused post flashes on the route it tried (any between them, whatever its kind), else on a line', () => {
    // Engineer → Reviewer is a handoff route: a question there was refused
    expect(postEdges(project(), TEAM, post('a', 'e1', ['r'], { kind: 'question', blocked: true }))).toEqual([{ from: 'seat:eng', to: 'seat:rev', route: { id: 'r1', leg: 0 }, blocked: true }]);
    // Reviewer → Engineer: no route at all
    expect(postEdges(project(), TEAM, post('b', 'r', ['e1'], { blocked: true }))).toEqual([{ from: 'seat:rev', to: 'seat:eng', route: null, blocked: true }]);
  });

  it("each route's count of the last hour (refused ones never went), and its last posts", () => {
    const now = 10_000_000;
    const p = project({ thread: [post('old', 'e1', ['r'], { at: now - 2 * 3_600_000 }), post('a', 'e1', ['r'], { at: now - 60_000 }), post('b', 'e2', ['r'], { at: now - 30_000 }), post('x', 'e1', ['r'], { kind: 'question', blocked: true, at: now - 10_000 }), post('c', 'r', ['t'], { at: now - 5_000 })] });
    expect(routeCounts(p, TEAM, now)).toEqual({ r1: 2, r2: 1 });
    expect(routePosts(p, TEAM, 'r1').map((x) => x.id)).toEqual(['x', 'b', 'a', 'old']);
  });
});

describe('the work on the map', () => {
  it("each open task on its owner's tile: a seated owner's own row, a member's own tile, a group's region, You; numbered as the queue", () => {
    const items = [task('a', { rank: 2, owner: 'e2', state: 'building' }), task('b', { rank: 1, owner: 'lead' }), task('c', { rank: 3, owner: 'builders' }), task('d', { rank: 4 }), task('e', { rank: 5, owner: 'you', state: 'review' }), task('f', { rank: 0, owner: 'e1', state: 'done' })];
    expect(taskBadges(project({ items }), TEAM).map((b) => [b.id, b.n, b.state, b.tile, b.sid])).toEqual([
      ['b', 1, 'queued', 'm:lead', undefined],
      ['a', 2, 'building', 'seat:eng', 'e2'],
      ['c', 3, 'queued', 'group:builders', undefined],
      ['e', 5, 'review', 'user', undefined],
    ]);
    // its owner changes: it moves with it
    const moved = items.map((i) => (i.id === 'a' ? { ...i, owner: 'r' } : i));
    expect(taskBadges(project({ items: moved }), TEAM).find((b) => b.id === 'a')).toMatchObject({ tile: 'seat:rev', sid: 'r' });
    expect(tileOf(project(), TEAM, 'nobody')).toBeNull();
  });
});

describe('the layout', () => {
  it("the builder's columns, left to right, a tile each as tall as its rows, none overlapping; You and the members without a seat in a row above", () => {
    const m = layoutOf(project(), TEAM, SESSIONS, {}, () => null);
    const [e, r, t] = ['eng', 'rev', 'test'].map((id) => m.boxOf(`seat:${id}`)!);
    // the builder has the Engineer on the left, the Reviewer and the Tester in the next column (the Builders route
    // straight to the Tester): so do the tiles, the gap between the columns the builder's (408 - 188)
    expect(r.x).toBe(e.x + TILE_W + 220);
    expect(t.x).toBe(r.x);
    expect(t.y).toBeGreaterThanOrEqual(r.y + r.h + 14);
    // fixed rows: the pool of two is taller by a row
    expect([e.h, r.h, t.h]).toEqual([tileHeight(2), tileHeight(1), tileHeight(1)]);
    expect(tileHeight(2) - tileHeight(1)).toBe(ROW_H);
    expect(tileHeight(0)).toBe(HEAD_H + EMPTY_H + 6);
    // You, then the lead and the helper, in a row above everything (the Builders' region and its label too)
    const you = m.boxOf('user')!;
    expect(m.freeBoxes.map((b) => b.y)).toEqual([you.y, you.y]);
    expect(m.freeBoxes[0].x).toBeGreaterThan(you.x + you.w);
    expect(you.y + you.h).toBeLessThan(m.gb.builders!.y);
    // the route geometry follows the tiles: its arrows leave a tile's right edge (252 wide, not the builder's 188)
    expect(m.geoms.r1!.legs[0].d.startsWith(`M${e.x + TILE_W} `)).toBe(true);
  });

  it("seats one above the other in a builder column stay so, without overlapping (a group's seats together)", () => {
    const t: Team = { ...TEAM, seats: [seat('a', 'A'), seat('b', 'B'), seat('c', 'C')], groups: [{ id: 'g', name: 'G', members: ['a', 'c'], dispatch: 'claim' }], routes: [] };
    const { look } = mapLook(t, { pos: { a: { x: 0, y: 0 }, b: { x: 0, y: 60 }, c: { x: 0, y: 120 } } }, { a: 100, b: 100, c: 100 }, 0);
    const order = ['a', 'b', 'c'].sort((x, y) => look.pos[x].y - look.pos[y].y);
    // a and c (a group) together, b after them; one column
    expect(order).toEqual(['a', 'c', 'b']);
    expect(new Set(order.map((id) => look.pos[id].x)).size).toBe(1);
    for (let k = 1; k < 3; k++) expect(look.pos[order[k]].y).toBeGreaterThanOrEqual(look.pos[order[k - 1]].y + 100 + 14);
  });

  it("a post's path: its route's leg, or a line from the sender's header to the recipient's", () => {
    const m = layoutOf(project(), TEAM, SESSIONS, {}, () => null);
    expect(pathOf(m, postEdges(project(), TEAM, post('a', 'e1', ['r']))[0])).toBe(m.geoms.r1!.legs[0].full);
    const line = pathOf(m, postEdges(project(), TEAM, post('b', 'lead', ['r']))[0])!;
    expect(line).toMatch(/^M[\d.-]+ [\d.-]+ C/);
    // a recipient on the sender's left: still from the sender (its dot travels the right way)
    const back = pathOf(m, { from: 'seat:test', to: 'seat:eng', route: null, blocked: false })!;
    expect(back.startsWith(`M${m.boxOf('seat:test')!.x} `)).toBe(true);
  });
});

describe('the wide map: HTML tiles, a row per member', () => {
  const html = (p = project(), width = 1600) => renderToStaticMarkup(createElement(TeamMap, { p, team: TEAM, sessions: SESSIONS, doing: { e1: 'Building the map', e2: 'Fixing the label' }, branch: (sid: string) => ({ e1: 'feat/team-map', e2: 'fix/y' })[sid] ?? null, now: 10_000_000, size: { width, height: 1000 } }));
  const slice = (h: string, from: string, to: string) => h.slice(h.indexOf(from), h.indexOf(to));

  it("every live member of a pool has its row: both Engineers, each with its name, state, what it's on and its branch; the header says 2 of 3", () => {
    const h = html();
    expect(h).not.toContain('tm-list');
    const eng = slice(h, 'data-tile="seat:eng"', 'data-tile="seat:rev"');
    expect(eng.match(/class="tm-row /g)).toHaveLength(2);
    expect(eng).toContain('Engineer 1');
    expect(eng).toContain('Engineer 2');
    expect(eng).toContain('Building the map');
    expect(eng).toContain('Fixing the label');
    expect(eng).toContain('<code title="feat/team-map">feat/team-map</code>');
    // the header: a pool's live of max (its state is the tile's corner, not said again in words)
    expect(eng).toContain('2 of 3');
    expect(eng).not.toContain('needs you · 2 of 3');
    // the member needing you: its row's chip
    expect(eng).toMatch(/class="need"[^>]*>Needs you</);
    // the ended Engineer 3 has no row
    expect(eng).not.toContain('Engineer 3');
    // the full text on hover: each field's title
    expect(eng).toContain('title="Fixing the label"');
  });

  it('the members without a seat, You, the badges and the route counts', () => {
    const p = project({ items: [task('a', { rank: 1, owner: 'e2', state: 'building' })], thread: [post('a', 'e1', ['r'], { at: 10_000_000 - 1000 })] });
    const h = html(p);
    for (const t of ['seat:eng', 'seat:rev', 'seat:test', 'm:lead', 'm:helper', 'user']) expect(h).toContain(`data-tile="${t}"`);
    expect(slice(h, 'data-tile="m:lead"', 'data-tile="m:helper"')).toMatch(/<span class="hs">lead<\/span>/);
    // the badge on Engineer 2's own row
    expect(slice(h, 'data-sid="e2"', 'data-tile="seat:rev"')).toMatch(/class="tm-badge"[^>]*>1</);
    // a route that carried a message in the last five minutes: its last kind and how long ago, then its count
    expect(h).toMatch(/class="tm-count"[^>]*><tspan class="last">handoff · \d+s<\/tspan> · (<!-- -->)?1<\/text>/);
    // nothing travels until a post arrives after it's drawn
    expect(h).not.toContain('tdot');
  });
});

describe('a narrow panel: the compact map', () => {
  const html = (width: number, p = project()) => renderToStaticMarkup(createElement(TeamMap, { p, team: TEAM, sessions: SESSIONS, doing: {}, branch: () => null, now: 10_000_000, size: { width, height: 700 } }));

  it('is used below 520px, or wherever the wide map would read under 80%', () => {
    expect(isCompact(293, 1)).toBe(true);
    expect(isCompact(519, 1)).toBe(true);
    expect(isCompact(800, 0.7)).toBe(true);
    expect(isCompact(1600, 1)).toBe(false);
    expect(html(293)).toContain('tm-list');
    expect(html(1600)).not.toContain('tm-list');
  });

  it('the seats as sections in the order work flows, each with its member rows; You and the members without a seat first; no SVG', () => {
    const h = html(293);
    expect(h).not.toContain('<svg');
    const at = (s: string) => h.indexOf(s);
    expect(at('data-tile="user"')).toBeLessThan(at('data-tile="m:lead"'));
    expect(at('data-tile="m:lead"')).toBeLessThan(at('data-tile="seat:eng"'));
    expect(at('data-tile="seat:eng"')).toBeLessThan(at('data-tile="seat:rev"'));
    expect(at('data-tile="seat:rev"')).toBeLessThan(at('data-tile="seat:test"'));
    expect(h.match(/class="tm-row /g)).toHaveLength(4);
    // a group's name where its seats begin
    expect(h).toMatch(/class="tm-glab">Builders/);
  });

  it("each seat's routes as short lines under it: whom to, its kinds, its count of the last hour", () => {
    const p = project({ thread: [post('a', 'e1', ['r'], { at: 10_000_000 - 1000 }), post('b', 'e1', ['r'], { at: 10_000_000 - 500 })] });
    const h = html(293, p);
    const eng = h.slice(h.indexOf('data-tile="seat:eng"'), h.indexOf('data-tile="seat:rev"'));
    expect(eng).toMatch(/→<\/span> <b>Reviewer<\/b> · handoff<span class="last"> · handoff \d+s<\/span><span class="n"> · 2 this hour<\/span>/);
    // the pool's group route (Builders → Tester) is the Engineer's too
    expect(eng).toMatch(/<b>Tester<\/b> · handoff, note/);
    expect(routeLines(TEAM, 'test', {}, (e) => (e === 'user' ? 'You' : e))).toEqual([{ id: 'r3', to: 'You', kinds: 'any message', count: 0, wake: 'auto' }]);
  });

  it("in flow order whatever the builder had: a group's seats together", () => {
    const t: Team = { ...TEAM, seats: [seat('a', 'A'), seat('b', 'B'), seat('c', 'C')], groups: [{ id: 'g', name: 'G', members: ['a', 'c'], dispatch: 'claim' }], routes: [{ id: 'r', from: ['seat:b'], to: 'group:g', kinds: 'any', wake: 'auto' }] };
    expect(flowOrder(t, { pos: { a: { x: 400, y: 0 }, b: { x: 0, y: 0 }, c: { x: 400, y: 200 } } })).toEqual(['b', 'a', 'c']);
  });

  it("a route's popover stays inside the panel, however near its edge the route is", () => {
    expect(popoverLeft(10, 293)).toBe(146.5);
    expect(popoverLeft(150, 1000)).toBe(152);
    expect(popoverLeft(990, 1000)).toBe(848);
    expect(popoverLeft(500, 1000)).toBe(500);
  });
});

describe("pass 2: a member's drawer", () => {
  const items = [task('a', { rank: 1, owner: 'e2', state: 'building' }), task('b', { rank: 2, owner: 'lead' }), task('c', { rank: 3, owner: 'e2', state: 'review' }), task('d', { rank: 4 }), task('e', { rank: 5, owner: 'e2', state: 'done' })];
  const thread = Array.from({ length: 7 }, (_, k) => post(`p${k}`, k % 2 ? 'e2' : 'r', ['lead'], { at: 1_000_000 + k }));
  const drawer = (sid: string, size = { width: 1600, height: 1000 }) => renderToStaticMarkup(createElement(TeamMap, { p: project({ items, thread, coordination: true }), team: TEAM, sessions: SESSIONS, doing: {}, branch: () => null, now: 10_000_000, size, drawer: sid }));
  const part = (h: string) => h.slice(h.indexOf('class="tm-drawer'), h.indexOf('class="tm-rail'));

  it('a pool member: its name, its seat and number, Crew\'s reply line to it, Crew\'s settings, its work in queue order, its last posts, and Restart its seat', () => {
    const h = part(drawer('e2'));
    expect(h).toContain('Engineer 2');
    expect(h).toContain('Engineer 2 · needs you');
    // Talk: Crew's own reply line, To this member only
    expect(h).toMatch(/class="pc-compose"/);
    expect(h).toMatch(/<select[^>]*><option value="e2" selected="">Engineer 2<\/option><\/select>/);
    expect(h).toContain('Open session');
    // Settings: Crew's own menu (lead, hears, may post, may be woken, seat name)
    expect(h).toMatch(/class="pc-menu"/);
    for (const t of ['Lead of the project', 'Hears', 'May post to the project', 'May be woken', 'Seat name']) expect(h).toContain(t);
    // its work: its open tasks in queue order (numbered as the Work panel), with the Work panel's state control
    expect(drawerWork(project({ items }), 'e2').map((i) => [i.id, i.n])).toEqual([
      ['a', 1],
      ['c', 3],
    ]);
    expect(h).toMatch(/Its work <b>2<\/b>/);
    expect(h.indexOf('Task a')).toBeLessThan(h.indexOf('Task c'));
    expect(h).not.toContain('Task e');
    expect(h.match(/<button class="on">(building|review)<\/button>/g)).toEqual(['<button class="on">building</button>', '<button class="on">review</button>']);
    // its last posts (its own, newest first, five at most)
    expect(drawerPosts(project({ thread }), 'e2').map((x) => x.id)).toEqual(['p5', 'p3', 'p1']);
    expect(drawerPosts(project({ thread: Array.from({ length: 9 }, (_, k) => post(`q${k}`, 'e2', [])) }), 'e2').map((x) => x.id)).toEqual(['q8', 'q7', 'q6', 'q5', 'q4']);
    // its lifecycle: not running here (no terminal), so Resume; and its seat's restart
    expect(h).toContain('Resume');
    expect(h).toContain('Restart Engineer');
  });

  it('the lead (no seat): named as the lead, the same talk and settings, its work; no seat to restart', () => {
    const h = part(drawer('lead'));
    expect(h).toContain('lead · idle');
    expect(h).toMatch(/class="pc-compose"/);
    expect(h).toMatch(/class="pc-menu"/);
    expect(h).toMatch(/Its work <b>1<\/b>/);
    expect(h).toContain('Task b');
    expect(h).not.toContain('Restart ');
  });

  it('a seated member that leads nothing, alone on its seat: its seat with no number', () => {
    expect(part(drawer('r'))).toContain('Reviewer · idle');
    expect(part(drawer('r'))).toContain('Restart Reviewer');
  });

  it('over all of the compact map, from the right on the wide one', () => {
    expect(drawer('e2', { width: 293, height: 700 })).toContain('class="tm-drawer full"');
    expect(drawer('e2')).toContain('class="tm-drawer"');
  });
});

describe("pass 2: the map's header", () => {
  const head = (p: Project, live: TeamLive | null) => {
    const h = renderToStaticMarkup(createElement(TeamMap, { p, team: TEAM, sessions: SESSIONS, doing: {}, branch: () => null, now: 10_000_000, size: { width: 1600, height: 1000 }, live }));
    return h.slice(h.indexOf('class="tm-top-bar"'), h.indexOf('class="tm-body"'));
  };
  const LIVE = (o: Partial<TeamLive> = {}): TeamLive => ({ version: 4, up: true, health: [], restart: [], ...o });

  it("the Team panel's own row: state and version, Edit, Bring up and Stand down (as bringUpOffer says)", () => {
    const h = head(project(), LIVE());
    expect(h).toContain('Version 4');
    expect(h).toContain('>up<');
    expect(h).toContain('Stand down');
    expect(h).toMatch(/<button class="pp-btn" disabled="" title="The team is up">Bring up<\/button>/);
    // stood down: Bring up offered, Stand down not
    const down = head(project(), LIVE({ up: false }));
    expect(down).toContain('stood down');
    expect(down).toMatch(/<button class="pp-btn go" title="[^"]*">Bring up<\/button>/);
    expect(down).toMatch(/<button class="pp-btn bad" disabled=""[^>]*>Stand down<\/button>/);
    // its members run an older definition: Restart to apply
    expect(head(project(), LIVE({ restart: ['rev'] }))).toContain('Restart Reviewer to apply');
  });

  it("how much work nobody has: open tasks without an owner (never done ones), none at all says nothing", () => {
    const items = [task('a', { rank: 1 }), task('b', { rank: 2 }), task('c', { rank: 3, owner: 'e1' }), task('d', { rank: 4, state: 'done' })];
    expect(unassigned(project({ items }))).toBe(2);
    expect(head(project({ items }), LIVE())).toContain('2 unassigned');
    expect(head(project(), LIVE())).not.toContain('unassigned');
  });
});

describe("pass 2: pass 1's findings", () => {
  it("a post to the user lights You (its card goes by 'you'), as well as its writer", () => {
    expect(litSids(post('a', 't', ['user']))).toEqual(['t', 'you']);
    expect(litSids(post('b', 'e1', ['r', 'lead']))).toEqual(['e1', 'r', 'lead']);
  });

  it("Escape on the popover or the drawer is its own: it closes it and is consumed, so the board's never also fires", () => {
    const calls: string[] = [];
    const ev = (key: string) => ({ key, preventDefault: () => void calls.push('prevented'), stopPropagation: () => void calls.push('stopped') });
    expect(ownEscape(ev('Escape'), () => void calls.push('closed'))).toBe(true);
    expect(calls).toEqual(['prevented', 'stopped', 'closed']);
    calls.length = 0;
    expect(ownEscape(ev('Enter'), () => void calls.push('closed'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a click anywhere outside the popover closes it: on the map, or elsewhere on the board', () => {
    const at = (inside: boolean) => ({ closest: (sel: string) => (inside && sel.includes('.tm-pop') ? {} : null) });
    expect(outsidePop(at(false))).toBe(true);
    expect(outsidePop(at(true))).toBe(false);
    // (a click on something that isn't an element, the page itself)
    expect(outsidePop(null)).toBe(true);
    expect(outsidePop({})).toBe(true);
  });

  it("the compact cards shrink to the panel's width (down to 200px), never wider than it", () => {
    const css = readFileSync(join(__dirname, '../src/components/board/teamMap.css'), 'utf8');
    expect(css).toContain('minmax(min(240px, 100%), 1fr)');
    expect(css).toContain('minmax(min(180px, 100%), 1fr)');
    expect(css).toMatch(/\.tb\.tm\.compact \.tm-card \{ min-width: 0; width: 100%; \}/);
    // and the map at 200px is the compact one
    expect(isCompact(200, 1)).toBe(true);
  });
});

describe('pass 3: working, and needing you', () => {
  const MIN = 60_000;
  const now = 10_000_000;
  it("a working member's row says how long its turn has run (from its turnAt), counted as it goes; nobody else's does", () => {
    const sessions = { ...SESSIONS, e1: S('e1', 'Engineer 1', { state: 'working', turnAt: now - 4 * MIN }) };
    const [l1, l2] = seatLines(project(), 'eng', sessions, deps);
    expect(l1.turnAt).toBe(now - 4 * MIN);
    expect(turnTime(l1, now)).toBe('4m');
    expect(turnTime(l1, now + 2 * MIN)).toBe('6m');
    // needing you, idle, or working with no turnAt known: no timer
    expect(turnTime(l2, now)).toBeNull();
    expect(turnTime({ state: 'idle', turnAt: now - MIN }, now)).toBeNull();
    expect(turnTime({ state: 'work' }, now)).toBeNull();
    const h = renderToStaticMarkup(createElement(TeamMap, { p: project(), team: TEAM, sessions, doing: {}, branch: () => null, now, size: { width: 1600, height: 1000 } }));
    expect(h).toMatch(/data-sid="e1"[\s\S]*?<span class="tt">4m<\/span>/);
  });

  it('a member that needs you: its row is marked, with a Needs you chip (an approval waiting is said as such)', () => {
    const asks = (sid: string) => sid === 'r';
    const lines = seatLines(project(), 'rev', SESSIONS, { ...deps, asking: asks });
    expect(lines[0]).toMatchObject({ state: 'need', asking: true });
    const h = renderToStaticMarkup(createElement(TeamMap, { p: project(), team: TEAM, sessions: SESSIONS, doing: {}, branch: () => null, now, size: { width: 1600, height: 1000 }, asks }));
    // e2 (its session needs you) and r (an approval waits): both marked, each with its chip
    expect(h).toMatch(/class="tm-row m-need"[^>]*data-sid="e2"/);
    expect(h).toMatch(/class="tm-row m-need"[^>]*data-sid="r"/);
    expect(h).toMatch(/data-sid="r"[\s\S]*?title="An approval of its waits for you: open its drawer"[^>]*>Needs you</);
    expect(h).toMatch(/data-sid="e2"[\s\S]*?title="It asks you something in its session: open it"[^>]*>Needs you</);
  });
});

describe('pass 3: who is talking to whom', () => {
  const MIN = 60_000;
  const now = 10_000_000;
  it('a route that carried a message in the last five minutes stays lit, by its latest (its kind, the leg it came by, how long ago); then it goes out', () => {
    const p = project({ thread: [post('a', 'e1', ['r'], { at: now - 4 * MIN }), post('b', 'e1', ['r'], { kind: 'question', blocked: true, at: now - MIN }), post('c', 'e2', ['t'], { kind: 'note', at: now - 30_000 }), post('d', 'r', ['t'], { at: now - 6 * MIN })] });
    expect(litRoutes(p, TEAM, now)).toEqual({ r1: { kind: 'handoff', at: now - 4 * MIN, leg: 0, ago: '4m' }, r2: { kind: 'note', at: now - 30_000, leg: 1, ago: '30s' } });
    // a minute on, r1's message is five minutes old: out
    expect(Object.keys(litRoutes(p, TEAM, now + MIN))).toEqual(['r2']);
    // the next change: r1 going out (and the hour's count losing its messages later)
    expect(nextFade(p, now)).toBe(now - 4 * MIN + LIT_MS);
    expect(nextChange(p, now)).toBe(now - 4 * MIN + LIT_MS);
    // nothing lit, nothing in the hour: nothing to wait for (nothing loops)
    expect(nextChange(project(), now)).toBeNull();
    expect(nextChange(project({ thread: [post('x', 'e1', ['r'], { at: now - 10 * MIN })] }), now)).toBe(now - 10 * MIN + 3_600_000);
  });

  it('a message with no route (to or from a member without a seat) keeps its line as long as a lit route', () => {
    const p = project({ thread: [post('a', 'lead', ['e1'], { at: now - 2 * MIN }), post('b', 'e1', ['r'], { at: now - MIN }), post('c', 'lead', ['r'], { at: now - 6 * MIN })] });
    expect(litLines(p, TEAM, now).map((x) => [x.key, x.edge.from, x.edge.to])).toEqual([['a:0', 'm:lead', 'seat:eng']]);
    const h = renderToStaticMarkup(createElement(TeamMap, { p, team: TEAM, sessions: SESSIONS, doing: {}, branch: () => null, now, size: { width: 1600, height: 1000 } }));
    expect(h.match(/class="tm-line talk"/g)).toHaveLength(1);
    // the lit route: its class, its leg solid, its last kind by its chip
    expect(h).toMatch(/class="route w-auto talking"[^>]*data-route="r1"/);
    expect(h).toMatch(/data-route="r1"[\s\S]*?class="ln on"/);
  });
});

describe('pass 3: the activity rail', () => {
  const MIN = 60_000;
  const now = 10_000_000;
  const items = [task('a', { rank: 1, openedAt: now - 9 * MIN, owner: 'e1', ownedAt: now - 8 * MIN, state: 'review', updatedAt: now - 3 * MIN }), task('b', { rank: 2, openedAt: now - 7 * MIN, owner: 'e2', ownedAt: now - 7 * MIN, state: 'done', updatedAt: now - 2 * MIN, closedAt: now - 2 * MIN, outcome: 'merged as abc1234' })];
  const thread = [post('h', 'e1', ['r'], { at: now - 5 * MIN, text: 'branch: feat/x\nready for review' }), post('q', 'e1', ['r'], { kind: 'question', blocked: true, at: now - 4 * MIN, text: 'may I merge?' }), post('u', 't', ['user'], { kind: 'question', at: now - MIN, text: 'ship it?' })];
  const sess = { e1: S('e1', 'Engineer 1', { startedAt: now - 20 * MIN }), e2: S('e2', 'Engineer 2', { startedAt: now - 20 * MIN, state: 'ended', lastTs: now - 30_000 }), r: S('r', 'Reviewer', { startedAt: now - 30 * MIN }), t: S('t', 'Tester', { startedAt: now - 30 * MIN }) };
  const p = () => project({ items, thread, sessions: ['e1', 'e2', 'r', 't'] } as never);
  const name = (x: string) => (x === 'user' || x === 'you' ? 'You' : (sess as Record<string, SessionInfo>)[x]?.alias ?? x);

  it('the last events, newest first, a line each: posts (who → who, kind, first words), refused ones, task moves, members starting and stopping', () => {
    const ev = railEvents(p(), TEAM, sess, name);
    expect(ev.map((e) => [e.kind, e.text])).toEqual([
      ['member', 'Engineer 2 stopped'],
      ['post', 'Tester → You · question: ship it?'],
      ['task', 'Task b done: merged as abc1234'],
      ['task', 'Task a: review'],
      ['refused', 'Engineer 1 → Reviewer · refused: may I merge?'],
      ['post', 'Engineer 1 → Reviewer · handoff: branch: feat/x ready for review'],
      ['task', 'Task b → Engineer 2'],
      ['task', 'Task opened: Task b'],
      ['task', 'Task a → Engineer 1'],
      ['task', 'Task opened: Task a'],
      // (at one moment, the later of two first: as they're listed)
      ['member', 'Engineer 2 started'],
      ['member', 'Engineer 1 started'],
      ['member', 'Tester started'],
      ['member', 'Reviewer started'],
    ]);
    // thirty at most
    const many = project({ thread: Array.from({ length: 40 }, (_, k) => post(`m${k}`, 'e1', ['r'], { at: now - k * 1000 })), sessions: [] } as never);
    expect(railEvents(many, TEAM, {}, name)).toHaveLength(30);
    expect(railEvents(many, TEAM, {}, name)[0].key).toBe('p:m0');
  });

  it("an entry lights its members and its route while hovered; a click opens its route's popover, else its first member's drawer (never You's)", () => {
    const ev = railEvents(p(), TEAM, sess, name);
    const handoff = ev.find((e) => e.key === 'p:h')!;
    expect(railTargets(handoff)).toEqual({ sids: new Set(['e1', 'r']), route: 'r1' });
    expect(railOpens(handoff, p().sessions)).toEqual({ route: 'r1' });
    // to the user: You is lit, and the Tester's drawer opens (the user's route has no popover worth it: r3, here, does)
    const toYou = ev.find((e) => e.key === 'p:u')!;
    expect(toYou.who).toEqual(['t', 'you']);
    expect(railOpens({ who: ['you', 't'], route: null }, p().sessions)).toEqual({ member: 't' });
    expect(railOpens({ who: ['you'], route: null }, p().sessions)).toBeNull();
    const move = ev.find((e) => e.key === 't:a:state')!;
    expect(railTargets(move)).toEqual({ sids: new Set(['e1']), route: null });
  });

  it('on the wide map a column at its edge; on the compact one a strip at its top; it can be folded', () => {
    const wide = renderToStaticMarkup(createElement(TeamMap, { p: p(), team: TEAM, sessions: sess, doing: {}, branch: () => null, now, size: { width: 1600, height: 1000 } }));
    expect(wide).toMatch(/<aside class="tm-rail" aria-label="What happened lately">/);
    expect(wide).toMatch(/class="re k-refused"[^>]*>/);
    expect(wide.indexOf('class="tm-body"')).toBeLessThan(wide.indexOf('class="tm-rail"'));
    const narrow = renderToStaticMarkup(createElement(TeamMap, { p: p(), team: TEAM, sessions: sess, doing: {}, branch: () => null, now, size: { width: 293, height: 700 } }));
    expect(narrow).toMatch(/<aside class="tm-rail strip"/);
    expect(narrow.indexOf('class="tm-rail strip"')).toBeLessThan(narrow.indexOf('class="tm-main"'));
  });
});

describe("pass 3: the End dialog's Escape", () => {
  it("is its own: it closes the dialog and is consumed (the board stays in Fill the area, a drawer under it stays); Enter does what it offers", () => {
    const calls: string[] = [];
    const ev = (key: string) => ({ key, preventDefault: () => void calls.push('prevented'), stopPropagation: () => void calls.push('stopped') });
    const o = { close: () => void calls.push('closed'), go: () => void calls.push('went') };
    expect(endKey(ev('Escape'), o)).toBe(true);
    expect(calls).toEqual(['prevented', 'stopped', 'closed']);
    calls.length = 0;
    expect(endKey(ev('Enter'), o)).toBe(true);
    expect(calls).toEqual(['went']);
    calls.length = 0;
    expect(endKey(ev('a'), o)).toBe(false);
    expect(calls).toEqual([]);
  });
});
