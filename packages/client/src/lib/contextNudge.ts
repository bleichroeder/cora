import { NUDGE_ADVICE, rereads, type SessionInfo } from '@cora/shared';
import { notice } from '../state/oops';
import { sessionName } from './format';

/**
 * The header's context chip for a session that was nudged (contextNudge.ts): amber, "each turn rereads ~Nk", while
 * its context is still past the threshold it passed (a /compact or a handover brings it back under). Null: as usual.
 */
export function heavyContext(s: Pick<SessionInfo, 'contextNudge'>, ctx: number, compacted: boolean): string | null {
  const n = s.contextNudge;
  return n && !compacted && ctx >= n.over ? rereads(ctx) : null;
}

const KEY = 'cora.contextNudged';
const FRESH_MS = 10 * 60_000;
/** The notice for a session's nudge: the first time it's seen (and it's recent), never again. `seen`: those told. */
export function nudgeNotice(s: SessionInfo, seen: Set<string>, now: number): { title: string; detail: string } | null {
  const n = s.contextNudge;
  if (!n || seen.has(s.id) || now - n.at > FRESH_MS) return null;
  return { title: `${sessionName(s)}: ${rereads(n.tokens)}`, detail: `Its context is past ${Math.round(n.over / 1000)}k. ${NUDGE_ADVICE}` };
}

function seenSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
/** A session as it arrives: its nudge's notice, once (remembered across reloads). */
export function noticeNudge(s: SessionInfo, now = Date.now()): void {
  if (!s.contextNudge) return;
  const seen = seenSet();
  const n = nudgeNotice(s, seen, now);
  if (!n) return;
  notice(n.title, n.detail);
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen, s.id].slice(-200)));
  } catch {
    /* private mode: told again after a reload at most */
  }
}
