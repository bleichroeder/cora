import { describe, expect, it, vi } from 'vitest';
import { parseRequest, sitesFromCookies } from '../src/jira';

vi.mock('electron', () => ({ app: {}, ipcMain: {}, session: {}, shell: {} }));

describe('Jira sites from the browser’s cookies', () => {
  it('the site you are signed in to first, then others you have been to', () => {
    const cookies = [
      { domain: '.atlassian.net', name: 'cloud.session.token' },
      { domain: 'other.atlassian.net', name: 'atlassian.xsrf.token' },
      { domain: 'other.atlassian.net', name: 'JSESSIONID' },
      { domain: 'acme.atlassian.net', name: 'tenant.session.token' },
      { domain: '.id.atlassian.net', name: 'x' },
      { domain: 'gitlab.com', name: '_gitlab_session' },
      { domain: 'a.b.atlassian.net', name: 'y' },
    ];
    expect(sitesFromCookies(cookies)).toEqual(['acme.atlassian.net', 'other.atlassian.net']);
    expect(sitesFromCookies([])).toEqual([]);
  });
});

describe('requests from the dashboard', () => {
  it('only known operations, only key-shaped keys, at most 50', () => {
    expect(parseRequest({ op: 'sites' })).toEqual({ op: 'sites' });
    expect(parseRequest({ op: 'issues', site: 'acme.atlassian.net', keys: ['ACME-1', '../myself', 'UTF-8', 'x'] })).toEqual({ op: 'issues', site: 'acme.atlassian.net', keys: ['ACME-1', 'UTF-8'] });
    expect((parseRequest({ op: 'issues', site: 's', keys: Array.from({ length: 80 }, (_, i) => `ACME-${i + 1}`) }) as { keys: string[] }).keys).toHaveLength(50);
    expect(parseRequest({ op: 'mine', site: 's' })).toEqual({ op: 'mine', site: 's', max: 50 });
    expect(parseRequest({ op: 'projects', site: 's' })).toEqual({ op: 'projects', site: 's' });
    expect(parseRequest({ op: 'delete', site: 's' })).toBeNull();
    expect(parseRequest({ op: 'issues', site: 's' })).toBeNull();
    expect(parseRequest(null)).toBeNull();
  });
});
