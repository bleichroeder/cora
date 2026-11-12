/**
 * Cora's Whiteboard: boards drawn in Excalidraw, kept as
 * standard .excalidraw files in ~/.cora/boards. You draw anything; sessions read a board (a picture and an outline)
 * and draw on it in frames of their own (Mermaid, or simple shapes), and only ever remove their own frames.
 */

export const SCRATCH_BOARD = 'scratch';
/** The board tools every session gets (allowed without asking: drawing only adds, in a frame of its own). */
export const BOARDS_TOOLS = ['boards_list', 'board_read', 'board_draw', 'board_erase'] as const;

/** What a board is tied to (a session's, or a project's): it shows with it. */
export type BoardLink = { sessionId?: string; projectId?: string };

export type BoardSummary = {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** bumped on every change: an open board reloads when it's ahead of what it has */
  version: number;
  link?: BoardLink;
  /** a session drew on it since you last opened it (its name) */
  unseen?: string;
  /** how many things are on it */
  count: number;
};

/** An Excalidraw element, as far as Cora needs to know it (the rest passes through untouched). */
export type BoardElement = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  updated?: number;
  frameId?: string | null;
  containerId?: string | null;
  text?: string;
  name?: string | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  /** a session's: { by: its id, byName: its name } */
  customData?: Record<string, unknown>;
  [k: string]: unknown;
};

/** A board's scene: what an .excalidraw file holds. */
export type BoardScene = { elements: BoardElement[]; appState: Record<string, unknown>; files: Record<string, unknown> };
export type BoardDoc = BoardSummary & { scene: BoardScene };

export type BoardsMsg = { t: 'boards'; list: BoardSummary[] };

/**
 * A session's simple shape. Positions are optional (unplaced shapes are laid out in rows); arrows and lines join two
 * shapes by their id or label.
 */
export type BoardShape = {
  type: 'rect' | 'ellipse' | 'diamond' | 'note' | 'text' | 'arrow' | 'line';
  id?: string;
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  from?: string;
  to?: string;
  color?: string;
};

/** Cora's server to the app: draw this on that board (the app converts, places and frames it, and answers). */
export type BoardDrawMsg = { t: 'board-draw'; reqId: string; boardId: string; by: { sessionId: string; name: string }; title?: string; mermaid?: string; shapes?: BoardShape[] };

/**
 * A session's colours, as Excalidraw's own palette: kept in their light-theme form (Excalidraw's dark theme inverts the
 * whole canvas, so these show as their dark counterparts there).
 */
export const BOARD_COLORS: Record<string, { stroke: string; fill: string }> = {
  gray: { stroke: '#495057', fill: '#e9ecef' },
  red: { stroke: '#e03131', fill: '#ffc9c9' },
  orange: { stroke: '#e8590c', fill: '#ffd8a8' },
  yellow: { stroke: '#f08c00', fill: '#ffec99' },
  green: { stroke: '#2f9e44', fill: '#b2f2bb' },
  teal: { stroke: '#0c8599', fill: '#96f2d7' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  violet: { stroke: '#6741d9', fill: '#d0bfff' },
  pink: { stroke: '#c2255c', fill: '#fcc2d7' },
};

/**
 * Two copies of a board's elements, one: each element by its id, the higher version winning (Excalidraw bumps an
 * element's version on every change, deletion included); a tie goes to the lower versionNonce, as Excalidraw's own
 * reconciling does, so both sides settle on the same one. Order: the base's, then what's new from the other.
 */
export function mergeElements(base: BoardElement[], incoming: BoardElement[]): BoardElement[] {
  const theirs = new Map(incoming.map((e) => [e.id, e]));
  const out: BoardElement[] = [];
  const seen = new Set<string>();
  for (const e of base) {
    const t = theirs.get(e.id);
    out.push(!t ? e : wins(t, e) ? t : e);
    seen.add(e.id);
  }
  for (const e of incoming) if (!seen.has(e.id)) out.push(e);
  return out;
}
const wins = (a: BoardElement, b: BoardElement) => a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);

/** Whether two element lists say the same (each id at the same version). */
export function sameElements(a: BoardElement[], b: BoardElement[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((e) => [e.id, e.version]));
  return b.every((e) => m.get(e.id) === e.version);
}

const live = (els: BoardElement[]) => els.filter((e) => !e.isDeleted);

/** Where the next thing drawn goes: beside what's there (to its right, its top aligned), never on it. */
export function placeBeside(els: BoardElement[], gap = 120): { x: number; y: number } {
  const on = live(els);
  if (!on.length) return { x: 0, y: 0 };
  let maxX = -Infinity;
  let minY = Infinity;
  for (const e of on) {
    maxX = Math.max(maxX, e.x + Math.max(0, e.width));
    minY = Math.min(minY, e.y);
  }
  return { x: Math.round(maxX + gap), y: Math.round(minY) };
}

/**
 * A board in words, for a session: its frames (who drew them), its shapes with their labels, and what's joined to
 * what. With the picture, enough to talk about it and draw beside it.
 */
export function outlineBoard(title: string, els: BoardElement[]): string {
  const on = live(els);
  if (!on.length) return `# ${title}\n(empty)`;
  const byId = new Map(on.map((e) => [e.id, e]));
  // a shape's words: its bound text (a label), else its own
  const labelOf = (e: BoardElement): string => {
    const bound = e.boundElements?.find((b) => b.type === 'text');
    const t = bound ? byId.get(bound.id)?.text : e.type === 'text' ? e.text : undefined;
    return (t ?? '').replace(/\s+/g, ' ').trim();
  };
  const name = (id?: string | null) => {
    const e = id ? byId.get(id) : undefined;
    return e ? labelOf(e) || `${e.type} ${e.id.slice(0, 6)}` : '?';
  };
  const lines: string[] = [`# ${title}`];
  const frames = on.filter((e) => e.type === 'frame');
  for (const f of frames) {
    const who = typeof f.customData?.byName === 'string' ? ` (drawn by ${f.customData.byName})` : ' (yours)';
    lines.push(`- frame "${f.name ?? 'Frame'}"${who} at ${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}×${Math.round(f.height)}`);
  }
  const shapes = on.filter((e) => !['frame', 'arrow', 'line'].includes(e.type) && !(e.type === 'text' && e.containerId));
  const inFrame = (e: BoardElement) => (e.frameId ? ` in "${byId.get(e.frameId)?.name ?? 'a frame'}"` : '');
  for (const s of shapes.slice(0, 200)) {
    const l = labelOf(s);
    lines.push(`- ${s.type === 'freedraw' ? 'a drawn stroke' : s.type}${l ? ` "${l.slice(0, 120)}"` : ''} at ${Math.round(s.x)},${Math.round(s.y)}${inFrame(s)}`);
  }
  if (shapes.length > 200) lines.push(`- …and ${shapes.length - 200} more`);
  for (const a of on.filter((e) => e.type === 'arrow' || e.type === 'line')) {
    const from = a.startBinding?.elementId;
    const to = a.endBinding?.elementId;
    const l = labelOf(a);
    lines.push(from || to ? `- ${a.type} ${name(from)} → ${name(to)}${l ? ` ("${l}")` : ''}` : `- a loose ${a.type}${l ? ` "${l}"` : ''} at ${Math.round(a.x)},${Math.round(a.y)}`);
  }
  return lines.join('\n');
}
