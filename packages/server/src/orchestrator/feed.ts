import { ciActive, type BrainEvent, type CiPipeline, type PendingRequest, type SessionInfo } from '@cora/shared';
import type { Verdict } from './mandate';

export type FeedMode = 'off' | 'important' | 'autopilot';

export type FeedDeps = {
  /** type the lines into the agent (false: it couldn't take them now); `others`: someone else's words are in them */
  deliver(text: string, others: boolean): boolean;
  /** the agent is working (or asking something): lines wait */
  agentBusy(): boolean;
  /** autopilot (a goal is live), important (the default otherwise), or off */
  mode(): FeedMode;
  isWorker(sessionId: string): boolean;
  isAgent(sessionId: string): boolean;
  name(sessionId: string): string;
  now?(): number;
  /** lines gather this long before they go (several things at once arrive together) */
  flushMs?: number;
};

const WAITED_MS = 3 * 60_000;
/** failed tool calls in a row (with no success between) before it's news */
export const FAIL_STREAK = 3;
/** working with no activity this long: it may be stuck */
export const STALLED_MS = 15 * 60_000;
/**
 * An event older than this isn't news: it's one read again (Cora re-reads the day's transcripts when it starts, and a
 * hook's event and its transcript line are stored as one, so the same event can come by more than once).
 */
export const LIVE_MS = 5 * 60_000;
/** a failure that only follows from the one before (the file it was to make isn't there): not a failure of its own */
const FOLLOW_ON = /\b(does not exist|no such file|not found|ENOENT|cannot find the (file|path))\b/i;
const FOLLOWERS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const SEEN_MAX = 5000;
const MAX_LINES = 20;

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What a held prompt is about, in a few words. */
export function promptWhat(p: Pick<PendingRequest, 'toolName' | 'toolInput'>): string {
  const i = (p.toolInput ?? {}) as Record<string, unknown>;
  const detail = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : '';
  return `${p.toolName}${detail ? ` \`${clip(detail, 160)}\`` : ''}`;
}

/**
 * What Cora hears, as short lines typed into its input while it's idle, a few at a time. On autopilot: everything
 * about the goal's sessions (finished turns with their last words, the prompts they hit and what the mandate said,
 * their pipelines, their ends). Otherwise the important things: a pipeline that failed, a prompt that has waited a
 * while. Off: nothing.
 */
export class EventFeed {
  private q: string[] = [];
  private firstAt = 0;
  private seenPending = new Set<string>();
  private toldWaiting = new Set<string>();
  private pipes = new Map<string, string>();
  private lastSay = new Map<string, string>();
  /** failure watching: failed calls in a row per session (told once per streak), the last thing each did, who was told stalled */
  private streaks = new Map<string, { n: number; told: boolean; last: string }>();
  /** each session's turn, as live events tell it: open (a prompt came, no end yet) and when it last did anything */
  private turns = new Map<string, { open: boolean; at: number }>();
  /** sessions told stuck in their current working stretch (said again only after it stops working) */
  private toldStalled = new Set<string>();
  /** sessions whose alerts are muted, until when (the user asked, through Cora) */
  private muted = new Map<string, number>();
  /** events already heard (by id): the same event coming again isn't heard twice */
  private seen = new Set<string>();

  /** Things to know but not worth a turn of their own (Jira): they go with the next delivery, or before your next words. */
  private held: string[] = [];
  /** someone else's words (a Slack reply, an email) are among the gathered lines: the turn they start acts on nothing */
  private qOthers = false;

  constructor(private d: FeedDeps) {}

  /** Something to know, but not worth a turn: with the next delivery, or before the user's next words. */
  hold(line: string): void {
    if (this.d.mode() === 'off' || this.held.includes(line)) return;
    // what's reachable now is all that matters: a newer network line replaces the one held before
    if (line.startsWith('[Network] ')) this.held = this.held.filter((l) => !l.startsWith('[Network] '));
    this.held.push(line);
    if (this.held.length > 30) this.held.shift();
  }
  /** What it was holding (taken: it goes with your words). */
  takeHeld(): string[] {
    const h = this.held;
    this.held = [];
    return h;
  }

  private now = () => this.d.now?.() ?? Date.now();
  private push(line: string): void {
    if (this.d.mode() === 'off' || this.q.includes(line)) return;
    this.q.push(line);
    if (!this.firstAt) this.firstAt = this.now();
  }
  queued(): string[] {
    return [...this.q];
  }

  /** Something to tell it in so many words (a budget reached, the user stood it down, …). */
  note(line: string, o: { others?: boolean; /** comes even with the feed off (a follow-up the user asked for) */ always?: boolean } = {}): void {
    if (this.d.mode() === 'off' && !o.always) return;
    this.push(line);
    if (o.others) this.qOthers = true;
  }

  /** Mute a session's alerts (failures, stuck, ended) for a while; 0 hours unmutes. Returns until when. */
  mute(sessionId: string, hours: number): number {
    if (hours <= 0) return void this.muted.delete(sessionId), 0;
    const until = this.now() + hours * 3_600_000;
    this.muted.set(sessionId, until);
    return until;
  }
  private quiet(sid: string): boolean {
    const until = this.muted.get(sid);
    if (until && until <= this.now()) this.muted.delete(sid);
    return !!until && until > this.now();
  }

  event(e: BrainEvent): void {
    if (!e.sessionId || this.d.isAgent(e.sessionId) || e.agentId !== 'main') return;
    // news only: an event read again (old), or one heard already, is neither counted nor told
    if (this.now() - e.ts > LIVE_MS) return;
    const key = `${e.id}|${e.phase ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    if (e.kind === 'say' && e.text) this.lastSay.set(e.sessionId, e.text);
    this.watchFailures(e);
    this.watchTurn(e);
    if (this.d.mode() !== 'autopilot' || !this.d.isWorker(e.sessionId)) return;
    const name = this.d.name(e.sessionId);
    if (e.kind === 'turn_end') {
      const last = this.lastSay.get(e.sessionId);
      this.push(`"${name}" (${e.sessionId}) finished its turn${last ? `: ${clip(last, 300)}` : ''}`);
    } else if (e.kind === 'session_end') this.push(`"${name}" (${e.sessionId}) ended`);
  }

  /**
   * Failures worth Cora's attention in any session (unless it hears nothing): a run of failed tool calls, an API
   * error that stopped a turn, a session that ended in the middle of one. Each is said once.
   */
  private watchFailures(e: BrainEvent): void {
    const sid = e.sessionId;
    const name = () => `"${this.d.name(sid)}" (${sid})`;
    if (e.kind === 'tool' && e.phase === 'end' && e.tool) {
      const s = this.streaks.get(sid) ?? { n: 0, told: false, last: '' };
      if (!e.tool.failed) return void this.streaks.delete(sid);
      // reading what a failed step was to make (its screenshot, its file) fails too: that's the same failure
      if (s.n && FOLLOWERS.has(e.tool.name) && FOLLOW_ON.test(e.tool.resultSummary ?? '')) return;
      s.n += 1;
      s.last = `${e.tool.name}${e.tool.summary ? ` \`${clip(e.tool.summary, 120)}\`` : ''}${e.tool.resultSummary ? `: ${clip(e.tool.resultSummary, 200)}` : ''}`;
      this.streaks.set(sid, s);
      if (s.n >= FAIL_STREAK && !s.told) {
        s.told = true;
        if (!this.quiet(sid)) this.push(`${name()} has failed ${s.n} tool calls in a row (last: ${s.last})`);
      }
    } else if (e.kind === 'say' && /^\s*API Error\b/i.test(e.text ?? '')) {
      if (!this.quiet(sid)) this.push(`${name()} stopped on an API error: ${clip(e.text, 240)}`);
    } else if (e.kind === 'session_end') {
      // mid-turn: a turn began (heard live) and hadn't ended, and it was doing something lately (a session left idle
      // for hours and closed isn't cut off mid-turn, whatever its last line was)
      const t = this.turns.get(sid);
      if (t?.open && e.ts - t.at < STALLED_MS && !this.quiet(sid)) this.push(`${name()} ended in the middle of a turn`);
      this.streaks.delete(sid);
      this.turns.delete(sid);
    }
  }

  /** A session's turn as live events tell it: a prompt opens it; its end, an interrupt or a fresh start closes it. */
  private watchTurn(e: BrainEvent): void {
    const sid = e.sessionId;
    const t = this.turns.get(sid) ?? { open: false, at: e.ts };
    if (e.kind === 'prompt' && !e.queue) t.open = true;
    else if (e.kind === 'turn_end' || e.kind === 'interrupt' || e.kind === 'session_start') t.open = false;
    t.at = Math.max(t.at, e.ts);
    this.turns.set(sid, t);
  }

  /**
   * Sessions that look stuck: working, with nothing happening for a while. Said once a working stretch: again only
   * after it has stopped working (finished, waiting on you, ended), not every time it stirs. Muted sessions: never.
   */
  sessions(list: SessionInfo[]): void {
    const now = this.now();
    for (const s of list) {
      if (this.d.isAgent(s.id)) continue;
      const working = s.state === 'working' || s.state === 'thinking';
      // one Cora hasn't heard from since it started may only look busy (its transcript read again): not stuck
      if (!working || !this.turns.has(s.id)) {
        this.toldStalled.delete(s.id);
        continue;
      }
      if (now - s.lastTs >= STALLED_MS && !this.toldStalled.has(s.id)) {
        this.toldStalled.add(s.id);
        if (!this.quiet(s.id)) this.push(`"${this.d.name(s.id)}" (${s.id}) has been working with no activity for ${Math.round((now - s.lastTs) / 60_000)} minutes: it may be stuck (mute_alerts quiets it)`);
      }
    }
  }

  /** The prompts sessions are held on (checked on every change and now and then), with the mandate's verdicts. */
  pending(list: PendingRequest[], verdicts: Map<string, Verdict>): void {
    const mode = this.d.mode();
    const now = this.now();
    for (const p of list) {
      if (!p.sessionId || this.d.isAgent(p.sessionId)) continue;
      const name = this.d.name(p.sessionId);
      if (mode === 'autopilot' && this.d.isWorker(p.sessionId) && !this.seenPending.has(p.id)) {
        this.seenPending.add(p.id);
        if (p.kind === 'question') {
          const qs = ((p.toolInput as { questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> })?.questions ?? []).map((q) => `"${q.question}" [${(q.options ?? []).map((o) => o.label).join(' | ')}]`);
          this.push(`"${name}" (${p.sessionId}) asks: ${qs.join(' ; ')}. Answer it with answer_question ${p.id}`);
          continue;
        }
        const v = verdicts.get(p.id);
        const said = !v ? 'waiting for the user' : v.verdict === 'allow' ? 'allowed (your mandate)' : v.verdict === 'refuse' ? `refused: ${v.why}` : `waiting for the user: ${v.why}`;
        this.push(`"${name}" (${p.sessionId}) asked for ${promptWhat(p)}: ${said}`);
        continue;
      }
      // (a worker's prompt it was already told about isn't news again)
      if (mode !== 'off' && !this.seenPending.has(p.id) && !this.toldWaiting.has(p.id) && now - p.createdAt > WAITED_MS) {
        this.toldWaiting.add(p.id);
        this.push(`"${name}" (${p.sessionId}) has waited ${Math.round((now - p.createdAt) / 60_000)} minutes for the user: ${promptWhat(p)}`);
      }
    }
  }

  /** A pipeline changed (with the sessions that follow it). */
  pipeline(p: CiPipeline, sessionIds: string[]): void {
    const prev = this.pipes.get(p.key);
    this.pipes.set(p.key, p.status);
    if (prev === p.status || prev === undefined) return;
    const workers = sessionIds.filter((s) => this.d.isWorker(s));
    const failedJobs = p.stages.flatMap((s) => s.jobs.filter((j) => j.status === 'failed' && !j.allowFailure).map((j) => j.name));
    const jobs = failedJobs.length ? ` (failed: ${failedJobs.slice(0, 5).join(', ')})` : '';
    if (this.d.mode() === 'autopilot' && workers.length) {
      this.push(`pipeline #${p.id} on ${p.ref} for "${this.d.name(workers[0])}": ${p.status}${jobs} ${p.url}`);
      return;
    }
    if (p.status === 'failed' && ciActive(prev as never)) {
      const who = sessionIds.filter((s) => !this.d.isAgent(s)).map((s) => `"${this.d.name(s)}"`);
      this.push(`pipeline #${p.id} on ${p.ref} failed${jobs}${who.length ? ` (${who.join(', ')})` : ''} ${p.url}`);
    }
  }

  /** Deliver what's gathered, if it's had a moment to gather and the agent is free. */
  tick(): boolean {
    if (!this.q.length || this.now() - this.firstAt < (this.d.flushMs ?? 4000) || this.d.agentBusy()) return false;
    const t = new Date(this.now());
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    // what it was holding goes first (it's older), with what's gathered
    const lines = [...this.held, ...this.q];
    const more = lines.length - MAX_LINES;
    const text = [`[Cora ${hhmm}]`, ...lines.slice(0, MAX_LINES).map((l) => `- ${l}`), ...(more > 0 ? [`- …and ${more} more`] : [])].join('\n');
    if (!this.d.deliver(text, this.qOthers)) return false;
    this.qOthers = false;
    this.q = [];
    this.held = [];
    this.firstAt = 0;
    return true;
  }
}
