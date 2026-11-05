import { spawnOf, type SessionInfo } from '@cora/shared';

/**
 * Where the nav puts the sessions another session started (spawned.ts): each under its creator, as a folded sub-row
 * (in the creator's project when it's in one), never loose at the bottom. Those whose creator isn't in the nav (or is
 * unknown: a test root's session with no marker) fold into one group of their own.
 * `listed`: the sessions the nav lists (live, or ended lately); `inProject`: those a project shows (its own, not ours).
 */
export function spawnTree(listed: SessionInfo[], inProject: Set<string>): { under: Map<string, SessionInfo[]>; loose: SessionInfo[]; ids: Set<string> } {
  const spawned = listed.filter((s) => !inProject.has(s.id) && spawnOf(s));
  const ids = new Set(spawned.map((s) => s.id));
  // a creator the nav shows as a row of its own (a spawned one isn't a creator's place: it nests where it's drawn)
  const rows = new Set(listed.filter((s) => !ids.has(s.id)).map((s) => s.id));
  const under = new Map<string, SessionInfo[]>();
  const loose: SessionInfo[] = [];
  for (const s of spawned) {
    const by = spawnOf(s)!.by;
    if (by && rows.has(by)) under.set(by, [...(under.get(by) ?? []), s]);
    else loose.push(s);
  }
  return { under, loose, ids };
}

/** A creator's sub-row, folded: how many it started, and why (the first one's words; "…" when they differ). */
export function spawnedLine(kids: SessionInfo[]): { count: string; why: string } {
  const whys = [...new Set(kids.map((s) => spawnOf(s)?.why).filter((w): w is string => !!w))];
  return { count: `${kids.length} spawned`, why: whys.length > 1 ? `${whys[0]} …` : (whys[0] ?? '') };
}
