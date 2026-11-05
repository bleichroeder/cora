import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, type AccountUsage } from '@cora/shared';

/** Where Claude Code keeps its login (its config folder, unless CLAUDE_CONFIG_DIR moves it). */
const credentialsPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
/** Asked at most this often, whatever asks (the session cards, the board, the usage view): usage moves slowly. */
export const FRESH_MS = 5 * 60_000;
/**
 * Rate-limited (429: every Cora on the machine, and Claude Code itself, read the one login): asked again after its
 * Retry-After, else after 5 minutes, doubling to 30. Other failures: after 1 minute, doubling to 10.
 */
const LIMITED_MS = [5 * 60_000, 30 * 60_000] as const;
const FAILED_MS = [60_000, 10 * 60_000] as const;
/** a Retry-After taken as said, within these */
const RETRY_AFTER_MS = [30_000, 2 * 3_600_000] as const;

/** Retry-After as ms from now (seconds, or an HTTP date), or null when it's missing or makes no sense. */
export function retryAfterMs(h: string | null, now: number): number | null {
  if (!h) return null;
  const v = h.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(RETRY_AFTER_MS[1], Math.max(RETRY_AFTER_MS[0], ms)) : null;
}

const hhmm = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Your plan's usage, as /usage shows it. It reads the login Claude Code keeps and asks the endpoint Claude Code itself
 * uses (not a documented API: an unknown answer just shows nothing). It only reads: it never refreshes the login (that
 * would sign Claude Code out) or keeps it; an expired one waits for Claude Code to run and refresh it. When asking
 * fails, the last good reading stays on show (marked stale) and it asks again later, longer each time (`off`: a test
 * Cora, CORA_NO_USAGE, never asks).
 */
export function accountUsage(o: { fetch?: typeof fetch; read?: (p: string) => Promise<string>; now?: () => number; off?: () => boolean } = {}) {
  const get = o.fetch ?? fetch;
  const read = o.read ?? ((p: string) => readFile(p, 'utf8'));
  const now = o.now ?? Date.now;
  const off = o.off ?? (() => !!process.env.CORA_NO_USAGE);
  /** what's shown, the last good reading, when to ask again, and the wait that failing now gives */
  let shown: AccountUsage | null = null;
  let good: AccountUsage | null = null;
  let nextAt = 0;
  let wait = 0;
  /** what the last failure was (a different one starts its own wait) */
  let how: 'limited' | 'failed' | null = null;
  let pending: Promise<AccountUsage> | null = null;

  /** An answer, and whether it's a failure worth waiting out (how: rate-limited, with its Retry-After, or other). */
  type Read = { u: AccountUsage; fail?: { limited: boolean; retryAfter: number | null } };
  const load = async (): Promise<Read> => {
    const at = now();
    let login: { accessToken?: string; expiresAt?: number; subscriptionType?: string } | undefined;
    try {
      login = JSON.parse(await read(credentialsPath())).claudeAiOauth;
    } catch {
      login = undefined;
    }
    if (!login?.accessToken) return { u: { state: 'none', at, limits: [], message: "No Claude login here for Cora to read (Claude Code keeps it; on a Mac it's in the keychain)." } };
    if (login.expiresAt && login.expiresAt < at) return { u: { state: 'expired', at, limits: [], message: 'Your Claude login needs a refresh: it renews the next time Claude Code runs.' } };
    const failed = (message: string, limited = false, retryAfter: number | null = null): Read => ({ u: { state: 'error', at, limits: [], message }, fail: { limited, retryAfter } });
    try {
      const r = await get(ENDPOINT, { headers: { Authorization: `Bearer ${login.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) return { u: { state: 'expired', at, limits: [], message: 'Your Claude login needs a refresh: it renews the next time Claude Code runs.' } };
      if (r.status === 429) return failed('Usage is asked for too often just now (HTTP 429).', true, retryAfterMs(r.headers.get('retry-after'), at));
      if (!r.ok) return failed(`Usage couldn't be read (HTTP ${r.status}).`);
      const u = normalizeUsage(await r.json(), at, login.subscriptionType);
      return u.limits.length || u.extra ? { u } : failed("Usage came back in a shape Cora doesn't know.");
    } catch (e) {
      return failed(`Usage couldn't be read (${(e as Error).message}).`);
    }
  };

  const settle = ({ u, fail }: Read): AccountUsage => {
    const t = now();
    if (!fail) {
      wait = 0;
      how = null;
      nextAt = t + FRESH_MS;
      if (u.state === 'ok') good = u;
      return u;
    }
    const [first, most] = fail.limited ? LIMITED_MS : FAILED_MS;
    const again = how === (fail.limited ? 'limited' : 'failed');
    how = fail.limited ? 'limited' : 'failed';
    wait = fail.retryAfter ?? (again && wait ? Math.min(most, wait * 2) : first);
    nextAt = t + wait;
    // the last good reading stays, marked: as of when, and why it isn't newer
    return good ? { ...good, stale: { message: `${fail.limited ? 'Asked for too often just now' : (u.message ?? "Couldn't be read").replace(/\.$/, '')}: as of ${hhmm(good.at)}, asked again at ${hhmm(nextAt)}.`, retryAt: nextAt } } : { ...u, message: `${u.message} Asked again at ${hhmm(nextAt)}.` };
  };

  return {
    /** The latest: asked again once FRESH_MS has passed, or the wait after a failure (one ask at a time). */
    async get(): Promise<AccountUsage> {
      if (off()) return { state: 'off', at: now(), limits: [], message: "Usage is off in a test Cora (it doesn't ask, so the real one's reading isn't rate-limited)." };
      if (shown && now() < nextAt) return shown;
      pending ??= load()
        .then(settle)
        .finally(() => (pending = null));
      return (shown = await pending);
    },
  };
}
