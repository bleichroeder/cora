import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Team } from '@cora/shared';
import { Projects } from '../src/projects';
import { TeamRuntime, inGitRepo, seatFolder } from '../src/teams';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-folders-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a seat's folder at launch", () => {
  it("one that isn't there yet is made (its parents too), and said", async () => {
    const at = join(dir, 'new', 'team');
    expect(await seatFolder(at, false)).toEqual({ at, made: true });
    expect(existsSync(at)).toBe(true);
    expect(await seatFolder(at, false)).toEqual({ at });
  });

  it('never a folder that is not a full path, made or there already (never Cora\'s own folder by chance)', async () => {
    expect(await seatFolder('relative/team', false)).toEqual({ error: "relative/team isn't a full path, so Cora won't use it." });
    expect(existsSync(join(process.cwd(), 'relative'))).toBe(false);
    expect(await seatFolder('packages', false)).toEqual({ error: "packages isn't a full path, so Cora won't use it." });
  });

  it("a worktree of a folder that isn't a git repository: it works in the folder itself (no worktree is asked for)", async () => {
    let asked = 0;
    const make = async () => (asked++, join(dir, 'wt'));
    expect(await seatFolder(dir, true, make)).toEqual({ at: dir, noRepo: true });
    const fresh = join(dir, 'fresh');
    expect(await seatFolder(fresh, true, make)).toEqual({ at: fresh, made: true, noRepo: true });
    expect(asked).toBe(0);
  });

  it('a git repository gets its worktree; git saying it is no repo after all works in the folder; any other failure is one', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    expect(inGitRepo(sub)).toBe(true);
    expect(inGitRepo(dir)).toBe(false);
    expect(await seatFolder(sub, true, async () => join(dir, 'wt'))).toEqual({ at: join(dir, 'wt') });
    expect(await seatFolder(repo, true, async () => { throw new Error(`${repo} isn't a git repo`); })).toEqual({ at: repo, noRepo: true });
    expect(await seatFolder(repo, true, async () => { throw new Error('git is busy'); })).toEqual({ error: `Couldn't make a worktree of ${repo}: git is busy` });
    expect(await seatFolder(repo, true)).toEqual({ error: "Worktrees aren't available here." });
    // a worktree's .git is a file
    const wt = join(dir, 'linked');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere');
    expect(inGitRepo(wt)).toBe(true);
  });
});

const seat = (id: string, name: string, path: string, worktree = false) => ({ id, name, instructions: '', agent: {}, skills: [], folder: { path, ...(worktree ? { worktree: true } : {}) }, count: { min: 1, max: 1 }, startup: {} });

function setup(t: Team, result: (name: string) => { made?: boolean; noRepo?: boolean }) {
  const projects = new Projects(null, () => 1);
  const p = projects.create('Ops');
  expect((projects.setTeam(p.id, t, 'you') as { ok?: boolean }).ok).not.toBe(false);
  const live = new Set<string>();
  const told: string[] = [];
  let n = 0;
  const rt = new TeamRuntime({
    projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => 1,
    launch: async (o) => {
      const sessionId = `s${++n}`;
      live.add(sessionId);
      return { sessionId, ...result(o.name) };
    },
    stop: (sid) => void live.delete(sid),
    live: (sid) => live.has(sid), idle: () => false,
    deliver: () => {}, tell: (x) => void told.push(x),
  });
  return { rt, projects, pid: p.id, live, told };
}

describe('what a bring-up says about the seats\' folders', () => {
  const t: Team = {
    version: 0,
    seats: [seat('fixer', 'Frontend fixer', 'C:/t'), seat('back', 'Backend fixer', 'C:/t'), seat('qa', 'QA', 'C:/t'), seat('docs', 'Docs', 'C:/d')],
    groups: [], labels: [], routes: [], fallback: 'user', escalation: [],
  };
  const res = (name: string) => (name.startsWith('docs') ? { made: true } : name.startsWith('qa') ? {} : { noRepo: true, ...(name.startsWith('fixer') ? { made: true } : {}) });

  it('once per bring-up, a line per folder: the seats working in it itself, and a folder Cora made', async () => {
    const { rt, pid, told, live, projects } = setup(t, res);
    const r = await rt.bringUp(pid);
    expect(r.problems).toEqual([]);
    expect(told).toEqual([
      "Ops: C:/t wasn't there, so Cora made it.",
      "Ops: Frontend fixer and Backend fixer work in C:/t itself: it isn't a git repository, so they have no worktrees of their own.",
      "Ops: C:/d wasn't there, so Cora made it.",
    ]);
    // a seat started again later in the same bring-up's life isn't said again
    const fixer = Object.entries(projects.get(pid)!.members).find(([, m]) => m.seat === 'fixer')![0];
    live.delete(fixer);
    await rt.tick(10 * 60_000);
    expect(told).toHaveLength(3);
    // the next bring-up says it again, for the seats it starts
    told.length = 0;
    live.clear();
    live.add(Object.entries(projects.get(pid)!.members).find(([, m]) => m.seat === 'qa')![0]);
    live.add(Object.entries(projects.get(pid)!.members).find(([, m]) => m.seat === 'docs')![0]);
    live.add(Object.entries(projects.get(pid)!.members).find(([, m]) => m.seat === 'back')![0]);
    await rt.bringUp(pid);
    expect(told).toEqual(["Ops: C:/t wasn't there, so Cora made it.", "Ops: Frontend fixer works in C:/t itself: it isn't a git repository, so it has no worktree of its own."]);
  });
});
