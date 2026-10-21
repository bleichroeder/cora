import { KEY_IN_TEXT, type JiraIssue, type JiraRef, type JiraResult } from '@cora/shared';

// the matchers live in shared (the server finds a session's ticket with them too)
export { KEY_IN_TEXT, jiraLink, projectOf, type JiraRef } from '@cora/shared';

/** Text split into plain runs and the issue keys in it that `known` accepts. */
export function splitKeys(text: string, known: (key: string) => boolean): Array<string | JiraRef> {
  const out: Array<string | JiraRef> = [];
  let last = 0;
  for (const m of text.matchAll(KEY_IN_TEXT)) {
    const key = m[0];
    if (!known(key)) continue;
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push({ key });
    last = i + key.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** How long a lookup's answer is good for. Not-found is near-permanent; a missing login is checked again soon. */
export const TTL: Record<'ok' | NonNullable<Extract<JiraResult<unknown>, { ok: false }>['error']>, number> = {
  ok: 90_000,
  'not-found': 10 * 60_000,
  'signed-out': 30_000,
  offline: 15_000,
  error: 60_000,
  'no-site': 30_000,
  unavailable: Infinity,
};
export type Entry = { r: JiraResult<JiraIssue>; at: number };
const ttl = (r: JiraResult<unknown>) => TTL[r.ok ? 'ok' : r.error];

/** fresh: show it; stale: show it and look again (stale-while-revalidate); missing: nothing to show yet. */
export const freshness = (e: Entry | undefined, now: number): 'fresh' | 'stale' | 'missing' => (!e ? 'missing' : now - e.at < ttl(e.r) ? 'fresh' : 'stale');

/**
 * A new answer onto what's cached. A known issue survives a failed refresh when Jira couldn't be reached (offline,
 * a 5xx): it stays on screen and is tried again as soon as an offline answer would be.
 */
export function settle(prev: Entry | undefined, r: JiraResult<JiraIssue>, now: number): Entry {
  if (!r.ok && (r.error === 'offline' || r.error === 'error') && prev?.r.ok) return { r: prev.r, at: now - TTL.ok + TTL.offline };
  return { r, at: now };
}

/** Collects keys asked for within `wait` ms into one call (one round trip to the desktop app for a page of chips). */
export function batcher<K>(flush: (keys: K[]) => void, wait = 25) {
  const q = new Set<K>();
  let t: ReturnType<typeof setTimeout> | undefined;
  return (k: K) => {
    q.add(k);
    t ??= setTimeout(() => {
      t = undefined;
      const ks = [...q];
      q.clear();
      flush(ks);
    }, wait);
  };
}

