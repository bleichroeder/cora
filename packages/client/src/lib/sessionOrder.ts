import type { SessionInfo, SessionState } from '@cora/shared';
import { isDismissed } from './format';
import { useBrain } from '../state/store';

/**
 * The session list's groups. A session that needs you stays where it is among the working ones (it lights up red
 * instead of jumping to the top), so the list doesn't reshuffle while several sessions run at once.
 */
export const GROUPS: Array<{ title: string; states: SessionState[] }> = [
  { title: 'working', states: ['needs-you', 'working', 'thinking'] },
  { title: 'idle', states: ['idle'] },
  { title: 'ended', states: ['ended'] },
];
/** How long an ended session stays in the list (then it's in Resume, with everything else from before). */
export const ENDED_KEEP_MS = 4 * 3600_000;
/**
 * In the session list: not removed, and live or ended within the last few hours. The session you're looking at stays
 * listed whatever its age (you went to it, from Resume or the palette).
 */
export const inList = (s: SessionInfo, now: number, focus: string | null): boolean =>
  !isDismissed(s) && (s.state !== 'ended' || now - s.lastTs < ENDED_KEEP_MS || s.id === focus);
const RANK: Record<SessionState, number> = { 'needs-you': 0, working: 0, thinking: 0, idle: 1, ended: 2 };
export const sameGroup = (a: SessionInfo, b: SessionInfo) => RANK[a.state] === RANK[b.state];

/**
 * Working and idle sessions keep the order you gave them (then oldest first for ones you haven't placed), never
 * reshuffled by activity; ended ones are history, most recent first.
 */
export function sortedSessions(sessions: Record<string, SessionInfo>): SessionInfo[] {
  const placed = (s: SessionInfo) => s.order ?? Infinity;
  return Object.values(sessions).sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (a.state === 'ended' ? b.lastTs - a.lastTs : placed(a) - placed(b) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)),
  );
}

/** `ids` with `id` moved to just before `before` (or to the end). */
export function moved(ids: string[], id: string, before: string | null): string[] {
  const rest = ids.filter((x) => x !== id);
  const i = before == null ? -1 : rest.indexOf(before);
  rest.splice(i < 0 ? rest.length : i, 0, id);
  return rest;
}

/** The arranged (not ended) sessions, top to bottom. */
const arranged = (sessions: Record<string, SessionInfo>) => sortedSessions(sessions).filter((s) => s.state !== 'ended');

/** The new order after dropping `id` above or below `target`. */
export function dropOrder(sessions: Record<string, SessionInfo>, id: string, target: string, below: boolean): string[] {
  const ids = arranged(sessions).map((s) => s.id);
  const before = below ? (ids[ids.indexOf(target) + 1] ?? null) : target;
  return moved(ids, id, before === id ? (ids[ids.indexOf(id) + 1] ?? null) : before);
}

/** The new order after moving `id` one place up or down among the visible sessions of its group, or null at an end. */
export function nudgeOrder(sessions: Record<string, SessionInfo>, id: string, dir: -1 | 1, visible: (s: SessionInfo) => boolean): string[] | null {
  const s = sessions[id];
  if (!s || s.state === 'ended') return null;
  const group = arranged(sessions).filter((x) => sameGroup(x, s) && (x.id === id || visible(x)));
  const j = group.findIndex((x) => x.id === id) + dir;
  if (j < 0 || j >= group.length) return null;
  return dropOrder(sessions, id, group[j].id, dir > 0);
}

/** Save the order (shown at once; the server confirms each session over the socket). */
export async function saveOrder(ids: string[]) {
  const st = useBrain.getState();
  const next = { ...st.sessions };
  ids.forEach((id, i) => next[id] && (next[id] = { ...next[id], order: i }));
  useBrain.setState({ sessions: next });
  await fetch('/api/sessions/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
}
