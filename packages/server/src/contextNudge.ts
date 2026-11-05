import { pastNudge, type BrainEvent } from '@cora/shared';

/** How old an event may be and still count (older: a transcript read from its start as Cora starts, not news). */
const FRESH_MS = 10 * 60_000;

/**
 * Watches each session's context as its turns come in (the main agent's tokens: what it read, and wrote); the first
 * time it's past the threshold, the session is nudged (contextNudge.ts), and never again. Cora acts on nothing.
 */
export class ContextNudges {
  constructor(private d: { threshold: () => number; nudged: (sid: string) => boolean; nudge: (sid: string, tokens: number, over: number) => void; now?: () => number }) {}

  event(e: BrainEvent): void {
    if (e.agentId !== 'main' || !e.tokens) return;
    if (e.ts < (this.d.now ?? Date.now)() - FRESH_MS) return;
    const tokens = e.tokens.in + e.tokens.out;
    const over = this.d.threshold();
    if (!pastNudge(tokens, over) || this.d.nudged(e.sessionId)) return;
    this.d.nudge(e.sessionId, tokens, over);
  }
}
