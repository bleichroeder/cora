import { create } from 'zustand';
import { isUnread, type InboxItem, type InboxMsg, type InboxSource } from '@cora/shared';
import { useBrain } from './store';
import { useTools } from './tools';
import { openInBrowser } from './browser';
import { slackAppLink } from './slack';
import { desktop } from '../lib/desktop';
import { toolHost } from '../lib/tools';

type State = {
  items: InboxItem[];
  /** the item open in the detail */
  sel: string | null;
  /** when you'd last opened it before now (where "New since you looked" goes) */
  selReadAt: number | null;
  filter: InboxSource | 'all';
  unreadOnly: boolean;
};
export const useInbox = create<State>(() => ({ items: [], sel: null, selReadAt: null, filter: 'all', unreadOnly: false }));

/** When its latest happened (a ticket's comment, an email's date): what the list sorts and groups by. */
export const whenOf = (i: InboxItem) => i.entries[0]?.at ?? i.at;
const newestFirst = (a: InboxItem, b: InboxItem) => whenOf(b) - whenOf(a);

/** The server's news: everything, or what changed and what went. */
export function applyInbox(m: InboxMsg): void {
  const s = useInbox.getState();
  if (m.full) return useInbox.setState({ items: [...m.items].sort(newestFirst) });
  const gone = new Set([...(m.gone ?? []), ...m.items.map((i) => i.id)]);
  useInbox.setState({ items: [...m.items, ...s.items.filter((i) => !gone.has(i.id))].sort(newestFirst) });
}

/** What the list shows: the filter's source, unread only if asked. */
export function shownItems(s: Pick<State, 'items' | 'filter' | 'unreadOnly'>): InboxItem[] {
  return s.items.filter((i) => (s.filter === 'all' || i.source === s.filter) && (!s.unreadOnly || isUnread(i)));
}

const DAY = 86_400_000;
const startOf = (t: number) => new Date(t).setHours(0, 0, 0, 0);
/** Under day headings: Today, Yesterday, the weekday this week, then the date. */
export function dayGroups(items: InboxItem[], now = Date.now()): Array<{ label: string; items: InboxItem[] }> {
  const today = startOf(now);
  const label = (t: number) => {
    const d = startOf(t);
    if (d === today) return 'Today';
    if (d === today - DAY) return 'Yesterday';
    if (today - d < 7 * DAY) return new Date(t).toLocaleDateString('en-US', { weekday: 'long' });
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const out: Array<{ label: string; items: InboxItem[] }> = [];
  for (const i of items) {
    const l = label(whenOf(i));
    if (out.at(-1)?.label === l) out.at(-1)!.items.push(i);
    else out.push({ label: l, items: [i] });
  }
  return out;
}

/** Mark read: here at once, then on the server (every dashboard hears it). */
export function markRead(sel: { ids?: string[]; source?: InboxSource; all?: boolean }): void {
  const now = Date.now();
  const hit = (i: InboxItem) => sel.all || (sel.source && i.source === sel.source) || sel.ids?.includes(i.id);
  useInbox.setState((s) => ({ items: s.items.map((i) => (hit(i) && isUnread(i) ? { ...i, readAt: Math.max(now, i.at) } : i)) }));
  void fetch('/api/inbox/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sel) }).catch(() => {});
}

/** Open one in the detail: where you'd left off is kept for its marker, then it's read. */
export function openItem(id: string): void {
  const it = useInbox.getState().items.find((i) => i.id === id);
  if (!it) return;
  useInbox.setState({ sel: id, selReadAt: it.readAt });
  if (isUnread(it)) markRead({ ids: [id] });
}

export const setFilter = (filter: State['filter']) => useInbox.setState({ filter });
export const setUnreadOnly = (unreadOnly: boolean) => useInbox.setState({ unreadOnly });

/**
 * An Inbox item's page: in your Tool for that site when you have one (Slack, Jira…), else in a browser window of its
 * own. Never a session's browser: the item isn't that session's.
 */
export function openFromInbox(url: string): void {
  const host = toolHost(url);
  const site = (h: string) => h.split('.').slice(-2).join('.');
  const t = (useBrain.getState().prefs?.tools ?? []).find((x) => {
    const th = toolHost(x.url);
    return !!th && !!host && (host === th || site(host) === site(th));
  });
  if (t && desktop?.browser) {
    useBrain.getState().setInbox(false);
    return useTools.getState().show(t.id, /app\.slack\.com/.test(t.url) ? slackAppLink(url) : url);
  }
  // no Tool for its site: Cora's Browser
  if (desktop?.browser) return openInBrowser(url);
  window.open(url, '_blank', 'noopener');
}

/** Open or close the Inbox drawer (it and the Tools drawer open in the same place: one at a time). */
export function setInboxOpen(on: boolean): void {
  if (on) useTools.getState().close();
  useBrain.getState().setInbox(on);
}

/** Show the Inbox (from the nav, or an alert card: `key` opens its item). */
export function showInbox(key?: string): void {
  setInboxOpen(true);
  const it = key ? useInbox.getState().items.find((i) => i.key === key) : undefined;
  if (it) (useInbox.setState({ filter: 'all', unreadOnly: false }), openItem(it.id));
}
