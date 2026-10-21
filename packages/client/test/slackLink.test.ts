import { describe, expect, it } from 'vitest';
import { slackAppLink, useSlack } from '../src/state/slack';

describe('a Slack message link in the Slack tool', () => {
  it("opens the web app at its conversation or thread, once Cora knows the workspace", () => {
    const dm = 'https://acme.slack.com/archives/D022K1G6FU7/p1792164375920239';
    expect(slackAppLink(dm)).toBe(dm);
    useSlack.setState({ status: { connected: true, team: 'Acme', teamId: 'T0TEAM', user: 'david', userId: 'U0', url: 'https://acme.slack.com/' } });
    expect(slackAppLink(dm)).toBe('https://app.slack.com/client/T0TEAM/D022K1G6FU7');
    expect(slackAppLink('https://acme.slack.com/archives/C1ABCDEF/p1700000050000100?thread_ts=1700000000.000100&cid=C1ABCDEF')).toBe('https://app.slack.com/client/T0TEAM/C1ABCDEF/thread/C1ABCDEF-1700000000.000100');
    expect(slackAppLink('https://example.com/x')).toBe('https://example.com/x');
  });
});
