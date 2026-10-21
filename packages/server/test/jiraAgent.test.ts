import { describe, expect, it } from 'vitest';
import { EventFeed } from '../src/orchestrator/feed';

describe("Cora's held notes", () => {
  it('go out with the next delivery, never on their own', () => {
    let now = 0;
    const sent: string[] = [];
    const feed = new EventFeed({ deliver: (t: string) => (sent.push(t), true), agentBusy: () => false, mode: () => 'important', isAgent: () => false, isWorker: () => false, name: (s: string) => s, now: () => now } as any);
    feed.hold('[Jira] Dana assigned you ACME-5301');
    now += 10_000;
    expect(feed.tick()).toBe(false);
    expect(sent).toEqual([]);
    feed.note('a session finished');
    now += 10_000;
    expect(feed.tick()).toBe(true);
    expect(sent[0]).toMatch(/- \[Jira\] Dana assigned you ACME-5301\n- a session finished/);
    expect(feed.takeHeld()).toEqual([]);
  });
  it("aren't kept when Cora hears nothing", () => {
    const feed = new EventFeed({ deliver: () => true, agentBusy: () => false, mode: () => 'off', isAgent: () => false, isWorker: () => false, name: (s: string) => s } as any);
    feed.hold('[Jira] x');
    expect(feed.takeHeld()).toEqual([]);
  });
});
