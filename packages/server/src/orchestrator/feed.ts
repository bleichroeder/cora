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
  private lastKind = new Map<string, string>();
  private toldStalled = new Map<string, number>();

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
  note(line: string, o: { others?: boolean } = {}): void {
    if (this.d.mode() === 'off') return;
    this.push(line);
    if (o.others) this.qOthers = true;
  }

  event(e: BrainEvent): void {
    if (!e.sessionId || this.d.isAgent(e.sessionId) || e.agentId !== 'main') return;
    if (e.kind === 'say' && e.text) this.lastSay.set(e.sessionId, e.text);
    this.watchFailures(e);
    this.lastKind.set(e.sessionId, e.kind);
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
      s.n += 1;
      s.last = `${e.tool.name}${e.tool.summary ? ` \`${clip(e.tool.summary, 120)}\`` : ''}${e.tool.resultSummary ? `: ${clip(e.tool.resultSummary, 200)}` : ''}`;
      this.streaks.set(sid, s);
      if (s.n >= FAIL_STREAK && !s.told) {
        s.told = true;
        this.push(`${name()} has failed ${s.n} tool calls in a row (last: ${s.last})`);
      }
    } else if (e.kind === 'say' && /^\s*API Error\b/i.test(e.text ?? '')) {
      this.push(`${name()} stopped on an API error: ${clip(e.text, 240)}`);
    } else if (e.kind === 'session_end') {
      const prev = this.lastKind.get(sid);
      if (prev && prev !== 'turn_end' && prev !== 'session_start' && prev !== 'interrupt') this.push(`${name()} ended in the middle of a turn`);
      this.streaks.delete(sid);
    }
  }

  /** Sessions that look stuck: working, with nothing happening for a while (said once until they move again). */
  sessions(list: SessionInfo[]): void {
    const now = this.now();
    for (const s of list) {
      if (this.d.isAgent(s.id)) continue;
      const told = this.toldStalled.get(s.id);
      if (told !== undefined && s.lastTs > told) this.toldStalled.delete(s.id);
      if ((s.state === 'working' || s.state === 'thinking') && now - s.lastTs >= STALLED_MS && !this.toldStalled.has(s.id)) {
        this.toldStalled.set(s.id, s.lastTs);
        this.push(`"${this.d.name(s.id)}" (${s.id}) has been working with no activity for ${Math.round((now - s.lastTs) / 60_000)} minutes: it may be stuck`);
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
