import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeRepo } from '@cora/shared';
import { Worktrees, linksIn } from '../src/worktrees';

let dir: string;
let repo: string;
let sessions: { id: string; cwd: string; live: boolean }[];
let pushed: WorktreeRepo[][];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cora-wt-'));
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  repo = join(dir, 'repo');
  git(dir, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  sessions = [];
  pushed = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const store = () => new Worktrees({ mine: () => [repo], sessions: () => sessions, recentFolders: () => [], onChange: (r) => pushed.push(r) });
const commit = (cwd: string, file: string) => (writeFileSync(join(cwd, file), `${Math.random()}\n`), git(cwd, 'add', '.'), git(cwd, 'commit', '-qm', file));

describe('worktrees', () => {
  it('makes one fresh from the base with a good branch, in .claude/worktrees, kept out of git status', async () => {
    const w = store();
    const made = await w.make(repo, { ticket: 'CORA-212', title: 'Port retry fails' });
    expect(made.branch).toBe('fix/CORA-212-port-retry-fails');
    expect(made.path).toBe(join(repo, '.claude', 'worktrees', 'cora-212-port-retry-fails'));
    expect(existsSync(join(made.path, 'a.txt'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const again = await w.make(repo, { ticket: 'CORA-212', title: 'Port retry fails' });
    expect(again.branch).toBe('fix/CORA-212-port-retry-fails-2');
    const [r] = w.list();
    expect(r).toMatchObject({ name: 'repo', mine: true, base: 'origin/main' });
    expect(r.trees.map((t) => t.main)).toEqual([true, false, false]);
    expect(pushed.length).toBeGreaterThan(0);
  });

  it('who is in it, what it holds, and its state: active, idle, done once merged', async () => {
    const w = store();
    const { path } = await w.make(repo, { name: 'feature' });
    sessions = [{ id: 's1', cwd: path, live: true }, { id: 's2', cwd: repo, live: true }];
    commit(path, 'b.txt');
    writeFileSync(join(path, 'c.txt'), 'wip\n');
    let [r] = await w.refresh();
    let t = r.trees.find((x) => x.path === path)!;
    expect(t).toMatchObject({ branch: 'wt/feature', ahead: 1, behind: 0, dirty: 1, unpushed: 1, merged: false, who: ['s1'], state: 'active' });
    expect(r.trees[0].who).toEqual(['s2']);
    // finished: committed, merged into main and pushed, nobody there
    rmSync(join(path, 'c.txt'));
    git(repo, 'merge', '-q', '--ff-only', 'wt/feature');
    git(repo, 'push', '-q', 'origin', 'main');
    sessions = [];
    [r] = await w.refresh();
    t = r.trees.find((x) => x.path === path)!;
    expect(t).toMatchObject({ merged: true, dirty: 0, unpushed: 0, state: 'done' });
    // a fresh one with no work of its own is never "done"
    const fresh = await w.make(repo, { name: 'empty' });
    [r] = await w.refresh();
    expect(r.trees.find((x) => x.path === fresh.path)!.state).toBe('idle');
  });

  it('removing: refused for the main checkout, someone in it, uncommitted or unpushed work; then removed with its branch', async () => {
    const w = store();
    const { path, branch } = await w.make(repo, { name: 'gone' });
    expect(await w.remove(repo)).toEqual({ ok: false, why: "it's the repo's main checkout" });
    sessions = [{ id: 's1', cwd: join(path), live: true }];
    expect(await w.remove(path)).toEqual({ ok: false, why: 'a session is working in it' });
    sessions = [];
    writeFileSync(join(path, 'x.txt'), 'x\n');
    expect(await w.remove(path)).toEqual({ ok: false, why: '1 file not committed' });
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'x');
    expect(await w.remove(path)).toEqual({ ok: false, why: '1 commit not pushed' });
    git(repo, 'merge', '-q', '--ff-only', branch);
    git(repo, 'push', '-q', 'origin', 'main');
    expect(await w.remove(path, { deleteBranch: true })).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toBe('');
  });

  it("the gate: a hosted session's edit in a checkout another session is changing is refused with a worktree to move into", async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    const srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(dir, 'data-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const gate = async (sid: string, file: string) => (await srv.app.inject({ method: 'POST', url: '/edit-gate', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, tool_name: 'Edit', tool_input: { file_path: file } } })).json();
      srv.store.upsertSession({ id: 'first', cwd: repo, state: 'working' });
      srv.store.upsertSession({ id: 'second', cwd: repo, state: 'working', alias: 'Second job' });
      // alone in the checkout (nobody else has edited): through
      expect(await gate('second', join(repo, 'a.txt'))).toEqual({});
      srv.store.upsertEvent({ id: 'tool:e1:end', sessionId: 'first', agentId: 'main', ts: Date.now(), kind: 'tool', phase: 'end', toolUseId: 'e1', icon: { name: 'Pencil', family: 'edit' }, source: 'hook', tool: { name: 'Edit', input: {}, summary: 'a.txt', change: { path: join(repo, 'a.txt'), kind: 'edit', add: 1, del: 0 } } } as never);
      const r = await gate('second', join(repo, 'a.txt'));
      const why: string = r.hookSpecificOutput.permissionDecisionReason;
      expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
      const path = join(repo, '.claude', 'worktrees', 'second-job');
      expect(why).toContain(`EnterWorktree with path "${path}"`);
      expect(why).toContain(join(path, 'a.txt'));
      expect(existsSync(path)).toBe(true);
      // asked again: the same worktree; the one that was there first is never moved
      expect((await gate('second', join(repo, 'a.txt'))).hookSpecificOutput.permissionDecisionReason).toContain(path);
      expect(await gate('first', join(repo, 'a.txt'))).toEqual({});
      // once it's in its worktree, its edits there go through
      srv.store.upsertSession({ id: 'second', wd: path });
      expect(await gate('second', join(path, 'a.txt'))).toEqual({});
      // outside any repo: through
      expect(await gate('second', join(dir, 'notes.md'))).toEqual({});
    } finally {
      await srv.close();
      // the gate's last read of the repo (in the background) finishes before the folder goes
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, 30_000);

  it('a link inside (a shared node_modules) is unlinked first: what it points to is untouched', async () => {
    const w = store();
    const { path } = await w.make(repo, { name: 'linked' });
    const shared = join(dir, 'shared-modules');
    mkdirSync(join(shared, 'pkg'), { recursive: true });
    writeFileSync(join(shared, 'pkg', 'index.js'), 'keep me\n');
    symlinkSync(shared, join(path, 'node_modules'), 'junction');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), `${readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')}node_modules\n`);
    expect(linksIn(path)).toEqual([join(path, 'node_modules')]);
    const [r] = await w.refresh();
    expect(r.trees.find((x) => x.path === path)!.links).toBe(true);
    expect(await w.remove(path)).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(shared, 'pkg', 'index.js'), 'utf8')).toBe('keep me\n');
  });
});
