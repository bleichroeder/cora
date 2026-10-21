import { seenTicket, useJiraWatch } from '../state/jiraWatch';
import { useEffect, useState } from 'react';
import type { SlackTalk } from '@cora/shared';
import { slackAppLink, ticketTalk, useSlack } from '../state/slack';
import { useBrain } from '../state/store';
import { useTools } from '../state/tools';
import { slackTool } from '../lib/tools';
import { desktop } from '../lib/desktop';
import { issueUrl, type SessionInfo } from '@cora/shared';
import { jiraSite, lookupIssue, useJira, useJiraIssue } from '../state/jira';
import { Avatar, MISS, openInBrowser, typeIcon } from './JiraChip';
import { Icon } from './Icon';

/**
 * The ticket a session is about, in its header: key, summary, status, assignee, priority, live from the lookup
 * cache (looked at again every minute and when the window comes back). Click: the ticket in the session's browser
 * (Ctrl/Shift+click: your own browser), the way a chip opens. Signed out, it keeps the summary it last had and says
 * "sign in".
 */
export function TicketCard({ s }: { s: SessionInfo }) {
  const t = s.ticket!;
  const site = useJira((st) => t.site || jiraSite(st));
  const r = useJiraIssue(t.key, t.site ?? undefined);
  useEffect(() => {
    const again = () => void lookupIssue(t.key, { site: t.site ?? undefined });
    const timer = setInterval(again, 60_000);
    window.addEventListener('focus', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
    };
  }, [t.key, t.site]);
  const i = r?.ok ? r.value : null;
  const url = i?.url ?? (site ? issueUrl(site, t.key) : '');
  const state = !r ? 'loading' : r.ok ? r.value.status.category : r.error;
  const pill = !r ? '…' : r.ok ? r.value.status.name : MISS[r.error];
  const summary = i?.summary || t.summary;
  // a new mention or comment on it (Cora watching Jira), until you open it
  const fresh = useJiraWatch((st) => !!st.unseen[t.key]);
  const open = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (url) openInBrowser(url, s.id, e.ctrlKey || e.metaKey || e.shiftKey);
    seenTicket(t.key);
  };
  const tip = [
    `${t.key}${summary ? ` · ${summary}` : ''}`,
    i ? [i.status.name, i.type?.name, i.priority && `${i.priority.name} priority`, i.assignee ? `assigned to ${i.assignee.name}` : 'unassigned'].filter(Boolean).join(' · ') : r && !r.ok && r.error === 'signed-out' ? "Signed out of Jira: sign in in Cora's browser" : '',
    fresh ? 'New: a mention or comment since you last opened it' : '',
    url ? 'Click to open it (Ctrl+click: your browser)' : '',
  ].filter(Boolean).join('\n');

  return (
    <span className={`tcard j-${state}`} role="link" tabIndex={0} title={tip} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open(e)}>
      {i?.type ? <Icon name={typeIcon(i.type)} size={13} /> : <Icon name="Ticket" size={13} />}
      <span className="tk">{t.key}</span>
      {pill ? <span className={`tst j-${state}`}>{pill}</span> : null}
      {i?.assignee ? <Avatar name={i.assignee.name} url={i.assignee.avatarUrl} /> : null}
      {fresh ? <i className="tc-new" title="A new mention or comment" /> : null}
    </span>
  );
}

/**
 * Where the session's ticket comes up in Slack: a quiet count beside its card (hover: the conversations; click: the
 * newest one in the Slack tool). Nothing when Slack isn't connected, can't search, or the ticket isn't mentioned.
 */
export function TicketSlack({ ticketKey }: { ticketKey: string }) {
  const can = useSlack((s) => s.status.connected && s.status.search !== false);
  const tools = useBrain((s) => s.prefs.tools);
  const [talk, setTalk] = useState<SlackTalk[]>([]);
  useEffect(() => {
    if (!can) return setTalk([]);
    let live = true;
    void ticketTalk(ticketKey).then((t) => live && setTalk(t));
    return () => {
      live = false;
    };
  }, [ticketKey, can]);
  if (!talk.length) return null;
  const total = talk.reduce((n, g) => n + g.count, 0);
  const newest = [...talk].sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  const open = () => {
    const slack = slackTool(tools);
    if (slack && desktop?.browser) useTools.getState().show(slack.id, slackAppLink(newest.link));
    else window.open(newest.link, '_blank', 'noopener');
  };
  return (
    <button className="tslack" onClick={open} title={`${ticketKey} in Slack:\n${talk.map((g) => `${g.where} · ${g.count}`).join('\n')}\nClick: the newest, in Slack`}>
      <Icon name="MessageSquare" size={13} />
      <span>{total}</span>
    </button>
  );
}
