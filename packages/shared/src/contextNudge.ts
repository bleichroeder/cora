/**
 * A session whose context has grown huge rereads all of it on every turn (one session at ~460k was half of all token
 * use in a month). Past a threshold (a setting) Cora nudges, once: the header's context chip turns amber and says how
 * much each turn rereads, a notice suggests a handover or /compact, and a team seat's lead hears it on the board. Cora
 * never acts on it herself.
 */
export const CONTEXT_NUDGE = 300_000;
/** The thresholds Settings offers (0: never nudge). */
export const CONTEXT_NUDGES = [0, 150_000, 300_000, 500_000] as const;
/** The threshold set (or the default). */
export const nudgeAt = (s: { context?: { nudgeAt?: number } } | null | undefined): number => s?.context?.nudgeAt ?? CONTEXT_NUDGE;
/** Past it: its context at or over the threshold (0: never). */
export const pastNudge = (ctx: number, at: number): boolean => at > 0 && ctx >= at;
/** "each turn rereads ~460k" */
export const rereads = (ctx: number): string => `each turn rereads ~${Math.round(ctx / 1000)}k`;
export const NUDGE_ADVICE = 'A handover (a fresh session given a summary of where it stands) or /compact would make each turn cheaper.';
/** A session's nudge, once given: when, its context then, and the threshold it passed. */
export type ContextNudge = { at: number; tokens: number; over: number };
