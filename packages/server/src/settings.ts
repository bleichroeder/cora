import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { LEGACY_TOKEN_HEADER, TOKEN_HEADER } from '@cora/shared';
import { writeFileAtomic } from './fsx';

// SessionEnd prints a one-line failure on exit when the server is down (spike S3); accepted now that the
// desktop app keeps the server running, because it's the only way to see external sessions exit promptly.
export const OBSERVE_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'Notification', 'PreCompact',
] as const;
export const BLOCKING_EVENTS = ['PermissionRequest', 'Elicitation'] as const;

/** Seconds Claude Code waits on a blocking hook; must exceed the server hold time (120 s). */
/**
 * How long Claude Code waits for a prompt's answer from Cora. Cora itself holds a prompt only 2 minutes while you're at
 * the PC (then the terminal's own prompt decides); a prompt that went to your phone (Cora's Slack bot) waits longer.
 */
export const BLOCKING_TIMEOUT_S = 3600;

export type HttpHook = {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  allowedEnvVars?: string[];
  async?: boolean;
  timeout?: number;
};
export type HookMatcher = { matcher?: string; hooks: any[] };
export type Settings = Record<string, any>;

export function settingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

export function computeHooksBlock(o: { port: number; token: string; envToken?: boolean }): Record<string, HookMatcher[]> {
  const hook = (ev: string, blocking: boolean): HttpHook => ({
    type: 'http',
    url: `http://127.0.0.1:${o.port}/hook/${ev}`,
    headers: { [TOKEN_HEADER]: o.envToken ? '$CORA_TOKEN' : o.token },
    ...(o.envToken ? { allowedEnvVars: ['CORA_TOKEN'] } : {}),
    ...(blocking ? { timeout: BLOCKING_TIMEOUT_S } : { async: true }),
  });
  const out: Record<string, HookMatcher[]> = {};
  for (const ev of OBSERVE_EVENTS) out[ev] = [{ matcher: '*', hooks: [hook(ev, false)] }];
  for (const ev of BLOCKING_EVENTS) out[ev] = [{ matcher: '*', hooks: [hook(ev, true)] }];
  return out;
}

/** Our hooks are recognised by shape, so no custom keys are written into settings.json (old ones by the old header). */
export function isOurs(h: any): boolean {
  return h?.type === 'http' && typeof h.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/hook\//.test(h.url) && !!h.headers && (TOKEN_HEADER in h.headers || LEGACY_TOKEN_HEADER in h.headers);
}

/**
 * Are Cora's hooks in these settings, and aimed at this server (its port, and its key or an env reference)? 'none';
 * 'here'; or 'elsewhere': they point at another Cora (a test install on another port) or carry an old key, so every
 * event gets turned away (audit B4).
 */
export function hooksAimed(settings: Settings, target: { port: number; token: string }): { state: 'none' | 'here' | 'elsewhere'; port?: number } {
  const ours = Object.values<HookMatcher[]>(settings.hooks ?? {}).flatMap((l) => (Array.isArray(l) ? l : []).flatMap((m) => m.hooks ?? [])).filter(isOurs);
  if (!ours.length) return { state: 'none' };
  const key = (h: any) => String(h.headers[TOKEN_HEADER] ?? h.headers[LEGACY_TOKEN_HEADER] ?? '');
  const off = ours.find((h: any) => !h.url.startsWith(`http://127.0.0.1:${target.port}/hook/`) || (key(h) !== target.token && !key(h).startsWith('$')));
  if (!off) return { state: 'here' };
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)\//.exec(off.url)?.[1]);
  return { state: 'elsewhere', ...(port && port !== target.port ? { port } : {}) };
}

/** Hooks written before the rename (old header) that can be rewritten as is: not the env-token kind, whose variable the user set by hand. */
export function legacyHooks(settings: Settings, target?: { port: number; token: string }): { found: boolean; envToken: boolean } {
  const ours = Object.values<HookMatcher[]>(settings.hooks ?? {}).flatMap((l) => (Array.isArray(l) ? l : []).flatMap((m) => m.hooks ?? [])).filter(isOurs);
  // only hooks aimed at this server (its port, its token or an env reference): a test instance elsewhere leaves them be
  const aimed = (h: any) => !target || (h.url.startsWith(`http://127.0.0.1:${target.port}/hook/`) && (h.headers[LEGACY_TOKEN_HEADER] === target.token || String(h.headers[LEGACY_TOKEN_HEADER]).startsWith('$')));
  const old = ours.filter((h: any) => LEGACY_TOKEN_HEADER in h.headers && aimed(h));
  return { found: old.length > 0, envToken: old.some((h: any) => String(h.headers[LEGACY_TOKEN_HEADER]).startsWith('$')) };
}

/** Our hooks for this server whose wait is shorter than Cora's now (written by an older Cora): rewrite them. */
export function shortHooks(settings: Settings, target: { port: number; token: string }): boolean {
  const ours = Object.values<HookMatcher[]>(settings.hooks ?? {}).flatMap((l) => (Array.isArray(l) ? l : []).flatMap((m) => m.hooks ?? [])).filter(isOurs);
  return ours.some((h: any) => h.url.startsWith(`http://127.0.0.1:${target.port}/hook/`) && h.headers[TOKEN_HEADER] === target.token && typeof h.timeout === 'number' && h.timeout < BLOCKING_TIMEOUT_S);
}

export function removeHooks(settings: Settings): Settings {
  const out: Settings = structuredClone(settings);
  if (!out.hooks) return out;
  for (const [ev, list] of Object.entries<HookMatcher[]>(out.hooks)) {
    const kept = (Array.isArray(list) ? list : [])
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((m) => m.hooks.length > 0);
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export function mergeHooks(settings: Settings, block: Record<string, HookMatcher[]>): Settings {
  const out = removeHooks(settings);
  out.hooks ??= {};
  for (const [ev, list] of Object.entries(block)) out.hooks[ev] = [...(out.hooks[ev] ?? []), ...structuredClone(list)];
  return out;
}

/** Minimal line diff (LCS) for showing the settings change before writing it. */
export function diffText(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join('\n');
}

/** Claude Code's settings file can't be read as JSON: Cora leaves it alone and says so (docs/audit-2026-10-20.md B3). */
export class SettingsFileError extends Error {}

export function readSettings(file = settingsPath()): { raw: string; json: Settings } {
  if (!existsSync(file)) return { raw: '', json: {} };
  const raw = readFileSync(file, 'utf8');
  try {
    return { raw, json: raw.trim() ? JSON.parse(raw) : {} };
  } catch (e) {
    throw new SettingsFileError(`${file} isn't valid JSON (${(e as Error).message}). Fix it, and Cora can add its hooks; until then it doesn't touch it.`);
  }
}

export function writeSettings(json: Settings, file = settingsPath()): string | null {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.cora-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    // only the newest backup is kept: each holds Cora's hook key, and they'd pile up forever (audit S11)
    const prefix = `${basename(file)}.cora-backup-`;
    for (const f of readdirSync(dirname(file))) {
      if (f.startsWith(prefix) && join(dirname(file), f) !== backup) rmSync(join(dirname(file), f), { force: true });
    }
  }
  writeFileAtomic(file, JSON.stringify(json, null, 2) + '\n');
  return backup;
}
