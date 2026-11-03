import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SEAT_MESSAGING_TOOLS, teamPluginName, type Seat, type Team } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * A team's seats as Claude Code agents. Each team has its own plugin
 * (`<data>/team-plugins/<project>/`, named `cora-team-<project>`), loaded only into that team's seats: its seats are
 * agents there (`cora-team-<project>:<seat>`) and its skills are that plugin's skills, so one team's agents and skills
 * never reach another team's sessions (nor anyone else's). Each agent file has an EMPTY body: a non-empty agent prompt
 * would replace Claude Code's whole system prompt, so the seat's instructions go in a separate prompt file that Cora
 * appends. Plugin agents ignore permissionMode, hooks and mcpServers, so permissions live in a per-seat settings file.
 */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** a running seat's own copies of its prompt and settings (hostedArgs writes them): kept this long */
const FULL_KEEP_MS = 30 * 86_400_000;

/** A team's own plugin folder. */
export function teamPluginDir(dataDir: string, projectId: string): string {
  return join(dataDir, 'team-plugins', projectId);
}

/** The seat's prompt and settings files (in Cora's data folder). */
export function seatFiles(dataDir: string, projectId: string, seatId: string): { prompt: string; settings: string } {
  const dir = join(dataDir, 'teams', projectId);
  return { prompt: join(dir, `${seatId}.prompt.md`), settings: join(dir, `${seatId}.settings.json`) };
}

/** Writes a file only when its content differs (so nothing reloads for nothing). */
function put(path: string, body: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === body) return;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileAtomic(path, body);
}

const q = (s: string) => JSON.stringify(s);

function agentFile(projectId: string, team: Team, seat: Seat): string {
  const a = seat.agent;
  const skillNames = new Map((team.skills ?? []).map((s) => [slug(s.name), `${teamPluginName(projectId)}:${slug(s.name)}`]));
  const lines = ['---', `name: ${q(slug(seat.id))}`, `description: ${q(`${seat.name} in a Cora team`)}`];
  // a list of tools keeps the team's messaging tools (SEAT_MESSAGING_TOOLS), unless the team took one away
  if (a.tools?.length) {
    const away = new Set(a.disallowedTools ?? []);
    const tools = [...new Set([...a.tools, ...SEAT_MESSAGING_TOOLS.filter((t) => !away.has(t))])];
    lines.push(`tools: ${q(tools.join(', '))}`);
  }
  if (a.disallowedTools?.length) lines.push(`disallowedTools: ${q(a.disallowedTools.join(', '))}`);
  if (a.model) lines.push(`model: ${q(a.model)}`);
  if (a.effort) lines.push(`effort: ${q(a.effort)}`);
  if (seat.skills.length) {
    lines.push('skills:');
    for (const s of seat.skills) lines.push(`  - ${q(skillNames.get(slug(s)) ?? s)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function settingsFile(seat: Seat): string {
  const p = seat.agent.permissions ?? {};
  const permissions: Record<string, string[]> = {};
  for (const k of ['allow', 'ask', 'deny'] as const) if (p[k]?.length) permissions[k] = p[k] as string[];
  return JSON.stringify({ permissions }, null, 2);
}

/** Removes a folder's entries except `keep` (and those `spare` says to leave). */
function prune(dir: string, keep: Set<string>, spare: (name: string) => boolean = () => false): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (!keep.has(name) && !spare(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

/**
 * Writes the team's plugin (every seat's agent file and every team skill), each seat's prompt and settings; deletes this
 * project's that no longer belong. A running seat's own copies (`*.full.md`, `*.full.json`: what it was started with)
 * stay while they're recent. Returns the team's plugin folder.
 */
export function writeTeamArtifacts(dataDir: string, projectId: string, team: Team, card: (seat: Seat) => string): string {
  const plugin = teamPluginDir(dataDir, projectId);
  put(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: teamPluginName(projectId), version: '0.1.0', description: "A Cora team's seats and skills", author: { name: 'Cora' } }, null, 2));
  const agents = new Set<string>();
  const seatIds = new Set<string>();
  for (const seat of team.seats) {
    const name = `${slug(seat.id)}.md`;
    agents.add(name);
    put(join(plugin, 'agents', name), agentFile(projectId, team, seat));
    const f = seatFiles(dataDir, projectId, seat.id);
    seatIds.add(`${seat.id}.prompt.md`).add(`${seat.id}.settings.json`);
    put(f.prompt, `# Your seat: ${seat.name}\n\n${seat.instructions.trim()}\n\n${card(seat).trim()}\n`);
    put(f.settings, settingsFile(seat));
  }
  const skills = new Set<string>();
  for (const s of team.skills ?? []) {
    const dir = slug(s.name);
    skills.add(dir);
    put(join(plugin, 'skills', dir, 'SKILL.md'), `---\nname: ${q(dir)}\ndescription: ${q(s.description)}\n---\n\n${s.body.trim()}\n`);
  }
  prune(join(plugin, 'agents'), agents);
  prune(join(plugin, 'skills'), skills);
  const seatDir = join(dataDir, 'teams', projectId);
  const now = Date.now();
  prune(seatDir, seatIds, (name) => {
    if (!/\.full\.(md|json)$/.test(name)) return false;
    try {
      return now - statSync(join(seatDir, name)).mtimeMs < FULL_KEEP_MS;
    } catch {
      return false;
    }
  });
  return plugin;
}

/** Removes everything this project wrote (its plugin, its seats' files). */
export function removeTeamArtifacts(dataDir: string, projectId: string): void {
  rmSync(teamPluginDir(dataDir, projectId), { recursive: true, force: true });
  rmSync(join(dataDir, 'teams', projectId), { recursive: true, force: true });
}
