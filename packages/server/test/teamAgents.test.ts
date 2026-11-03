import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEAT_MESSAGING_TOOLS, type Seat, type Team } from '@cora/shared';
import { removeTeamArtifacts, seatFiles, teamPluginDir, writeTeamArtifacts } from '../src/teamAgents';
import { writeCoraPlugin } from '../src/coraPlugin';

const seat = (id: string, over: Partial<Seat> = {}): Seat => ({
  id, name: id.toUpperCase(), instructions: '  Do the thing.  ', agent: {}, skills: [], folder: { path: '.' },
  count: { min: 1, max: 1 }, startup: {}, ...over,
});
const team = (seats: Seat[], skills: Team['skills'] = []): Team => ({ version: 1, seats, groups: [], labels: [], routes: [], fallback: 'user', escalation: [], skills });
const card = (s: Seat) => `card for ${s.id}\n`;
const data = () => mkdtempSync(join(tmpdir(), 'ta-d-'));
const agentOf = (d: string, pid: string, id: string) => join(teamPluginDir(d, pid), 'agents', `${id}.md`);

describe('writeTeamArtifacts', () => {
  it("writes the team's own plugin: its manifest, and each agent file with exact frontmatter and an empty body", () => {
    const d = data();
    const s = seat('dev', { agent: { model: 'sonnet', effort: 'high', tools: ['Read', 'Edit'], disallowedTools: ['Bash'] }, skills: ['a', 'b'] });
    expect(writeTeamArtifacts(d, 'proj1', team([s]), card)).toBe(join(d, 'team-plugins', 'proj1'));
    expect(JSON.parse(readFileSync(join(d, 'team-plugins', 'proj1', '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'cora-team-proj1' });
    expect(readFileSync(agentOf(d, 'proj1', 'dev'), 'utf8')).toBe(
      `---\nname: "dev"\ndescription: "DEV in a Cora team"\ntools: "Read, Edit, ${SEAT_MESSAGING_TOOLS.join(', ')}"\ndisallowedTools: "Bash"\nmodel: "sonnet"\neffort: "high"\nskills:\n  - "a"\n  - "b"\n---\n`,
    );
  });
  it("a seat given a list of tools keeps the team's messaging tools: without them it can't message anyone (found live: no SendMessage, no project_post)", () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('a', { agent: { tools: ['Read', 'Write', 'Bash'] } })]), card);
    const tools = /tools: "([^"]*)"/.exec(readFileSync(agentOf(d, 'p', 'a'), 'utf8'))![1].split(', ');
    for (const t of ['SendMessage', 'mcp__cora__project_post', 'mcp__cora__project_read']) expect(tools).toContain(t);
    expect(tools.slice(0, 3)).toEqual(['Read', 'Write', 'Bash']);
  });
  it('a messaging tool you took away from a seat stays away; one you listed yourself is not listed twice', () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('a', { agent: { tools: ['Read', 'SendMessage'], disallowedTools: ['mcp__cora__project_post'] } })]), card);
    const tools = /tools: "([^"]*)"/.exec(readFileSync(agentOf(d, 'p', 'a'), 'utf8'))![1].split(', ');
    expect(tools.filter((t) => t === 'SendMessage')).toHaveLength(1);
    expect(tools).not.toContain('mcp__cora__project_post');
  });
  it('omits unset keys and an empty skills list', () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('x')]), card);
    expect(readFileSync(agentOf(d, 'p', 'x'), 'utf8')).toBe('---\nname: "x"\ndescription: "X in a Cora team"\n---\n');
  });
  it('writes prompt and settings (only set lists, never permissionMode)', () => {
    const d = data();
    const s = seat('dev', { agent: { permissionMode: 'plan', permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] } } });
    writeTeamArtifacts(d, 'p', team([s]), card);
    const f = seatFiles(d, 'p', 'dev');
    expect(readFileSync(f.prompt, 'utf8')).toBe('# Your seat: DEV\n\nDo the thing.\n\ncard for dev\n');
    expect(JSON.parse(readFileSync(f.settings, 'utf8'))).toEqual({ permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] } });
    expect(readFileSync(agentOf(d, 'p', 'dev'), 'utf8')).not.toContain('permissionMode');
  });
  it("writes team skills in the team's plugin", () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('x')], [{ name: 'Triage Bugs', description: 'How: to triage', body: 'Steps.' }]), card);
    expect(readFileSync(join(teamPluginDir(d, 'p'), 'skills', 'triage-bugs', 'SKILL.md'), 'utf8')).toBe('---\nname: "triage-bugs"\ndescription: "How: to triage"\n---\n\nSteps.\n');
  });
  it("names a team skill a seat uses by its team plugin's name", () => {
    const d = data();
    const s = seat('x', { skills: ['Triage Bugs', 'other'] });
    writeTeamArtifacts(d, 'p', team([s], [{ name: 'Triage Bugs', description: 'd', body: 'b' }]), card);
    expect(readFileSync(agentOf(d, 'p', 'x'), 'utf8')).toContain('skills:\n  - "cora-team-p:triage-bugs"\n  - "other"\n');
  });
  it('keeps mtime of unchanged files', () => {
    const d = data();
    const t = team([seat('x')], [{ name: 's', description: 'd', body: 'b' }]);
    writeTeamArtifacts(d, 'p', t, card);
    const files = [agentOf(d, 'p', 'x'), seatFiles(d, 'p', 'x').prompt, seatFiles(d, 'p', 'x').settings, join(teamPluginDir(d, 'p'), 'skills', 's', 'SKILL.md')];
    for (const f of files) utimesSync(f, 1000, 1000);
    writeTeamArtifacts(d, 'p', t, card);
    for (const f of files) expect(statSync(f).mtimeMs).toBe(1_000_000);
  });
  it('deletes what no longer belongs, only for this project; two teams never share a plugin', () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('a'), seat('b')], [{ name: 's', description: 'd', body: 'b' }]), card);
    writeTeamArtifacts(d, 'q', team([seat('a')]), card);
    writeTeamArtifacts(d, 'p', team([seat('a')]), card);
    expect(existsSync(agentOf(d, 'p', 'b'))).toBe(false);
    expect(existsSync(join(teamPluginDir(d, 'p'), 'skills', 's'))).toBe(false);
    expect(existsSync(seatFiles(d, 'p', 'b').prompt)).toBe(false);
    expect(existsSync(seatFiles(d, 'p', 'b').settings)).toBe(false);
    expect(existsSync(agentOf(d, 'p', 'a'))).toBe(true);
    expect(existsSync(agentOf(d, 'q', 'a'))).toBe(true);
  });
  it("keeps a running seat's own launch files (*.full.md, *.full.json) while they're recent", () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('a'), seat('b')]), card);
    const dir = join(d, 'teams', 'p');
    for (const f of ['a.prompt.sess-1.full.md', 'a.settings.sess-1.full.json', 'b.prompt.sess-2.full.md', 'old.prompt.full.md']) writeFileSync(join(dir, f), 'x');
    utimesSync(join(dir, 'old.prompt.full.md'), 1000, 1000);
    // b removed while its member runs: its launch files stay; a month-old one goes
    writeTeamArtifacts(d, 'p', team([seat('a')]), card);
    expect(readdirSync(dir).sort()).toEqual(['a.prompt.md', 'a.prompt.sess-1.full.md', 'a.settings.json', 'a.settings.sess-1.full.json', 'b.prompt.sess-2.full.md']);
  });
});

describe('removeTeamArtifacts', () => {
  it('removes everything the project wrote and nothing else', () => {
    const d = data();
    writeTeamArtifacts(d, 'p', team([seat('a')], [{ name: 's', description: 'd', body: 'b' }]), card);
    writeTeamArtifacts(d, 'q', team([seat('a')]), card);
    removeTeamArtifacts(d, 'p');
    expect(readdirSync(join(d, 'team-plugins'))).toEqual(['q']);
    expect(existsSync(join(d, 'teams', 'p'))).toBe(false);
    expect(existsSync(join(d, 'teams', 'q'))).toBe(true);
  });
  it('is fine when nothing was written', () => {
    expect(() => removeTeamArtifacts(data(), 'nope')).not.toThrow();
  });
});

describe("Cora's own plugin", () => {
  it("drops teams' agents and skills an older Cora wrote there (each team has its own plugin now)", () => {
    const d = data();
    const dir = writeCoraPlugin(d, 'http://127.0.0.1:1', 't');
    for (const f of ['agents/team-p-a.md', 'skills/team-p-s/SKILL.md', 'agents/mine.md']) {
      const at = join(dir, f);
      mkdirSync(join(at, '..'), { recursive: true });
      writeFileSync(at, 'x');
    }
    writeCoraPlugin(d, 'http://127.0.0.1:1', 't');
    expect(readdirSync(join(dir, 'agents'))).toEqual(['mine.md']);
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['cora-project']);
  });
});
