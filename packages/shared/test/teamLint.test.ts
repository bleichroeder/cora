import { describe, expect, it } from 'vitest';
import { checkTeam, clone, lintTeam, monitorFiles, newSeat, problemTarget, type Team } from '../src/index';
import { drill, drillDraft } from './fixtures';

const texts = (t: Team, ctx = {}) => lintTeam(t, ctx).map((x) => x.text);

describe("lintTeam: a seat's startup steps that can't run as written", () => {
  const monitored = (monitor: string, o: { folder?: string; instructions?: string; tools?: string[]; disallowed?: string[] } = {}) => {
    const t = drill();
    // only this one monitors (the drill's other monitor seat doesn't)
    for (const x of t.seats) delete x.startup.monitor;
    const s = t.seats[0];
    s.folder = { path: o.folder ?? 'C:\\work' };
    s.startup = { ...s.startup, monitor };
    if (o.instructions !== undefined) s.instructions = o.instructions;
    s.agent = { ...s.agent, ...(o.tools ? { tools: o.tools } : {}), ...(o.disallowed ? { disallowedTools: o.disallowed } : {}) };
    return { t, s };
  };
  const startupWarns = (t: Team, ctx = {}) => texts(t, ctx).filter((x) => /monitor/.test(x));

  it('a monitor on a file that is not on this PC and that no seat says it makes', () => {
    const { t, s } = monitored('tail -f ci.log');
    const seen: string[] = [];
    const warns = startupWarns(t, { fileExists: (p: string) => (seen.push(p), false) });
    expect(seen).toEqual(['C:\\work\\ci.log']);
    expect(warns).toEqual([`${s.name}'s monitor reads ci.log, which isn't on this PC and no seat says it makes it: as written it watches nothing. Have a seat make it, or point the monitor at something that's there.`]);
    expect(lintTeam(t, { fileExists: () => false }).find((x) => /ci\.log/.test(x.text))!.target).toEqual({ kind: 'seat', id: s.id });
    // it's there; or a seat says it makes it; or this PC wasn't asked: nothing
    expect(startupWarns(t, { fileExists: () => true })).toEqual([]);
    expect(startupWarns(t)).toEqual([]);
    const made = monitored('tail -f ci.log');
    made.t.seats[1].instructions = 'Run the tests and write their output to ci.log.';
    expect(startupWarns(made.t, { fileExists: () => false })).toEqual([]);
  });

  it('the files a monitor reads: full paths, in the seat folder, not options, URLs, modules or what the command writes itself', () => {
    const files = (cmd: string, folder = 'C:\\work') => monitorFiles(monitored(cmd, { folder }).s);
    expect(files('Get-Content -Wait -Path logs\\ci.log')).toEqual([{ name: 'ci.log', path: 'C:\\work\\logs\\ci.log' }]);
    expect(files('tail -F /var/log/app.log', '/srv/app')).toEqual([{ name: 'app.log', path: '/var/log/app.log' }]);
    expect(files('tail -f out.txt', '/srv/app')).toEqual([{ name: 'out.txt', path: '/srv/app/out.txt' }]);
    expect(files('tail -f "C:\\my logs\\x.log"')).toEqual([{ name: 'x.log', path: 'C:\\my logs\\x.log' }]);
    expect(files('npm test > ci.log; tail -f ci.log')).toEqual([]);
    expect(files('npm test 2>&1 | tee ci.log')).toEqual([]);
    expect(files('python -m http.server --log=a.log')).toEqual([]);
    expect(files('gh run watch https://example.com/x.json')).toEqual([]);
    expect(files('kubectl logs -f deploy/api')).toEqual([]);
    expect(files('node watch.js; tail -f a.log')).toEqual([{ name: 'watch.js', path: 'C:\\work\\watch.js' }, { name: 'a.log', path: 'C:\\work\\a.log' }]);
  });

  it('a monitor on a seat that may not use the Monitor tool', () => {
    const { t, s } = monitored('npm run watch', { disallowed: ['Monitor'] });
    expect(startupWarns(t)).toEqual([`${s.name} starts a monitor, but may not use the Monitor tool: it can't start it.`]);
    expect(startupWarns(monitored('npm run watch', { tools: ['Read', 'Bash'] }).t)).toEqual([`${s.name} starts a monitor, but Monitor isn't in its tools: it can't start it.`]);
    expect(startupWarns(monitored('npm run watch', { tools: ['Read', 'Monitor'] }).t)).toEqual([]);
    expect(startupWarns(monitored('npm run watch').t)).toEqual([]);
  });
});

describe('lintTeam: what the builder warns about', () => {
  it('the drill team: only that nothing handles ingest work', () => {
    expect(lintTeam(drill())).toEqual([{ level: 'warn', text: 'Analysts splits by issue but has nothing for ingest, and no else.', target: { kind: 'group', id: 'analysts' } }]);
  });

  it('a seat nobody messages and that messages nobody', () => {
    const t = drill();
    t.seats.push(newSeat('lonely', 'Lonely', 'C:/w'));
    expect(lintTeam(t)).toContainEqual({ level: 'warn', text: 'Lonely: nobody can message it, and it messages nobody.', target: { kind: 'seat', id: 'lonely' } });
  });

  it('seats only reached from their own loop (when the team has sources)', () => {
    const t = drill();
    t.seats.push(newSeat('x', 'X', 'C:/w'), newSeat('y', 'Y', 'C:/w'));
    t.routes.push({ id: 'xy', from: ['seat:x'], to: 'seat:y', kinds: 'any', wake: 'auto' }, { id: 'yx', from: ['seat:y'], to: 'seat:x', kinds: 'any', wake: 'auto' });
    expect(texts(t)).toEqual(expect.arrayContaining(['X: no route reaches it from you, Cora or a source, only from seats in its own loop.', 'Y: no route reaches it from you, Cora or a source, only from seats in its own loop.']));
  });

  it('a squad (everyone messages everyone, no source) is not warned about reaching', () => {
    const t: Team = { version: 0, seats: [newSeat('lead', 'Lead', 'C:/w'), newSeat('peer-1', 'Peer 1', 'C:/w')], groups: [{ id: 'squad', name: 'Squad', members: ['lead', 'peer-1'], dispatch: 'direct' }], labels: [], routes: [{ id: 'r-1', from: ['group:squad'], to: 'group:squad', kinds: 'any', wake: 'auto' }], fallback: 'seat:lead', escalation: [] };
    expect(lintTeam(t)).toEqual([]);
  });

  it('groups: empty, unreached, growing past the seat, a split that misses a value', () => {
    const t = drillDraft();
    t.groups.push({ id: 'spare', name: 'Spare', members: [], dispatch: 'claim' });
    t.groups.find((g) => g.id === 'encoder-analysts')!.grow = { seat: 'analyst-enc', max: 5 };
    expect(texts(t)).toEqual(expect.arrayContaining(['Spare has nobody in it.', "Encoder analysts grows to 5, above Encoder analyst's maximum of 2: it stops at 2."]));
  });

  it('a route carrying a label value its target group has nothing for', () => {
    const t = drill();
    t.routes.find((r) => r.id === 'r-handoff')!.labels!.issue.push('ingest');
    expect(texts(t)).toContain('Triage → Analysts carries issue ingest, but Analysts has nothing for it (it would go to everyone in Analysts).');
  });

  it('a seat that may act without asking (⚠), and one whose folder is not on this PC', () => {
    const t = drill();
    t.seats[2].agent.permissionMode = 'bypassPermissions';
    const out = texts(t, { folderExists: (p: string) => p !== 'C:\\ops\\drill' });
    expect(out).toContain('⚠ Triage may act without asking (bypassPermissions).');
    expect(out).toContain("Triage's folder C:\\ops\\drill isn't on this PC: it will be created when the team comes up.");
  });

  it("a seat whose 'may not use' takes away its team messaging: said (it can't message anyone without it)", () => {
    const t = drill();
    t.seats[2].agent.disallowedTools = ['Bash', 'mcp__cora__project_post', 'SendMessage'];
    expect(texts(t)).toContain("Triage may not use mcp__cora__project_post and SendMessage: without them it can't message its team.");
  });

  it('two seats of one name: said (the change lines and the team read alike for both)', () => {
    const t = drill();
    t.seats.push(newSeat('triage-b', 'Triage', 'C:\ops\drill'));
    expect(texts(t)).toContain('Two seats are called Triage: name them apart, or the team reads as one.');
  });

  it("a folder that isn't a full path is an error, never \"it will be created\"", () => {
    const t = drill();
    t.seats[2].folder = { path: 'ops' };
    const out = checkTeam(t, { folderExists: () => false });
    expect(out).toContainEqual({ level: 'error', text: 'Seat "triage": folder.path must be a full path (like C:\\work\\ops), not "ops".', target: { kind: 'seat', id: 'triage' } });
    expect(out.filter((c) => /^Triage/.test(c.text)).map((c) => c.text)).not.toContainEqual(expect.stringMatching(/will be created/));
  });

  it("a seat that wants a worktree of a folder that isn't a git repository works in the folder itself (said)", () => {
    const t = drill();
    t.seats[2].folder = { path: 'C:\\ops\\drill', worktree: true };
    const notRepo = { gitRepo: (p: string) => p !== 'C:\\ops\\drill' };
    expect(texts(t, notRepo)).toContain("Triage works in a worktree, but C:\\ops\\drill isn't a git repository: it will work in the folder itself.");
    expect(texts(t, { gitRepo: () => true }).some((x) => /git repository/.test(x))).toBe(false);
    // a seat without a worktree doesn't need one
    t.seats[2].folder = { path: 'C:\\ops\\drill' };
    expect(texts(t, notRepo).some((x) => x.startsWith('Triage') && /git repository/.test(x))).toBe(false);
    // a folder not there yet: made empty, so no worktree either (one line)
    t.seats[2].folder = { path: 'C:\\ops\\drill', worktree: true };
    const both = texts(t, { ...notRepo, folderExists: () => false }).filter((x) => x.startsWith('Triage'));
    expect(both).toEqual(["Triage's folder C:\\ops\\drill isn't on this PC: it will be created when the team comes up, and Triage will work in it itself (a new folder isn't a git repository, so it has no worktree)."]);
  });

  it('an ask route into a seat that is usually idle', () => {
    expect(texts(drillDraft(), { usuallyIdle: (id: string) => id === 'triage' })).toContain('Analysts → Triage wakes Triage only with your OK, and Triage is usually idle: every message on it will need your OK.');
  });

  it("never throws, whatever the draft holds: a check that can't run says so, plainly, about the team", () => {
    const off = [{ level: 'warn', text: "Some checks couldn't run on this draft as it is.", target: { kind: 'team' } }];
    expect(lintTeam({ version: 0, seats: [{ id: 'x' }], groups: [{ id: 'g' }], labels: [], routes: [{ id: 'r' }], fallback: 'user', escalation: [] } as unknown as Team)).toEqual(off);
    const failing = { folderExists: () => { throw new Error('denied'); } };
    expect(lintTeam(drillDraft(), failing)).toEqual(off);
    expect(lintTeam(drillDraft())).not.toContainEqual(off[0]);
  });
});

describe('checkTeam: errors first (Apply is off), then warnings', () => {
  it("validateTeam's problems are errors, each pointing at what it is about", () => {
    const t = clone(drill());
    t.seats[2].count = { min: 3, max: 1 };
    const out = checkTeam(t);
    expect(out[0]).toEqual({ level: 'error', text: 'Seat "triage" has count.min 3 above count.max 1.', target: { kind: 'seat', id: 'triage' } });
    expect(out.at(-1)!.level).toBe('warn');
  });

  it('problem targets', () => {
    expect(problemTarget('Group "analysts" splits to "x", which is not a member.')).toEqual({ kind: 'group', id: 'analysts' });
    expect(problemTarget('Route "r-1" needs at least one "from".')).toEqual({ kind: 'route', id: 'r-1' });
    expect(problemTarget('Escalation rule 2: "then" must be a list of steps.')).toEqual({ kind: 'team' });
    expect(problemTarget('The lead "ghost" is not a seat in the team.')).toEqual({ kind: 'team' });
    expect(problemTarget('Duplicate seat id "x".')).toBeUndefined();
  });
});
