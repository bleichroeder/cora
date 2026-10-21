import { describe, expect, it } from 'vitest';
import { adfMentions, adfText, catchupSummary, jiraEvents, jiraLine, parseSince, type WatchedIssue } from '../src';

const ME = 'acc-me';
const DANA = { accountId: 'acc-dana', displayName: 'Dana Scully' };
const T0 = Date.parse('2026-10-16T14:00:00Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const doc = (...content: any[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const txt = (text: string) => ({ type: 'text', text });
const mention = (id: string, text: string) => ({ type: 'mention', attrs: { id, text } });

const issue = (o: Partial<WatchedIssue> & { assignee?: string | null }): WatchedIssue => ({
  key: 'ACME-5301',
  fields: { summary: 'Saved search dedupe fails on reload', assignee: o.assignee === undefined ? { accountId: ME } : o.assignee ? { accountId: o.assignee } : null, reporter: DANA, created: iso(-600) },
  changelog: { histories: [] },
  comments: [],
  from: ['mine'],
  ...o,
});

describe('ADF', () => {
  it('reads text and mentions', () => {
    const d = doc(txt('hey '), mention(ME, '@David'), txt(' can you check the export?'));
    expect(adfText(d)).toBe('hey @David can you check the export?');
    expect(adfMentions(d, ME)).toBe(true);
    expect(adfMentions(d, 'acc-other')).toBe(false);
  });
});

describe('jiraEvents', () => {
  const since = T0;
  it('a ticket assigned to you by someone else', () => {
    const i = issue({ changelog: { histories: [{ id: '10', author: DANA, created: iso(1), items: [{ field: 'assignee', to: ME, toString: 'David' }] }] } });
    expect(jiraEvents({ site: 's.atlassian.net', me: ME, since, issues: [i] })).toEqual([
      { id: 'ACME-5301:h10', kind: 'assigned', key: 'ACME-5301', summary: 'Saved search dedupe fails on reload', who: 'Dana Scully', what: 'assigned you', at: T0 + 60_000, link: 'https://s.atlassian.net/browse/ACME-5301' },
    ]);
  });

  it('a new ticket created already assigned to you counts as assigned', () => {
    const i = issue({ fields: { summary: 'New one', assignee: { accountId: ME }, reporter: DANA, created: iso(2) } });
    expect(jiraEvents({ site: 's', me: ME, since, issues: [i] }).map((e) => [e.kind, e.id])).toEqual([['assigned', 'ACME-5301:created']]);
  });

  it('a mention in a comment beats a comment, and links to the comment', () => {
    const i = issue({ comments: [{ id: '77', author: DANA, created: iso(3), body: doc(mention(ME, '@David'), txt(' can you check the export?')) }] });
    const [e] = jiraEvents({ site: 's', me: ME, since, issues: [i] });
    expect(e).toMatchObject({ kind: 'mentioned', id: 'ACME-5301:c77', what: 'mentioned you: @David can you check the export?', link: 'https://s/browse/ACME-5301?focusedCommentId=77' });
  });

  it('comments and status changes on your tickets by others; yours ignored', () => {
    const i = issue({
      comments: [
        { id: '1', author: DANA, created: iso(2), body: doc(txt('looks good')) },
        { id: '2', author: { accountId: ME, displayName: 'David' }, created: iso(3), body: doc(txt('thanks')) },
      ],
      changelog: { histories: [
        { id: '20', author: DANA, created: iso(4), items: [{ field: 'status', fromString: 'In Progress', toString: 'QA' }] },
        { id: '21', author: { accountId: ME }, created: iso(5), items: [{ field: 'status', toString: 'Done' }] },
      ] },
    });
    expect(jiraEvents({ site: 's', me: ME, since, issues: [i] }).map((e) => [e.kind, e.what])).toEqual([
      ['commented', 'commented: looks good'],
      ['status', 'moved it to QA'],
    ]);
  });

  it("changes on a ticket you watch (not yours) are 'watched'", () => {
    const i = issue({ assignee: 'acc-sam', from: ['watched'], changelog: { histories: [{ id: '30', author: DANA, created: iso(1), items: [{ field: 'status', toString: 'Done' }] }] } });
    expect(jiraEvents({ site: 's', me: ME, since, issues: [i] }).map((e) => [e.kind, e.what])).toEqual([['watched', 'moved it to Done']]);
  });

  it('a mention in the description counts when the description changed', () => {
    const i = issue({ assignee: 'acc-sam', from: ['mentions'], fields: { summary: 'S', assignee: { accountId: 'acc-sam' }, reporter: DANA, created: iso(-600), description: doc(txt('ping '), mention(ME, '@David')) }, changelog: { histories: [{ id: '40', author: DANA, created: iso(2), items: [{ field: 'description' }] }] } });
    expect(jiraEvents({ site: 's', me: ME, since, issues: [i] }).map((e) => [e.kind, e.what])).toEqual([['mentioned', 'mentioned you in the description']]);
  });

  it('nothing at or before since; an edited comment counts by its edit', () => {
    const i = issue({ comments: [
      { id: '5', author: DANA, created: iso(0), body: doc(txt('old')) },
      { id: '6', author: DANA, created: iso(-30), updated: iso(2), body: doc(mention(ME, '@David'), txt(' edited')) },
    ] });
    expect(jiraEvents({ site: 's', me: ME, since, issues: [i] }).map((e) => e.id)).toEqual(['ACME-5301:c6']);
  });
});

describe('helpers', () => {
  it('parseSince', () => {
    expect(parseSince('30m')).toBe(30 * 60_000);
    expect(parseSince('4h')).toBe(4 * 3_600_000);
    expect(parseSince('2d')).toBe(2 * 86_400_000);
    expect(parseSince('soon')).toBeNull();
  });
  it('jiraLine and catchupSummary', () => {
    const e = { id: 'x', kind: 'assigned' as const, key: 'ACME-5301', summary: 'Saved search dedupe fails on reload', who: 'Dana Scully', what: 'assigned you', at: T0, link: 'https://s/browse/ACME-5301' };
    expect(jiraLine(e, new Date(T0))).toMatch(/^\[\d\d:\d\d\] ACME-5301 · Dana Scully assigned you · Saved search dedupe fails on reload \(https:\/\/s\/browse\/ACME-5301\)$/);
    expect(catchupSummary([e, { ...e, kind: 'mentioned' }, { ...e, kind: 'mentioned' }])).toBe('While Cora was closed: 1 assigned to you, 2 mentions');
  });
});
