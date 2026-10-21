import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The MCP servers the user has connected to Claude Code (their names only; never their settings or secrets): user
 * scope in ~/.claude.json, and ~/.claude/settings.json. Cora's agent gets the read-only tools of the ones it knows
 * (matched however they're spelled: orchestrator/files.ts workServer), and its instructions name only what's there.
 * Project servers (.mcp.json, a folder's own in ~/.claude.json) aren't counted: Cora's agent runs in its own folder,
 * where they don't load. claude.ai connectors live with the account, not in a file: they aren't seen here.
 */
export function connectedMcp(o: { claudeJson?: string; settingsJson?: string } = {}, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  const files = [o.claudeJson ?? join(homedir(), '.claude.json'), o.settingsJson ?? join(homedir(), '.claude', 'settings.json')];
  const names = new Set<string>();
  for (const f of files) {
    try {
      const j = JSON.parse(read(f));
      for (const k of Object.keys(j?.mcpServers ?? {})) if (/^[\w.-]{1,64}$/.test(k)) names.add(k);
    } catch {
      /* no such file, or not JSON: nothing from it */
    }
  }
  return [...names].sort();
}
