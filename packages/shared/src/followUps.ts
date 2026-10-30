/**
 * Cora checking back by herself, when the user asked her to ("let me know what it finds"): watch a session until its
 * turn ends, or look at a time, or every so often, a few times at most. Each one, when it comes, is a [Follow-up] line
 * to Cora with what the session said since; she tells the user (their Cora DM when they're away).
 */
export type FollowUp = {
  id: string;
  /** what the user wants to hear, in their words */
  about: string;
  /** the session it's about */
  sessionId?: string;
  /** turn: when the session's turn ends; time: at `next` (and then every `everyMs`) */
  on: 'turn' | 'time';
  next?: number;
  everyMs?: number;
  /** how many more times it comes */
  left: number;
  /** what's new is what the session did since this (moved on each time it comes) */
  since: number;
  /** it gives up after this */
  until: number;
  createdAt: number;
};
export const MAX_FOLLOW_UPS = 10;
export const FOLLOW_UP_MIN_EVERY_MS = 5 * 60_000;
