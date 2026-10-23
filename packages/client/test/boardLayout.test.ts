import { describe, expect, it } from 'vitest';
import { COLS, DEFAULT_BOARD, keepBoards, template, pageCount, removePage, sendToPage, addPanel, collides, compact, dropOn, merge, moveEdge, moveTo, normalize, popExplain, removePanel, resizeTo, visible, type BoardItem } from '../src/lib/boardLayout';

const at = (items: BoardItem[]) => Object.fromEntries(items.map((i) => [i.id, [i.x, i.y, i.w, i.h]]));
const overlapFree = (items: BoardItem[]) => items.every((a) => items.every((b) => !collides(a, b)));
const it_ = (id: string, x: number, y: number, w: number, h: number): BoardItem => ({ id, k: 'agents', x, y, w, h });

describe("the live board's grid", () => {
  it('the default fills the 12 by 12 area exactly', () => {
    expect(overlapFree(DEFAULT_BOARD)).toBe(true);
    expect(DEFAULT_BOARD.reduce((s, i) => s + i.w * i.h, 0)).toBe(144);
  });

  it('panels float up to close gaps, never passing one another', () => {
    expect(at(compact([it_('a', 0, 4, 6, 2), it_('b', 0, 9, 6, 2), it_('c', 6, 3, 6, 2)]))).toEqual({ a: [0, 0, 6, 2], b: [0, 2, 6, 2], c: [6, 0, 6, 2] });
    // overlaps go below
    expect(at(compact([it_('a', 0, 0, 6, 4), it_('b', 3, 2, 6, 2)]))).toEqual({
      a: [0, 0, 6, 4],
      b: [3, 4, 6, 2],
    });
  });

  it('dropping a panel on another: that one goes below it (a swap); kept on the grid', () => {
    const two = [it_('a', 0, 0, 12, 3), it_('b', 0, 3, 12, 3)];
    expect(at(moveTo(two, 'b', 0, 0))).toEqual({
      a: [0, 3, 12, 3],
      b: [0, 0, 12, 3],
    });
    expect(at(moveTo(two, 'a', 0, 4))).toEqual({
      a: [0, 3, 12, 3],
      b: [0, 0, 12, 3],
    });
    // beside: both stay on top
    const half = [it_('a', 0, 0, 6, 3), it_('b', 0, 3, 6, 3)];
    expect(at(moveTo(half, 'b', 9, 0))).toEqual({
      a: [0, 0, 6, 3],
      b: [6, 0, 6, 3],
    });
    for (let x = -3; x < 15; x++) for (let y = 0; y < 14; y++) expect(overlapFree(moveTo(DEFAULT_BOARD, 'tasks', x, y))).toBe(true);
    expect(moveTo(DEFAULT_BOARD, 'nope', 1, 1)).toBe(DEFAULT_BOARD);
  });

  it('resizing pushes what it now covers down, within the width and at least 2 by 2', () => {
    const r = resizeTo(DEFAULT_BOARD, 'agents', 12, 8);
    expect(overlapFree(r)).toBe(true);
    expect(at(r).agents).toEqual([0, 0, 12, 8]);
    expect(r.filter((i) => i.id !== 'agents').every((i) => i.y >= 8)).toBe(true);
    expect(at(resizeTo(DEFAULT_BOARD, 'touching', 40, 0)).touching).toEqual([7, 0, COLS - 7, 2]);
  });

  it('resizing moves the shared edge: the neighbour gives way, or takes up the room', () => {
    expect(at(resizeTo(DEFAULT_BOARD, 'agents', 9, 8))).toMatchObject({
      agents: [0, 0, 9, 8],
      touching: [9, 0, 3, 6],
      explains: [9, 6, 3, 6],
    });
    // narrower: Touching widens; Explains would run into Tasks, so it stays
    expect(at(resizeTo(DEFAULT_BOARD, 'agents', 5, 8))).toMatchObject({
      agents: [0, 0, 5, 8],
      touching: [5, 0, 7, 6],
      explains: [7, 6, 5, 6],
    });
    expect(at(resizeTo(DEFAULT_BOARD, 'touching', 5, 4))).toMatchObject({
      touching: [7, 0, 5, 4],
      explains: [7, 4, 5, 8],
    });
  });

  it('an edge moves like a split bar: every panel along the line, both sides, as far as each stays 2 wide', () => {
    expect(at(moveEdge(DEFAULT_BOARD, 'agents', 'x', 9))).toEqual({
      agents: [0, 0, 9, 8],
      touching: [9, 0, 3, 6],
      explains: [9, 6, 3, 6],
      tasks: [0, 8, 9, 4],
    });
    expect(at(moveEdge(DEFAULT_BOARD, 'tasks', 'x', 12)).agents).toEqual([0, 0, 10, 8]);
    // the line between Agents and Tasks runs only under Agents
    expect(at(moveEdge(DEFAULT_BOARD, 'agents', 'y', 6))).toMatchObject({
      agents: [0, 0, 7, 6],
      tasks: [0, 6, 7, 6],
      touching: [7, 0, 5, 6],
    });
    expect(moveEdge(DEFAULT_BOARD, 'agents', 'x', 7)).toBe(DEFAULT_BOARD);
  });

  it('dropped on another panel: its middle swaps them, an edge takes that half (its own place taken up)', () => {
    expect(at(dropOn(DEFAULT_BOARD, 'tasks', 'touching', 'swap'))).toMatchObject({ tasks: [7, 0, 5, 6], touching: [0, 8, 7, 4] });
    const split = dropOn(DEFAULT_BOARD, 'tasks', 'touching', 'bottom');
    expect(overlapFree(split)).toBe(true);
    expect(at(split)).toMatchObject({
      agents: [0, 0, 7, 12],
      touching: [7, 0, 5, 3],
      tasks: [7, 3, 5, 3],
      explains: [7, 6, 5, 6],
    });
    expect(at(dropOn(DEFAULT_BOARD, 'explains', 'agents', 'left'))).toMatchObject({
      explains: [0, 0, 3, 8],
      agents: [3, 0, 4, 8],
      touching: [7, 0, 5, 12],
    });
    expect(dropOn(DEFAULT_BOARD, 'tasks', 'tasks', 'swap')).toBe(DEFAULT_BOARD);
  });

  it('adds a panel once, where it fits (or beside the biggest); removing gives its place to its neighbours', () => {
    let b = removePanel(DEFAULT_BOARD, 'tasks');
    expect(at(b).agents).toEqual([0, 0, 7, 12]);
    b = addPanel(b, 'tasks');
    expect(overlapFree(b)).toBe(true);
    expect(at(b).agents).toEqual([0, 0, 7, 6]);
    expect(b.find((i) => i.k === 'tasks')).toMatchObject({
      x: 0,
      y: 6,
      w: 7,
      h: 6,
    });
    expect(addPanel(b, 'tasks')).toBe(b);
    expect(removePanel([it_('a', 0, 0, 2, 2)], 'a')).toEqual([]);
    expect(normalize([])).toBe(DEFAULT_BOARD);
  });

  it("a popped-out explain shows in its session only; the others' boards close the gap", () => {
    const b = popExplain(DEFAULT_BOARD, 's1', 'Release 2.4');
    expect(popExplain(b, 's1', 'Release 2.4')).toBe(b);
    expect(overlapFree(b)).toBe(true);
    expect(visible(b, 's1').map((i) => i.k)).toContain('explain');
    expect(visible(b, 's2')).toEqual(DEFAULT_BOARD);
    // a change in s2 keeps s1's explain
    const s2 = moveTo(visible(b, 's2'), 'tasks', 0, 0);
    expect(merge(b, 's2', s2).filter((i) => i.k === 'explain')).toHaveLength(1);
  });

  it('from the preferences: odd entries dropped; the earlier columns layout becomes the grid', () => {
    expect(normalize(undefined)).toBe(DEFAULT_BOARD);
    expect(normalize([{ id: 'a', k: 'nope', x: 0, y: 0, w: 2, h: 2 }])).toBe(DEFAULT_BOARD);
    expect(at(normalize([{ id: 'a', k: 'agents', x: 30, y: -2, w: 99, h: 1 }]))).toEqual({ a: [0, 0, 12, 2] });
    const cols = normalize([
      {
        w: 2,
        panels: [
          { id: 'agents', k: 'agents', h: 3 },
          { id: 'tasks', k: 'tasks', h: 1 },
        ],
      },
      { w: 1, panels: [{ id: 'touching', k: 'touching', h: 1 }] },
    ]);
    expect(at(cols)).toEqual({
      agents: [0, 0, 8, 9],
      tasks: [0, 9, 8, 3],
      touching: [8, 0, 4, 12],
    });
  });

  it('pages: each laid out on its own; a panel sent to another lands where there is room, its place here filled', () => {
    expect(pageCount(DEFAULT_BOARD)).toBe(1);
    expect(pageCount(DEFAULT_BOARD, 3)).toBe(3);
    const b = sendToPage(DEFAULT_BOARD, 's1', 'tasks', 0, 1);
    expect(pageCount(b)).toBe(2);
    expect(at(visible(b, 's1', 0)).agents).toEqual([0, 0, 7, 12]);
    expect(visible(b, 's1', 1)).toEqual([expect.objectContaining({ id: 'tasks', x: 0, y: 0, w: COLS, h: 12, pg: 1 })]);
    // a change on page 1 keeps page 0
    const b2 = merge(b, 's1', resizeTo(visible(b, 's1', 1), 'tasks', 6, 6), 1);
    expect(visible(b2, 's1', 0)).toEqual(visible(b, 's1', 0));
    expect(b2.find((p) => p.id === 'tasks')).toMatchObject({ w: 6, h: 6, pg: 1 });
    // two pages overlapping in place: each compacts on its own
    expect(at(normalize([{ ...it_('a', 0, 0, 12, 12) }, { ...it_('b', 0, 0, 12, 12), pg: 1 }]))).toEqual({ a: [0, 0, 12, 12], b: [0, 0, 12, 12] });
    // removing a page takes its panels; later pages move up
    const three = [it_('a', 0, 0, 12, 12), { ...it_('b', 0, 0, 12, 12), pg: 1 }, { ...it_('c', 0, 0, 12, 12), pg: 2 }];
    expect(removePage(three, 1)).toEqual([it_('a', 0, 0, 12, 12), { ...it_('c', 0, 0, 12, 12), pg: 1 }]);
  });

  it("each session's own board; new ones start from the chosen layout, without another session's explains", () => {
    expect(template(undefined)).toBe(DEFAULT_BOARD);
    const chosen = popExplain(resizeTo(DEFAULT_BOARD, 'agents', 9, 8), 's1', 'Release');
    const t = template(chosen);
    expect(t.some((p) => p.k === 'explain')).toBe(false);
    expect(overlapFree(t)).toBe(true);
    expect(at(t).agents).toEqual([0, 0, 9, 8]);
    // kept for sessions still around, the one changed last
    const boards = keepBoards({ gone: { items: [] }, s1: { items: DEFAULT_BOARD } }, 's2', { items: t, page: 1 }, (id) => id !== 'gone');
    expect(Object.keys(boards)).toEqual(['s1', 's2']);
    expect(boards.s2.page).toBe(1);
  });
});
