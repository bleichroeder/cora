import type { BrainEvent } from '@cora/shared';

export const MAIN_POS = { x: -8.5, y: 0 };
export const SUB_X = 1.2;
export const RES_X = 11;
export const SLOT_Y = [3.4, -3.4, 0, 5.6, -5.6, 1.7];
export const OVERFLOW_POS = { x: SUB_X + 2.6, y: -6.4 };
const RES_SPACING = 1.6;

/** Stable slot assignment: agents keep their slot until they leave; new agents take the lowest free slot. */
export function assignSlots(prev: Map<string, number>, agentIds: string[]): Map<string, number> {
  const next = new Map<string, number>();
  for (const id of agentIds) if (prev.has(id) && prev.get(id)! >= 0) next.set(id, prev.get(id)!);
  const used = new Set(next.values());
  for (const id of agentIds) {
    if (next.has(id)) continue;
    const free = SLOT_Y.findIndex((_, i) => !used.has(i));
    next.set(id, free);
    if (free >= 0) used.add(free);
  }
  return next;
}

export function slotPos(slot: number): { x: number; y: number } {
  return slot < 0 ? OVERFLOW_POS : { x: SUB_X, y: SLOT_Y[slot] };
}

/** How far right of its parent a nested subagent sits. */
export const NEST_DX = 5.6;
/**
 * Two agents closer than LABEL_SPAN_X across and AGENT_SPAN_Y up and down would collide: a name is about that wide,
 * and an orb with the two lines under it about that tall.
 */
export const LABEL_SPAN_X = 4.4;
export const AGENT_SPAN_Y = 2.8;
/**
 * Nested subagents never get closer to the resource column than NEST_MAX_X, and stay between the lowest and highest
 * of main's slots (a name hangs below its orb, so the lowest keeps room for it on screen).
 */
const NEST_MAX_X = RES_X - 2.8;
const NEST_Y = { min: Math.min(...SLOT_Y), max: 6.2 };
const NEST_STEP = 0.7;

/**
 * A subagent started by another subagent sits to the right of its parent (between it and the resources), at the
 * height nearest its parent's (above first) that keeps clear of every agent already placed (`taken`, its parent
 * included). Siblings stack a label's height apart; a deeper level stops short of the resources, so it shares its
 * parent's column and sits above or below it rather than on it. In a crowd with no clear spot, it takes the one that
 * overlaps least (the labels' own declutter then keeps the names apart).
 */
export function nestedPos(parent: { x: number; y: number }, taken: Array<{ x: number; y: number }>): { x: number; y: number } {
  const x = Math.min(parent.x + NEST_DX, NEST_MAX_X);
  const overlap = (y: number) => taken.reduce((sum, t) => sum + (Math.abs(t.x - x) < LABEL_SPAN_X ? Math.max(0, AGENT_SPAN_Y - Math.abs(t.y - y)) : 0), 0);
  let best = { y: Math.min(NEST_Y.max, Math.max(NEST_Y.min, parent.y)), cost: Infinity };
  for (let k = 1; k <= (NEST_Y.max - NEST_Y.min) / NEST_STEP; k++) {
    for (const y of [parent.y + k * NEST_STEP, parent.y - k * NEST_STEP]) {
      if (y > NEST_Y.max + 1e-6 || y < NEST_Y.min - 1e-6) continue;
      const cost = overlap(y);
      if (cost < 1e-6) return { x, y: +y.toFixed(4) };
      if (cost < best.cost - 1e-6) best = { y: +y.toFixed(4), cost };
    }
  }
  return { x, y: best.y };
}

/** An agent orb's radius: main's and a subagent's. */
export const ORB_R = { main: 0.85, sub: 0.52 };
/** How far below its orb's centre an agent's name hangs (the label's top edge): main's clears its context gauge (r × 2.06). */
export const tagDrop = (r: number, isMain: boolean) => (isMain ? r * 2.06 + 0.12 : r + 0.55);

/** The red rings that pulse out of an agent waiting on you: from r0 to r1 (world units), main's and a subagent's. */
export const BEACON = { main: { r0: 1, r1: 3.1 }, sub: { r0: 0.6, r1: 1.9 } };

/**
 * A beacon's ring is open at the bottom, where its agent's name hangs (`top` below the centre): the arc (start and
 * length, in radians counter-clockwise from +x) that keeps even its widest ring above the name, so the pulses never
 * run through the name, "Waiting for you" or main's context line.
 */
export function beaconArc(r1: number, top: number): { start: number; length: number } {
  const half = Math.acos(Math.min(1, (top - 0.1) / r1));
  return { start: -Math.PI / 2 + half, length: Math.PI * 2 - 2 * half };
}

// shell last: its recent-command log hangs below it, with nothing underneath to collide with
const KIND_ORDER = ['web', 'browser', 'mcp', 'files', 'shell'];
const kindOf = (r: string) => r.split(':')[0];

/** Most-touched resources, then ordered by kind so the column doesn't shuffle as counts change. */
export function topResources(events: BrainEvent[], max = 7): string[] {
  const count = new Map<string, number>();
  const last = new Map<string, number>();
  for (const e of events) {
    const r = e.kind === 'tool' && e.phase === 'start' ? e.tool?.resource : undefined;
    if (!r) continue;
    count.set(r, (count.get(r) ?? 0) + 1);
    last.set(r, Math.max(last.get(r) ?? 0, e.ts));
  }
  return [...count]
    .sort((a, b) => b[1] - a[1] || last.get(b[0])! - last.get(a[0])! || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([r]) => r)
    .sort((a, b) => KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) || a.localeCompare(b));
}

export function resourceColumn(ids: string[]): Map<string, { x: number; y: number }> {
  const top = ((ids.length - 1) / 2) * RES_SPACING;
  return new Map(ids.map((id, i) => [id, { x: RES_X, y: +(top - i * RES_SPACING).toFixed(4) || 0 }]));
}

export function resourceLabel(id: string): string {
  const [kind, rest] = [kindOf(id), id.slice(id.indexOf(':') + 1)];
  if (!id.includes(':')) return id;
  if (kind === 'files') return `${rest}/`;
  if (kind === 'web') return rest === 'search' ? 'web search' : rest;
  if (kind === 'mcp') return `${rest} · mcp`;
  return id;
}

export const RESOURCE_ICON: Record<string, string> = { files: 'Folder', shell: 'SquareTerminal', web: 'Globe', browser: 'AppWindow', mcp: 'Plug' };
export const resourceIcon = (id: string) => RESOURCE_ICON[kindOf(id)] ?? 'Box';
