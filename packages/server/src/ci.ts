import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ciActive, ciFinished, groupStages, type BrainEvent, type CiHealth, type CiJob, type CiLink, type CiMsg, type CiPipeline, type CiStatus, type CiWhy, type SessionInfo } from '@cora/shared';
import { CI_TOOLS, commandRefs, ownedRefs, parseRemotes, pickProject, splitUpstream, traceTail } from './ciRefs';
import { gitlabHost } from './gitlabHost';

/**
 * GitLab pipelines for live sessions, read with `glab api` (GET only). One poller for everything:
 *  - each live session follows its branch's latest pipeline (its MR's, when it has one), checked every couple of
 *    minutes, and soon and often after something that may start one (a push, `glab ci run`, `glab mr create`).
 *    Only a branch it works on, though: one it committed to, pushed, created or ran a pipeline on (sessions sharing
 *    a folder share its checkout, and another session's branch isn't this one's news);
 *  - pipelines its commands start or look at (links in their output, `glab ci …` with ids or branches);
 *  - a pipeline that's on its way is read with its jobs every few seconds until it finishes, then left alone.
 * Sessions on the same repo and branch share the reads; a few glab processes at most run at once; nothing is read
 * while no dashboard is open. glab missing, signed out or offline is one line of state, not a crash or a log flood.
 */

export const RUN_MS = 8_000;
/** parked pipelines (waiting on a manual job, scheduled) */
const PARKED_MS = 60_000;
const IDLE_MS = 120_000;
/** after a push (or similar): look again this soon, then this often until a new pipeline shows up */
const KICKS = [3_000, 8_000, 15_000, 30_000, 60_000];
const MR_TTL = 10 * 60_000;
const REPO_TTL = 90_000;
const NO_REPO_TTL = 10 * 60_000;
/** another branch a command asked about (or pushed to) is followed this long */
const EXTRA_TTL = 30 * 60_000;
/** pipelines a session looked at stay on its list this long (newest few) */
const REF_TTL = 6 * 3600_000;
const MAX_REFS = 5;
const MAX_CONC = 3;
const PAUSE_MS = 5 * 60_000;
/** history replayed at startup isn't something to follow now */
const FRESH_MS = 5 * 60_000;
/** ...except a session's own last hour, read back when the watcher starts following it (a restart forgets) */
const REPLAY_MS = 60 * 60_000;

export type Exec = (file: string, args: string[], o: { cwd?: string; timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

export const nodeExec: Exec = (file, args, o) =>
  new Promise((res, rej) => {
    execFile(file, args, { ...o, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) rej(Object.assign(err, { stdout, stderr }));
      else res({ stdout, stderr });
    });
  });

export type CiDeps = {
  publish(m: CiMsg): void;
  hasClients(): boolean;
  /** sessions as stored (the watcher keeps the live ones) */
  sessions(): SessionInfo[];
  /** a session's stored events since a time (to pick up what it pushed or looked at before a restart) */
  recent?(sessionId: string, since: number): BrainEvent[];
  /** a session's stored commands that may commit, push or create a branch (which branches it works on) */
  gitWork?(sessionId: string): BrainEvent[];
  exec?: Exec;
  /** glab's path (found on PATH or in its usual install folder otherwise) */
  glab?: string;
  now?: () => number;
  log?: (m: string) => void;
};

/** `branch`: what it pushes to (its upstream's name, else its own); `head`: the local branch's name */
type Repo = { project: string; branch: string | null; head?: string };
type Detect = { at: number; repo: Repo | null; busy?: Promise<Repo | null> };
type Branch = {
  project: string;
  ref: string;
  subs: Map<string, { why: CiWhy; until: number }>;
  latest?: string;
  due: number;
  kicks: number[];
  /** a pipeline newer than this one is what the kick was waiting for */
  kickBase?: number;
  kickWhy?: CiWhy;
  kickAt?: number;
  mr?: { iid: number | null; at: number };
  fails: number;
  busy?: boolean;
};
type Pipe = { project: string; id: number; due: number; fails: number; data?: CiPipeline; json?: string; busy?: boolean; done?: boolean; /** from the branch's list, before it's read */ created?: number };
type Link = { sid: string; cwd: string; repo: Repo | null; refs: Map<string, { why: CiWhy; at: number; branch?: string }>; activeAt: number; /** branches it works on */ owned: Set<string> };

/** A pipeline listed for several reasons keeps the strongest. */
const WHY_RANK: Record<CiWhy, number> = { branch: 0, url: 1, command: 2, push: 3 };

export class GlabError extends Error {
  constructor(public kind: CiHealth['state'] | 'missing', message: string) {
    super(message);
  }
}

/** What a failed glab run means: no glab, signed out, the thing isn't there (or isn't ours), offline, or something else. */
export function classify(err: any): GlabError {
  const text = `${err?.stderr ?? ''}\n${err?.message ?? ''}`;
  if (err?.code === 'ENOENT') return new GlabError('no-glab', 'glab is not installed (or not on PATH)');
  if (/\b401\b|unauthori[sz]ed|not logged in|glab auth login|token.*(invalid|expired)/i.test(text)) return new GlabError('signed-out', `glab is not signed in to ${gitlabHost()} (run \`glab auth login${gitlabHost() === 'gitlab.com' ? '' : ` --hostname ${gitlabHost()}`}\`)`);
  if (/\b40[34]\b|not found/i.test(text)) return new GlabError('missing', 'not found');
  if (err?.killed || /ENOTFOUND|EAI_AGAIN|ECONNRE|ETIMEDOUT|dial tcp|no such host|i\/o timeout|timeout|connection (refused|reset)|network is unreachable|TLS handshake/i.test(text)) return new GlabError('offline', `can't reach ${gitlabHost()}`);
  const line = String(err?.stderr || err?.message || 'glab failed').split(/\r?\n/).find((l: string) => l.trim()) ?? 'glab failed';
  return new GlabError('error', line.slice(0, 200));
}

/** glab's output as JSON (anything it printed before the JSON, like a deprecation notice, is skipped). */
export function json(out: string): any {
  const i = out.search(/^[[{]/m);
  return JSON.parse(i > 0 ? out.slice(i) : out);
}

const ts = (s: unknown) => (typeof s === 'string' && s ? Date.parse(s) || null : null);
const enc = (project: string) => encodeURIComponent(project);
export const pipeKey = (project: string, id: number) => `${project}#${id}`;
const branchKey = (project: string, ref: string) => `${project}@${ref}`;

/** A pipeline from the API's pipeline and its jobs. */
export function toPipeline(project: string, p: any, jobs: any[]): CiPipeline {
  const js: CiJob[] = (jobs ?? []).map((j) => ({
    id: Number(j.id), name: String(j.name ?? ''), stage: String(j.stage ?? ''), status: j.status as CiStatus,
    ...(j.allow_failure ? { allowFailure: true } : {}), ...(j.failure_reason ? { failureReason: String(j.failure_reason) } : {}),
    startedAt: ts(j.started_at), finishedAt: ts(j.finished_at), url: String(j.web_url ?? ''),
  }));
  return {
    key: pipeKey(project, Number(p.id)), project, id: Number(p.id), ref: String(p.ref ?? ''), sha: String(p.sha ?? ''), status: p.status as CiStatus,
    ...(p.source ? { source: String(p.source) } : {}), url: String(p.web_url ?? ''), createdAt: ts(p.created_at) ?? 0,
    startedAt: ts(p.started_at), finishedAt: ts(p.finished_at), ...(typeof p.duration === 'number' ? { duration: p.duration } : {}), stages: groupStages(js),
  };
}

/** Where glab is: on PATH, else its Windows installer's folder. */
export function findGlab(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const candidates = process.platform === 'win32' ? [join(local, 'Programs', 'glab', 'glab.exe')] : ['/usr/local/bin/glab', '/opt/homebrew/bin/glab', '/usr/bin/glab'];
  return candidates.find((c) => existsSync(c)) ?? 'glab';
}

export class CiWatcher {
  private exec: Exec;
  private now: () => number;
  private glabPath: string;
  private onPath = true;
  private health: CiHealth = { state: 'ok' };
  private pausedUntil = 0;
  private running = 0;
  private timer?: NodeJS.Timeout;
  private detects = new Map<string, Detect>();
  private branches = new Map<string, Branch>();
  private pipes = new Map<string, Pipe>();
  private links = new Map<string, Link>();
  private defaults = new Map<string, string | null>();
  private dirtyLinks = new Set<string>();
  private dirtyPipes = new Set<string>();
  private goneLinks = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private logs = new Map<string, string[]>();
  private synced = 0;
  private sent = new Map<string, string>();

  constructor(private d: CiDeps) {
    this.exec = d.exec ?? nodeExec;
    this.now = d.now ?? Date.now;
    this.glabPath = d.glab ?? 'glab';
  }

  start(): void {
    this.synced = this.now();
    this.syncSessions();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.flushTimer);
  }

  snapshot(): CiMsg {
    return { t: 'ci', full: true, pipelines: [...this.pipes.values()].flatMap((p) => (p.data ? [p.data] : [])), links: [...this.links.values()].map((l) => this.linkOf(l)), health: this.health };
  }

  /** A live session's repo on gitlab.com and its branch (null: not followed, or not a GitLab repo on a branch). */
  repoOf(sid: string): CiLink['repo'] {
    const l = this.links.get(sid);
    return l ? this.linkOf(l).repo : null;
  }

  /** Pick up live sessions (at start, and now and then in case an update was missed). */
  syncSessions(): void {
    for (const s of this.d.sessions()) this.sessionChanged(s);
  }

  sessionChanged(s: SessionInfo): void {
    // ended (or put away): nothing to follow
    if (s.state === 'ended' || !s.cwd || (s.dismissedAt != null && s.dismissedAt >= s.lastTs)) {
      if (this.links.has(s.id)) this.drop(s.id);
      return;
    }
    const l = this.links.get(s.id);
    if (l && l.cwd === s.cwd) return;
    const link: Link = { sid: s.id, cwd: s.cwd, repo: null, refs: l?.refs ?? new Map(), activeAt: this.now(), owned: l?.owned ?? new Set() };
    this.links.set(s.id, link);
    // the branches it has worked on, from all it ran (only those its commands or their output name: what's checked
    // out now may be another session's)
    if (!l) for (const e of this.d.gitWork?.(s.id) ?? []) this.claim(link, e, false);
    void this.refreshRepo(s.id, true);
    // newly followed (the server just started, or the session just went live): what it pushed or looked at lately
    if (!l) for (const e of this.d.recent?.(s.id, this.now() - REPLAY_MS) ?? []) this.consider(e);
  }

  /** A stored event: commands that push, start or look at pipelines; a branch switch. */
  event(e: BrainEvent): void {
    if (this.now() - e.ts > FRESH_MS) return;
    this.consider(e);
  }

  private consider(e: BrainEvent): void {
    if (e.kind !== 'tool' || e.phase !== 'end' || !e.tool) return;
    const l = this.links.get(e.sessionId);
    if (!l) return;
    l.activeAt = this.now();
    if (!CI_TOOLS.test(e.tool.name)) return;
    const input = (e.tool.input ?? {}) as { command?: unknown; url?: unknown };
    const command = typeof input.command === 'string' ? input.command : typeof input.url === 'string' ? input.url : '';
    if (/\bgit\b[^|;&]*\b(checkout|switch|worktree|push)\b/.test(command)) this.detects.delete(l.cwd);
    const r = commandRefs(command, e.tool.preview ?? '');
    const at = e.ts;
    void (async () => {
      const repo = await this.refreshRepo(l.sid, false);
      this.claim(l, e, true);
      const project = (p: string | null) => p ?? repo?.project ?? null;
      if (r.kick && repo?.branch) this.kick(l.sid, repo.project, repo.branch, r.kick);
      for (const b of r.branches) {
        const p = project(b.project);
        if (p) b.why === 'push' ? this.kick(l.sid, p, b.ref, 'push') : this.follow(l.sid, p, b.ref, b.why);
      }
      for (const x of r.pipelines) {
        const p = project(x.project);
        if (p) this.ref(l, p, x.id, x.why, at);
      }
      for (const x of r.jobs) {
        const p = project(x.project);
        if (p) void this.viaJob(l, p, x.id, x.why, at);
      }
      for (const x of r.mrs) {
        const p = project(x.project);
        if (p) void this.viaMr(l, p, x.id, x.why, at);
      }
    })();
  }

  /**
   * The branches a command shows the session working on become its own (their pipelines are its news). `now`: the
   * command just ran, so one that names no branch was on the current one (from history, that's unknown: skipped).
   */
  private claim(l: Link, e: BrainEvent, now: boolean): void {
    if (e.kind !== 'tool' || !e.tool) return;
    const input = (e.tool.input ?? {}) as { command?: unknown };
    if (typeof input.command !== 'string') return;
    const o = ownedRefs(input.command, e.tool.preview ?? '');
    const before = this.owns(l);
    for (const b of o.branches) l.owned.add(b);
    if (o.current && now && l.repo?.branch) {
      l.owned.add(l.repo.branch);
      if (l.repo.head) l.owned.add(l.repo.head);
    }
    if (!before && this.owns(l) && l.repo?.branch) {
      this.follow(l.sid, l.repo.project, l.repo.branch, 'branch');
      this.dirtyLinks.add(l.sid);
      this.flushSoon();
    }
  }
  /** Does the session work on the branch its folder has checked out? */
  private owns(l: Link): boolean {
    const r = l.repo;
    return !!r?.branch && (l.owned.has(r.branch) || (!!r.head && l.owned.has(r.head)));
  }

  /** A job's log, its last lines (only for jobs of pipelines shown here). */
  async jobLog(project: string, jobId: number): Promise<{ lines: string[] } | { error: string }> {
    const known = [...this.pipes.values()].some((p) => p.project === project && p.data?.stages.some((s) => s.jobs.some((j) => j.id === jobId)));
    if (!known) return { error: 'not a job of a pipeline Cora follows' };
    const key = `${project}#${jobId}`;
    const cached = this.logs.get(key);
    if (cached) return { lines: cached };
    try {
      const text = await this.glab(['api', `projects/${enc(project)}/jobs/${jobId}/trace`], 64 * 1024 * 1024);
      const lines = traceTail(text, 60);
      const job = [...this.pipes.values()].flatMap((p) => p.data?.stages.flatMap((s) => s.jobs) ?? []).find((j) => j.id === jobId);
      // a finished job's log won't change
      if (job && ciFinished(job.status)) {
        this.logs.set(key, lines);
        if (this.logs.size > 20) this.logs.delete(this.logs.keys().next().value!);
      }
      return { lines };
    } catch (e) {
      return { error: classify(e).message };
    }
  }

  // ---------------------------------------------------------------------------

  private drop(sid: string): void {
    this.links.delete(sid);
    for (const b of this.branches.values()) b.subs.delete(sid);
    this.goneLinks.add(sid);
    this.sent.delete(sid);
    this.dirtyLinks.delete(sid);
    this.prune();
    this.flushSoon();
  }

  /** The session's repo and branch, from git (cached a little while; `force` asks again). */
  private async refreshRepo(sid: string, force: boolean): Promise<Repo | null> {
    const l = this.links.get(sid);
    if (!l) return null;
    const cwd = l.cwd;
    let d = this.detects.get(cwd);
    const ttl = d?.repo ? REPO_TTL : NO_REPO_TTL;
    if (force || !d || (!d.busy && this.now() - d.at > ttl)) {
      const busy = this.detect(cwd);
      d = { at: this.now(), repo: d?.repo ?? null, busy };
      this.detects.set(cwd, d);
      const repo = await busy;
      this.detects.set(cwd, { at: this.now(), repo });
    } else if (d.busy) await d.busy;
    const repo = this.detects.get(cwd)?.repo ?? null;
    const cur = this.links.get(sid);
    if (cur && (cur.repo?.project !== repo?.project || cur.repo?.branch !== repo?.branch)) {
      // moved to another branch (or repo): follow that one instead
      for (const b of this.branches.values()) if (b.subs.get(sid)?.why === 'branch') b.subs.delete(sid);
      cur.repo = repo;
      if (repo?.branch && this.owns(cur)) this.follow(sid, repo.project, repo.branch, 'branch');
      this.dirtyLinks.add(sid);
      this.prune();
      this.flushSoon();
    }
    return repo;
  }

  private async detect(cwd: string): Promise<Repo | null> {
    const git = (args: string[]) => this.exec('git', ['-C', cwd, ...args], { timeout: 8000 }).then((r) => r.stdout.trim());
    try {
      const [head, remotesOut] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['remote', '-v'])]);
      const remotes = parseRemotes(remotesOut);
      const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
      const upstream = up ? splitUpstream(up, Object.keys(remotes)) : null;
      const project = pickProject(remotes, upstream?.remote);
      if (!project) return null;
      // the branch it pushes to (its upstream's name), else its own name; detached: no branch
      const branch = head && head !== 'HEAD' ? (upstream?.branch ?? head) : null;
      return { project, branch, ...(branch ? { head } : {}) };
    } catch {
      return null;
    }
  }

  private async defaultBranch(project: string): Promise<string | null> {
    if (this.defaults.has(project)) return this.defaults.get(project) ?? null;
    this.defaults.set(project, null);
    try {
      const p = json(await this.glab(['api', `projects/${enc(project)}`]));
      const def = typeof p?.default_branch === 'string' ? p.default_branch : null;
      this.defaults.set(project, def);
      for (const l of this.links.values()) if (l.repo?.project === project) this.dirtyLinks.add(l.sid);
      this.flushSoon();
      return def;
    } catch (e) {
      // ask again later
      this.defaults.delete(project);
      this.note(e);
      return null;
    }
  }

  private branch(project: string, ref: string): Branch {
    const k = branchKey(project, ref);
    let b = this.branches.get(k);
    if (!b) this.branches.set(k, (b = { project, ref, subs: new Map(), due: this.now(), kicks: [], fails: 0 }));
    return b;
  }

  /** The session follows a branch's latest pipeline (its own branch for good; another one for a while). */
  private follow(sid: string, project: string, ref: string, why: CiWhy): Branch {
    const b = this.branch(project, ref);
    const own = b.subs.get(sid)?.why === 'branch' || why === 'branch';
    b.subs.set(sid, { why: own ? 'branch' : why, until: own ? Infinity : this.now() + EXTRA_TTL });
    const l = this.links.get(sid);
    if (b.latest && l) this.remember(l, b.latest, own ? 'branch' : why, own ? (this.pipes.get(b.latest)?.created ?? this.now()) : this.now(), branchKey(project, ref));
    return b;
  }

  /** Something may have started a pipeline on this branch: look soon, and keep looking for a bit. */
  private kick(sid: string, project: string, ref: string, why: CiWhy): void {
    const l = this.links.get(sid);
    const repo = l?.repo;
    // its own branch: pushing (or opening an MR, running a pipeline) makes it so; a look at another's is a look
    const mine = repo?.project === project && repo.branch === ref;
    if (mine && why === 'push') l!.owned.add(ref);
    const b = this.follow(sid, project, ref, mine && this.owns(l!) ? 'branch' : why);
    const now = this.now();
    b.kicks = KICKS.map((k) => now + k);
    b.kickBase = b.latest ? (this.pipes.get(b.latest)?.id ?? 0) : 0;
    b.kickWhy = why;
    b.kickAt = now;
    b.due = Math.min(b.due, b.kicks.shift()!);
  }

  /** A pipeline the session's command named (named again: read it again, it may have been retried). */
  private ref(l: Link, project: string, id: number, why: CiWhy, at: number): void {
    const k = pipeKey(project, id);
    const p = this.pipes.get(k);
    if (!p) this.pipes.set(k, { project, id, due: this.now(), fails: 0 });
    else if (p.done) (p.done = false), (p.due = this.now());
    this.soon();
    this.remember(l, k, why, at);
  }

  /**
   * Put a pipeline on the session's list. A pipeline keeps the strongest reason it was listed for (one its push
   * started stays that when it's also the branch's latest). The branch's latest is dated by when it was created (an
   * old one isn't news) and replaces the branch's previous latest; the rest are the newest few, for a few hours.
   */
  private remember(l: Link, key: string, why: CiWhy, at: number, branch?: string): void {
    const had = l.refs.get(key);
    const w = had && WHY_RANK[had.why] > WHY_RANK[why] ? had.why : why;
    l.refs.set(key, { why: w, at: why === 'branch' ? (had?.at ?? at) : Math.max(at, had?.at ?? 0), branch: branch ?? had?.branch });
    // the branch's new latest (however it's listed) replaces its previous latest
    if (branch) for (const [k, v] of l.refs) if (k !== key && v.why === 'branch' && v.branch === branch) l.refs.delete(k);
    const now = this.now();
    const others = [...l.refs].filter(([, v]) => v.why !== 'branch').sort((a, b) => b[1].at - a[1].at);
    others.forEach(([k, v], i) => (i >= MAX_REFS || now - v.at > REF_TTL) && l.refs.delete(k));
    this.dirtyLinks.add(l.sid);
    this.prune();
    this.flushSoon();
  }

  private async viaJob(l: Link, project: string, jobId: number, why: CiWhy, at: number): Promise<void> {
    try {
      const j = json(await this.glab(['api', `projects/${enc(project)}/jobs/${jobId}`]));
      if (j?.pipeline?.id) this.ref(l, project, Number(j.pipeline.id), why, at);
    } catch (e) {
      this.note(e);
    }
  }

  private async viaMr(l: Link, project: string, iid: number, why: CiWhy, at: number): Promise<void> {
    try {
      const list = json(await this.glab(['api', `projects/${enc(project)}/merge_requests/${iid}/pipelines?per_page=1`]));
      if (Array.isArray(list) && list[0]?.id) this.ref(l, project, Number(list[0].id), why, at);
    } catch (e) {
      this.note(e);
    }
  }

  /** Forget branches nobody follows and pipelines nobody lists. */
  private prune(): void {
    const now = this.now();
    for (const [k, b] of this.branches) {
      for (const [sid, s] of b.subs) if (s.until < now || !this.links.has(sid)) b.subs.delete(sid);
      if (!b.subs.size) this.branches.delete(k);
    }
    const listed = new Set<string>();
    for (const l of this.links.values()) for (const k of l.refs.keys()) listed.add(k);
    for (const b of this.branches.values()) if (b.latest) listed.add(b.latest);
    for (const k of this.pipes.keys()) if (!listed.has(k)) this.pipes.delete(k);
  }

  private linkOf(l: Link): CiLink {
    const repo = l.repo?.branch ? { project: l.repo.project, branch: l.repo.branch, ...(this.defaults.get(l.repo.project) ? { defaultBranch: this.defaults.get(l.repo.project)! } : {}) } : null;
    return { sessionId: l.sid, repo, pipelines: [...l.refs].filter(([k]) => this.pipes.get(k)?.data).map(([key, v]) => ({ key, why: v.why, at: v.at })).sort((a, b) => b.at - a.at) };
  }

  private flushSoon(): void {
    this.flushTimer ??= setTimeout(() => this.flush(), 60);
  }

  private flush(): void {
    this.flushTimer = undefined;
    const pipelines = [...this.dirtyPipes].flatMap((k) => (this.pipes.get(k)?.data ? [this.pipes.get(k)!.data!] : []));
    // a session's list as last sent: unchanged ones aren't sent again
    const links = [...this.dirtyLinks].flatMap((sid) => {
      const l = this.links.get(sid);
      if (!l) return [];
      const link = this.linkOf(l);
      const text = JSON.stringify(link);
      if (this.sent.get(sid) === text) return [];
      this.sent.set(sid, text);
      return [link];
    });
    const goneLinks = [...this.goneLinks];
    this.dirtyPipes.clear();
    this.dirtyLinks.clear();
    this.goneLinks.clear();
    if (!pipelines.length && !links.length && !goneLinks.length) return;
    this.d.publish({ t: 'ci', ...(pipelines.length ? { pipelines } : {}), ...(links.length ? { links } : {}), ...(goneLinks.length ? { goneLinks } : {}) });
  }

  private setHealth(h: CiHealth): void {
    if (h.state === this.health.state && h.message === this.health.message) return;
    if (h.state !== 'ok') this.d.log?.(`pipelines: ${h.message ?? h.state}`);
    else if (this.health.state !== 'ok') this.d.log?.(`pipelines: reading from ${gitlabHost()} again`);
    this.health = h;
    this.d.publish({ t: 'ci', health: h });
  }

  /** A failed read: says so once (no glab, signed out, offline), and pauses everything when glab can't work at all. */
  private note(e: unknown): GlabError {
    const g = e instanceof GlabError ? e : classify(e);
    if (g.kind === 'no-glab' || g.kind === 'signed-out') this.pausedUntil = this.now() + PAUSE_MS;
    if (g.kind !== 'missing') this.setHealth({ state: g.kind as CiHealth['state'], message: g.message });
    return g;
  }

  private async glab(args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
    this.running++;
    try {
      const env = { ...process.env, GLAB_CHECK_UPDATE: 'false', NO_COLOR: '1', GLAB_NO_PROMPT: 'true' };
      const run = (file: string) => this.exec(file, [...args.slice(0, 1), '--hostname', gitlabHost(), ...args.slice(1)], { timeout: 30_000, maxBuffer, env, cwd: homedir() });
      let r: { stdout: string };
      try {
        r = await run(this.onPath ? 'glab' : this.glabPath);
      } catch (e: any) {
        // not on the server's PATH (an app started from the Start menu may not have it): its usual install folder
        if (e?.code !== 'ENOENT' || !this.onPath) throw e;
        this.onPath = false;
        if (this.glabPath === 'glab') this.glabPath = findGlab();
        r = await run(this.glabPath);
      }
      if (this.health.state !== 'ok') this.setHealth({ state: 'ok' });
      return r.stdout;
    } catch (e) {
      throw classify(e);
    } finally {
      this.running--;
    }
  }

  async tick(): Promise<void> {
    const now = this.now();
    if (!this.d.hasClients() || now < this.pausedUntil) return;
    if (now - this.synced > 30_000) (this.synced = now), this.syncSessions();
    // re-read the branch of sessions that were busy since it was last read (a checkout may have moved it)
    for (const l of this.links.values()) {
      const d = this.detects.get(l.cwd);
      if (!d?.busy && (!d || (l.activeAt > d.at && now - d.at > REPO_TTL))) void this.refreshRepo(l.sid, false);
    }
    this.prune();
    const due: Array<{ at: number; run: () => Promise<void> }> = [];
    for (const p of this.pipes.values()) if (!p.busy && !p.done && p.due <= now) due.push({ at: p.due, run: () => this.checkPipe(p) });
    for (const b of this.branches.values()) if (!b.busy && b.due <= now) due.push({ at: b.due, run: () => this.checkBranch(b) });
    due.sort((a, b) => a.at - b.at);
    for (const x of due) {
      if (this.running >= MAX_CONC) break;
      void x.run();
    }
  }

  /** A new pipeline to read: don't wait for the next tick. */
  private soon(): void {
    setTimeout(() => void this.tick(), 0);
  }

  private backoff(fails: number): number {
    return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, fails - 1));
  }

  private async checkBranch(b: Branch): Promise<void> {
    b.busy = true;
    try {
      const def = this.defaults.has(b.project) ? this.defaults.get(b.project) : await this.defaultBranch(b.project);
      // an open merge request's pipelines include the branch's own, and the MR-only ones a branch query misses
      if (b.ref !== def && (!b.mr || this.now() - b.mr.at > MR_TTL)) {
        const mrs = json(await this.glab(['api', `projects/${enc(b.project)}/merge_requests?source_branch=${encodeURIComponent(b.ref)}&state=opened&per_page=1`]));
        b.mr = { iid: Array.isArray(mrs) && mrs[0]?.iid ? Number(mrs[0].iid) : null, at: this.now() };
      }
      let list: any[] = b.mr?.iid ? json(await this.glab(['api', `projects/${enc(b.project)}/merge_requests/${b.mr.iid}/pipelines?per_page=1`])) : [];
      if (!Array.isArray(list) || !list.length) list = json(await this.glab(['api', `projects/${enc(b.project)}/pipelines?ref=${encodeURIComponent(b.ref)}&per_page=1`]));
      const top = Array.isArray(list) ? list[0] : null;
      b.fails = 0;
      if (top?.id) {
        const id = Number(top.id);
        const k = pipeKey(b.project, id);
        if (!this.pipes.has(k)) this.pipes.set(k, { project: b.project, id, due: this.now(), fails: 0 }), this.soon();
        const pipe = this.pipes.get(k)!;
        pipe.created = ts(top.created_at) ?? this.now();
        // finished, but on its way again (a job was retried): read it again
        if (pipe.done && ciActive(top.status)) (pipe.done = false), (pipe.due = this.now());
        const fresh = b.latest !== k;
        b.latest = k;
        // the pipeline a kick was waiting for: it's here
        const started = b.kickBase != null && id > b.kickBase && pipe.created >= (b.kickAt ?? 0) - 60_000;
        if (started) (b.kicks = []), (b.kickBase = undefined);
        if (fresh || started) {
          for (const [sid, s] of b.subs) {
            const l = this.links.get(sid);
            const why = started && b.kickWhy ? b.kickWhy : s.why;
            if (l) this.remember(l, k, why, why === 'branch' ? pipe.created : this.now(), branchKey(b.project, b.ref));
          }
        }
      }
      b.due = b.kicks.length ? b.kicks.shift()! : this.now() + IDLE_MS;
    } catch (e) {
      const g = this.note(e);
      b.fails++;
      b.due = this.now() + (g.kind === 'missing' ? 30 * 60_000 : this.backoff(b.fails));
    } finally {
      b.busy = false;
    }
  }

  private async checkPipe(p: Pipe): Promise<void> {
    p.busy = true;
    try {
      const raw = json(await this.glab(['api', `projects/${enc(p.project)}/pipelines/${p.id}`]));
      const jobs = json(await this.glab(['api', `projects/${enc(p.project)}/pipelines/${p.id}/jobs?per_page=100`]));
      const data = toPipeline(p.project, raw, Array.isArray(jobs) ? jobs : []);
      const text = JSON.stringify(data);
      p.fails = 0;
      if (text !== p.json) {
        p.json = text;
        p.data = data;
        this.dirtyPipes.add(data.key);
        // its first read: sessions listing it can show it now
        for (const l of this.links.values()) if (l.refs.has(data.key)) this.dirtyLinks.add(l.sid);
        this.flushSoon();
      }
      if (ciFinished(data.status)) p.done = true;
      else p.due = this.now() + (ciActive(data.status) ? RUN_MS : PARKED_MS);
    } catch (e) {
      const g = this.note(e);
      p.fails++;
      if (g.kind === 'missing') p.done = true;
      else p.due = this.now() + this.backoff(p.fails);
    } finally {
      p.busy = false;
    }
  }
}
