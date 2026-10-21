import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isUnread, INBOX_KEEP_MS, type InboxItem } from '@cora/shared';
import { Inbox, type InboxAdd } from '../src/inbox';

const jira = (id: string, text = 'commented'): InboxAdd => ({ source: 'jira', key: 'jira:ACME-1', title: 'ACME-1 · Fix login', why: 'a comment on your ticket', entry: { id, who: 'Dana', text, at: 1 } });

function make(file?: string) {
  let now = 1000;
  const changes: Array<{ changed: InboxItem[]; gone: string[] }> = [];
  const box = new Inbox({ file, now: () => now, onChange: (changed, gone) => changes.push({ changed, gone }) });
  return { box, changes, tick: (ms: number) => (now += ms) };
}

describe('the Inbox store', () => {
  it('one item per conversation: what is new folds in, moves it to the top and makes it unread again', () => {
    const { box, tick } = make();
    box.add(jira('a'));
    tick(10);
    box.add({ ...jira('m1'), source: 'mail', key: 'mail:t1', title: 'QA · Re: login' });
    tick(10);
    box.read({ all: true });
    tick(10);
    box.add(jira('b', 'moved it to QA'));
    const [top, next] = box.list();
    expect(top.key).toBe('jira:ACME-1');
    expect(top.entries.map((e) => e.id)).toEqual(['b', 'a']);
    expect(isUnread(top)).toBe(true);
    expect(isUnread(next)).toBe(false);
  });

  it('the same entry twice is told once (a restart, the same event again)', () => {
    const { box, changes } = make();
    expect(box.add(jira('a'))).not.toBeNull();
    expect(box.add(jira('a'))).toBeNull();
    expect(box.list()[0].entries).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  it('a pipeline: the latest result replaces the one before; fixed before you saw it failing, it comes in read', () => {
    const { box, tick } = make();
    const ci = (id: string, state: 'ok' | 'failed'): InboxAdd => ({ source: 'gitlab', key: 'ci:g/p@main', title: 'p · main', why: 'a pipeline your session follows', state, replace: true, entry: { id, text: state === 'ok' ? 'Pipeline #2 passed' : 'Pipeline #1 failed', at: 1 } });
    box.add(ci('p1:failed', 'failed'));
    tick(10);
    const fixed = box.add(ci('p2:success', 'ok'))!;
    expect(fixed.entries.map((e) => e.id)).toEqual(['p2:success']);
    expect(fixed.state).toBe('ok');
    expect(isUnread(fixed)).toBe(false);
    tick(10);
    box.add(ci('p3:failed', 'failed'));
    expect(isUnread(box.list()[0])).toBe(true);
  });

  it('read: by ids, by source, or all; an item can arrive already read', () => {
    const { box } = make();
    const a = box.add(jira('a'))!;
    box.add({ ...jira('m1'), source: 'mail', key: 'mail:t1' });
    box.add({ ...jira('c1'), source: 'cora', key: 'cora:ask:1', read: true });
    expect(box.list().filter(isUnread).map((i) => i.source).sort()).toEqual(['jira', 'mail']);
    expect(box.read({ ids: [a.id] })).toBe(1);
    expect(box.read({ source: 'mail' })).toBe(1);
    expect(box.list().filter(isUnread)).toEqual([]);
    // by key: you answered it in Slack itself
    box.add({ ...jira('s1'), source: 'slack', key: 'slack:D1' });
    expect([box.read({ keys: ['slack:D2'] }), box.read({ keys: ['slack:D1'] })]).toEqual([0, 1]);
  });

  it('keeps 14 days and the newest 20 entries, and survives a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-inbox-')), 'inbox.json');
    const { box, tick } = make(file);
    for (let n = 0; n < 25; n++) box.add(jira(`e${n}`));
    expect(box.list()[0].entries).toHaveLength(20);
    expect(box.fresh).toBe(true);
    const again = new Inbox({ file, now: () => 1000 });
    expect(again.fresh).toBe(false);
    expect(again.list()[0].entries[0].id).toBe('e24');
    tick(INBOX_KEEP_MS + 1);
    box.add({ ...jira('x'), key: 'jira:ACME-2' });
    expect(box.list().map((i) => i.key)).toEqual(['jira:ACME-2']);
  });
});
