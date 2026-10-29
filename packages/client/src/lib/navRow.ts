import type { SessionInfo } from '@cora/shared';

/**
 * What a session's row in the nav says: its folder as you'd
 * name it, and a word for its state only when something is happening.
 */

/** The repo's folder name, with the worktree it works in: "orion-api" or "orion-api › fix-login"; the full path as the title. */
export function folderLabel(cwd: string, wd?: string | null): { text: string; title: string } {
  const path = wd || cwd;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const at = parts.lastIndexOf('worktrees');
  if (at >= 2 && parts[at - 1] === '.claude' && parts[at + 1]) return { text: `${parts[at - 2]} › ${parts[at + 1]}`, title: path };
  return { text: parts.at(-1) ?? path, title: path };
}

/** "45s", "9m", "2h", "3d": the time beside a state word. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

export type RowState = { word: 'working' | 'needs you' | 'done' | 'speaking'; cls: 'w' | 'n' | 'd' | 's'; time?: string } | null;

/**
 * Its state as a word, or nothing when it's idle or ended (the group heading says that): needs you (with how long it
 * has waited), working (with how long this turn has run), done (finished while you were elsewhere), speaking.
 */
export function rowState(s: Pick<SessionInfo, 'state' | 'turnAt' | 'lastTs'>, o: { now: number; fresh: boolean; speaking: boolean; waitingSince?: number }): RowState {
  if (o.speaking) return { word: 'speaking', cls: 's' };
  if (s.state === 'needs-you') return { word: 'needs you', cls: 'n', ...(o.waitingSince ? { time: shortAge(o.now - o.waitingSince) } : {}) };
  if (s.state === 'working' || s.state === 'thinking') return { word: 'working', cls: 'w', ...(s.turnAt ? { time: shortAge(o.now - s.turnAt) } : {}) };
  if (o.fresh && s.state === 'idle') return { word: 'done', cls: 'd' };
  return null;
}
