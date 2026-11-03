import type { SessionInfo } from '@cora/shared';

/** Active in the last three minutes and not ended or idle: it's probably still open somewhere. */
export function recentlyActive(s: Pick<SessionInfo, 'state' | 'lastTs'>, now = Date.now()): boolean {
  return now - s.lastTs < 3 * 60_000 && s.state !== 'ended' && s.state !== 'idle';
}
/**
 * Resume here, for a session Cora doesn't host, once the check for it running elsewhere answered: blocked when it
 * runs in another terminal; on that one click only when it's known to have ended (its SessionEnd) and the check could
 * look; otherwise asked first (a plain `claude` left open elsewhere can't be seen by the check).
 */
export function resumeStep(s: Pick<SessionInfo, 'state'>, r: { checked: boolean; elsewhere: boolean }): 'blocked' | 'confirm' | 'go' {
  if (r.elsewhere) return 'blocked';
  return r.checked && s.state === 'ended' ? 'go' : 'confirm';
}
