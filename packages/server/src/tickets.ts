import { readFileSync } from 'node:fs';
import { ISSUE_KEY_RE, isJiraHost, issueInPrompt, issueTitleInPrompt, ticketInPrompt, type SessionIssue, type SessionTicket } from '@cora/shared';
import type { Store } from './store';
import { writeFileAtomic } from './fsx';

/** A Jira project key (what's before the dash of ACME-5206). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

/** A ticket from a launch or the API: a key, a Jira host when known, a summary when known (all checked). */
export function checkTicket(t: { key?: unknown; site?: unknown; summary?: unknown }): SessionTicket {
  const key = String(t.key ?? '').trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) throw new Error('ticket must be an issue key like PROJ-123');
  const site = t.site == null || t.site === '' ? null : String(t.site).toLowerCase();
  if (site && !isJiraHost(site)) throw new Error('ticket site must be a host name');
  return { key, site, summary: checkSummary(t.summary) };
}

export function checkSummary(s: unknown): string | null {
  if (s == null || s === '') return null;
  if (typeof s !== 'string') throw new Error('summary must be a string');
  return s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300) || null;
}

/**
 * Which Jira ticket each session is about. Started from one in Cora, it's set at launch; otherwise it's found in the
 * session's first prompt (`/jira KEY`, a Jira link, or a key of one of the site's projects), however the session was
 * started. The site's project keys come from the UI (it's the one signed in to Jira) and are kept here, so bare
 * keys are recognised before any window is open. Set once: a cleared ticket (null) stays cleared.
 */
export class Tickets {
  private projects = new Set<string>();

  constructor(private o: { path: string | null; store: Store; set(sessionId: string, t: SessionTicket): void; setIssue?(sessionId: string, i: SessionIssue): void; gitlabHost?(): string }) {
    try {
      if (o.path) for (const k of JSON.parse(readFileSync(o.path, 'utf8')).projects ?? []) if (PROJECT_KEY_RE.test(k)) this.projects.add(k);
    } catch {
      /* none saved yet */
    }
  }

  knownProjects(): string[] {
    return [...this.projects].sort();
  }

  private known = (p: string) => this.projects.has(p);

  /**
   * The site's projects, from the UI. Sessions whose first prompt named a ticket of a project only now known get
   * it. Returns how many did.
   */
  setProjects(keys: string[]): number {
    const next = new Set(keys.filter((k) => PROJECT_KEY_RE.test(k)));
    const added = [...next].filter((k) => !this.projects.has(k));
    if (!added.length && next.size === this.projects.size) return 0;
    this.projects = next;
    try {
      if (this.o.path) writeFileAtomic(this.o.path, JSON.stringify({ projects: this.knownProjects() }, null, 2) + '\n');
    } catch (e) {
      console.error('[cora] could not save Jira projects', (e as Error).message);
    }
    if (!added.length) return 0;
    let n = 0;
    for (const s of this.o.store.listSessions()) {
      if (s.ticket !== undefined) continue;
      const first = this.o.store.firstPrompt(s.id);
      const t = first?.text ? ticketInPrompt(first.text, (p) => added.includes(p)) : null;
      if (t) {
        this.o.set(s.id, { key: t.key, site: t.site ?? null, summary: null });
        n++;
      }
    }
    return n;
  }

  /**
   * A main-agent prompt (or a slash command read from the transcript) was recorded. When it's the session's first
   * and names a ticket, and the session has none yet (nor had one cleared), that's its ticket.
   */
  consider(sessionId: string, text: string | undefined, ts: number, id?: string): SessionTicket | null {
    if (!text) return null;
    const s = this.o.store.getSession(sessionId);
    if (!s || s.ticket !== undefined) return null;
    const first = this.o.store.firstPrompt(sessionId);
    if (first && first.id !== id && first.ts < ts) return null;
    this.considerIssue(sessionId, text);
    const t = ticketInPrompt(text, this.known);
    if (!t) return null;
    const ticket = { key: t.key, site: t.site ?? null, summary: null };
    this.o.set(sessionId, ticket);
    return ticket;
  }

  /** The session's first message links to a GitLab issue (Cora's issue prompt does): that's its issue. */
  private considerIssue(sessionId: string, text: string): void {
    const host = this.o.gitlabHost?.();
    if (!host || !this.o.setIssue || this.o.store.getSession(sessionId)?.issue !== undefined) return;
    const i = issueInPrompt(text, host);
    if (i) this.o.setIssue(sessionId, { project: i.project, iid: i.iid, url: i.url, title: issueTitleInPrompt(text) });
  }
}
