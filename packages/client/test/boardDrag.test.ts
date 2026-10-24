import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../src/lib/boardLayout';
import { dropLabel, dropTarget } from '../src/lib/boardDrag';

// two panels side by side on a 12-wide board, each cell 100 px, 12 px gaps
const A: BoardItem = { id: 'a', k: 'agents', x: 0, y: 0, w: 6, h: 12 };
const B: BoardItem = { id: 'b', k: 'tasks', x: 6, y: 0, w: 6, h: 12 };
const C: BoardItem = { id: 'c', k: 'goal', x: 0, y: 0, w: 3, h: 12 };
const GAP = 12;
const rect = (i: BoardItem) => ({ left: i.x * 100, top: i.y * 100, width: i.w * 100 - GAP, height: i.h * 100 - GAP });

describe('dropping a panel on the board', () => {
  it('swaps in the middle of a panel and takes a half near its edge (a fixed band, not a share)', () => {
    expect(dropTarget([A, B], 'a', 900, 600, rect, GAP)).toEqual({ id: 'b', how: 'swap' });
    expect(dropTarget([A, B], 'a', 630, 600, rect, GAP)).toEqual({ id: 'b', how: 'left' });
    expect(dropTarget([A, B], 'a', 900, 20, rect, GAP)).toEqual({ id: 'b', how: 'top' });
    expect(dropTarget([A, B], 'a', 1170, 600, rect, GAP)).toEqual({ id: 'b', how: 'right' });
    // 80 px in is past the band (72 px) on a wide panel: the middle
    expect(dropTarget([A, B], 'a', 680, 600, rect, GAP)).toEqual({ id: 'b', how: 'swap' });
  });

  it('counts the gap between panels as the nearest one, so crossing it never loses the target', () => {
    // the gap between a (ends at 588) and b (starts at 600): its right half is b's
    expect(dropTarget([A, B], 'z', 596, 300, rect, GAP)?.id).toBe('b');
    expect(dropTarget([A, B], 'z', 591, 300, rect, GAP)?.id).toBe('a');
  });

  it("says it's a swap when a panel is too small to halve on that side", () => {
    expect(dropTarget([C, B], 'b', 10, 600, rect, GAP)).toEqual({ id: 'c', how: 'swap', fallback: true });
    expect(dropLabel('swap', 'Goal', true)).toBe('Swap with Goal (too small to split)');
    expect(dropLabel('left', 'Tasks')).toBe('Left half of Tasks');
  });

  it("at the board's own edge (or just past it), the whole side", () => {
    const board = { width: 1188, height: 1188 };
    expect(dropTarget([A, B], 'a', 600, 1180, rect, GAP, board)).toEqual({ id: '', how: 'bottom', edge: true });
    expect(dropTarget([A, B], 'a', -10, 600, rect, GAP, board)).toEqual({ id: '', how: 'left', edge: true });
    // further in: the panel there, as before
    expect(dropTarget([A, B], 'a', 900, 1140, rect, GAP, board)).toEqual({ id: 'b', how: 'bottom' });
    // far off the board: nothing
    expect(dropTarget([A, B], 'a', -300, 600, rect, GAP, board)).toBeNull();
    expect(dropLabel('bottom', '', false, true)).toBe('Full width, along the bottom');
  });

  it('is nothing outside every panel', () => {
    expect(dropTarget([A], 'z', 900, 300, rect, GAP)).toBeNull();
  });
});
