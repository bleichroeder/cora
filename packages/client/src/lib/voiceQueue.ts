/**
 * What's waiting to be said aloud. Nothing talks over anything else: lines wait their turn (a "read aloud" you click
 * cuts in; Esc and mute clear it all). Short announcements waiting together are said as one (in the same voice, up to a
 * sentence or three); a line already waiting or playing isn't added twice, a newer one of the same group replaces the
 * older, and anything left unsaid too long is dropped rather than said late. Pure: lib/voice.ts plays it.
 */

export type Line = {
  id: string;
  /** speakable text */
  text: string;
  sessionId?: string;
  at: number;
  /** the voice it's said in ('' for the sessions' default): only lines in the same voice are said together */
  voice: string;
  /** a short announcement (said together with others like it) */
  short: boolean;
  /** a newer line of the same group replaces a waiting one (e.g. one session's latest summary) */
  group?: string;
  /** dropped when it has waited this long */
  keepMs: number;
};

/** Short lines said together stay under this many characters. */
export const MERGE_CAP = 420;
/** At most this many lines wait (the oldest go first). */
export const QUEUE_MAX = 8;

/** A line joins the queue: not twice (same id), replacing a waiting one of its group, the oldest dropped past the cap. */
export function enqueueLine(queue: Line[], line: Line, playingId?: string | null): Line[] {
  if (line.id === playingId || queue.some((q) => q.id === line.id)) return queue;
  const kept = line.group ? queue.filter((q) => q.group !== line.group) : queue;
  return [...kept, line].slice(-QUEUE_MAX);
}

/** What to say next (stale lines dropped; short ones waiting in a row in the same voice joined into one), and what's left. */
export function nextUp(queue: Line[], now: number): { line: Line | null; rest: Line[] } {
  const fresh = queue.filter((q) => now - q.at < q.keepMs);
  const first = fresh[0];
  if (!first) return { line: null, rest: [] };
  if (!first.short) return { line: first, rest: fresh.slice(1) };
  let text = first.text;
  let n = 1;
  while (n < fresh.length) {
    const q = fresh[n];
    if (!q.short || q.voice !== first.voice || text.length + q.text.length + 1 > MERGE_CAP) break;
    text = `${text.replace(/\s*$/, '')}${/[.!?]$/.test(text.trim()) ? '' : '.'} ${q.text}`;
    n++;
  }
  const merged = n > 1 ? { ...first, text, ...(fresh.slice(0, n).every((q) => q.sessionId === first.sessionId) ? {} : { sessionId: undefined }) } : first;
  return { line: merged, rest: fresh.slice(n) };
}
