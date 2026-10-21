/**
 * Watching Jira for you: what's watched, how loudly, what an event is, and what the dashboard hears. No imports:
 * types.ts (Settings) uses it.
 */

export const JIRA_EVENT_KINDS = ['assigned', 'mentioned', 'commented', 'status', 'watched'] as const;
export type JiraEventKind = (typeof JIRA_EVENT_KINDS)[number];
/** off: not looked for · quiet: inbox and Cora only · notify: a card or a notification · say: that, and Cora says it */
export type JiraAlertLevel = 'off' | 'quiet' | 'notify' | 'say';
export const JIRA_ALERT_LEVELS: readonly JiraAlertLevel[] = ['off', 'quiet', 'notify', 'say'];

/** When a ticket is assigned to you: just tell you, offer to start it, or start it (to get it ready) on its own. */
export const JIRA_START_MODES = ['tell', 'offer', 'auto'] as const;
export type JiraStartMode = (typeof JIRA_START_MODES)[number];

export type JiraWatchSettings = {
  on: boolean;
  /** the Jira site to watch (the dashboard's); empty: the one you're signed in to */
  site?: string;
  kinds: Record<JiraEventKind, JiraAlertLevel>;
  /** when a ticket is assigned to you */
  start: JiraStartMode;
};
export const DEFAULT_JIRA_WATCH: JiraWatchSettings = { on: false, kinds: { assigned: 'say', mentioned: 'say', commented: 'notify', status: 'notify', watched: 'quiet' }, start: 'offer' };

/** Something that happened in Jira that you'd want to know. `id` is stable: the same change found twice is one event. */
export type JiraEvent = { id: string; kind: JiraEventKind; key: string; summary: string; who: string; what: string; at: number; link: string };
/** An event with how loudly it's to be told (what the dashboard gets). */
export type JiraAlertEvent = JiraEvent & { level: JiraAlertLevel; /** Cora offers or starts it: its card and its voice are Cora's */ handoff?: boolean };

export type JiraWatchStatus = { state: 'off' | 'ok' | 'paused' | 'error'; message?: string; checkedAt?: number; mentionFallback?: boolean };

/** The dashboard's message: the watcher's status, new events (or one catch-up summary), and the recent ones. */
export type JiraMsg = { t: 'jira'; status: JiraWatchStatus; events?: JiraAlertEvent[]; summary?: string; recent?: JiraEvent[] };

/** The searches a check runs; one issue can come from several. */
export type JiraSearch = 'mine' | 'mentions' | 'watched';
/** An issue as the watcher hands it over: Jira's fields and changelog, its comments, which searches found it. */
export type WatchedIssue = { key: string; fields: any; changelog?: { histories?: any[] }; comments: any[]; from: JiraSearch[] };

/** "30m", "4h", "2d" as milliseconds (null: not that shape). */
export function parseSince(s: string): number | null {
  const m = /^(\d+)\s*([mhd])$/i.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 'm' | 'h' | 'd'];
}

/** One event as a line for Cora: `[10:42] ACME-5301 · Dana Scully assigned you · Saved search dedupe fails on reload (link)`. */
export function jiraLine(e: JiraEvent, now = new Date()): string {
  const d = new Date(e.at);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const when = d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${t}`;
  return `[${when}] ${e.key} · ${e.who} ${e.what} · ${e.summary} (${e.link})`;
}

const COUNTED: Record<JiraEventKind, (n: number) => string> = {
  assigned: (n) => `${n} assigned to you`,
  mentioned: (n) => `${n} mention${n === 1 ? '' : 's'}`,
  commented: (n) => `${n} comment${n === 1 ? '' : 's'} on your tickets`,
  status: (n) => `${n} status change${n === 1 ? '' : 's'}`,
  watched: (n) => `${n} change${n === 1 ? '' : 's'} on tickets you watch`,
};
/** What happened while Cora was closed, in one line: "While Cora was closed: 1 assigned to you, 3 mentions". */
export function catchupSummary(events: Pick<JiraEvent, 'kind'>[]): string {
  const parts = JIRA_EVENT_KINDS.map((k) => [k, events.filter((e) => e.kind === k).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => COUNTED[k](n));
  return `While Cora was closed: ${parts.join(', ')}`;
}
