import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { WORKTREE_DIR, branchFor, dirtyCount, folderFor, parseWorktreeList, stateOf, type Worktree, type WorktreeRepo } from '@cora/shared';

/** A folder as both sides write it: forward slashes, no trailing slash, any case. */
const key = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, dir: string) => key(p) === key(dir) || key(p).startsWith(`${key(dir)}/`);

/** `ask`: you asked for it (signing in), so it may ask you: Credential Manager's window, with time to answer it. */
export type Git = (cwd: string, args: string[], o?: { ask?: boolean }) => Promise<{ ok: boolean; out: string; err?: string }>;
/**
 * Git as Cora runs it in the background: never asking for anything. No prompt in a terminal, no sign-in window from
 * Git Credential Manager (a fetch whose sign-in has run out would open one every round, a burst of them for several
 * repos), no SSH passphrase prompt;
 * such a fetch just fails, and tries again next time.
 */
export const quietGitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  // and none of its windows at all: its GitLab sign-in (2.0.x) opens its window before it checks the line above
  GCM_GUI_PROMPT: 'false',
  GIT_OPTIONAL_LOCKS: '0',
  ...(env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
});
const realGit: Git = (cwd, args, o) =>
  new Promise((done) =>
    execFile(
      'git',
      args,
      { cwd, timeout: o?.ask ? 180_000 : 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: o?.ask ? { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } : quietGitEnv() },
      (e, out, err) => done({ ok: !e, out: String(out ?? ''), err: String(err ?? '') }),
    ),
  );

/** glab's path, when it's signed in to a host (asked again every 10 minutes per host); null: not installed or not signed in there. */
export function glabSignedIn(): (host: string) => Promise<string | null> {
  let exe: Promise<string | null> | undefined;
  const known = new Map<string, { ok: boolean; at: number }>();
  const find = () =>
    new Promise<string | null>((done) =>
      execFile(process.platform === 'win32' ? 'where' : 'which', ['glab'], { windowsHide: true, timeout: 5000 }, (e, out) => {
        const hit = e ? null : String(out ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
        const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'glab', 'glab.exe') : null;
        done(hit ?? (local && existsSync(local) ? local : null));
      }),
    );
  return async (host) => {
    const path = await (exe ??= find());
    if (!path) return null;
    const k = known.get(host);
    if (!k || Date.now() - k.at > 10 * 60_000) {
      const ok = await new Promise<boolean>((done) => execFile(path, ['auth', 'status', '--hostname', host], { windowsHide: true, timeout: 15_000 }, (e) => done(!e)));
      known.set(host, { ok, at: Date.now() });
    }
    return known.get(host)!.ok ? path : null;
  };
}

/** A fetch that failed because it couldn't sign in (not because it's offline): what git says then. */
export const SIGN_IN_FAILED = /authentication failed|could not read (username|password)|terminal prompts disabled|access denied|permission denied \(publickey|\b40[13]\b/i;
/** The host a remote URL points at (https://host/…, git@host:…, ssh://git@host/…). */
export const remoteHost = (url: string): string | null => url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)/i)?.[1]?.toLowerCase() ?? null;

/** How often a repo's remote is looked at (to see merged branches go): its branches, never its files. */
const FETCH_EVERY = 10 * 60_000;

type Session = { id: string; cwd: string; live: boolean };

/**
 * Every worktree of your repos: Cora's repos and the
 * repos sessions worked in lately; read from git, who's in each from the sessions' folders, kept and pushed. Makes a
 * worktree for new work (fresh from the base, a good branch name) and removes one, never by force.
 */
export class Worktrees {
  private repos = new Map<string, WorktreeRepo>();
  private rootOf = new Map<string, string | null>();
  private fetched = new Map<string, number>();
  /** per host, the repos whose fetch couldn't sign in (since this start: a note left from before is cleared by the first that can) */
  private signIn = new Map<string, Set<string>>();
  private wantedUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private poked = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessions told to move into a worktree: its folder, and since when */
  private moving = new Map<string, { path: string; at: number }>();
  private git: Git;
  private glab: (host: string) => Promise<string | null>;
  /** fetches go one at a time: several at once race Credential Manager's refresh of a run-out GitLab sign-in */
  private fetching: Promise<unknown> = Promise.resolve();

  constructor(
    private o: {
      /** the repos you gave Cora */
      mine(): string[];
      /** sessions: where each works now, whether it's live, and the folders of those active lately */
      sessions(): Session[];
      recentFolders(): string[];
      onChange(repos: WorktreeRepo[]): void;
      /**
       * The repos whose background fetch can't sign in to a host now (empty: it can again), told when that changes, so
       * you hear it once (and never get a sign-in window from it)
       */
      onSignIn?(host: string, repos: string[]): void;
      git?: Git;
      now?: () => number;
      /** how long before a fetch that couldn't sign in tries once more (the sign-in may have been mid-refresh) */
      retryMs?: number;
      /** glab, when it's signed in to a host: its path (git then signs in with glab's sign-in there) */
      glab?: (host: string) => Promise<string | null>;
    },
  ) {
    this.git = o.git ?? realGit;
    // tests that fake git don't ask the real glab
    this.glab = o.glab ?? (o.git ? async () => null : glabSignedIn());
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** The main checkout a folder belongs to (a worktree's too), or null when it isn't in a repo. */
  async root(folder: string): Promise<string | null> {
    const k = key(folder);
    if (this.rootOf.has(k)) return this.rootOf.get(k)!;
    let root: string | null = null;
    if (existsSync(folder)) {
      const r = await this.git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const common = r.ok ? r.out.trim() : '';
      if (common && basename(common) === '.git') root = resolve(dirname(common));
    }
    this.rootOf.set(k, root);
    return root;
  }

  /** Someone wants the list (Cora's board shows it, or its agent asked): kept fresh for a few minutes. */
  want(): void {
    const first = this.wantedUntil < this.now();
    this.wantedUntil = this.now() + 5 * 60_000;
    if (first) void this.refresh();
  }

  /** Read every minute while someone wants them; else every quarter hour (Cora's card says when some are done). */
  start(): void {
    let last = 0;
    const tick = () => {
      if (this.wantedUntil < this.now() && this.now() - last < 15 * 60_000) return;
      last = this.now();
      void this.refresh().catch(() => {});
    };
    this.first = setTimeout(tick, 20_000);
    this.timer = setInterval(tick, 60_000);
  }
  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.first);
    for (const t of this.poked.values()) clearTimeout(t);
  }

  /** A session ran git in a folder: that repo again, shortly. */
  poke(folder: string): void {
    void this.root(folder).then((root) => {
      if (!root || !this.repos.has(key(root))) return;
      clearTimeout(this.poked.get(root));
      this.poked.set(root, setTimeout(() => void this.refresh(root), 2000));
    });
  }

  list(): WorktreeRepo[] {
    return [...this.repos.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
  }

  /** Read them again: every repo, or one. */
  async refresh(only?: string): Promise<WorktreeRepo[]> {
    const mine = new Set<string>();
    for (const r of this.o.mine()) {
      const root = await this.root(r);
      if (root) mine.add(key(root));
    }
    const roots = new Map<string, string>();
    if (only) {
      const root = await this.root(only);
      if (root) roots.set(key(root), root);
    } else {
      for (const f of [...this.o.mine(), ...this.o.recentFolders()]) {
        const root = await this.root(f);
        if (root) roots.set(key(root), root);
      }
      for (const k of [...this.repos.keys()]) if (!roots.has(k)) this.repos.delete(k);
    }
    // a few at a time, each shown as soon as it's read (many repos needn't wait for the slowest)
    const queue = [...roots];
    const work = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [k, root] = next;
        const repo = await this.readRepo(root, mine.has(k)).catch(() => null);
        if (repo) {
          this.repos.set(k, repo);
          this.o.onChange(this.list());
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, work));
    if (!roots.size) this.o.onChange(this.list());
    return this.list();
  }

  /** The base new work is cut from and measured against: origin's default branch (else the local one). */
  private async base(root: string): Promise<string> {
    const head = await this.git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.ok && head.out.trim()) return head.out.trim();
    for (const b of ['origin/main', 'origin/master', 'main', 'master']) if ((await this.git(root, ['rev-parse', '--verify', '--quiet', b])).ok) return b;
    return 'HEAD';
  }

  private async fetch(root: string): Promise<void> {
    if (this.now() - (this.fetched.get(key(root)) ?? 0) < FETCH_EVERY) return;
    this.fetched.set(key(root), this.now());
    const url = (await this.git(root, ['remote', 'get-url', 'origin'])).out.trim();
    const auth = await this.signInArgs(url);
    const once = () => this.queued(() => this.git(root, [...auth, 'fetch', '--prune', '--quiet', 'origin']));
    let r = await once();
    // couldn't sign in: most often another git (a session's) was refreshing the same sign-in at that moment, and it
    // works a few seconds later (as it did when you clicked Sign in): try once more before saying so
    if (!r.ok && SIGN_IN_FAILED.test(r.err ?? '')) {
      await new Promise((ok) => setTimeout(ok, this.o.retryMs ?? 5000));
      r = await once();
    }
    // couldn't sign in, or can again: said once per change (offline and the like: nothing to say)
    const failed = !r.ok && SIGN_IN_FAILED.test(r.err ?? '');
    if (!r.ok && !failed) return;
    const host = remoteHost(url);
    if (!host) return;
    const known = this.signIn.has(host);
    const set = this.signIn.get(host) ?? new Set<string>();
    if (known && failed === set.has(root)) return;
    if (failed) set.add(root);
    else set.delete(root);
    this.signIn.set(host, set);
    this.o.onSignIn?.(host, [...set]);
  }

  /**
   * How git signs in for a remote: an https GitLab remote whose host glab is signed in to uses glab's own sign-in
   * (`glab auth git-credential`), for this command only, instead of Git Credential Manager, whose GitLab sign-in runs
   * out every couple of hours and whose browser sign-in can fail to open. Anything else: as git is set up.
   */
  private async signInArgs(url: string): Promise<string[]> {
    const host = /^https:\/\//i.test(url) ? remoteHost(url) : null;
    if (!host) return [];
    const exe = await this.glab(host).catch(() => null);
    return exe ? ['-c', 'credential.helper=', '-c', `credential.https://${host}.helper=!'${exe.replace(/\\/g, '/')}' auth git-credential`] : [];
  }

  /** One fetch after another (whatever the one before did). */
  private queued<T>(run: () => Promise<T>): Promise<T> {
    const p = this.fetching.then(run, run);
    this.fetching = p.catch(() => {});
    return p;
  }

  /**
   * You asked to sign in (the Inbox's note): one fetch of a repo that couldn't, this time allowed to ask (Credential
   * Manager's sign-in window opens, as you expect it to), then the rest of that host's at once; the note follows.
   */
  async signInTo(host: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const roots = [...(this.signIn.get(host) ?? [])];
    // after a restart the note can outlive what this start knows: any repo of that host will do
    if (!roots.length) for (const r of this.repos.values()) if (remoteHost((await this.git(r.root, ['remote', 'get-url', 'origin'])).out) === host) roots.push(r.root);
    if (!roots.length) return { ok: false, error: `No repo of ${host} to sign in with` };
    const auth = await this.signInArgs((await this.git(roots[0], ['remote', 'get-url', 'origin'])).out.trim());
    const r = await this.git(roots[0], [...auth, 'fetch', '--prune', '--quiet', 'origin'], { ask: true });
    if (!r.ok) return { ok: false, error: (r.err ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^fatal:\s*/, '') || "The sign-in didn't work" };
    for (const root of roots) {
      this.fetched.delete(key(root));
      await this.fetch(root);
      void this.refresh(root).catch(() => {});
    }
    return { ok: true };
  }

  private async readRepo(root: string, mine: boolean): Promise<WorktreeRepo> {
    // read what's here now; a fetch that was due runs after, and the repo is read again when it's in
    if (this.now() - (this.fetched.get(key(root)) ?? 0) >= FETCH_EVERY) void this.fetch(root).then(() => this.refresh(root)).catch(() => {});
    const base = await this.base(root);
    const listed = parseWorktreeList((await this.git(root, ['worktree', 'list', '--porcelain'])).out).filter((w) => !w.bare && existsSync(w.path));
    const sessions = this.o.sessions().filter((s) => s.live && s.cwd);
    const trees: Worktree[] = [];
    for (const w of listed) trees.push(await this.readTree(resolve(w.path), w.branch, key(w.path) === key(root), base));
    // who's in each: the deepest worktree holding their folder
    for (const s of sessions) {
      const home = trees.filter((t) => inside(s.cwd, t.path)).sort((a, b) => b.path.length - a.path.length)[0];
      if (home) home.who.push(s.id);
    }
    const now = this.now();
    for (const [sid, m] of this.moving) {
      if (now - m.at > 30 * 60_000 || trees.some((t) => key(t.path) === key(m.path) && t.who.includes(sid))) this.moving.delete(sid);
      else {
        const t = trees.find((x) => key(x.path) === key(m.path));
        if (t) t.coming = [...(t.coming ?? []), sid];
      }
    }
    for (const t of trees) t.state = stateOf(t, now);
    const main = trees.filter((t) => t.main);
    const rest = trees.filter((t) => !t.main).sort((a, b) => b.changedAt - a.changedAt);
    return { root, name: basename(root), mine, base, trees: [...main, ...rest] };
  }

  private async readTree(path: string, branch: string | null, main: boolean, base: string): Promise<Worktree> {
    const g = (args: string[]) => this.git(path, args);
    const status = (await g(['status', '--porcelain=v1'])).out;
    const dirty = dirtyCount(status);
    const counts = (await g(['rev-list', '--left-right', '--count', `${base}...HEAD`])).out.trim().split(/\s+/).map(Number);
    const behind = counts[0] || 0;
    const ahead = counts[1] || 0;
    let gone = false;
    let unpushed = 0;
    let merged = false;
    if (branch) {
      const track = (await g(['for-each-ref', '--format=%(upstream:short)|%(upstream:track)', `refs/heads/${branch}`])).out.trim();
      // pushed, then its remote branch went (merged, the branch deleted): its work is in
      gone = /\|\[gone\]/.test(track);
      unpushed = gone ? 0 : Number((await g(['rev-list', '--count', 'HEAD', '--not', '--remotes'])).out.trim()) || 0;
      if (!main) {
        const own = (await g(['reflog', 'show', '--format=%gs', '-n', '50', `refs/heads/${branch}`])).out.split('\n').some((l) => l.trim() && !/^branch: Created/.test(l));
        merged = gone || (own && ahead === 0 && (await g(['merge-base', '--is-ancestor', 'HEAD', base])).ok);
      }
    }
    let changedAt = (Number((await g(['log', '-1', '--format=%ct'])).out.trim()) || 0) * 1000;
    for (const line of status.replace(/\r/g, '').split('\n').filter(Boolean).slice(0, 50)) {
      try {
        changedAt = Math.max(changedAt, statSync(join(path, line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!)).mtimeMs);
      } catch {
        /* gone */
      }
    }
    return { path, branch, main, ahead, behind, dirty, unpushed, links: !main && linksIn(path).length > 0, changedAt, merged, who: [], state: 'idle' };
  }

  /** The worktree a session was told to move into (to tell it the same again), while it exists. */
  movingTo(sessionId: string): string | null {
    const m = this.moving.get(sessionId);
    return m && existsSync(m.path) ? m.path : null;
  }
  /** A session was told to move into this worktree: shown "moving in" until it's there. */
  expect(sessionId: string, path: string): void {
    this.moving.set(sessionId, { path, at: this.now() });
  }

  /** The worktree a file is in, with its repo (null outside your repos). */
  async checkoutOf(file: string): Promise<{ root: string; tree: Worktree } | null> {
    const root = await this.root(isAbsolute(file) && existsSync(file) && !statSync(file).isDirectory() ? dirname(file) : existsSync(file) ? file : dirname(file));
    if (!root) return null;
    let repo = this.repos.get(key(root));
    if (!repo) repo = (await this.refresh(root)).find((r) => key(r.root) === key(root));
    const tree = repo?.trees.filter((t) => inside(file, t.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return repo && tree ? { root: repo.root, tree } : null;
  }

  /** New work: a worktree fresh from the base, with a branch for it, in <repo>/.claude/worktrees. */
  async make(root: string, o: { name?: string | null; ticket?: string | null; title?: string | null } = {}): Promise<{ path: string; branch: string }> {
    const main = await this.root(root);
    if (!main) throw new Error(`${root} isn't a git repo`);
    await this.fetch(main);
    const base = await this.base(main);
    const taken = (await this.git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).out.split('\n').map((s) => s.trim()).filter(Boolean);
    const branch = branchFor({ ...o, taken });
    const dir = join(main, ...WORKTREE_DIR.split('/'));
    mkdirSync(dir, { recursive: true });
    excludeLocally(main);
    let path = join(dir, folderFor(branch));
    for (let i = 2; existsSync(path); i++) path = join(dir, `${folderFor(branch)}-${i}`);
    const r = await this.git(main, ['worktree', 'add', '--no-track', '-b', branch, path, base]);
    if (!r.ok) throw new Error(`git couldn't make the worktree (${branch} from ${base})`);
    await this.refresh(main);
    return { path, branch };
  }

  /**
   * Remove a worktree (and its branch, when asked and git agrees it's merged). Never forced: not a main checkout, nobody
   * in it, nothing uncommitted or unpushed; links inside are unlinked first so what they point to is never touched.
   */
  async remove(path: string, o: { deleteBranch?: boolean } = {}): Promise<{ ok: true; branchKept?: string } | { ok: false; why: string }> {
    const at = await this.checkoutOf(path);
    if (!at || key(at.tree.path) !== key(path)) return { ok: false, why: 'not a worktree Cora knows' };
    await this.refresh(at.root);
    const t = this.repos.get(key(at.root))?.trees.find((x) => key(x.path) === key(path));
    if (!t) return { ok: false, why: 'it went' };
    if (t.main) return { ok: false, why: "it's the repo's main checkout" };
    if (t.who.length) return { ok: false, why: 'a session is working in it' };
    if (t.dirty) return { ok: false, why: `${t.dirty} file${t.dirty === 1 ? '' : 's'} not committed` };
    if (t.unpushed) return { ok: false, why: `${t.unpushed} commit${t.unpushed === 1 ? '' : 's'} not pushed` };
    for (const l of linksIn(t.path)) unlinkOnly(l);
    const r = await this.git(at.root, ['worktree', 'remove', t.path]);
    if (!r.ok) return { ok: false, why: "git wouldn't remove it (something in it changed)" };
    let branchKept: string | undefined;
    if (o.deleteBranch && t.branch) {
      const b = await this.git(at.root, ['branch', '-d', t.branch]);
      if (!b.ok) branchKept = t.branch;
    }
    await this.refresh(at.root);
    return branchKept ? { ok: true, branchKept } : { ok: true };
  }
}

/** Links (junctions, symlinks) in a worktree's top two levels: never followed, never into node_modules or .git. */
export function linksIn(dir: string): string[] {
  const out: string[] = [];
  const look = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.slice(0, 500)) {
      if (n === '.git') continue;
      const p = join(d, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) out.push(p);
      else if (st.isDirectory() && depth < 2 && n !== 'node_modules') look(p, depth + 1);
    }
  };
  look(dir, 1);
  return out;
}

/** Remove a link itself, never what it points to. */
function unlinkOnly(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p); // a directory junction on Windows (non-recursive: only the link)
  }
}

/** Keep `.claude/worktrees/` out of the main checkout's git status, for this clone only. */
function excludeLocally(root: string): void {
  const f = join(root, '.git', 'info', 'exclude');
  try {
    const now = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (!now.split(/\r?\n/).includes(`/${WORKTREE_DIR}/`)) {
      mkdirSync(dirname(f), { recursive: true });
      appendFileSync(f, `${now && !now.endsWith('\n') ? '\n' : ''}/${WORKTREE_DIR}/\n`);
    }
  } catch {
    /* only tidiness */
  }
}
