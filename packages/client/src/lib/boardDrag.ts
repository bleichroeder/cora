import { canSplit, type BoardItem, type Drop } from './boardLayout';

/** A rectangle on screen (the board's own pixels). */
export type Px = { left: number; top: number; width: number; height: number };

/** Within this of the board's own edge (or past it), a drop runs the full width or height along that side. */
export const BOARD_EDGE = 26;

/** How far in from a panel's edge a drop takes that half: a share of it, at least this much and at most that. */
export const EDGE_SHARE = 0.28;
export const EDGE_MIN = 48;
export const EDGE_MAX = 180;

/**
 * Where a dragged panel would land, from the pointer: the panel under it (the gaps between panels count as the
 * nearest panel's, so crossing one never flickers to "nothing"), then near an edge (its outer share, within bounds) that
 * half of it, otherwise a swap. Too small to halve on that side: a swap, said so (`fallback`). At the board's own edges
 * (`board`: its size), the whole side (`edge`).
 */
export function dropTarget(items: BoardItem[], id: string, x: number, y: number, rectOf: (i: BoardItem) => Px, gap: number, board?: { width: number; height: number }): { id: string; how: Drop; fallback?: boolean; edge?: boolean } | null {
  // the board's own edges (the last few pixels, or past them): the full width or height along that side
  if (board) {
    const sides: Array<[number, Exclude<Drop, 'swap'>]> = [
      [x, 'left'],
      [board.width - x, 'right'],
      [y, 'top'],
      [board.height - y, 'bottom'],
    ];
    const [d, side] = sides.sort((a, b) => a[0] - b[0])[0];
    if (d < BOARD_EDGE && d > -80) return { id: '', how: side, edge: true };
  }
  let best: { o: BoardItem; r: Px } | null = null;
  for (const o of items) {
    if (o.id === id) continue;
    const r = rectOf(o);
    // the panel, with half the gap all round: the board has no dead space between panels
    const dx = Math.max(r.left - gap / 2 - x, 0, x - (r.left + r.width + gap / 2));
    const dy = Math.max(r.top - gap / 2 - y, 0, y - (r.top + r.height + gap / 2));
    if (dx === 0 && dy === 0) {
      best = { o, r };
      break;
    }
  }
  if (!best) return null;
  const { o, r } = best;
  // (a share of the panel, so a tall one's whole top part means its top half; never past a third of it)
  const band = (len: number) => Math.min(len / 3, Math.max(EDGE_MIN, Math.min(EDGE_MAX, len * EDGE_SHARE)));
  const near: Array<[number, Exclude<Drop, 'swap'>]> = (
    [
      [x - r.left, 'left'],
      [r.left + r.width - x, 'right'],
      [y - r.top, 'top'],
      [r.top + r.height - y, 'bottom'],
    ] as Array<[number, Exclude<Drop, 'swap'>]>
  ).filter(([d, side]) => d < band(side === 'left' || side === 'right' ? r.width : r.height));
  if (!near.length) return { id: o.id, how: 'swap' };
  const side = near.sort((a, b) => a[0] - b[0])[0][1];
  return canSplit(o, side) ? { id: o.id, how: side } : { id: o.id, how: 'swap', fallback: true };
}

/** What a drop does, in words (on the overlay that shows where it lands). */
export function dropLabel(how: Drop, target: string, fallback = false, edge = false): string {
  if (edge) return how === 'top' || how === 'bottom' ? `Full width, along the ${how}` : `Full height, on the ${how}`;
  if (how === 'swap') return fallback ? `Swap with ${target} (too small to split)` : `Swap with ${target}`;
  return `${how === 'left' ? 'Left' : how === 'right' ? 'Right' : how === 'top' ? 'Top' : 'Bottom'} half of ${target}`;
}
