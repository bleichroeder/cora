import { ciRef, ciRepoName, type CiPipeline, type DeployBump, type JiraEvent, type MailHit, type MailWatch } from '@cora/shared';
import type { InboxAdd } from './inbox';

/** What Cora did or asked, as the orchestrator tells it. */
export type CoraTold = { key: string; title: string; text: string; why: string; sessionId?: string; read?: boolean };

const WHY: Record<JiraEvent['kind'], string> = { assigned: 'assigned to you', mentioned: 'you were mentioned', commented: 'a comment on your ticket', status: 'your ticket changed status', watched: 'a ticket you watch' };

/** "QA Team <qa@example.com>" → "QA Team" (or the address). */
export const who = (from: string) => from.replace(/\s*<[^>]+>/, '').replace(/^"|"$/g, '').trim() || from;
export const mailLink = (threadId: string) => `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;

export function fromJira(e: JiraEvent): InboxAdd {
  return { source: 'jira', key: `jira:${e.key}`, title: `${e.key} · ${e.summary}`, why: WHY[e.kind], link: e.link, entry: { id: e.id, who: e.who, text: e.what, at: e.at } };
}

export function fromMail(h: MailHit): InboxAdd {
  return {
    source: 'mail',
    key: `mail:${h.threadId}`,
    title: `${who(h.from)} · ${h.subject || '(no subject)'}`,
    why: h.why && h.why !== 'important' ? `your rule: ${h.why}` : 'Gmail marked it important',
    link: mailLink(h.threadId),
    mailId: h.id,
    entry: { id: h.id, who: who(h.from), text: h.snippet, at: h.at },
  };
}

export function fromWatch(w: Pick<MailWatch, 'about'>, m: MailHit, did: string, sessionId?: string): InboxAdd {
  return { ...fromMail(m), why: `a watch: ${w.about}`, did, ...(sessionId ? { sessionId } : {}) };
}

/** A finished pipeline a session follows (running ones aren't news). */
export function fromPipeline(p: CiPipeline, follower?: { id: string; name: string }): InboxAdd | null {
  if (p.status !== 'success' && p.status !== 'failed') return null;
  const ok = p.status === 'success';
  return {
    source: 'gitlab',
    key: `ci:${p.project}@${p.ref}`,
    title: `${ciRepoName(p.project)} · ${ciRef(p.ref)}`,
    why: follower ? `a pipeline ${follower.name} follows` : 'a pipeline your session follows',
    link: p.url,
    state: ok ? 'ok' : 'failed',
    replace: true,
    ...(follower ? { sessionId: follower.id } : {}),
    entry: { id: `${p.key}:${p.status}`, text: `Pipeline #${p.id} ${ok ? 'passed' : 'failed'}`, at: p.finishedAt ?? p.createdAt },
  };
}

export function fromBump(b: DeployBump, line: string): InboxAdd {
  return {
    source: 'gitlab',
    key: `bump:${b.id}`,
    title: `${ciRepoName(b.project)} · ${b.env} → ${b.tag}`,
    why: 'a bump you started from Cora',
    state: b.state === 'done' ? 'ok' : b.state === 'failed' ? 'failed' : 'running',
    replace: true,
    entry: { id: `${b.id}:${b.state}`, text: line.replace(/^\[Deploys\] /, ''), at: b.doneAt ?? b.at },
  };
}

export function fromCora(t: CoraTold): InboxAdd {
  return { source: 'cora', key: `cora:${t.key}`, title: t.title, why: t.why, ...(t.sessionId ? { sessionId: t.sessionId } : {}), ...(t.read ? { read: true } : {}), entry: { id: `${t.key}:${t.text}`.slice(0, 200), text: t.text, at: Date.now() } };
}
