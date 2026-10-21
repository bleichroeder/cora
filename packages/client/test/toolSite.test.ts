import { describe, expect, it } from 'vitest';
import { toolSite } from '../src/lib/tools';

describe("a tool's site", () => {
  it('is the host alone: no scheme, path, query, port or www', () => {
    expect(toolSite('https://app.slack.com/client/T1/C2?x=1#y')).toBe('app.slack.com');
    expect(toolSite('https://acme.atlassian.net/jira/software/projects/ID/boards/12?quickFilter=3')).toBe('acme.atlassian.net');
    expect(toolSite('https://www.gitlab.com/dashboard/merge_requests?assignee_username=jdoe')).toBe('gitlab.com');
    expect(toolSite('http://localhost:5601/app/discover')).toBe('localhost');
    expect(toolSite('not a url')).toBe('');
  });
});
