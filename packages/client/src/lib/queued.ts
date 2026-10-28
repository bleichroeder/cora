import type { BrainEvent } from '@cora/shared';

/**
 * Messages still queued for Claude (you sent them while it worked): the ones marked waiting since its turn last ended.
 * Claude Code hands every queued message over by the end of the turn it was sent in, so one older than that was taken,
 * even when its transcript never said so (a `!` command run from the queue leaves no line saying it left).
 */
export function stillQueued(events: readonly BrainEvent[]): BrainEvent[] {
  let ended = 0;
  for (const e of events) if (e.kind === 'turn_end' && e.agentId === 'main') ended = Math.max(ended, e.ts);
  return events.filter((e) => e.kind === 'prompt' && e.queue === 'waiting' && e.ts > ended);
}
