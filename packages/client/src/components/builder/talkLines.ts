import { BUILDER_FIRST_PROMPT, isShell, type BrainEvent, type BuilderDraftView, type LintItem, type Team, type TerminalInfo } from '@cora/shared';

/** A line of Talk: your words or Cora's, and under her last words in a turn what she changed (with Undo). */
export type TalkLine = { id: string; who: 'you' | 'cora'; text: string; at: number; turn?: { ids: string[]; summary: string; undone: boolean; struck?: string[] }; /** yours, sent, not yet in her conversation */ sending?: true };

/** Something you sent from Talk that her conversation doesn't show yet (her session may still be starting; `live`: it was running). */
export type Sending = { id: string; text: string; at: number; live?: true };
// the same words, however they were typed in (the guard before a leading "/", "!" or "#"; spacing and line breaks)
const sameWords = (a: string, b: string) => a.replace(/​/g, '').replace(/\s+/g, ' ').trim() === b.replace(/​/g, '').replace(/\s+/g, ' ').trim();
/** How much earlier than your Send her transcript may date the same words (its clock and this screen's). */
const ARRIVED_SLACK_MS = 2000;
/** What you sent that hasn't arrived in her conversation yet. */
export function stillSending(sending: Sending[], lines: TalkLine[]): Sending[] {
  return sending.filter((p) => !lines.some((l) => l.who === 'you' && !l.sending && l.at >= p.at - ARRIVED_SLACK_MS && sameWords(l.text, p.text)));
}
/**
 * How long your words may show as sending: her session has 90 seconds to be heard from (and a closing one 30 to go)
 * before Cora gives up on them and says so; past this, nothing will say (Cora restarted meanwhile), so Talk does.
 */
export const SENDING_MAX_MS = 150_000;
/** What you sent that has been on its way too long to still arrive. */
export function sendingGone(sending: Sending[], now: number): Sending[] {
  return sending.filter((p) => now - p.at >= SENDING_MAX_MS);
}
/** The conversation with what you just sent at the end, marked sending, so it shows the moment you press Enter. */
export function withSending(lines: TalkLine[], sending: Sending[]): TalkLine[] {
  const left = stillSending(sending, lines);
  return left.length ? [...lines, ...left.map((p) => ({ id: p.id, who: 'you' as const, text: p.text, at: p.at, sending: true as const }))] : lines;
}

/**
 * Talk from the builder session's events (as Cora's console reads hers) and the draft's turns: a turn's changes go
 * under the last thing she said before your next words (one line per turn, however many changes it made).
 */
export function talkLines(evs: BrainEvent[], turns: BuilderDraftView['turns']): TalkLine[] {
  const out: TalkLine[] = [];
  let from = -Infinity;
  let last: TalkLine | null = null;
  // a line's id is its turn's prompt and its place in it, so a change that lands before her words keeps its element when they arrive
  let key = 'start';
  let nth = 0;
  const lineId = () => `${key}:${nth++}`;
  const attach = (until: number) => {
    const ts = turns.filter((t) => t.at > from && t.at <= until);
    if (!ts.length) return;
    const line = last ?? { id: lineId(), who: 'cora' as const, text: 'I changed the draft.', at: ts[0].at };
    if (!last) out.push(line);
    // Undo takes back only what is still in the draft; turns already undone show struck
    const live = ts.filter((t) => !t.undone);
    const gone = ts.filter((t) => t.undone);
    line.turn = { ids: live.map((t) => t.id), summary: (live.length ? live : gone).map((t) => t.summary).join(' · '), undone: !live.length, ...(live.length && gone.length ? { struck: gone.map((t) => t.summary) } : {}) };
  };
  for (const e of evs) {
    if (e.agentId !== 'main') continue;
    if (e.kind === 'prompt' && !e.queue && e.text) {
      // words you sent while she was working are still yours to read, but they don't start a new turn
      if (!e.midTurn) {
        attach(e.ts);
        from = e.ts;
        last = null;
        key = e.id;
        nth = 0;
      }
      if (e.text.trim() !== BUILDER_FIRST_PROMPT) out.push({ id: e.id, who: 'you', text: e.text, at: e.ts });
    } else if (e.kind === 'say' && e.text?.trim()) {
      last = { id: lineId(), who: 'cora', text: e.text, at: e.ts };
      out.push(last);
    }
  }
  attach(Infinity);
  return out;
}

/**
 * Her builder session is running: its terminal is alive here. (Builder sessions stay out of the client's session list,
 * so its terminal is what tells; an ended session has none, or a dead one.)
 */
export function builderRunning(terminals: TerminalInfo[], sid: string | null | undefined): boolean {
  return !!sid && terminals.some((t) => t.sessionId === sid && t.alive && !isShell(t));
}
/** What you sent while she was running won't reach her once she has stopped; what you sent to start her waits for her. */
export function sendingStopped(sending: Sending[], running: boolean): Sending[] {
  return running || !sending.some((s) => s.live) ? sending : sending.filter((s) => !s.live);
}

/**
 * Cora is on it: your last words haven't had her turn's end yet, and her session is running (one ended or killed
 * mid-turn records no turn end).
 */
export function talkBusy(evs: BrainEvent[], running = true): boolean {
  if (!running) return false;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.agentId !== 'main') continue;
    if (e.kind === 'turn_end' || e.kind === 'session_end' || e.kind === 'interrupt') return false;
    if (e.kind === 'prompt' && !e.queue) return true;
  }
  return false;
}

/** Her builder tools and her skill, in words (anything else: its own name). */
const STEP_WORDS: Record<string, string> = { team_draft_get: 'Reading the draft', team_draft_set: 'Saving changes', team_trace: 'Tracing a message', Skill: 'Looking up how to build teams' };
const stepOf = (tool: string) => {
  const name = tool.replace(/^mcp__.+?__/, '');
  return STEP_WORDS[name] ?? name;
};
/** How long a turn has run: minutes and seconds. */
export function turnClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/**
 * What Cora is doing in her turn, from her builder session's events: the tool in progress in words (one she has said
 * or thought something since isn't, even with no end recorded), Thinking when her latest step is a think, else
 * Working; and how long the turn has run. Null: no turn in progress.
 */
export function talkActivity(evs: BrainEvent[], now: number): { step: string; clock: string } | null {
  let step: string | null = null;
  let latest = true;
  // (walking back: she said or thought something after the steps still to come)
  let movedOn = false;
  const ended = new Set<string>();
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.agentId !== 'main') continue;
    if (e.kind === 'turn_end' || e.kind === 'session_end' || e.kind === 'interrupt') return null;
    if (e.kind === 'prompt') {
      // words you sent mid-turn don't start it
      if (!e.queue && !e.midTurn) return { step: step ?? 'Working', clock: turnClock(now - e.ts) };
      continue;
    }
    if (latest && e.kind === 'think') step = 'Thinking';
    latest = false;
    if (e.kind === 'say' || e.kind === 'think') movedOn = true;
    if (e.kind !== 'tool' || !e.toolUseId) continue;
    if (e.phase === 'end') ended.add(e.toolUseId);
    else if (step === null && !movedOn && !ended.has(e.toolUseId) && e.tool) step = stepOf(e.tool.name);
  }
  return null;
}

export const TRY_CHIP = 'try a message';
/** A few things you might say next, from where the draft is. */
export function suggestions(t: Team, checks: LintItem[]): string[] {
  if (!t.seats.length) return ['I need a team that watches our encoders'];
  const out: string[] = [];
  if (checks.length) out.push('what is still missing?');
  if (!t.escalation.some((e) => e.when === 'unclaimed')) out.push('add an escalation');
  out.push(TRY_CHIP, 'are we ready?');
  // three at most: trying a message goes first when there are more
  return (out.length > 3 ? out.filter((c) => c !== TRY_CHIP) : out).slice(0, 3);
}
