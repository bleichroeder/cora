import { open, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

/** A slash command you can type in a session: one of your skills or commands, a project's, or an enabled plugin's. */
export type SlashCommand = {
  name: string;
  description: string;
  /** what goes after it, from the frontmatter's argument-hint (e.g. "<issue-key or URL>") */
  hint?: string;
  kind: 'skill' | 'command';
  /** where it comes from: project, user, or the plugin's name */
  source: string;
};

/** The frontmatter fields we show (a tiny YAML subset: `key: value`, quoted values, folded `>` / `|` blocks). */
export function frontmatter(md: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      v = block.join(v.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[kv[1].toLowerCase()] = v;
  }
  return out;
}

/** A command file without a description is described by its first line of text (as Claude Code does). */
const firstLine = (md: string) =>
  md
    .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean) ?? '';

/** The start of a file is enough for its frontmatter (skills can be long). */
async function head(file: string, bytes = 8192): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function skillsIn(dir: string, source: string, prefix = ''): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const md = await head(join(dir, e.name, 'SKILL.md'));
    if (md == null) continue;
    const f = frontmatter(md);
    if (f['user-invocable'] === 'false') continue;
    out.push({ name: prefix + (f.name || e.name), description: clip(f.description || firstLine(md)), ...(f['argument-hint'] ? { hint: f['argument-hint'] } : {}), kind: 'skill', source });
  }
  return out;
}

/** Commands are .md files, in subfolders too (a subfolder groups them; the name is the file's). */
async function commandsIn(dir: string, source: string, prefix = '', depth = 0): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (e.isDirectory() && depth < 3) out.push(...(await commandsIn(join(dir, e.name), source, prefix, depth + 1)));
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const md = await head(join(dir, e.name));
    if (md == null) continue;
    const f = frontmatter(md);
    out.push({ name: prefix + basename(e.name, '.md'), description: clip(f.description || firstLine(md)), ...(f['argument-hint'] ? { hint: f['argument-hint'] } : {}), kind: 'command', source });
  }
  return out;
}

/** Plugins switched on in your Claude Code settings, with where they're installed. */
async function enabledPlugins(claudeDir: string): Promise<Array<{ name: string; path: string }>> {
  try {
    const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    const installed = JSON.parse(await readFile(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const on = Object.entries(settings?.enabledPlugins ?? {}).filter(([, v]) => v === true).map(([k]) => k);
    return on.flatMap((key) => {
      const p = (installed?.plugins?.[key] ?? [])[0]?.installPath;
      return typeof p === 'string' ? [{ name: key.split('@')[0], path: p }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Everything you can run with `/` in a session in `cwd`: the project's skills and commands, yours (`claudeDir`,
 * normally ~/.claude) and your enabled plugins' (`plugin:name`). A project one hides a personal one of the same name.
 */
export async function listCommands(o: { claudeDir: string; cwd?: string | null }): Promise<SlashCommand[]> {
  const project = o.cwd ? join(o.cwd, '.claude') : null;
  // a session in your home folder would list your own ones twice
  const isHome = project != null && relative(project, o.claudeDir) === '';
  const groups: SlashCommand[][] = [];
  if (project && !isHome) groups.push(await skillsIn(join(project, 'skills'), 'project'), await commandsIn(join(project, 'commands'), 'project'));
  groups.push(await skillsIn(join(o.claudeDir, 'skills'), 'user'), await commandsIn(join(o.claudeDir, 'commands'), 'user'));
  for (const p of await enabledPlugins(o.claudeDir)) {
    groups.push(await skillsIn(join(p.path, 'skills'), p.name, `${p.name}:`), await commandsIn(join(p.path, 'commands'), p.name, `${p.name}:`));
  }
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const c of groups.flat()) {
    const key = c.name.toLowerCase();
    if (seen.has(key) || !/^[\w.:-]+$/.test(c.name)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
