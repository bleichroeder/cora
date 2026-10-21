import type { JiraEvent, JiraEventKind, WatchedIssue } from './jiraWatch';

/** Stronger first: a change that fits two kinds is told as the stronger. */
const RANK: Record<JiraEventKind, number> = { assigned: 5, mentioned: 4, status: 3, commented: 2, watched: 1 };

/** ADF (Jira's rich text) as plain text: text as is, mentions as their @name, whitespace squeezed. */
export function adfText(node: any): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    else if (n.type === 'mention') out.push(String(n.attrs?.text ?? '@someone'));
    else if (n.type === 'hardBreak') out.push(' ');
    for (const c of Array.isArray(n.content) ? n.content : []) walk(c);
    if (n.type === 'paragraph' || n.type === 'listItem') out.push(' ');
  };
  walk(node);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Does this ADF mention the account? */
export function adfMentions(node: any, accountId: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'mention' && node.attrs?.id === accountId) return true;
  return (Array.isArray(node.content) ? node.content : []).some((c: any) => adfMentions(c, accountId));
}

/**
 * What happened in these issues after `since` that you'd want to know (not your own doing): assigned to you,
 * mentioned, comments and status changes on your tickets, changes on tickets you watch. Oldest first.
 */
export function jiraEvents(o: { site: string; me: string; since: number; issues: WatchedIssue[] }): JiraEvent[] {
  const out = new Map<string, JiraEvent>();
  const put = (e: JiraEvent) => {
    const had = out.get(e.id);
    if (!had || RANK[e.kind] > RANK[had.kind]) out.set(e.id, e);
  };
  for (const i of o.issues) {
    const f = i.fields ?? {};
    const mine = i.from.includes('mine') || f.assignee?.accountId === o.me;
    const watched = !mine && i.from.includes('watched');
    const base = `https://${o.site}/browse/${i.key}`;
    const ev = (thing: string, kind: JiraEventKind, who: string, what: string, at: number, link = base): JiraEvent => ({
      id: `${i.key}:${thing}`,
      kind,
      key: i.key,
      summary: String(f.summary ?? ''),
      who,
      what,
      at,
      link,
    });
    // a ticket created already in your name (no assignee change to see)
    const created = Date.parse(f.created ?? '');
    if (created > o.since && f.assignee?.accountId === o.me && f.reporter?.accountId !== o.me) put(ev('created', 'assigned', String(f.reporter?.displayName ?? 'Someone'), 'assigned you', created));
    for (const h of i.changelog?.histories ?? []) {
      const at = Date.parse(h.created ?? '');
      if (!(at > o.since) || h.author?.accountId === o.me) continue;
      const who = String(h.author?.displayName ?? 'Someone');
      for (const it of h.items ?? []) {
        if (it.field === 'assignee' && it.to === o.me) put(ev(`h${h.id}`, 'assigned', who, 'assigned you', at));
        else if (it.field === 'status' && (mine || watched)) put(ev(`h${h.id}`, mine ? 'status' : 'watched', who, `moved it to ${it.toString ?? '?'}`, at));
        else if (it.field === 'description' && adfMentions(f.description, o.me)) put(ev(`h${h.id}`, 'mentioned', who, 'mentioned you in the description', at));
      }
    }
    for (const c of i.comments ?? []) {
      const at = Date.parse(c.updated ?? c.created ?? '');
      if (!(at > o.since) || c.author?.accountId === o.me) continue;
      const who = String(c.author?.displayName ?? 'Someone');
      const text = adfText(c.body).slice(0, 200);
      const link = `${base}?focusedCommentId=${c.id}`;
      if (adfMentions(c.body, o.me)) put(ev(`c${c.id}`, 'mentioned', who, `mentioned you: ${text}`, at, link));
      else if (mine) put(ev(`c${c.id}`, 'commented', who, `commented: ${text}`, at, link));
      else if (watched) put(ev(`c${c.id}`, 'watched', who, `commented: ${text}`, at, link));
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}
