/** The session card's state: one word, its colour class, and one clock (or time) beside it. */
export type CardState = {
  word: string;
  /** s: speaking or listening, n: needs you, p: paused on a limit, w: working, t: thinking or compacting, i: idle or ended */
  cls: 's' | 'n' | 'p' | 'w' | 't' | 'i';
  /** since when the clock beside the word counts (it ticks), if it has one */
  since: number | null;
  /** or words beside it that don't tick ("resets 4pm") */
  note: string;
};

/**
 * When a limit's message says it resets ("… resets 4pm (America/New_York)", "resets at 3:00 PM"), that, short;
 * else ''.
 */
export function limitReset(text: string): string {
  const m = /\bresets?\s+(?:at\s+|in\s+|on\s+)?([^.·|()\n]+)/i.exec(text);
  const when = m?.[1].trim().replace(/\s+/g, ' ') ?? '';
  return when && when.length <= 24 ? `resets ${when}` : '';
}

/**
 * What the card says the session is: the first of these that holds. You (talking to it, it waiting on you) come before
 * what it's doing by itself; a limit that stopped it and a compaction are said as themselves, not as idle or working.
 * One clock: how long it has waited on you, how long it has been compacting, or how long this turn has run (the tool
 * running now restarts every few seconds: the turn is the time that means something).
 */
export function cardState(o: {
  listening?: boolean;
  speaking?: boolean;
  /** it's waiting on your answer: since when (null: its state says so, but no question is listed) */
  askedAt?: number | null;
  state: string;
  limit?: { text: string; at: number } | null;
  compacting?: { since: number } | null;
  doing?: boolean;
  turn?: { since: number; until: number | null } | null;
}): CardState {
  const turnSince = o.turn && o.turn.until == null ? o.turn.since : null;
  if (o.listening) return { word: 'listening', cls: 's', since: null, note: '' };
  if (o.speaking) return { word: 'speaking', cls: 's', since: null, note: '' };
  if (o.askedAt !== undefined || o.state === 'needs-you') return { word: 'needs you', cls: 'n', since: o.askedAt ?? null, note: '' };
  if (o.state === 'ended') return { word: 'ended', cls: 'i', since: null, note: '' };
  if (o.limit) return { word: 'paused', cls: 'p', since: null, note: limitReset(o.limit.text) || 'on a limit' };
  if (o.compacting) return { word: 'compacting', cls: 't', since: o.compacting.since, note: '' };
  if (o.doing) return { word: 'working', cls: 'w', since: turnSince, note: '' };
  if (o.state === 'thinking') return { word: 'thinking', cls: 't', since: turnSince, note: '' };
  return { word: 'idle', cls: 'i', since: null, note: '' };
}
