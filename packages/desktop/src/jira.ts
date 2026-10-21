import { readFileSync } from 'node:fs';
import { ipcMain, powerMonitor, session, type BrowserWindow } from 'electron';
import { ISSUE_KEY_RE, isCloudHost, jiraClient, type JiraFetch, type JiraResult } from '@cora/shared';
import { WEB_PARTITION } from './browser';
import { JiraWatcher } from './jiraWatch';

/** Jira Cloud's login cookies: one changing means you signed in or out. */
const AUTH_COOKIES = new Set(['tenant.session.token', 'cloud.session.token']);
/** Atlassian's own hosts under atlassian.net that aren't anyone's Jira. */
const NOT_SITES = new Set(['id.atlassian.net', 'api.atlassian.net', 'auth.atlassian.net', 'start.atlassian.net', 'admin.atlassian.net', 'home.atlassian.net']);

/**
 * The Jira Cloud sites the browser has been to (its cookies), the one you're signed in to first: a site's login
 * cookie lives on its own host (tenant.session.token on acme.atlassian.net), so that's what decides.
 */
export function sitesFromCookies(cookies: Array<{ domain?: string; name: string }>): string[] {
  const score = new Map<string, number>();
  for (const c of cookies) {
    const host = (c.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!isCloudHost(host) || host.split('.').length !== 3 || NOT_SITES.has(host)) continue;
    score.set(host, (score.get(host) ?? 0) + (c.name === 'tenant.session.token' ? 1000 : 1));
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

/** A request from the dashboard, checked: a known operation, keys that look like keys, at most 50 of them. */
export type JiraRequest = { op: 'sites' } | { op: 'issues'; site: string; keys: string[] } | { op: 'mine'; site: string; max?: number } | { op: 'projects'; site: string } | { op: 'myself'; site: string };
export function parseRequest(m: unknown): JiraRequest | null {
  const r = (m ?? {}) as Record<string, unknown>;
  const site = String(r.site ?? '');
  switch (r.op) {
    case 'sites':
      return { op: 'sites' };
    case 'issues':
      return Array.isArray(r.keys) ? { op: 'issues', site, keys: r.keys.map(String).filter((k) => ISSUE_KEY_RE.test(k)).slice(0, 50) } : null;
    case 'mine':
      return { op: 'mine', site, max: Number(r.max) || 50 };
    case 'projects':
    case 'myself':
      return { op: r.op, site };
  }
  return null;
}

/**
 * Jira lookups for the dashboard, read-only, through the built-in browser's session: the login you made in a Jira
 * tab is what authorises them (no API token to set up). The dashboard learns when that login changes, to look again.
 */
export function setupJira(win: BrowserWindow) {
  const ses = session.fromPartition(WEB_PARTITION);
  const fetch: JiraFetch = (url) => ses.fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include', signal: AbortSignal.timeout(15_000) });
  const api = jiraClient(fetch);

  ipcMain.removeHandler('ab:jira');
  ipcMain.handle('ab:jira', async (e, m: unknown): Promise<JiraResult<unknown> | Record<string, JiraResult<unknown>>> => {
    if (e.sender !== win.webContents) return { ok: false, error: 'unavailable' };
    const r = parseRequest(m);
    if (!r) return { ok: false, error: 'error', message: 'bad request' };
    // all of them: a { domain } filter misses host-only cookies on subdomains (a site's own login cookie)
    if (r.op === 'sites') return { ok: true, value: sitesFromCookies(await ses.cookies.get({})) };
    if (r.op === 'issues') return api.issues(r.site, r.keys);
    if (r.op === 'mine') return api.myOpenIssues(r.site, r.max);
    if (r.op === 'projects') return api.projectKeys(r.site);
    return api.myself(r.site);
  });

  // signing in or out in a Jira tab: tell the dashboard (once the cookie writes settle) so chips look again
  let t: ReturnType<typeof setTimeout> | undefined;
  ses.cookies.on('changed', (_e, c) => {
    if (!AUTH_COOKIES.has(c.name) || !/atlassian\.net$/i.test(c.domain ?? '')) return;
    clearTimeout(t);
    t = setTimeout(() => !win.isDestroyed() && win.webContents.send('ab:jira-auth'), 1500);
  });
}

/** Watching Jira for you: the watcher, through the browser's Jira login, reporting to Cora's server. */
export function startJiraWatch(o: { base: string; tokenFile: string }): () => void {
  const ses = session.fromPartition(WEB_PARTITION);
  const fetch: JiraFetch = (url) => ses.fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include', signal: AbortSignal.timeout(15_000) });
  const api = jiraClient(fetch);
  const token = () => {
    try {
      return readFileSync(o.tokenFile, 'utf8').trim();
    } catch {
      return '';
    }
  };
  const call = async (path: string, init?: RequestInit) => {
    const r = await globalThis.fetch(`${o.base}${path}`, { ...init, headers: { 'x-cora-token': token(), 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`server ${r.status}`);
    return r.json();
  };
  const w = new JiraWatcher({
    api,
    server: { info: () => call('/api/local/jira-watch'), send: async (b) => void (await call('/api/local/jira-events', { method: 'POST', body: JSON.stringify(b) })) },
    sites: async () => sitesFromCookies(await ses.cookies.get({})),
    // away: idle for 5 minutes, or the screen locked
    away: () => powerMonitor.getSystemIdleState(300) !== 'active',
  });
  w.start();
  return () => w.stop();
}
