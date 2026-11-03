import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { Projects } from '../src/projects';
import { TeamRuntime } from '../src/teams';
import { seatFiles } from '../src/teamAgents';
import { hostedArgs } from '../src/hosted';
import { loadConfig } from '../src/config';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-launch-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {}, ...o });
const team = (seats: unknown[]) => ({ version: 0, seats, groups: [], labels: [], routes: [], fallback: 'user', escalation: [] });

function setup(seats: unknown[], pluginDir: string | null = join(dir, 'plugin'), o: { resume?: boolean | 'fail'; watchFails?: boolean | 'string' } = {}) {
  const projects = new Projects(null, () => 1);
  const p = projects.create('Ops');
  const r = projects.setTeam(p.id, team(seats), 'you');
  expect((r as { ok?: boolean }).ok).not.toBe(false);
  const calls: any[] = [];
  const liveSet = new Set<string>();
  const stopped: string[] = [];
  const resumed: string[] = [];
  const dismissed: string[] = [];
  const delivered: Array<[string, string]> = [];
  const watched: any[] = [];
  const told: string[] = [];
  let n = 0;
  const rt = new TeamRuntime({
    projects, dataDir: join(dir, 'data'), pluginDir, now: () => 1,
    launch: async (o) => {
      calls.push(o);
      if (o.name.startsWith('bad-')) return { error: 'no folder' };
      const sessionId = `s${++n}`;
      liveSet.add(sessionId);
      return { sessionId };
    },
    ...(o.resume ? { resume: async (sid: string) => (o.resume === 'fail' ? { error: 'its transcript is gone' } : (resumed.push(sid), liveSet.add(sid), { sessionId: sid })) } : {}),
    stop: (sid) => { stopped.push(sid); liveSet.delete(sid); },
    dismiss: (sid) => void dismissed.push(sid),
    live: (sid) => liveSet.has(sid), idle: () => false,
    watch: (sid, w) => { if (o.watchFails === 'string') throw 'watches file is locked'; if (o.watchFails) throw new Error('watches file is locked'); watched.push([sid, w]); }, deliver: (sid, t) => void delivered.push([sid, t]), tell: (t) => void told.push(t),
  });
  return { rt, projects, pid: p.id, calls, stopped, watched, liveSet, resumed, delivered, dismissed, told };
}

describe('launching a team', () => {
  it('bringUp starts min of each seat with the right agent, prompt, settings and name; a second one starts nothing', async () => {
    const { rt, projects, pid, calls } = setup([seat('triage'), seat('dev', { agent: { permissionMode: 'acceptEdits' }, folder: { path: 'C:/x', worktree: true } })]);
    const r = await rt.bringUp(pid);
    expect(r).toEqual({ started: ['s1', 's2'], problems: [] });
    const f = seatFiles(join(dir, 'data'), pid, 'triage');
    // its agent in its team's own plugin; named by its seat and its project (seatHandle)
    expect(calls[0]).toMatchObject({ cwd: 'C:/work', name: `triage-${pid.slice(0, 4)}`, seat: { agent: `cora-team-${pid}:triage`, pluginDir: join(dir, 'data', 'team-plugins', pid), prompt: f.prompt, settings: f.settings } });
    expect(calls[1]).toMatchObject({ cwd: 'C:/x', worktree: true, name: `dev-${pid.slice(0, 4)}`, seat: { permissionMode: 'acceptEdits' } });
    expect(calls[0].label).toBe('triage');
    expect(projects.get(pid)!.members.s1.seat).toBe('triage');
    expect(projects.get(pid)!.members.s2.seat).toBe('dev');
    expect(await rt.bringUp(pid)).toEqual({ started: [], problems: [] });
    expect(calls).toHaveLength(2);
  });

  it("a seat whose watch can't be set still starts (it's said), and the rest of the team comes up", async () => {
    const w = { kind: 'gmail', about: 'alerts', from: 'alerts@x.com', then: 'Look into it.' };
    const { rt, pid, told } = setup([seat('triage', { startup: { watches: [w] } }), seat('dev')], undefined, { watchFails: true });
    const r = await rt.bringUp(pid);
    expect(r).toEqual({ started: ['s1', 's2'], problems: [] });
    expect(told).toEqual(["triage started, but its watch couldn't be set: watches file is locked."]);
  });

  it('a watch that throws something other than an Error is said the same way (it never fails the bring-up)', async () => {
    const w = { kind: 'gmail', about: 'alerts', from: 'alerts@x.com', then: 'Look into it.' };
    const { rt, pid, told } = setup([seat('triage', { startup: { watches: [w] } })], undefined, { watchFails: 'string' });
    expect((await rt.bringUp(pid)).started).toEqual(['s1']);
    expect(told).toEqual(["triage started, but its watch couldn't be set: watches file is locked."]);
  });

  it('the seat prompt file carries the seat card', async () => {
    const { rt, pid } = setup([seat('triage')]);
    await rt.bringUp(pid);
    const text = readFileSync(seatFiles(join(dir, 'data'), pid, 'triage').prompt, 'utf8');
    expect(text).toContain('Your seat: triage.\nYou may message: the user (anything).');
  });

  it('standDown stops all, or one seat', async () => {
    const { rt, pid, stopped } = setup([seat('a'), seat('b')]);
    await rt.bringUp(pid);
    await rt.standDown(pid, 'a');
    expect(stopped).toEqual(['s1']);
    await rt.standDown(pid);
    expect(stopped).toEqual(['s1', 's2']);
  });

  it('stood down, then brought up: the same sessions come back as themselves (told they are back); none started new', async () => {
    const { rt, projects, pid, calls, resumed, delivered } = setup([seat('a'), seat('b')], undefined, { resume: true });
    await rt.bringUp(pid);
    await rt.standDown(pid);
    await rt.tick(2);
    // closed, but kept: they're the team's, stood down
    expect(projects.get(pid)!.sessions).toEqual(['s1', 's2']);
    const r = await rt.bringUp(pid);
    expect(r.started).toEqual(['s1', 's2']);
    expect(resumed).toEqual(['s1', 's2']);
    expect(calls).toHaveLength(2);
    expect(delivered.map(([sid, t]) => [sid, t.slice(0, 22)])).toEqual([['s1', "You're back on duty as"], ['s2', "You're back on duty as"]]);
  });

  it("a member that can't be resumed is said in Cora's log (why), and a new one starts in its place", async () => {
    const { rt, pid, calls } = setup([seat('a')], undefined, { resume: 'fail' });
    await rt.bringUp(pid);
    await rt.standDown(pid);
    await rt.tick(2);
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.join(' ')));
    try {
      const r = await rt.bringUp(pid);
      expect(r.started).toEqual(['s2']);
      expect(calls).toHaveLength(2);
      expect(warns).toEqual([expect.stringMatching(/team: a's member s1 couldn't be resumed \(its transcript is gone\): a new one starts in its place/)]);
    } finally {
      spy.mockRestore();
    }
  });

  it('Start fresh: the members that ended are let go (out of the project and the session list), and every seat starts new', async () => {
    const { rt, projects, pid, resumed, dismissed } = setup([seat('a')], undefined, { resume: true });
    await rt.bringUp(pid);
    await rt.standDown(pid);
    await rt.tick(2);
    const r = await rt.bringUp(pid, { fresh: true });
    expect(r.started).toEqual(['s2']);
    expect(resumed).toEqual([]);
    expect(projects.get(pid)!.sessions).toEqual(['s2']);
    expect(dismissed).toEqual(['s1']);
  });

  it('Start fresh pressed while the stood-down members are still closing: they are let go once closed', async () => {
    const { rt, projects, pid, dismissed } = setup([seat('a')], undefined, { resume: true });
    await rt.bringUp(pid);
    await rt.standDown(pid);
    await rt.bringUp(pid, { fresh: true });
    await rt.tick(2);
    expect(projects.get(pid)!.sessions).toEqual(['s2']);
    expect(dismissed).toEqual(['s1']);
  });

  it("a pool's members above its minimum leave once closed; its standing ones are kept", async () => {
    const { rt, projects, pid, liveSet } = setup([seat('w', { count: { min: 1, max: 3 } })], undefined, { resume: true });
    await rt.bringUp(pid);
    // grown for load: a second member
    projects.add(pid, 's9');
    projects.setSeat(pid, 's9', 'w', 2);
    liveSet.add('s9');
    await rt.standDown(pid);
    await rt.tick(2);
    expect(projects.get(pid)!.sessions).toEqual(['s1']);
  });

  it('a member that died is brought back once; dying again, it is replaced by a fresh one and leaves', async () => {
    const { rt, projects, pid, liveSet, resumed } = setup([seat('a')], undefined, { resume: true });
    await rt.bringUp(pid);
    liveSet.delete('s1');
    await rt.bringUp(pid);
    expect(resumed).toEqual(['s1']);
    liveSet.delete('s1');
    const r = await rt.bringUp(pid);
    expect(r.started).toEqual(['s2']);
    expect(projects.get(pid)!.sessions).toEqual(['s2']);
  });

  it('a seat up and whole lets go of its members that ended (left over from before a Cora restart)', async () => {
    const { rt, projects, pid, dismissed } = setup([seat('a')], undefined, { resume: true });
    await rt.bringUp(pid);
    projects.add(pid, 'old');
    projects.setSeat(pid, 'old', 'a');
    await rt.tick(2);
    expect(projects.get(pid)!.sessions).toEqual(['s1']);
    expect(dismissed).toEqual(['old']);
  });

  it('without resume (an older Cora): members that ended leave, and seats start new', async () => {
    const { rt, projects, pid } = setup([seat('a'), seat('b')]);
    await rt.bringUp(pid);
    await rt.standDown(pid);
    await rt.tick(2);
    await rt.bringUp(pid);
    expect(projects.get(pid)!.sessions.sort()).toEqual(['s3', 's4']);
  });

  it('without the plugin: a problem, nothing started', async () => {
    const { rt, pid, calls } = setup([seat('a')], null);
    const r = await rt.bringUp(pid);
    expect(r.started).toEqual([]);
    expect(r.problems).toEqual(['Teams need Claude Code 2.1.287 or later (claude update).']);
    expect(calls).toHaveLength(0);
  });

  it('a pool seat starts count.min instances named <id>-1, <id>-2', async () => {
    const { rt, projects, pid, calls } = setup([seat('worker', { count: { min: 2, max: 3 } })]);
    await rt.bringUp(pid);
    expect(calls.map((c) => c.name)).toEqual([`worker-1-${pid.slice(0, 4)}`, `worker-2-${pid.slice(0, 4)}`]);
    expect(projects.get(pid)!.members.s2.instance).toBe(2);
    // called by their seat in Cora (with the instance, in a pool)
    expect(calls.map((c) => c.label)).toEqual(['worker 1', 'worker 2']);
  });

  it('startup prompt, monitor line and watches', async () => {
    const w = { kind: 'slack', channel: '#ops', about: 'ops', then: 'look' };
    const { rt, pid, calls, watched } = setup([seat('a', { startup: { prompt: 'Begin.', monitor: 'tail -f log', watches: [w] } }), seat('b')]);
    await rt.bringUp(pid);
    expect(calls[0].prompt).toBe('Begin.\nStart a Monitor on: tail -f log and act on what it reports.');
    expect(calls[1].prompt).toBeUndefined();
    expect(watched).toEqual([['s1', w]]);
  });

  it('bringing a team up turns its project\'s coordination on (its seats post and hear through it)', async () => {
    const { rt, projects, pid } = setup([seat('a')]);
    projects.update(pid, { coordination: false });
    await rt.bringUp(pid);
    expect(projects.get(pid)!.coordination).toBe(true);
  });

  it('a seated member resumed: its seat launch from the team as it is now; its seat gone: none, and it has no seat', async () => {
    const { rt, projects, pid } = setup([seat('triage', { agent: { permissionMode: 'plan' } }), seat('w', { count: { min: 0, max: 3 } })]);
    projects.add(pid, 'old-1');
    projects.add(pid, 'old-2');
    projects.setSeat(pid, 'old-1', 'triage');
    projects.setSeat(pid, 'old-2', 'w', 2);
    expect(rt.resumeSeat('old-1')).toEqual({ seat: { agent: `cora-team-${pid}:triage`, pluginDir: join(dir, 'data', 'team-plugins', pid), ...seatFiles(join(dir, 'data'), pid, 'triage'), permissionMode: 'plan' }, name: `triage-${pid.slice(0, 4)}` });
    expect(rt.resumeSeat('old-2')?.name).toBe(`w-2-${pid.slice(0, 4)}`);
    projects.setTeam(pid, team([seat('w', { count: { min: 0, max: 3 } })]), 'you');
    expect(rt.resumeSeat('old-1')).toBeNull();
    expect(projects.get(pid)!.members['old-1'].seat).toBeUndefined();
    expect(rt.resumeSeat('nobody')).toBeNull();
  });

  it("permission mode 'default' is Claude Code's own: no mode passed (it has no --permission-mode default)", async () => {
    const { rt, pid, calls } = setup([seat('a', { agent: { permissionMode: 'default' } })]);
    await rt.bringUp(pid);
    expect(calls[0].seat.permissionMode).toBeUndefined();
    expect(rt.resumeSeat('s1')?.seat.permissionMode).toBeUndefined();
  });

  it('a failed launch is a problem', async () => {
    const { rt, pid } = setup([seat('bad')]);
    const r = await rt.bringUp(pid);
    expect(r).toEqual({ started: [], problems: ['no folder'] });
  });
});

describe('hostedArgs for a seat', () => {
  it('one prompt file, one settings file, agent, permission mode', () => {
    const cfg = loadConfig({ dataDir: join(dir, 'cfg'), hookToken: 't', uiToken: 'u' });
    const prompt = join(dir, 'a.prompt.md'), settings = join(dir, 'a.settings.json');
    writeFileSync(prompt, 'SEAT PROMPT');
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
    const s = { ...DEFAULT_SETTINGS, worktrees: { move: 'collide' as const } };
    const args = hostedArgs(cfg, s, 'sess-0001', { pluginDir: '/p', name: 'x' }, { agent: 'cora-team-p:a', pluginDir: '/team-p', prompt, settings, permissionMode: 'plan', name: 'a-p' });
    expect(args[args.indexOf('--agent') + 1]).toBe('cora-team-p:a');
    expect(args[args.indexOf('--name') + 1]).toBe('a-p');
    // Cora's plugin, and its team's own (only its seats load it)
    expect(args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []))).toEqual(['/p', '/team-p']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args.filter((a) => a === '--append-system-prompt-file')).toHaveLength(1);
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    // its team messaging never stops at a permission prompt (the hand-off would wait on you)
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual(expect.arrayContaining(['SendMessage', 'mcp__cora__project_post', 'mcp__cora__project_claim', 'mcp__cora__project_item']));
    const text = readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
    // its own copies, by its session (an edit to the team never pulls them from under it)
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(join(dir, 'a.prompt.sess-0001.full.md'));
    expect(text).toMatch(/running inside Cora/);
    expect(text.endsWith('\n\nSEAT PROMPT')).toBe(true);
    const merged = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
    expect(args[args.indexOf('--settings') + 1]).toBe(join(dir, 'a.settings.sess-0001.full.json'));
    expect(merged.permissions.deny).toEqual(['Bash(rm:*)']);
    expect(merged.hooks.PreToolUse).toBeTruthy();
    // 'default': no flag
    const def = hostedArgs(cfg, s, 'sess-0001', { pluginDir: '/p', name: 'x' }, { agent: 'cora-team-p:a', pluginDir: '/team-p', prompt, settings, permissionMode: 'default', name: 'a-p' });
    expect(def).not.toContain('--permission-mode');
    expect(def).not.toContain('default');
    // without a seat: unchanged
    const plain = hostedArgs(cfg, s, 'sess-0001');
    expect(plain).not.toContain('--agent');
    expect(plain).not.toContain('--permission-mode');
    expect(plain[plain.indexOf('--allowedTools') + 1]).not.toContain('project_post');
    expect(plain.filter((a) => a === '--plugin-dir')).toHaveLength(0);
  });
});
