import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS, isSlackUrl, newTool, slackTool, toolHost, unreadOf } from '../src/lib/tools';

describe('tools', () => {
  it('reads unread news from a page title', () => {
    expect(unreadOf('(3) Inbox - Gmail')).toBe(3);
    expect(unreadOf('(12+) Notifications')).toBe(12);
    expect(unreadOf('* Slack | #deploys | Acme')).toBe('dot');
    expect(unreadOf('! Slack | dana | Acme')).toBe('dot');
    expect(unreadOf('Slack | #deploys | Acme')).toBeNull();
    expect(unreadOf('(0) Inbox')).toBeNull();
    expect(unreadOf('*bold* title')).toBeNull();
  });

  it('knows Slack', () => {
    expect(isSlackUrl('https://app.slack.com/client')).toBe(true);
    expect(isSlackUrl('https://acme.slack.com/archives/C1')).toBe(true);
    expect(isSlackUrl('https://notslack.com/')).toBe(false);
    expect(slackTool(DEFAULT_TOOLS)?.id).toBe('slack');
    expect(slackTool([])).toBeUndefined();
    expect(toolHost('nope')).toBe('');
  });

  it('makes a tool from a name and an address, with a unique id', () => {
    expect(newTool('Jira board', 'acme.atlassian.net/jira/software/projects/ID/boards/1', [])).toEqual({ id: 'jira-board', name: 'Jira board', url: 'https://acme.atlassian.net/jira/software/projects/ID/boards/1' });
    expect(newTool('', 'https://gitlab.com/dashboard/merge_requests', [])).toEqual({ id: 'gitlab', name: 'gitlab', url: 'https://gitlab.com/dashboard/merge_requests' });
    expect((newTool('Slack', 'https://app.slack.com', DEFAULT_TOOLS) as { id: string }).id).toBe('slack-2');
    expect(newTool('x', 'not a url at all', [])).toBe('not a web address');
  });
});
