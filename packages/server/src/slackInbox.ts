import { existsSync, readFileSync } from 'node:fs';
import type { SlackFollow } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * Slack in Cora's Inbox: which messages Cora would tell you about.
 * DMs, group DMs and mentions anywhere; in channels you follow, only what touches you (a thread you posted in, your
 * tickets and repos, your words, announcements). Never your own messages, nor Cora's bot.
 */

/** A message as Slack's live events give it (what's needed to decide). */
export type SlackSeen = { channel: string; ts: string; threadTs?: string; user: string; text: string; dm: boolean; group: boolean };
export type SlackCtx = {
  me: string;
  /** Cora's own bot (its user and its DM with you) */
  bot?: { userId: string; dm?: string };
  follow: SlackFollow[];
  /** a thread you posted in */
  mine: (channel: string, threadTs: string) => boolean;
  /** your work: ticket keys, repo and service names */
  work: string[];
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The term as a word of its own (not inside a longer word or name), any case. */
const has = (text: string, term: string) => new RegExp(`(^|[^\\w-])${esc(term)}(?![\\w-])`, 'i').test(text);

export function slackWhy(m: SlackSeen, c: SlackCtx): { why: string; short: string } | null {
  if (!m.user || m.user === c.me || m.user === c.bot?.userId || m.channel === c.bot?.dm) return null;
  if (m.dm) return { why: 'a DM to you', short: 'DM' };
  if (m.group) return { why: "a group DM you're in", short: 'group DM' };
  if (m.text.includes(`<@${c.me}>`)) return { why: 'you were mentioned', short: 'mentioned you' };
  const f = c.follow.find((x) => x.id === m.channel);
  if (!f) return null;
  if (m.threadTs && m.threadTs !== m.ts && c.mine(m.channel, m.threadTs)) return { why: 'a reply in a thread you posted in', short: 'your thread' };
  if (/<!(here|channel|everyone)(\|[^>]*)?>/.test(m.text)) return { why: `an announcement in ${f.label}`, short: 'announcement' };
  const work = c.work.find((t) => has(m.text, t));
  if (work) return { why: `it mentions ${work}`, short: work };
  const word = f.words.find((w) => has(m.text, w));
  if (word) return { why: `your word: ${word}`, short: word };
  return null;
}

/** Its conversation in the Inbox: a DM (or a thread in one), or a channel's thread (a top-level message starts one). */
export function slackKey(m: Pick<SlackSeen, 'channel' | 'ts' | 'threadTs' | 'dm' | 'group'>): string {
  const thread = m.threadTs && m.threadTs !== m.ts ? m.threadTs : null;
  if (m.dm || m.group) return thread ? `slack:${m.channel}:${thread}` : `slack:${m.channel}`;
  return `slack:${m.channel}:${thread ?? m.ts}`;
}

const KEEP_MS = 14 * 86_400_000;
const MAX_THREADS = 3000;

/** The threads you posted in (14 days), and when Slack was last heard (where a catch-up starts). */
export class MyThreads {
  private st: { threads: Record<string, number>; heard?: number } = { threads: {} };

  constructor(private file: string | undefined, private now: () => number = Date.now) {
    try {
      if (file && existsSync(file)) this.st = { threads: {}, ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      /* start afresh */
    }
    const cutoff = this.now() - KEEP_MS;
    for (const [k, at] of Object.entries(this.st.threads)) if (at < cutoff) delete this.st.threads[k];
  }
  private save() {
    try {
      if (this.file) writeFileAtomic(this.file, JSON.stringify(this.st));
    } catch {
      /* not kept */
    }
  }
  has(channel: string, threadTs: string): boolean {
    return !!this.st.threads[`${channel}:${threadTs}`];
  }
  posted(channel: string, threadTs: string): void {
    this.st.threads[`${channel}:${threadTs}`] = this.now();
    const keys = Object.keys(this.st.threads);
    if (keys.length > MAX_THREADS) for (const k of keys.sort((a, b) => this.st.threads[a] - this.st.threads[b]).slice(0, keys.length - MAX_THREADS)) delete this.st.threads[k];
    this.save();
  }
  heard(): number | undefined {
    return this.st.heard;
  }
  /** Slack was heard just now (saved at most once a minute). */
  hear(): void {
    const n = this.now();
    if (this.st.heard && n - this.st.heard < 60_000) return;
    this.st.heard = n;
    this.save();
  }
}
