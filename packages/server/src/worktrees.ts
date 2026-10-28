import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { WORKTREE_DIR, branchFor, dirtyCount, folderFor, parseWorktreeList, stateOf, type Worktree, type WorktreeRepo } from '@cora/shared';

/** A folder as both sides write it: forward slashes, no trailing slash, any case. */
const key = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, dir: string) => key(p) === key(dir) || key(p).startsWith(`${key(dir)}/`);

export type Git = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;
const realGit: Git = (cwd, args) =>
  new Promise((done) =>
    execFile('git', args, { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (e, out) => done({ ok: !e, out: String(out ?? '') })),
  );

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
  private wantedUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private poked = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessions told to move into a worktree: its folder, and since when */
  private moving = new Map<string, { path: string; at: number }>();
  private git: Git;

  constructor(
    private o: {
      /** the repos you gave Cora */
      mine(): string[];
      /** sessions: where each works now, whether it's live, and the folders of those active lately */
      sessions(): Session[];
      recentFolders(): string[];
      onChange(repos: WorktreeRepo[]): void;
      git?: Git;
      now?: () => number;
    },
  ) {
    this.git = o.git ?? realGit;
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
    await this.git(root, ['fetch', '--prune', '--quiet', 'origin']);
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
