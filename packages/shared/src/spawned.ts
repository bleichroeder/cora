import type { SessionInfo } from './types';

/**
 * A session another one started (a test harness's, a tool's): who started it and why. The spawner sets two variables
 * in its environment, CORA_SPAWNED_BY (the creator's session id) and CORA_SPAWN_WHY (a few words); Claude Code passes
 * them to Cora as its hooks' headers. A session with no marker whose folder is in a throwaway Cora's test root
 * (`cora-e2e-…`, scripts/e2e) counts as spawned too, its creator unknown.
 */
export const SPAWN_ENV = { by: 'CORA_SPAWNED_BY', why: 'CORA_SPAWN_WHY' } as const;
export const SPAWNED_BY_HEADER = 'x-cora-spawned-by';
export const SPAWN_WHY_HEADER = 'x-cora-spawn-why';

const TEST_ROOT = /(^|[\\/])cora-e2e-[^\\/]*([\\/]|$)/i;
/** A folder in a throwaway Cora's test root. */
export const inTestRoot = (dir: string | null | undefined): boolean => !!dir && TEST_ROOT.test(dir);

export type Spawn = { /** the creator's session id (null: unknown, a test root's session with no marker) */ by: string | null; why: string | null };

/** Who started it and why, when another session did (else null). */
export function spawnOf(s: Pick<SessionInfo, 'spawnedBy' | 'spawnWhy' | 'cwd' | 'wd'>): Spawn | null {
  if (s.spawnedBy) return { by: s.spawnedBy, why: s.spawnWhy ?? null };
  if (inTestRoot(s.cwd) || inTestRoot(s.wd)) return { by: null, why: "a throwaway Cora's test session" };
  return null;
}

/**
 * Spawned sessions to take off the list: ended, and their folder gone (cleaned up, as a throwaway Cora's root is when
 * its test is over). What they found stays in their creator's transcript.
 */
export function spawnedGone(list: SessionInfo[], exists: (dir: string) => boolean): SessionInfo[] {
  return list.filter((s) => s.state === 'ended' && (!s.dismissedAt || s.lastTs > s.dismissedAt) && !!spawnOf(s) && !exists(s.wd || s.cwd));
}

/**
 * The marker as its hooks sent it (`header`: a request header's value). Nothing when the variable wasn't set (Claude
 * Code sends it empty, or leaves "$CORA_SPAWNED_BY" as written) or isn't a session id.
 */
export function spawnMarker(header: (name: string) => string | undefined): { by: string; why: string | null } | null {
  const val = (name: string) => {
    const v = header(name)?.trim();
    return v && !v.startsWith('$') ? v : null;
  };
  const by = val(SPAWNED_BY_HEADER);
  if (!by || !/^[A-Za-z0-9_-]{1,80}$/.test(by)) return null;
  return { by, why: val(SPAWN_WHY_HEADER)?.slice(0, 200) ?? null };
}
