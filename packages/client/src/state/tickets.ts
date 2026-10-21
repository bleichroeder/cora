import { useEffect } from 'react';
import type { SessionInfo } from '@cora/shared';
import { isDismissed } from '../lib/format';
import { useBrain } from './store';
import { jiraAvailable, lookupIssue, useJira } from './jira';

/**
 * Sessions about a Jira ticket (SessionInfo.ticket, found by the server): the UI is what can ask Jira, so it tells
 * the server the ticket's summary when it learns it (the session is named after it, signed out or not), and which
 * projects the site has (bare keys of those in a first prompt are tickets).
 */

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const WEEK = 7 * 86400_000;
/** what was last sent for a session ("KEY summary"), so a lookup that changes nothing sends nothing */
const sent = new Map<string, string>();

/** Sessions whose ticket's summary is worth looking up: not known yet, or (while it's live) maybe renamed. */
const wanted = (s: SessionInfo, now: number) => !!s.ticket && !isDismissed(s) && (s.ticket.summary == null ? now - s.lastTs < WEEK : s.state !== 'ended');

async function syncSummaries() {
  if (!jiraAvailable() || useJira.getState().auth === 'signed-out') return;
  const now = Date.now();
  for (const s of Object.values(useBrain.getState().sessions)) {
    if (!wanted(s, now)) continue;
    const t = s.ticket!;
    void lookupIssue(t.key, { site: t.site ?? undefined }).then((r) => {
      if (!r.ok || !r.value.summary || r.value.summary === t.summary || sent.get(s.id) === `${t.key} ${r.value.summary}`) return;
      sent.set(s.id, `${t.key} ${r.value.summary}`);
      void post(`/api/sessions/${encodeURIComponent(s.id)}/meta`, { ticketSummary: { key: t.key, summary: r.value.summary } })
        .then(async (res) => res.ok && useBrain.getState().upsertSession(await res.json()))
        .catch(() => sent.delete(s.id));
    });
  }
}

let lastProjects = '';
function syncProjects() {
  const { projects, seen } = useJira.getState();
  const all = [...new Set([...projects, ...seen])].sort();
  const sig = all.join(',');
  if (!jiraAvailable() || !all.length || sig === lastProjects) return;
  lastProjects = sig;
  void post('/api/jira/projects', { projects: all }).catch(() => (lastProjects = ''));
}

/** Keeps the server's tickets in step: summaries as they're learned, the site's projects as they change. */
export function useTicketSync() {
  // which sessions have which tickets (not every session update: they come with every event)
  const sig = useBrain((st) =>
    Object.values(st.sessions)
      .filter((s) => s.ticket)
      .map((s) => `${s.id}:${s.ticket!.key}:${s.ticket!.summary ?? ''}:${s.state === 'ended' ? 1 : 0}`)
      .join('|'),
  );
  const auth = useJira((st) => st.auth);
  useEffect(() => void syncSummaries(), [sig, auth]);
  useEffect(() => {
    const t = setInterval(() => void syncSummaries(), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    syncProjects();
    return useJira.subscribe((st, prev) => (st.projects !== prev.projects || st.seen !== prev.seen) && syncProjects());
  }, []);
}
