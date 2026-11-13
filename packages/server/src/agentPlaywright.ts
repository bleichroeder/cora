import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A hosted session's Playwright, in Cora's browser: when you use Playwright's MCP server (`playwright`, in your user
 * config, the folder's in ~/.claude.json, or its .mcp.json), the session's MCP config gets one of the same name (a
 * session's own config wins over the others: only it loads), started as yours is but connected over CDP to Cora's
 * browser (cdpBridge.ts) instead of opening a browser of its own. Same tools, same names: your permissions still fit.
 */
export type McpStdio = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export const PLAYWRIGHT = 'playwright';

/** Your Playwright MCP server, if you have one (the folder's own first, as Claude Code picks it), else null. */
export function findPlaywright(cwd: string | undefined, read: (p: string) => string = (p) => readFileSync(p, 'utf8'), home = homedir()): McpStdio | null {
  const json = (p: string) => {
    try {
      return JSON.parse(read(p));
    } catch {
      return null;
    }
  };
  const stdio = (s: unknown): McpStdio | null => {
    const x = s as McpStdio & { type?: string } | undefined;
    return x && (x.type === undefined || x.type === 'stdio') && typeof x.command === 'string' ? x : null;
  };
  const claude = json(join(home, '.claude.json'));
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const local = cwd ? Object.entries((claude?.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>).find(([k]) => norm(k) === norm(cwd))?.[1]?.mcpServers?.[PLAYWRIGHT] : undefined;
  const project = cwd ? json(join(cwd, '.mcp.json'))?.mcpServers?.[PLAYWRIGHT] : undefined;
  return stdio(local) ?? stdio(project) ?? stdio(claude?.mcpServers?.[PLAYWRIGHT]);
}

/** Its own browser's options, dropped: Cora's browser is the browser (a value-taking one takes its value with it). */
const OWN_BROWSER = new Set(['--cdp-endpoint', '--cdp-header', '--browser', '--executable-path', '--user-data-dir', '--storage-state', '--device', '--viewport-size', '--proxy-server', '--proxy-bypass']);
const OWN_BROWSER_FLAGS = new Set(['--isolated', '--headless', '--extension', '--no-sandbox']);

/** Yours, connected to Cora's browser at `endpoint` instead. */
export function playwrightInCora(yours: McpStdio, endpoint: string): McpStdio {
  const args: string[] = [];
  const a = yours.args ?? [];
  for (let i = 0; i < a.length; i++) {
    const [flag, inline] = a[i].split('=', 2);
    if (OWN_BROWSER_FLAGS.has(flag)) continue;
    if (OWN_BROWSER.has(flag)) {
      if (inline === undefined) i++;
      continue;
    }
    args.push(a[i]);
  }
  // files: the session reaches them anyway (its shell), so its Playwright may too: a file:// page (a preview it wrote),
  // a screenshot saved to its scratchpad. Playwright MCP blocks both by default since 0.0.8x. An environment variable,
  // not the flag, so a version without it still starts; yours wins if you set it.
  return { type: 'stdio', command: yours.command, args: [...args, '--cdp-endpoint', endpoint], env: { [FILE_ACCESS]: 'true', ...yours.env } };
}

export const FILE_ACCESS = 'PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS';
