import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, type AccountUsage } from '@cora/shared';

/** Where Claude Code keeps its login (its config folder, unless CLAUDE_CONFIG_DIR moves it). */
const credentialsPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
/** Asked at most this often, whatever asks (the session cards, the board, the usage view). */
const FRESH_MS = 60_000;

/**
 * Your plan's usage, as /usage shows it. It reads the login Claude Code keeps and asks the endpoint Claude Code itself
 * uses (not a documented API: an unknown answer just shows nothing). It only reads: it never refreshes the login (that
 * would sign Claude Code out) or keeps it; an expired one waits for Claude Code to run and refresh it.
 */
export function accountUsage(o: { fetch?: typeof fetch; read?: (p: string) => Promise<string>; now?: () => number } = {}) {
  const get = o.fetch ?? fetch;
  const read = o.read ?? ((p: string) => readFile(p, 'utf8'));
  const now = o.now ?? Date.now;
  let last: AccountUsage | null = null;
  let pending: Promise<AccountUsage> | null = null;

  const load = async (): Promise<AccountUsage> => {
    const at = now();
    let login: { accessToken?: string; expiresAt?: number; subscriptionType?: string } | undefined;
    try {
      login = JSON.parse(await read(credentialsPath())).claudeAiOauth;
    } catch {
      login = undefined;
    }
    if (!login?.accessToken) return { state: 'none', at, limits: [], message: "No Claude login here for Cora to read (Claude Code keeps it; on a Mac it's in the keychain)." };
    if (login.expiresAt && login.expiresAt < at) return { state: 'expired', at, limits: [], message: 'Your Claude login needs a refresh: it renews the next time Claude Code runs.' };
    try {
      const r = await get(ENDPOINT, { headers: { Authorization: `Bearer ${login.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) return { state: 'expired', at, limits: [], message: 'Your Claude login needs a refresh: it renews the next time Claude Code runs.' };
      if (!r.ok) return { state: 'error', at, limits: [], message: `Usage couldn't be read (HTTP ${r.status}).` };
      const u = normalizeUsage(await r.json(), at, login.subscriptionType);
      return u.limits.length || u.extra ? u : { state: 'error', at, limits: [], message: "Usage came back in a shape Cora doesn't know." };
    } catch (e) {
      return { state: 'error', at, limits: [], message: `Usage couldn't be read (${(e as Error).message}).` };
    }
  };

  return {
    /** The latest, asked again when it's more than a minute old (one ask at a time). */
    async get(): Promise<AccountUsage> {
      if (last && now() - last.at < FRESH_MS) return last;
      pending ??= load().finally(() => (pending = null));
      return (last = await pending);
    },
  };
}
