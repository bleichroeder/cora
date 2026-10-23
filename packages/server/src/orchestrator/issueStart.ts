import { existsSync, readFileSync } from 'node:fs';
import { coraIssuePrompt, issueRef, type GitlabIssue, type GitlabTodo, type IssueStartMode, type SessionInfo, type StartFolder } from '@cora/shared';
import type { Approvals } from './approvals';
import { writeFileAtomic } from '../fsx';

/** What starting work on a GitLab issue needs (each a small function, so tests can fake them). */
export type IssueStartDeps = {
  mode(): IssueStartMode;
  sessions(): SessionInfo[];
  isDir(p: string): boolean;
  /** the first of these folders that's a checkout of the project */
  folderFor(project: string, folders: string[]): Promise<string | null>;
  /** the issue as glab reads it (null: it couldn't) */
  issue(project: string, iid: number): Promise<GitlabIssue | null>;
  approvals: Pick<Approvals, 'request' | 'list'>;
  /** `plan`: in plan mode (it can read and plan, not change anything, until the user approves) */
  launch(o: { cwd: string; prompt: string; trust: boolean; plan?: boolean }): Promise<{ terminal: { sessionId: string }; sent: boolean; why?: string; pending?: boolean }>;
  /** the user's prompts a session has (its first, the issue prompt, is Cora's) */
  prompts(sessionId: string): number;
  focus(sessionId: string): void;
  note(line: string): void;
  changed(): void;
  started?(r: IssueStarted): void;
  file?: string;
  now?(): number;
};
export type IssueStarted = { sessionId: string; project: string; iid: number; title: string; cwd: string; at: number; auto: boolean };

/** "On its own" starts at most this many before it offers instead (as Jira's). */
export const MAX_WAITING = 2;
const KEEP_MS = 14 * 86_400_000;
const STARTING_MS = 5 * 60_000;
const MAX_FOLDERS = 6;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const baseOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
const same = (a: { project: string; iid: number }, b: { project: string; iid: number }) => a.project.toLowerCase() === b.project.toLowerCase() && a.iid === b.iid;

/**
 * Starting work on a GitLab issue assigned to you (its `assigned` to-do). Unlike Jira's, nothing needs Cora's agent:
 * the folder is your checkout of the issue's project (its git remote), else where that project's issues ran, else
 * a recent folder. Then by Settings › GitLab: a card for you (Start in <folder> ▾ · Not now), or (on its own, at most
 * 2 waiting, and only in a checkout of its project) a session started in plan mode that sums the issue up and
 * diagnoses it. Never twice for one issue.
 */
export class IssueStarts {
  private rec: IssueStarted[] = [];
  constructor(private d: IssueStartDeps) {
    try {
      if (d.file && existsSync(d.file)) this.rec = (JSON.parse(readFileSync(d.file, 'utf8')) as IssueStarted[]).filter((r) => r && typeof r.sessionId === 'string');
    } catch {
      /* start afresh */
    }
  }

  private now = () => this.d.now?.() ?? Date.now();
  private save() {
    try {
      if (this.d.file) writeFileAtomic(this.d.file, JSON.stringify(this.rec));
    } catch {
      /* not kept */
    }
  }

  /** Where it could start: your checkout of its project first, then where its project's issues ran, then recent. */
  async folders(project: string): Promise<StartFolder[]> {
    const out: StartFolder[] = [];
    const add = (cwd: string, why: string) => {
      if (out.length < MAX_FOLDERS && cwd && !out.some((f) => norm(f.cwd) === norm(cwd)) && this.d.isDir(cwd)) out.push({ cwd, why });
    };
    const sessions = [...this.d.sessions()].sort((a, b) => b.lastTs - a.lastTs);
    const recent = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
    const checkout = await this.d.folderFor(project, recent).catch(() => null);
    if (checkout) add(checkout, `your checkout of ${project.split('/').pop()}`);
    for (const s of sessions) if (s.issue && s.issue.project.toLowerCase() === project.toLowerCase()) add(s.cwd, `its project's issues ran here`);
    for (const c of recent) add(c, 'recent');
    return out;
  }

  /** A session already on it, a start already offered, or one it started: nothing more to do. */
  private known(i: { project: string; iid: number }): boolean {
    return (
      this.d.sessions().some((s) => s.issue && same(s.issue, i)) ||
      this.d.approvals.list().some((a) => a.ticket?.source === 'gitlab' && a.ticket.key === issueRef(i)) ||
      this.started().some((r) => same(r, i))
    );
  }

  /** New GitLab to-dos: the issues assigned to you are offered or started (by the setting). */
  async todos(list: GitlabTodo[]): Promise<void> {
    if (this.d.mode() === 'tell') return;
    for (const t of list) {
      const iid = Number(/^#(\d+)$/.exec(t.ref)?.[1]);
      if (t.action !== 'assigned' || t.type !== 'Issue' || !iid) continue;
      await this.offer({ project: t.project, iid, title: t.title, who: t.who, url: t.link }).catch((e) => this.d.note(`Couldn't offer ${t.project}${t.ref}: ${(e as Error).message}`));
    }
  }

  private async offer(i: { project: string; iid: number; title: string; who: string; url: string }): Promise<void> {
    if (this.known(i)) return;
    const folders = await this.folders(i.project);
    if (!folders.length) return void this.d.note(`[GitLab] ${issueRef(i)} is assigned to the user, but no folder to start it in is known (it's in the Inbox).`);
    const cwd = folders[0].cwd;
    const checkout = folders[0].why.startsWith('your checkout');
    let reason: string | undefined;
    if (this.d.mode() === 'auto') {
      if (!checkout) reason = `none of your folders is a checkout of ${i.project}, so it's yours to start`;
      else if (this.waiting() >= MAX_WAITING) reason = `${this.waiting()} issues Cora started are waiting on you, so this one is yours to start`;
      else {
        try {
          return void (await this.go(i, cwd, true));
        } catch (e) {
          reason = `It couldn't start: ${(e as Error).message}`;
        }
      }
    }
    void this.d.approvals.request(
      { kind: 'start', title: `Start #${i.iid} in ${baseOf(cwd)}`, detail: reason ?? folders[0].why, cwd, ticket: { key: issueRef(i), summary: i.title, who: i.who, source: 'gitlab' }, folders },
      (_t, _late, chosen) => this.go(i, chosen ?? cwd, false),
      { do: 'issue', project: i.project, iid: i.iid, title: i.title, who: i.who, url: i.url, cwd },
    );
  }

  /** A kept card's OK, after a restart: start it there, as the card would have. */
  startFromCard(i: { project: string; iid: number; title: string; url: string }, cwd: string): Promise<string> {
    return this.go(i, cwd, false);
  }

  /** Start it: Cora's issue prompt (the issue as glab reads it now) in that folder, remembered. */
  private async go(i: { project: string; iid: number; title: string; url: string }, cwd: string, auto: boolean): Promise<string> {
    const issue = (await this.d.issue(i.project, i.iid).catch(() => null)) ?? { project: i.project, iid: i.iid, title: i.title, url: i.url, state: 'opened', labels: [] };
    // started on its own: in plan mode, so nothing changes until the user approves its plan
    const r = await this.d.launch({ cwd, prompt: coraIssuePrompt(issue), trust: true, ...(auto ? { plan: true } : {}) });
    const sid = r.terminal.sessionId;
    const now = this.now();
    this.rec = [{ sessionId: sid, project: i.project, iid: i.iid, title: issue.title, cwd, at: now, auto }, ...this.rec.filter((x) => now - x.at < KEEP_MS)];
    this.save();
    this.d.started?.(this.rec[0]);
    this.d.changed();
    if (!auto) this.d.focus(sid);
    const tail = r.pending ? " It's still starting; its prompt goes in when it's ready." : r.sent ? '' : ` Its prompt didn't go in: ${r.why}.`;
    return `Started ${issueRef(i)} in ${cwd} (id ${sid}).${tail}`;
  }

  /** What it started (the last 14 days, newest first). */
  started(): IssueStarted[] {
    const now = this.now();
    return this.rec.filter((r) => now - r.at < KEEP_MS);
  }

  /** Started sessions waiting on the user: not ended, nothing typed by them since. */
  waiting(): number {
    const now = this.now();
    const sessions = this.d.sessions();
    return this.started().filter((r) => {
      const s = sessions.find((x) => x.id === r.sessionId);
      return s ? s.state !== 'ended' && this.d.prompts(r.sessionId) <= 1 : now - r.at < STARTING_MS;
    }).length;
  }
}
