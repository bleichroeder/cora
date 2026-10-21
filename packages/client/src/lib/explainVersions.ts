/**
 * An explain written again under the same title (in the same session) is a new version of it, not another explain:
 * lists show its newest, the viewer steps through the rest.
 */

export const VERSIONS_KEPT = 20;

type Titled = { sessionId: string; title: string; ts: number };

const keyOf = (x: Titled) => `${x.sessionId}\u0000${x.title.trim().toLowerCase()}`;

/** The newest of each title, in the order they last changed (oldest first). */
export function latestByTitle<T extends Titled>(items: T[]): T[] {
  const latest = new Map<string, T>();
  for (const x of items) {
    const k = keyOf(x);
    const had = latest.get(k);
    if (!had || x.ts >= had.ts) latest.set(k, x);
  }
  return [...latest.values()].sort((a, b) => a.ts - b.ts);
}

/** Every version of one explain (that session, that title), oldest first, at most the last 20. */
export function versionsOf<T extends Titled>(items: T[], of: Titled): T[] {
  const k = keyOf(of);
  return items
    .filter((x) => keyOf(x) === k)
    .sort((a, b) => a.ts - b.ts)
    .slice(-VERSIONS_KEPT);
}
