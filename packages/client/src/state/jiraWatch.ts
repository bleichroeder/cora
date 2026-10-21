import { create } from 'zustand';
import type { JiraAlertEvent, JiraEvent, JiraMsg, JiraStarted, JiraWatchStatus } from '@cora/shared';
import { useBrain } from './store';
import { attentive, desktop } from '../lib/desktop';
import { speak, useVoice } from '../lib/voice';
import { openInBrowser } from '../components/JiraChip';

/** A card beside Cora: one event, several at once, or a catch-up summary. */
export type JiraAlert = { id: string; events: JiraAlertEvent[]; summary?: string; at: number };
/** How long a card stays. */
export const ALERT_MS = 10_000;

type State = {
  status: JiraWatchStatus;
  alerts: JiraAlert[];
  recent: JiraEvent[];
  /** tickets with a mention or comment you haven't opened */
  unseen: Record<string, number>;
  /** "Cora started" cards you've dismissed (by session) */
  startedSeen: Record<string, true>;
};
export const useJiraWatch = create<State>(() => ({ status: { state: 'off' }, alerts: [], recent: [], unseen: {}, startedSeen: {} }));

/** A "Cora started" card shows this long. */
export const STARTED_MS = 30 * 60_000;
/** The "Cora started" cards: sessions it started on its own lately, not dismissed, newest first. */
export function startedToShow(list: JiraStarted[], seen: Record<string, true>, now: number): JiraStarted[] {
  return list.filter((r) => r.auto && now - r.at < STARTED_MS && !seen[r.sessionId]).sort((a, b) => b.at - a.at);
}
export function dismissStarted(sessionId: string): void {
  useJiraWatch.setState((s) => ({ startedSeen: { ...s.startedSeen, [sessionId]: true } }));
}

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n: number) => NUM[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NOUN: Record<JiraAlertEvent['kind'], [string, string]> = { assigned: ['assignment', 'assignments'], mentioned: ['mention', 'mentions'], commented: ['comment', 'comments'], status: ['status change', 'status changes'], watched: ['change on a ticket you watch', 'changes on tickets you watch'] };

/** What someone did, with the ticket in the sentence: "assigned you ACME-5301", "mentioned you on ACME-5234", "moved ACME-5122 to QA". */
export function didWhat(e: Pick<JiraAlertEvent, 'what' | 'key'>, key = e.key): string {
  const verb = e.what.split(':')[0];
  if (verb === 'assigned you') return `assigned you ${key}`;
  if (verb.startsWith('mentioned you')) return `${verb} on ${key}`;
  if (verb === 'commented') return `commented on ${key}`;
  return verb.includes(' it ') ? verb.replace(' it ', ` ${key} `) : `${verb} (${key})`;
}

/** A card's (and a notification's) title: "Dana Scully assigned you ACME-5301", or "3 Jira updates". */
export function alertTitle(events: JiraAlertEvent[]): string {
  if (events.length !== 1) return `${events.length} Jira updates`;
  const [e] = events;
  return `${e.who} ${didWhat(e)}`;
}

/** What Cora says: one event in full, several counted, or the catch-up summary. Keys read as words and digits. */
export function spokenJira(events: JiraAlertEvent[], summary?: string): string {
  if (summary) return `${summary}.`;
  const key = (k: string) => k.replace('-', ' ');
  if (events.length === 1) {
    const [e] = events;
    return `${e.who} ${didWhat(e, key(e.key))}: ${e.summary}.`;
  }
  // the most of a kind first
  const kinds = [...new Set(events.map((e) => e.kind))]
    .map((k) => [k, events.filter((e) => e.kind === k).length] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${num(n)} ${NOUN[k][n === 1 ? 0 : 1]}`);
  return `${cap(num(events.length))} Jira updates: ${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds[0]}.`;
}

/** The server's news: the status, the recent events, and new ones told by their level. */
export function applyJira(m: JiraMsg): void {
  useJiraWatch.setState({ status: m.status, ...(m.recent ? { recent: m.recent } : {}) });
  const events = m.events ?? [];
  if (!events.length) return;
  const st = useJiraWatch.getState();
  // a mention or comment marks its ticket until you open it
  const unseen = { ...st.unseen };
  for (const e of events) if (e.kind === 'mentioned' || e.kind === 'commented') unseen[e.key] = e.at;
  // an assignment Cora offers or starts is Cora's to tell (its card, its voice); away, a notification still says it
  const handed = events.filter((e) => e.handoff && (e.level === 'notify' || e.level === 'say'));
  if (handed.length && !attentive()) desktop?.notify(alertTitle(handed), handed.length === 1 ? handed[0].summary : handed.map((e) => e.key).join(', '), '', handed.length === 1 ? handed[0].link : undefined);
  const loud = events.filter((e) => (e.level === 'notify' || e.level === 'say') && !e.handoff);
  const recent = [...events, ...st.recent].slice(0, 50);
  if (!loud.length && !m.summary) return useJiraWatch.setState({ unseen, recent });
  const alert: JiraAlert = { id: `j${Date.now()}${Math.random().toString(36).slice(2, 6)}`, events: loud, ...(m.summary ? { summary: m.summary } : {}), at: Date.now() };
  useJiraWatch.setState({ unseen, recent, alerts: [...st.alerts, alert] });
  setTimeout(() => dismissAlert(alert.id), ALERT_MS);
  if (!attentive() && loud.length) desktop?.notify(m.summary ? 'Jira' : alertTitle(loud), m.summary ?? (loud.length === 1 ? loud[0].summary : loud.map((e) => e.key).join(', ')), '', loud.length === 1 ? loud[0].link : undefined);
  const say = loud.filter((e) => e.level === 'say');
  if ((say.length || (m.summary && events.some((e) => e.level === 'say'))) && useVoice.getState().settings.enabled) void speak(`cora-jira-${alert.id}`, spokenJira(say, m.summary), 400, true);
}

export function dismissAlert(id: string): void {
  useJiraWatch.setState((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
}

/** You've seen the ticket (opened it): its mark goes. */
export function seenTicket(key: string): void {
  const { [key]: _gone, ...rest } = useJiraWatch.getState().unseen;
  useJiraWatch.setState({ unseen: rest });
}

/** Open an event's ticket in Cora's browser: in the session about that ticket, else the one you're looking at. */
export function openJiraEvent(e: Pick<JiraEvent, 'key' | 'link'>): void {
  const b = useBrain.getState();
  const about = Object.values(b.sessions).find((s) => s.ticket?.key === e.key && s.state !== 'ended');
  openInBrowser(e.link, about?.id ?? b.focus ?? undefined);
  seenTicket(e.key);
}

// a notification's click: the ticket it was about
desktop?.onOpenUrl?.((url) => {
  const key = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/.exec(url)?.[1];
  if (key) openJiraEvent({ key, link: url });
});
