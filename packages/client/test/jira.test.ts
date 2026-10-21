import { afterEach, describe, expect, it, vi } from 'vitest';
import { TTL, batcher, freshness, jiraLink, settle, splitKeys, type Entry } from '../src/lib/jira';

const PROJECTS = new Set(['ACME', 'WEB', 'OPS']);
const known = (k: string) => PROJECTS.has(k.slice(0, k.lastIndexOf('-')));
const keys = (s: string) => splitKeys(s, known).filter((p) => typeof p !== 'string').map((p) => (p as { key: string }).key);
const shapes = (s: string) => splitKeys(s, () => true).filter((p) => typeof p !== 'string').map((p) => (p as { key: string }).key);

describe('ticket keys in text', () => {
  it('finds keys of the site’s projects, keeping the text around them', () => {
    expect(splitKeys('Fixed ACME-5206 (and WEB-12).', known)).toEqual(['Fixed ', { key: 'ACME-5206' }, ' (and ', { key: 'WEB-12' }, ').']);
    expect(keys('branch feature/ACME-5206-captions, see OPS-9: done')).toEqual(['ACME-5206', 'OPS-9']);
  });
  it('lookalikes are not tickets: unknown projects, or not a key at all', () => {
    expect(keys('UTF-8, ISO-8601, SHA-256, RFC-2119, X-1')).toEqual([]);
    // the shape alone rules these out, whatever the projects
    expect(shapes('v1-2 abcID-5 ACME-05 foo-ACME-12 ACME-12a ACME-1.2 acme-3 @ACME-4 #ACME-6 ID-')).toEqual([]);
    expect(shapes('WEB-123')).toEqual(['WEB-123']);
  });
  it('text with nothing in it stays one piece', () => {
    expect(splitKeys('nothing here', known)).toEqual(['nothing here']);
    expect(splitKeys('', known)).toEqual([]);
  });
});

describe('Jira links', () => {
  const site = 'acme.atlassian.net';
  it('the issue a link is about', () => {
    expect(jiraLink('https://acme.atlassian.net/browse/ACME-5206')).toEqual({ key: 'ACME-5206', url: 'https://acme.atlassian.net/browse/ACME-5206', site });
    expect(jiraLink('https://acme.atlassian.net/browse/ACME-5206?focusedCommentId=1#comment-1')?.key).toBe('ACME-5206');
    expect(jiraLink('https://acme.atlassian.net/jira/software/c/projects/ID/boards/4?selectedIssue=ACME-77')?.key).toBe('ACME-77');
    expect(jiraLink('https://acme.atlassian.net/jira/software/projects/TVE/issues/WEB-3')?.key).toBe('WEB-3');
  });
  it('not an issue, not Jira, or not https: no chip', () => {
    expect(jiraLink('https://acme.atlassian.net/jira/your-work')).toBeNull();
    expect(jiraLink('https://gitlab.com/x/-/issues/ACME-5206')).toBeNull();
    expect(jiraLink('http://acme.atlassian.net/browse/ACME-1')).toBeNull();
    expect(jiraLink('not a url')).toBeNull();
  });
  it('a Jira on its own domain counts once it is the site', () => {
    expect(jiraLink('https://jira.example.com/browse/AB-1')).toBeNull();
    expect(jiraLink('https://jira.example.com/browse/AB-1', 'jira.example.com')?.key).toBe('AB-1');
  });
});

describe('the cache', () => {
  const ok: Entry['r'] = { ok: true, value: { key: 'ACME-1', summary: 's', url: 'u', status: { name: 'Open', category: 'todo' } } };
  it('fresh, then stale (shown while looked up again), by what the answer was', () => {
    expect(freshness(undefined, 0)).toBe('missing');
    expect(freshness({ r: ok, at: 0 }, TTL.ok - 1)).toBe('fresh');
    expect(freshness({ r: ok, at: 0 }, TTL.ok)).toBe('stale');
    expect(freshness({ r: { ok: false, error: 'signed-out' }, at: 0 }, 31_000)).toBe('stale');
    expect(freshness({ r: { ok: false, error: 'not-found' }, at: 0 }, 5 * 60_000)).toBe('fresh');
  });
  it('a known issue outlives a failed refresh, and is tried again soon', () => {
    const e = settle({ r: ok, at: 0 }, { ok: false, error: 'offline' }, 200_000);
    expect(e.r).toBe(ok);
    expect(freshness(e, 200_000 + TTL.offline - 1)).toBe('fresh');
    expect(freshness(e, 200_000 + TTL.offline)).toBe('stale');
    // signing out or the issue going away do replace it
    expect(settle({ r: ok, at: 0 }, { ok: false, error: 'signed-out' }, 5).r).toEqual({ ok: false, error: 'signed-out' });
  });
  it('batches keys asked for together', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const ask = batcher<string>((ks) => flushed.push(ks), 20);
    ask('A-1');
    ask('B-2');
    ask('A-1');
    vi.advanceTimersByTime(25);
    ask('C-3');
    vi.advanceTimersByTime(25);
    expect(flushed).toEqual([['A-1', 'B-2'], ['C-3']]);
    vi.useRealTimers();
  });
});

// ---- the store and the chips, against a fake desktop bridge ----

type R = { ok: boolean; [k: string]: unknown };
function fakeBridge() {
  const calls: Array<{ op: string; keys?: string[] }> = [];
  let signedIn = true;
  const issue = (key: string): R =>
    !signedIn ? { ok: false, error: 'signed-out', status: 401 } : key === 'ACME-404' ? { ok: false, error: 'not-found', status: 404 } : { ok: true, value: { key, summary: `About ${key}`, url: `https://acme.atlassian.net/browse/${key}`, status: { name: 'In Progress', category: 'progress' } } };
  const jira = {
    sites: async () => (calls.push({ op: 'sites' }), { ok: true, value: ['acme.atlassian.net'] }),
    myself: async () => (calls.push({ op: 'myself' }), signedIn ? { ok: true, value: { accountId: 'a', name: 'David' } } : { ok: false, error: 'signed-out' }),
    projectKeys: async () => (calls.push({ op: 'projects' }), { ok: true, value: ['ACME', 'WEB'] }),
    issues: async (_site: string, keys: string[]) => (calls.push({ op: 'issues', keys }), Object.fromEntries(keys.map((k) => [k, issue(k)]))),
    myOpenIssues: async () => (calls.push({ op: 'mine' }), { ok: true, value: [issue('ACME-7').value] }),
    onAuthChange: () => () => {},
  };
  return { jira, calls, signOut: () => void (signedIn = false) };
}

describe('Jira lookups (desktop bridge faked)', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as { coraDesktop?: unknown }).coraDesktop;
  });
  const boot = async () => {
    const b = fakeBridge();
    (globalThis as { coraDesktop?: unknown }).coraDesktop = { isDesktop: true, jira: b.jira };
    vi.resetModules();
    const j = await import('../src/state/jira');
    await j.refreshJira();
    return { ...b, j };
  };

  it('finds the site from the browser, checks the login, learns the projects', async () => {
    const { j, calls } = await boot();
    const st = j.useJira.getState();
    expect(j.jiraSite()).toBe('acme.atlassian.net');
    expect(st.auth).toBe('ok');
    expect(st.me?.name).toBe('David');
    expect(st.projects).toEqual(['ACME', 'WEB']);
    expect(calls.map((c) => c.op)).toEqual(['sites', 'myself', 'projects']);
    expect(j.isKnownKey('ACME-1')).toBe(true);
    expect(j.isKnownKey('UTF-8')).toBe(false);
  });

  it('lookups in the same moment go as one batch, each key once; then the cache answers', async () => {
    const { j, calls } = await boot();
    const [a, b, c] = await Promise.all([j.lookupIssue('ACME-1'), j.lookupIssue('ACME-2'), j.lookupIssue('ACME-1')]);
    expect(a.ok && a.value.summary).toBe('About ACME-1');
    expect(b.ok).toBe(true);
    expect(c).toEqual(a);
    const batches = calls.filter((x) => x.op === 'issues');
    expect(batches).toEqual([{ op: 'issues', keys: ['ACME-1', 'ACME-2'] }]);
    await j.lookupIssue('ACME-1');
    expect(calls.filter((x) => x.op === 'issues')).toHaveLength(1);
    expect(await j.lookupIssue('ACME-404')).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('signed out: lookups say so, and the auth state follows', async () => {
    const { j, signOut } = await boot();
    signOut();
    expect(await j.lookupIssue('WEB-5')).toMatchObject({ ok: false, error: 'signed-out' });
    expect(j.useJira.getState().auth).toBe('signed-out');
  });

  it('your open issues also fill the cache for their chips', async () => {
    const { j, calls } = await boot();
    const r = await j.myOpenIssues();
    expect(r.ok && r.value.map((i) => i.key)).toEqual(['ACME-7']);
    await j.lookupIssue('ACME-7');
    expect(calls.some((x) => x.op === 'issues')).toBe(false);
  });

  it('a new site starts over', async () => {
    const { j } = await boot();
    await j.lookupIssue('ACME-1');
    j.setJiraSite('https://other.atlassian.net/browse/X-1');
    expect(j.useJira.getState()).toMatchObject({ site: 'other.atlassian.net', projects: [], issues: {} });
  });

  it('markdown: keys and bare Jira links become chips, never in code or inside a link', async () => {
    // a server render sees the store's first state: start from projects saved by an earlier run
    const saved = JSON.stringify({ projects: ['ACME', 'WEB'], projectsAt: Date.now() });
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'ab:jira' ? saved : null), setItem: () => {} });
    const { j } = await boot();
    vi.unstubAllGlobals();
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { Markdown } = await import('../src/components/Markdown');
    expect(j.useJira.getState().projects).toEqual(['ACME', 'WEB']);
    const md = [
      'Fixed ACME-5206 and UTF-8 handling, see https://acme.atlassian.net/browse/WEB-3.',
      '',
      'Inline `ACME-1` and [the ticket](https://acme.atlassian.net/browse/ACME-2), [ACME-9](https://acme.atlassian.net/browse/ACME-9).',
      '',
      '```',
      'git checkout ACME-5206',
      '```',
    ].join('\n');
    const html = renderToStaticMarkup(React.createElement(Markdown, { text: md }));
    const chips = [...html.matchAll(/<span class="jk">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(chips).toEqual(['ACME-5206', 'WEB-3', 'ACME-9']);
    expect(html).toContain('<code>ACME-1</code>');
    expect(html).toContain('>the ticket</a>');
    expect(html).toMatch(/<pre><code>git checkout ACME-5206\n<\/code><\/pre>/);
    expect(html).toContain('UTF-8 handling');
    // a static copy (the pop-out) has no chips
    expect(renderToStaticMarkup(React.createElement(Markdown, { text: md, chips: false }))).not.toContain('jchip');
  }, 30_000); // loads react-markdown fresh (slow when the whole suite runs at once)
});
