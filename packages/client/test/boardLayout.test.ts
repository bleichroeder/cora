import { describe, expect, it } from 'vitest';
import { CORA_BOARD, CORA_LAYOUT, boardFor, fitsBoard, COLS, DEFAULT_BOARD, LAYOUTS, ROWS, shellsOf, addLayoutPage, duplicatePage, moveName, movePage, movedTo, addPanel, asLayout, fromLayout, namesWithout, crossings, moveMeet, dropEdge, dropOn, keepBoards, lineAt, lines, merge, moveEdge, moveLine, normalize, pageCount, popExplain, removePage, removePanel, scrollToShow, sendToPage, shareOut, template, tile, tiles, visible, type BoardItem, type PanelKind } from '../src/lib/boardLayout';

const at = (items: BoardItem[]) => Object.fromEntries(items.map((i) => [i.id, [i.x, i.y, i.w, i.h]]));
const it_ = (id: string, x: number, y: number, w: number, h: number): BoardItem => ({ id, k: 'agents', x, y, w, h });

describe("the live board's grid", () => {
  it('the default tiles the 24 by 24 area exactly', () => {
    expect(tiles(DEFAULT_BOARD)).toBe(true);
    expect(tile(DEFAULT_BOARD)).toBe(DEFAULT_BOARD);
  });

  it('any layout is laid out over the whole area: holes filled, overhangs brought in, shares kept', () => {
    // a hole on the right, and a board taller than the area
    const t = tile([it_('a', 0, 0, 6, 8), it_('b', 0, 8, 6, 16)]);
    expect(tiles(t)).toBe(true);
    expect(at(t)).toEqual({ a: [0, 0, 24, 8], b: [0, 8, 24, 16] });
    // overlapping panels: laid out side by side, in reading order
    expect(tiles(tile([it_('a', 0, 0, 6, 6), it_('b', 3, 3, 6, 6)]))).toBe(true);
    // four pinwheeled round a hole: no straight cut, still tiled
    expect(tiles(tile([it_('a', 0, 0, 8, 4), it_('b', 8, 0, 4, 8), it_('c', 4, 8, 8, 4), it_('d', 0, 4, 4, 8)]))).toBe(true);
  });

  it('shares cells fairly, each part at least its least', () => {
    expect(shareOut(24, [1, 1, 1], [3, 3, 3])).toEqual([8, 8, 8]);
    expect(shareOut(24, [10, 1], [3, 3])).toEqual([21, 3]);
    expect(shareOut(24, [1, 1, 1, 1, 1], [3, 3, 3, 3, 3]).reduce((a, b) => a + b)).toBe(24);
  });

  it('a line moves like a split bar: every panel along it, both sides, as far as each stays 3 wide', () => {
    expect(at(moveEdge(DEFAULT_BOARD, 'agents', 'x', 18))).toEqual({
      agents: [0, 0, 18, 16],
      touching: [18, 0, 6, 12],
      explains: [18, 12, 6, 12],
      tasks: [0, 16, 18, 8],
    });
    expect(at(moveEdge(DEFAULT_BOARD, 'tasks', 'x', 24)).agents).toEqual([0, 0, 21, 16]);
    // the line between Agents and Tasks runs only under Agents
    expect(at(moveEdge(DEFAULT_BOARD, 'agents', 'y', 12))).toMatchObject({ agents: [0, 0, 14, 12], tasks: [0, 12, 14, 12], touching: [14, 0, 10, 12] });
    expect(moveEdge(DEFAULT_BOARD, 'agents', 'x', 14)).toBe(DEFAULT_BOARD);
  });

  it('every line between panels can be dragged (never the edges of the area), and where two meet, both', () => {
    const ls = lines(DEFAULT_BOARD);
    expect(ls.map((l) => [l.axis, l.at, l.from, l.to])).toEqual(
      expect.arrayContaining([
        ['x', 14, 0, 24],
        ['y', 16, 0, 14],
        ['y', 12, 14, 24],
      ]),
    );
    expect(ls).toHaveLength(3);
    // the line between Touching and Explains is Explains' top too: dragging it from either side is the same line
    const tx = ls.find((l) => l.axis === 'y' && l.at === 12)!;
    const moved = moveLine(DEFAULT_BOARD, tx, 8);
    expect(at(moved)).toMatchObject({ touching: [14, 0, 10, 8], explains: [14, 8, 10, 16] });
    expect(lineAt(moved, tx)).toBe(8);
    // a T where a line ends on another: both move
    const ms = crossings(ls);
    expect(ms.map((m) => [m.x, m.y])).toEqual(expect.arrayContaining([[14, 16], [14, 12]]));
    const m = ms.find((c) => c.y === 16)!;
    const both = moveMeet(DEFAULT_BOARD, m, 18, 20);
    expect(at(both)).toMatchObject({ agents: [0, 0, 18, 20], tasks: [0, 20, 18, 4] });
    // as far as it goes, and no further
    expect(lineAt(moveLine(DEFAULT_BOARD, m.vs[0], 24), m.vs[0])).toBe(21);
  });

  it('lines that line up meet at one point, one handle for all of them (never two on top of each other)', () => {
    // two columns, each split at the same height: the up-and-down line meets two across lines at one point
    const four = [it_('a', 0, 0, 12, 12), it_('b', 0, 12, 12, 12), it_('c', 12, 0, 12, 12), it_('d', 12, 12, 12, 12)];
    const ms = crossings(lines(four));
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ x: 12, y: 12 });
    expect(ms[0].hs).toHaveLength(2);
    // dragging it moves the whole cross
    expect(at(moveMeet(four, ms[0], 16, 8))).toEqual({ a: [0, 0, 16, 8], b: [0, 8, 16, 16], c: [16, 0, 8, 8], d: [16, 8, 8, 16] });
    // and after it, still one
    expect(crossings(lines(moveMeet(four, ms[0], 16, 8)))).toHaveLength(1);
  });

  it('dropped on another panel: its middle swaps them, an edge takes that half (its own place taken up)', () => {
    expect(at(dropOn(DEFAULT_BOARD, 'tasks', 'touching', 'swap'))).toMatchObject({ tasks: [14, 0, 10, 12], touching: [0, 16, 14, 8] });
    const split = dropOn(DEFAULT_BOARD, 'tasks', 'touching', 'bottom');
    expect(tiles(split)).toBe(true);
    expect(at(split)).toMatchObject({ agents: [0, 0, 14, 24], touching: [14, 0, 10, 6], tasks: [14, 6, 10, 6], explains: [14, 12, 10, 12] });
    expect(at(dropOn(DEFAULT_BOARD, 'explains', 'agents', 'left'))).toMatchObject({ explains: [0, 0, 7, 16], agents: [7, 0, 7, 16], touching: [14, 0, 10, 24] });
    expect(dropOn(DEFAULT_BOARD, 'tasks', 'tasks', 'swap')).toBe(DEFAULT_BOARD);
  });

  it("dropped on the board's own edge: the full width (or height) along it, as deep as it was", () => {
    // two stacked on the left, one the full height on the right: the bottom left one goes the full width
    const b = [it_('a', 0, 0, 12, 12), it_('b', 0, 12, 12, 12), it_('c', 12, 0, 12, 24)];
    expect(at(dropEdge(b, 'b', 'bottom'))).toEqual({ a: [0, 0, 12, 12], b: [0, 12, 24, 12], c: [12, 0, 12, 12] });
    // never more than half the board; the rest keep their shares
    const r = dropEdge(DEFAULT_BOARD, 'agents', 'right');
    expect(tiles(r)).toBe(true);
    expect(at(r).agents).toEqual([12, 0, 12, 24]);
    expect(at(dropEdge(DEFAULT_BOARD, 'tasks', 'top')).tasks).toEqual([0, 0, 24, 8]);
  });

  it('adds a panel once, in half of the biggest; removing gives its place to its neighbours', () => {
    let b = removePanel(DEFAULT_BOARD, 'tasks');
    expect(at(b).agents).toEqual([0, 0, 14, 24]);
    b = addPanel(b, 'tasks');
    expect(tiles(b)).toBe(true);
    expect(at(b).agents).toEqual([0, 0, 14, 12]);
    expect(b.find((i) => i.k === 'tasks')).toMatchObject({ x: 0, y: 12, w: 14, h: 12 });
    expect(addPanel(b, 'tasks')).toBe(b);
    expect(removePanel([it_('a', 0, 0, 24, 24)], 'a')).toEqual([]);
    expect(normalize([])).toBe(DEFAULT_BOARD);
  });

  it('stays tiled whatever you do to it (a thousand random moves)', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 16807) % 2147483647), seed % n);
    const kinds: PanelKind[] = ['agents', 'touching', 'explains', 'tasks', 'goal', 'context', 'changes', 'git', 'tests', 'notes'];
    let b: BoardItem[] = DEFAULT_BOARD;
    for (let i = 0; i < 1000; i++) {
      const op = rnd(5);
      const pick = () => b[rnd(b.length)];
      if (op === 4 && rnd(3) === 0) b = dropEdge(b, pick().id, (['left', 'right', 'top', 'bottom'] as const)[rnd(4)]);
      else if (op === 0 && b.length < 8) b = addPanel(b, kinds[rnd(kinds.length)] as Exclude<PanelKind, 'explain'>);
      else if (op === 1 && b.length > 2) b = removePanel(b, pick().id);
      else if (op === 2 && b.length > 1) {
        const [a, t] = [pick(), pick()];
        b = dropOn(b, a.id, t.id, (['swap', 'left', 'right', 'top', 'bottom'] as const)[rnd(5)]);
      } else {
        const ls = lines(b);
        if (ls.length) b = moveLine(b, ls[rnd(ls.length)], rnd(25));
      }
      expect(tiles(b), `after step ${i}`).toBe(true);
    }
  });

  it("a popped-out explain shows in its session only; the others' boards close the gap", () => {
    const b = popExplain(DEFAULT_BOARD, 's1', 'Release 2.4');
    expect(popExplain(b, 's1', 'Release 2.4')).toBe(b);
    expect(tiles(b)).toBe(true);
    expect(visible(b, 's1').map((i) => i.k)).toContain('explain');
    expect(visible(b, 's2')).toEqual(DEFAULT_BOARD);
    // a change in s2 keeps s1's explain
    const s2 = dropOn(visible(b, 's2'), 'tasks', 'agents', 'swap');
    expect(merge(b, 's2', s2).filter((i) => i.k === 'explain')).toHaveLength(1);
  });

  it('from the preferences: odd entries dropped, laid out over the area; earlier layouts carried over', () => {
    expect(normalize(undefined)).toBe(DEFAULT_BOARD);
    expect(normalize([{ id: 'a', k: 'nope', x: 0, y: 0, w: 2, h: 2 }])).toBe(DEFAULT_BOARD);
    expect(at(normalize([{ id: 'a', k: 'agents', x: 30, y: -2, w: 99, h: 1 }]))).toEqual({ a: [0, 0, COLS, ROWS] });
    // the columns layout from before the grid
    const cols = normalize([
      { w: 2, panels: [{ id: 'agents', k: 'agents', h: 3 }, { id: 'tasks', k: 'tasks', h: 1 }] },
      { w: 1, panels: [{ id: 'touching', k: 'touching', h: 1 }] },
    ]);
    expect(at(cols)).toEqual({ agents: [0, 0, 16, 18], tasks: [0, 18, 16, 6], touching: [16, 0, 8, 24] });
    // a layout from before the finer grid (12 by 12): read at twice the size
    const old = [it_('agents', 0, 0, 7, 8), it_('touching', 7, 0, 5, 6), it_('explains', 7, 6, 5, 6), it_('tasks', 0, 8, 7, 4)];
    expect(at(normalize(old))).toEqual(at(DEFAULT_BOARD));
  });

  it('pages: each laid out on its own; a panel sent to another lands there, its place here filled', () => {
    expect(pageCount(DEFAULT_BOARD)).toBe(1);
    expect(pageCount(DEFAULT_BOARD, 3)).toBe(3);
    const b = sendToPage(DEFAULT_BOARD, 's1', 'tasks', 0, 1);
    expect(pageCount(b)).toBe(2);
    expect(at(visible(b, 's1', 0)).agents).toEqual([0, 0, 14, 24]);
    expect(visible(b, 's1', 1)).toEqual([expect.objectContaining({ id: 'tasks', x: 0, y: 0, w: COLS, h: ROWS, pg: 1 })]);
    // a change on page 1 keeps page 0
    const b2 = merge(b, 's1', addPanel(visible(b, 's1', 1), 'goal'), 1);
    expect(visible(b2, 's1', 0)).toEqual(visible(b, 's1', 0));
    expect(b2.find((p) => p.id === 'tasks')).toMatchObject({ w: 12, h: 24, pg: 1 });
    expect(at(normalize([{ ...it_('a', 0, 0, 24, 24) }, { ...it_('b', 0, 0, 24, 24), pg: 1 }]))).toEqual({ a: [0, 0, 24, 24], b: [0, 0, 24, 24] });
    const three = [it_('a', 0, 0, 24, 24), { ...it_('b', 0, 0, 24, 24), pg: 1 }, { ...it_('c', 0, 0, 24, 24), pg: 2 }];
    expect(removePage(three, 1)).toEqual([it_('a', 0, 0, 24, 24), { ...it_('c', 0, 0, 24, 24), pg: 1 }]);
  });

  it('layouts for kinds of work each tile a page; one is added as a new page after the last, with new panels', () => {
    for (const l of Object.values(LAYOUTS)) expect(tiles(fromLayout(l))).toBe(true);
    const r = addLayoutPage(DEFAULT_BOARD, 1, LAYOUTS.coding)!;
    expect(r.page).toBe(1);
    expect(visible(r.items, 's1', 0)).toEqual(DEFAULT_BOARD);
    const page = visible(r.items, 's1', 1);
    expect(page.map((p) => p.k)).toEqual(['changes', 'tests', 'agents', 'git', 'terminal']);
    expect(page.some((p) => DEFAULT_BOARD.some((d) => d.id === p.id))).toBe(false);
    // made pages count: after them
    expect(addLayoutPage(DEFAULT_BOARD, 3, LAYOUTS.shipping)!.page).toBe(3);
    // at the most pages: none
    expect(addLayoutPage(DEFAULT_BOARD, 9, LAYOUTS.shipping)).toBeNull();
  });

  it('pages move (the ones between shift over, names with them) and copy (new panels, a terminal without its shell)', () => {
    const three = [it_('a', 0, 0, 24, 24), { ...it_('b', 0, 0, 24, 24), pg: 1 }, { ...it_('c', 0, 0, 24, 24), pg: 2 }];
    expect(movePage(three, 0, 2).map((p) => [p.id, p.pg ?? 0])).toEqual([['a', 2], ['b', 0], ['c', 1]]);
    expect(movePage(three, 2, 0).map((p) => [p.id, p.pg ?? 0])).toEqual([['a', 1], ['b', 2], ['c', 0]]);
    expect([0, 1, 2].map((p) => movedTo(p, 0, 2))).toEqual([2, 0, 1]);
    expect(moveName(['One', null, 'Three'], 0, 2)).toEqual([null, 'Three', 'One']);
    expect(moveName(['One'], 0, 2)).toEqual([null, null, 'One']);
    const withShell = [{ ...it_('t', 0, 0, 24, 24), k: 'terminal' as const, term: 'x1' }];
    const d = duplicatePage(withShell, 's1', 0, 1)!;
    expect(d.page).toBe(1);
    expect(visible(d.items, 's1', 1)).toEqual([expect.objectContaining({ k: 'terminal', pg: 1 })]);
    expect(visible(d.items, 's1', 1)[0].term).toBeUndefined();
    expect(visible(d.items, 's1', 1)[0].id).not.toBe('t');
  });

  it('a page kept as a layout leaves its explains out; page names follow a removed page', () => {
    const b = popExplain(DEFAULT_BOARD, 's1', 'Release');
    const kept = asLayout(visible(b, 's1'));
    expect(kept.some((p) => p.k === 'explain')).toBe(false);
    expect(tiles(fromLayout(kept))).toBe(true);
    expect(namesWithout(['Coding', null, 'Shipping'], 1)).toEqual(['Coding', 'Shipping']);
    expect(namesWithout(undefined, 1)).toBeUndefined();
  });

  it("each session's own board; new ones start from the chosen layout, without another session's explains", () => {
    expect(template(undefined)).toBe(DEFAULT_BOARD);
    const chosen = popExplain(moveEdge(DEFAULT_BOARD, 'agents', 'x', 18), 's1', 'Release');
    const t = template(chosen);
    expect(t.some((p) => p.k === 'explain')).toBe(false);
    expect(tiles(t)).toBe(true);
    expect(at(t).agents).toEqual([0, 0, 18, 16]);
    // a Terminal panel's shell stays with its session: a new one starts its own
    const withShell = DEFAULT_BOARD.map((p) => (p.id === 'tasks' ? { ...p, k: 'terminal' as const, term: 'term-1' } : p));
    expect(normalize(withShell).find((p) => p.k === 'terminal')?.term).toBe('term-1');
    expect(template(withShell).find((p) => p.k === 'terminal')?.term).toBeUndefined();
    // tabs of shells: kept with the board, never carried to another session's
    const tabs = DEFAULT_BOARD.map((p) => (p.id === 'tasks' ? { ...p, k: 'terminal' as const, terms: ['a', 'b', 7], term: 'b' } : p));
    expect(shellsOf(normalize(tabs).find((p) => p.k === 'terminal')!)).toEqual(['a', 'b']);
    expect(shellsOf(template(tabs).find((p) => p.k === 'terminal')!)).toEqual([]);
    expect(shellsOf({ ...withShell[3] })).toEqual(['term-1']);
    const boards = keepBoards({ gone: { items: [] }, s1: { items: DEFAULT_BOARD } }, 's2', { items: t, page: 1 }, (id) => id !== 'gone');
    expect(Object.keys(boards)).toEqual(['s1', 's2']);
    expect(boards.s2.page).toBe(1);
  });
});

describe("the bar's strip of page tabs", () => {
  it('scrolls only as far as it takes to show a tab whole, clear of the fade', () => {
    // a 300-wide strip scrolled to 100: 100..400 shows
    expect(scrollToShow(100, 300, 150, 120, 18)).toBe(100);
    // cut on the right: brought in so its end clears the fade
    expect(scrollToShow(100, 300, 350, 120, 18)).toBe(188);
    // cut on the left: its start clears the fade, but never past the strip's start
    expect(scrollToShow(100, 300, 60, 120, 18)).toBe(42);
    expect(scrollToShow(100, 300, 0, 120, 18)).toBe(0);
  });

  it('a tab wider than the strip shows from its start', () => {
    expect(scrollToShow(0, 100, 200, 176, 18)).toBe(182);
  });
});

describe("Cora's board", () => {
  it('panels fit their board: session ones on sessions, Cora ones on Cora, some on both', () => {
    expect(fitsBoard('agents', 's1')).toBe(true);
    expect(fitsBoard('agents', CORA_BOARD)).toBe(false);
    expect(fitsBoard('worktrees', CORA_BOARD)).toBe(true);
    expect(fitsBoard('worktrees', 's1')).toBe(false);
    expect(fitsBoard('needs', CORA_BOARD) && fitsBoard('needs', 's1')).toBe(true);
    expect(fitsBoard('explain', CORA_BOARD)).toBe(false);
  });

  it('starts with Sessions, Worktrees and Needs you; a saved one keeps only what fits', () => {
    expect(boardFor(undefined, CORA_BOARD, null).map((p) => p.k)).toEqual(['wall', 'worktrees', 'needs']);
    const saved: BoardItem[] = [{ id: 'w', k: 'wall', x: 0, y: 0, w: 12, h: 12 }, { id: 'a', k: 'agents', x: 12, y: 0, w: 12, h: 12 }];
    expect(boardFor(saved, CORA_BOARD, null).map((p) => p.k)).toEqual(['wall']);
    expect(boardFor([{ id: 'a', k: 'agents', x: 0, y: 0, w: 12, h: 12 }], CORA_BOARD, null).map((p) => p.k)).toEqual(['wall', 'worktrees', 'needs']);
    expect(boardFor(undefined, 's1', null)).toEqual(template(null));
  });

  it("is kept when sessions' boards come and go", () => {
    const boards = keepBoards({ [CORA_BOARD]: { items: CORA_LAYOUT }, s1: { items: DEFAULT_BOARD } }, 's2', { items: DEFAULT_BOARD }, (id) => id === 's1');
    expect(Object.keys(boards)).toEqual([CORA_BOARD, 's1', 's2']);
    expect(Object.keys(keepBoards(boards, CORA_BOARD, { items: CORA_LAYOUT, page: 0 }, () => false))).toEqual([CORA_BOARD]);
  });
});
