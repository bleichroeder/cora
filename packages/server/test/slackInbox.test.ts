import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { slackPlain } from '../src/slack';
import { MyThreads, slackKey, slackWhy, type SlackCtx, type SlackSeen } from '../src/slackInbox';

const ctx = (o: Partial<SlackCtx> = {}): SlackCtx => ({ me: 'UME', bot: { userId: 'UBOT', dm: 'DBOT' }, follow: [{ id: 'CFOL', label: '#platform-ops', words: ['outage', 'node 3'] }], mine: () => false, work: ['ACME-4922', 'orion-services', 'aurora'], ...o });
const msg = (o: Partial<SlackSeen> = {}): SlackSeen => ({ channel: 'COTHER', ts: '100.1', user: 'UKIRA', text: 'hello', dm: false, group: false, ...o });

describe('Slack in the Inbox: what counts', () => {
  it('never your own messages, nor Cora\'s bot', () => {
    expect(slackWhy(msg({ user: 'UME', dm: true, channel: 'D1' }), ctx())).toBeNull();
    expect(slackWhy(msg({ user: 'UBOT', dm: true, channel: 'D1' }), ctx())).toBeNull();
    expect(slackWhy(msg({ channel: 'DBOT', dm: true }), ctx())).toBeNull();
  });

  it('DMs, group DMs and mentions anywhere', () => {
    expect(slackWhy(msg({ dm: true, channel: 'D1' }), ctx())).toEqual({ why: 'a DM to you', short: 'DM' });
    expect(slackWhy(msg({ group: true, channel: 'G1' }), ctx())?.why).toBe("a group DM you're in");
    expect(slackWhy(msg({ text: 'hey <@UME> look' }), ctx())).toEqual({ why: 'you were mentioned', short: 'mentioned you' });
  });

  it('a channel you do not follow: nothing else, not even your work', () => {
    expect(slackWhy(msg({ text: 'ACME-4922 is broken <!here>' }), ctx())).toBeNull();
  });

  it('a channel you follow: only what touches you', () => {
    const f = (o: Partial<SlackSeen>) => slackWhy(msg({ channel: 'CFOL', ...o }), ctx({ mine: (c, t) => c === 'CFOL' && t === '50.0' }));
    expect(f({ text: 'lunch?' })).toBeNull();
    expect(f({ threadTs: '50.0', text: 'done' })?.why).toBe('a reply in a thread you posted in');
    expect(f({ text: 'is acme-4922 on dev?' })?.why).toBe('it mentions ACME-4922');
    expect(f({ text: 'orion-services is down' })?.short).toBe('orion-services');
    expect(f({ text: 'the auroras are here' })).toBeNull();
    expect(f({ text: 'Node 3 is dropping' })?.why).toBe('your word: node 3');
    expect(f({ text: '<!channel> deploy freeze' })?.why).toBe('an announcement in #platform-ops');
  });

  it('keys: one per DM, one per thread', () => {
    expect(slackKey(msg({ dm: true, channel: 'D1' }))).toBe('slack:D1');
    expect(slackKey(msg({ dm: true, channel: 'D1', threadTs: '5.0' }))).toBe('slack:D1:5.0');
    expect(slackKey(msg({ channel: 'C1', ts: '7.0' }))).toBe('slack:C1:7.0');
    expect(slackKey(msg({ channel: 'C1', ts: '8.0', threadTs: '7.0' }))).toBe('slack:C1:7.0');
  });

  it('Slack markup as plain words', () => {
    const name = (id: string) => ({ UKIRA: 'kira' })[id] ?? id;
    expect(slackPlain('<@UKIRA> see <#C1|release> and <https://x.io|the doc> <https://y.io> <!here>', name)).toBe('@kira see #release and the doc (https://x.io) https://y.io @here');
  });

  it('remembers the threads you posted in (and forgets after 14 days)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-st-')), 'slack-threads.json');
    let now = 1000;
    const t = new MyThreads(file, () => now);
    t.posted('C1', '50.0');
    expect(new MyThreads(file, () => now).has('C1', '50.0')).toBe(true);
    now += 15 * 86_400_000;
    expect(new MyThreads(file, () => now).has('C1', '50.0')).toBe(false);
  });
});
