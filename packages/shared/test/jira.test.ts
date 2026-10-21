import { describe, expect, it } from 'vitest';
import { errorFor, isCloudHost, isJiraHost, jiraClient, normalizeIssue, type JiraResponse } from '../src/jira';

const SITE = 'acme.atlassian.net';
const RAW = {
  key: 'ACME-5206',
  fields: {
    summary: 'Captions drop on reconnect',
    status: { name: 'In Review', statusCategory: { key: 'indeterminate', colorName: 'yellow' } },
    issuetype: { name: 'Bug', subtask: false },
    priority: { name: 'High' },
    assignee: { displayName: 'Dana Ruiz', avatarUrls: { '48x48': 'https://avatar/48.png', '24x24': 'https://avatar/24.png' } },
    updated: '2026-10-13T10:00:00.000+0000',
  },
};

/** A fake Jira: path → [status, body] (a string body is served as HTML); every URL asked for is recorded. */
function fake(routes: Record<string, [number, unknown] | (() => never)>) {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<JiraResponse> => {
    asked.push(url);
    const u = new URL(url);
    const r = routes[u.pathname + u.search] ?? routes[u.pathname] ?? [404, { errorMessages: ['nope'] }];
    if (typeof r === 'function') return r();
    const [status, body] = r;
    return { status, url, headers: { get: (n) => (n === 'content-type' ? (typeof body === 'string' ? 'text/html' : 'application/json;charset=UTF-8') : null) }, json: async () => body };
  };
  return { api: jiraClient(fetch), asked };
}

describe('normalizeIssue', () => {
  it('keeps what a chip and its card show', () => {
    expect(normalizeIssue(SITE, RAW)).toEqual({
      key: 'ACME-5206',
      summary: 'Captions drop on reconnect',
      url: 'https://acme.atlassian.net/browse/ACME-5206',
      status: { name: 'In Review', category: 'progress' },
      type: { name: 'Bug' },
      priority: { name: 'High' },
      assignee: { name: 'Dana Ruiz', avatarUrl: 'https://avatar/48.png' },
      updated: '2026-10-13T10:00:00.000+0000',
    });
  });
  it('tolerates hidden or missing fields, and maps status categories', () => {
    const i = normalizeIssue(SITE, { key: 'WEB-1', fields: { status: { name: 'Done', statusCategory: { key: 'done' } }, assignee: null, priority: null } });
    expect(i).toEqual({ key: 'WEB-1', summary: '', url: 'https://acme.atlassian.net/browse/WEB-1', status: { name: 'Done', category: 'done' } });
    expect(normalizeIssue(SITE, { key: 'WEB-2', fields: {} })?.status).toEqual({ name: 'Unknown', category: 'unknown' });
    expect(normalizeIssue(SITE, { key: 'WEB-3', fields: { status: { name: 'Open', statusCategory: { key: 'new' } } } })?.status.category).toBe('todo');
  });
  it('refuses something that is not an issue', () => {
    expect(normalizeIssue(SITE, null)).toBeNull();
    expect(normalizeIssue(SITE, { key: 'not a key' })).toBeNull();
  });
});

describe('hosts and errors', () => {
  it('knows a Jira host from anything else', () => {
    expect(isJiraHost('acme.atlassian.net')).toBe(true);
    expect(isJiraHost('jira.example.com')).toBe(true);
    for (const h of ['https://acme.atlassian.net', 'acme.atlassian.net/browse', 'localhost', 'a b.com', 'x.com:8080', '']) expect(isJiraHost(h)).toBe(false);
    expect(isCloudHost('acme.atlassian.net')).toBe(true);
    expect(isCloudHost('jira.example.com')).toBe(false);
  });
  it('reads a status as a reason', () => {
    expect(errorFor(401)).toBe('signed-out');
    expect(errorFor(403)).toBe('signed-out');
    expect(errorFor(404)).toBe('not-found');
    expect(errorFor(500)).toBe('error');
  });
});

describe('jiraClient', () => {
  it("looks up an issue with just the fields it shows (and its description, for Cora's ticket prompt)", async () => {
    const { api, asked } = fake({ '/rest/api/3/issue/ACME-5206': [200, RAW] });
    const r = await api.issue(SITE, 'ACME-5206');
    expect(r.ok && r.value.summary).toBe('Captions drop on reconnect');
    expect(asked).toEqual(['https://acme.atlassian.net/rest/api/3/issue/ACME-5206?fields=summary,status,issuetype,priority,assignee,updated,description']);
  });

  it('signed out: 401, or a login page (not JSON) instead of an answer', async () => {
    expect(await fake({ '/rest/api/3/issue/ACME-1': [401, { errorMessages: ['Client must be authenticated'] }] }).api.issue(SITE, 'ACME-1')).toEqual({ ok: false, error: 'signed-out', status: 401 });
    expect(await fake({ '/rest/api/3/issue/ACME-1': [200, '<html>Log in</html>'] }).api.issue(SITE, 'ACME-1')).toMatchObject({ ok: false, error: 'signed-out' });
  });

  it('offline when the request fails; no-site without a usable site; never asks for a bad key', async () => {
    const { api, asked } = fake({ '/rest/api/3/issue/ACME-1': () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); } });
    expect(await api.issue(SITE, 'ACME-1')).toEqual({ ok: false, error: 'offline', message: 'net::ERR_INTERNET_DISCONNECTED' });
    expect(await api.issue('https://evil/x', 'ACME-1')).toEqual({ ok: false, error: 'no-site' });
    expect(await api.issue(SITE, '../../myself')).toEqual({ ok: false, error: 'not-found' });
    expect(asked).toHaveLength(1);
  });

  it('several at once, each asked once; not-found stays not-found while signed in', async () => {
    const { api, asked } = fake({ '/rest/api/3/issue/ACME-5206': [200, RAW], '/rest/api/3/myself': [200, { accountId: 'a1', displayName: 'David' }] });
    const r = await api.issues(SITE, ['ACME-5206', 'ACME-9999', 'ACME-5206']);
    expect(r['ACME-5206'].ok).toBe(true);
    expect(r['ACME-9999']).toMatchObject({ ok: false, error: 'not-found' });
    expect(asked.filter((u) => u.includes('ACME-5206'))).toHaveLength(1);
    expect(asked.some((u) => u.endsWith('/myself'))).toBe(true);
  });

  it('a site that hides issues from strangers (404 for all): the login check turns not-found into signed-out', async () => {
    const { api } = fake({ '/rest/api/3/myself': [401, {}] });
    const r = await api.issues(SITE, ['ACME-1', 'WEB-2']);
    expect(r['ACME-1']).toMatchObject({ ok: false, error: 'signed-out' });
    expect(r['WEB-2']).toMatchObject({ ok: false, error: 'signed-out' });
  });

  it('runs at most `parallel` lookups at a time', async () => {
    let now = 0;
    let peak = 0;
    const api = jiraClient(async (url) => {
      peak = Math.max(peak, ++now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return { status: 200, url, headers: { get: () => 'application/json' }, json: async () => ({ ...RAW, key: url.match(/issue\/([^?]+)/)![1] }) };
    });
    const keys = Array.from({ length: 10 }, (_, i) => `ACME-${i + 1}`);
    const r = await api.issues(SITE, keys, 3);
    expect(Object.keys(r).sort()).toEqual([...keys].sort());
    expect(peak).toBe(3);
  });

  it('your open issues: the JQL, through /search/jql', async () => {
    const { api, asked } = fake({ '/rest/api/3/search/jql': [200, { issues: [RAW, { key: 'WEB-7', fields: { summary: 'x', status: { name: 'To Do', statusCategory: { key: 'new' } } } }] }] });
    const r = await api.myOpenIssues(SITE, 20);
    expect(r.ok && r.value.map((i) => i.key)).toEqual(['ACME-5206', 'WEB-7']);
    const q = new URL(asked[0]).searchParams;
    expect(q.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
    expect(q.get('maxResults')).toBe('20');
    expect(q.get('fields')).toContain('status');
  });

  it('project keys across pages', async () => {
    const { api, asked } = fake({
      '/rest/api/3/project/search?maxResults=100&startAt=0': [200, { values: [{ key: 'WEB' }, { key: 'ACME' }], isLast: false }],
      '/rest/api/3/project/search?maxResults=100&startAt=2': [200, { values: [{ key: 'OPS' }, { key: 'bad key' }], isLast: true }],
    });
    expect(await api.projectKeys(SITE)).toEqual({ ok: true, value: ['ACME', 'OPS', 'WEB'] });
    expect(asked).toHaveLength(2);
  });

  it('an empty list while signed out is signed out (a site open to strangers answers 200 with nothing)', async () => {
    const { api } = fake({ '/rest/api/3/search/jql': [200, { issues: [] }], '/rest/api/3/project/search': [200, { values: [], isLast: true }], '/rest/api/3/myself': [401, {}] });
    expect(await api.myOpenIssues(SITE)).toMatchObject({ ok: false, error: 'signed-out' });
    expect(await api.projectKeys(SITE)).toMatchObject({ ok: false, error: 'signed-out' });
    const signedIn = fake({ '/rest/api/3/search/jql': [200, { issues: [] }], '/rest/api/3/myself': [200, { accountId: 'a' }] }).api;
    expect(await signedIn.myOpenIssues(SITE)).toEqual({ ok: true, value: [] });
  });

  it('who you are', async () => {
    const { api } = fake({ '/rest/api/3/myself': [200, { accountId: 'a1', displayName: 'Dana Ruiz', avatarUrls: { '32x32': 'https://av/32' } }] });
    expect(await api.myself(SITE)).toEqual({ ok: true, value: { accountId: 'a1', name: 'Dana Ruiz', avatarUrl: 'https://av/32' } });
  });
});
