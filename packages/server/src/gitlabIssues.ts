import { homedir } from 'node:os';
import type { GitlabIssue } from '@cora/shared';
import { classify, findGlab, json, nodeExec, type Exec } from './ci';
import { parseRemote, parseRemotes } from './ciRefs';
import { gitlabHost } from './gitlabHost';

/** GitLab as Cora reaches it: signed in (as whom), or why not. */
export type GitlabStatus = { state: 'connected' | 'signed-out' | 'no-glab' | 'offline' | 'error'; host: string; user?: string; name?: string; error?: string };

/** A GitLab issue from glab's API (an issue in the list, or one read on its own). Null: not an issue. */
export function toIssue(x: any): GitlabIssue | null {
  if (!x || typeof x !== 'object' || typeof x.iid !== 'number' || typeof x.web_url !== 'string') return null;
  const project = String(x.references?.full ?? '').replace(/#\d+$/, '') || (/^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/\d+/.exec(x.web_url)?.[1] ?? '');
  if (!project) return null;
  const at = typeof x.updated_at === 'string' ? Date.parse(x.updated_at) : NaN;
  return {
    project,
    iid: x.iid,
    title: String(x.title ?? ''),
    url: x.web_url,
    state: String(x.state ?? ''),
    labels: Array.isArray(x.labels) ? x.labels.map(String) : [],
    ...(typeof x.description === 'string' && x.description.trim() ? { description: x.description } : {}),
    ...(x.author?.name || x.author?.username ? { author: String(x.author.name ?? x.author.username) } : {}),
    ...(Array.isArray(x.assignees) && x.assignees.length ? { assignees: x.assignees.map((a: any) => String(a?.name ?? a?.username ?? '')).filter(Boolean) } : {}),
    ...(x.milestone?.title ? { milestone: String(x.milestone.title) } : {}),
    ...(Number.isFinite(at) ? { updatedAt: at } : {}),
  };
}

/**
 * GitLab issues for starting sessions, read with `glab api` (GET only: Cora never changes an issue): the open ones
 * assigned to you, one by its project and number, and which of your folders is a checkout of an issue's project.
 */
export class GitlabIssues {
  private onPath = true;
  private glabPath = 'glab';
  constructor(private exec: Exec = nodeExec) {}

  private async glab(args: string[]): Promise<string> {
    const env = { ...process.env, GLAB_CHECK_UPDATE: 'false', NO_COLOR: '1', GLAB_NO_PROMPT: 'true' };
    const run = (file: string) => this.exec(file, [...args.slice(0, 1), '--hostname', gitlabHost(), ...args.slice(1)], { timeout: 30_000, env, cwd: homedir(), maxBuffer: 16 * 1024 * 1024 });
    try {
      return (await run(this.onPath ? 'glab' : this.glabPath)).stdout;
    } catch (e: any) {
      if (e?.code !== 'ENOENT' || !this.onPath) throw e;
      this.onPath = false;
      this.glabPath = findGlab();
      return (await run(this.glabPath)).stdout;
    }
  }

  private who: { at: number; host: string; v: GitlabStatus } | null = null;
  /** Who glab is signed in as on Cora's GitLab (Settings › GitLab says "connected"): asked at most once a minute. */
  async status(force = false): Promise<GitlabStatus> {
    const host = gitlabHost();
    if (!force && this.who && this.who.host === host && Date.now() - this.who.at < 60_000) return this.who.v;
    let v: GitlabStatus;
    try {
      const u = json(await this.glab(['api', 'user'])) as { username?: string; name?: string };
      v = { state: 'connected', host, ...(u.username ? { user: u.username } : {}), ...(u.name ? { name: u.name } : {}) };
    } catch (e) {
      const g = classify(e);
      v = { state: g.kind === 'no-glab' || g.kind === 'signed-out' || g.kind === 'offline' ? g.kind : 'error', host, error: g.message };
    }
    this.who = { at: Date.now(), host, v };
    return v;
  }

  /** Your open issues (assigned to you, in every project), most recently updated first. */
  async mine(): Promise<{ ok: true; issues: GitlabIssue[] } | { ok: false; kind: string; error: string }> {
    try {
      const list = json(await this.glab(['api', 'issues?scope=assigned_to_me&state=opened&order_by=updated_at&per_page=50'])) as unknown[];
      return { ok: true, issues: list.map(toIssue).filter((i): i is GitlabIssue => !!i) };
    } catch (e) {
      const g = classify(e);
      return { ok: false, kind: g.kind, error: g.message };
    }
  }

  /** One issue, with its description. */
  async one(project: string, iid: number): Promise<{ ok: true; issue: GitlabIssue } | { ok: false; kind: string; error: string }> {
    try {
      const i = toIssue(json(await this.glab(['api', `projects/${encodeURIComponent(project)}/issues/${iid}`])));
      return i ? { ok: true, issue: i } : { ok: false, kind: 'missing', error: 'not an issue' };
    } catch (e) {
      const g = classify(e);
      return { ok: false, kind: g.kind, error: g.kind === 'missing' ? `There's no issue ${project}#${iid} you can see.` : g.message };
    }
  }

  /** The first of these folders that's a checkout of the project (a remote on Cora's GitLab with its path). */
  async folderFor(project: string, folders: string[]): Promise<string | null> {
    const want = project.toLowerCase();
    for (const f of folders.slice(0, 20)) {
      try {
        const out = (await this.exec('git', ['-C', f, 'remote', '-v'], { timeout: 5000 })).stdout;
        for (const url of Object.values(parseRemotes(out))) {
          const r = parseRemote(url);
          if (r && r.host === gitlabHost().toLowerCase() && r.project.toLowerCase() === want) return f;
        }
      } catch {
        /* not a git folder, or gone */
      }
    }
    return null;
  }
}
