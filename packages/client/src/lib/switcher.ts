import type { SessionInfo } from '@cora/shared';
import { isDismissed } from './format';

/**
 * The session switcher's order (Ctrl+Tab): the live sessions (working, needing you, idle; never ended or removed), the
 * ones you were in most recently first, then the rest by their latest activity.
 */
export function switchOrder(sessions: SessionInfo[], mru: string[]): SessionInfo[] {
  const rank = new Map(mru.map((id, i) => [id, i]));
  return sessions
    .filter((s) => s.state !== 'ended' && !isDismissed(s))
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || b.lastTs - a.lastTs);
}

/** You were in this session now: it goes first (a short list, newest first). */
export const touch = (mru: string[], id: string, max = 30) => [id, ...mru.filter((x) => x !== id)].slice(0, max);
