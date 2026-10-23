import { ISSUE_KEY_RE, jiraLink, type SessionInfo } from '@cora/shared';
import { plainName, sessionName } from './format';

/**
 * What was pasted into the New session dialog's ticket box: a key (any case: "acme-5206"), or a Jira link
 * (/browse/KEY, ?selectedIssue=KEY, …/issues/KEY) on a Cloud host or the configured site. Null: not a ticket.
 */
export function parseTicketInput(text: string, site?: string | null): { key: string; site?: string } | null {
  const t = text.trim().replace(/^<|>$/g, '');
  if (!t) return null;
  if (ISSUE_KEY_RE.test(t.toUpperCase())) return { key: t.toUpperCase() };
  const l = jiraLink(/^https?:\/\//i.test(t) ? t.replace(/^http:/i, 'https:') : `https://${t}`, site);
  return l ? { key: l.key, ...(l.site ? { site: l.site } : {}) } : null;
}

/**
 * A session's label in the list: its ticket's key (shown as a chip) and the rest of the name. Named after the ticket,
 * the rest is the summary; otherwise it's the name (your alias, the auto name…). When the name already has the key
 * in it, there's no separate chip: the name's own chip is the one.
 */
export function ticketLabel(s: Pick<SessionInfo, 'id' | 'alias' | 'autoName' | 'title' | 'project' | 'ticket' | 'issue'>): { key: string | null; text: string } {
  const t = s.ticket;
  // about a GitLab issue: named after it (its chip beside the folder says which)
  if (!t) return { key: null, text: !s.alias && s.issue?.title ? s.issue.title : sessionName(s) };
  const text = !s.alias && t.summary ? t.summary : plainName(s);
  return new RegExp(`(^|[^A-Z0-9_-])${t.key}(?![0-9])`).test(text) ? { key: null, text } : { key: t.key, text };
}
