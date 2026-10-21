import type { BrainEvent } from '@cora/shared';

/** One OK lets Cora carry on a conversation with a session this long (each message it sends extends it). */
export const TALK_MS = 10 * 60_000;
/** A prompt the session is held on this long (not answered by the mandate) means it's waiting on the user. */
const BLOCKED_MS = 15_000;
const POLL_MS = 3_000;

export type TurnResult =
  | { state: 'replied'; text: string; tools: string[] }
  | { state: 'blocked'; what: string }
  | { state: 'ended' }
  | { state: 'timeout' }
  | { state: 'cancelled' };

export type TalkDeps = {
  /** a session's events since then (oldest first) */
  events(sessionId: string, since: number): BrainEvent[];
  /** the prompt a session is held on (and since when), if any */
  heldOn(sessionId: string): { what: string; since: number } | undefined;
  /** a reply Cora stopped waiting for has come */
  onLate(sessionId: string, r: Extract<TurnResult, { state: 'replied' }>): void;
  /** the talks changed (to show them) */
  onChange?(): void;
  now?(): number;
};

type Waiter = { sid: string; since: number; done(r: TurnResult): void };

/** What a session said and did since then: its replies in full, and its tool calls counted by name. */
export function turnSince(events: BrainEvent[], since: number): { text: string; tools: string[] } {
  const says: string[] = [];
  const tools = new Map<string, number>();
  for (const e of events) {
    if (e.agentId !== 'main' || e.ts < since) continue;
    if (e.kind === 'say' && e.text?.trim()) says.push(e.text.trim());
    if (e.kind === 'tool' && e.phase === 'start' && e.tool) tools.set(e.tool.name, (tools.get(e.tool.name) ?? 0) + 1);
  }
  return { text: says.join('\n\n'), tools: [...tools].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)) };
}

/**
 * Cora's conversations with sessions: the sessions you've let it talk with for a while (one OK, then its follow-ups go
 * straight in), and waiting for a session to finish the turn Cora started. A reply it stopped waiting for comes to it
 * later as a [Cora] line.
 */
export class Talk {
  private grants = new Map<string, number>();
  private waiters = new Set<Waiter>();
  /** replies Cora stopped waiting for: session → since when */
  private late = new Map<string, number>();

  constructor(private d: TalkDeps) {}

  private now = () => this.d.now?.() ?? Date.now();

  /** Cora may talk with this session without asking (you OKed a conversation with it a little while ago). */
  allowed(sessionId: string): boolean {
    const until = this.grants.get(sessionId);
    if (until && until > this.now()) return true;
    if (until) (this.grants.delete(sessionId), this.d.onChange?.());
    return false;
  }

  grant(sessionId: string, ms = TALK_MS): void {
    this.grants.set(sessionId, this.now() + ms);
    this.d.onChange?.();
  }

  end(sessionId: string): void {
    if (this.grants.delete(sessionId)) this.d.onChange?.();
    this.late.delete(sessionId);
    for (const w of [...this.waiters]) if (w.sid === sessionId) w.done({ state: 'cancelled' });
  }

  /** The conversations it may carry on now (session → until). */
  list(): Array<{ sessionId: string; until: number }> {
    const now = this.now();
    return [...this.grants].filter(([, u]) => u > now).map(([sessionId, until]) => ({ sessionId, until }));
  }

  /** Stand down / turned off: no more conversations, nobody waited for. */
  endAll(): void {
    const had = this.grants.size > 0;
    this.grants.clear();
    this.late.clear();
    for (const w of [...this.waiters]) w.done({ state: 'cancelled' });
    if (had) this.d.onChange?.();
  }

  /** Tell Cora the reply to the turn begun at `since` when it comes (it isn't waiting for it). */
  expect(sessionId: string, since: number): void {
    this.late.set(sessionId, since);
  }

  /** Wait for the session to finish the turn begun at `since` (or to be held on the user, end, or time out). */
  wait(sessionId: string, since: number, ms: number): Promise<TurnResult> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      let poll: NodeJS.Timeout;
      const w: Waiter = {
        sid: sessionId,
        since,
        done: (r) => {
          if (!this.waiters.delete(w)) return;
          clearTimeout(timer);
          clearInterval(poll);
          if (r.state === 'timeout' || r.state === 'blocked') this.late.set(sessionId, since);
          resolve(r);
        },
      };
      this.waiters.add(w);
      timer = setTimeout(() => w.done({ state: 'timeout' }), ms);
      poll = setInterval(() => {
        const held = this.d.heldOn(sessionId);
        if (held && this.now() - Math.max(held.since, since) >= BLOCKED_MS) w.done({ state: 'blocked', what: held.what });
      }, POLL_MS);
    });
  }

  /** A session's event: finishes the waits on it. True when it was a reply Cora was waiting for (so it isn't news twice). */
  event(e: BrainEvent): boolean {
    if (!e.sessionId || e.agentId !== 'main') return false;
    if (e.kind !== 'turn_end' && e.kind !== 'session_end') return false;
    let used = false;
    for (const w of [...this.waiters]) {
      if (w.sid !== e.sessionId || e.ts < w.since) continue;
      used = true;
      w.done(e.kind === 'session_end' ? { state: 'ended' } : { state: 'replied', ...turnSince(this.d.events(w.sid, w.since), w.since) });
    }
    const since = this.late.get(e.sessionId);
    if (since !== undefined && e.ts >= since) {
      this.late.delete(e.sessionId);
      if (e.kind === 'turn_end') {
        used = true;
        this.d.onLate(e.sessionId, { state: 'replied', ...turnSince(this.d.events(e.sessionId, since), since) });
      }
    }
    return used;
  }

  dispose(): void {
    for (const w of [...this.waiters]) w.done({ state: 'cancelled' });
  }
}
