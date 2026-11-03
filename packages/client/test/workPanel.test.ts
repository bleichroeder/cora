import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, ProjectItem, SessionInfo } from '@cora/shared';
import { DoneTask, WorkList, doneTasks, moveRanks, openTasks, shortLink } from '../src/components/board/WorkPanel';

const S = (id: string, alias: string) => ({ id, alias, state: 'idle', startedAt: 1, lastTs: 10, cwd: 'C:/w' }) as SessionInfo;
const task = (id: string, o: Partial<ProjectItem> = {}): ProjectItem => ({ id, kind: 'task', title: `Task ${id}`, state: 'queued', openedBy: 'you', openedAt: 1, updatedBy: 'you', updatedAt: 1, notes: [], ...o });
const project = (items: ProjectItem[]): Project =>
  ({
    id: 'p1', name: 'Dev', brief: '', briefAt: 0, decisions: [], thread: [], sessions: ['eng', 'rev'], members: {}, items,
    team: { version: 1, seats: [], groups: [{ id: 'builders', name: 'Builders', members: [], dispatch: 'claim' }], labels: [], routes: [], fallback: 'user', escalation: [] },
  }) as unknown as Project;

/** The panel as it renders for this project and these sessions. */
const render = (p: Project, sessions: Record<string, SessionInfo> = {}) => renderToStaticMarkup(createElement(WorkList, { p, sessions }));

describe('the Work panel: its rows and their order', () => {
  it('one row per open task in rank order (then the oldest), numbered; done ones and other items left out', () => {
    const p = project([
      task('c', { rank: 3, openedAt: 1 }),
      task('a', { rank: 1, openedAt: 5 }),
      task('b2', { rank: 2, openedAt: 9 }),
      task('b1', { rank: 2, openedAt: 2 }),
      task('gone', { rank: 0, state: 'done', closedAt: 50, outcome: 'merged as abc1234' }),
      { ...task('inc'), kind: 'incident', state: 'open', severity: 'high' },
    ]);
    expect(openTasks(p).map((i) => i.id)).toEqual(['a', 'b1', 'b2', 'c']);
    const html = render(p);
    const titles = [...html.matchAll(/<b class="t">([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Task a', 'Task b1', 'Task b2', 'Task c']);
    expect([...html.matchAll(/<span class="n">(\d+)<\/span>/g)].map((m) => m[1])).toEqual(['1', '2', '3', '4']);
    // the counts on the toggle: four queued, one done
    expect(html).toMatch(/Queue <b>4<\/b>/);
    expect(html).toMatch(/Done <b>1<\/b>/);
    // the first can't go up, the last can't go down
    expect(html.match(/<button disabled="" title="Up the queue"/g)).toHaveLength(1);
    expect(html.match(/<button disabled="" title="Down the queue"/g)).toHaveLength(1);
  });

  it("each row: its title, its owner (a session's name, or a group's), its state, its branch, when it last changed", () => {
    const now = Date.now();
    const p = project([
      task('a', { rank: 1, owner: 'eng', state: 'building', link: 'feat/work-items', updatedAt: now - 5 * 60_000 }),
      task('b', { rank: 2, owner: 'builders', link: 'https://gitlab.example.com/acme/cora/-/merge_requests/42' }),
      task('c', { rank: 3 }),
    ]);
    const html = render(p, { eng: S('eng', 'Engineer') });
    const rows = html.split('class="pi-row pw-row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Engineer');
    expect(rows[0]).toContain('<span class="pp-kind">building</span>');
    expect(rows[0]).toContain('feat/work-items');
    expect(rows[0]).toContain('5m');
    expect(rows[1]).toContain('Builders');
    expect(rows[1]).toContain('>!42<');
    expect(rows[2]).toContain('<em>unassigned</em>');
    expect(rows[2]).toContain('<span class="pp-kind">queued</span>');
  });

  it('nothing queued: says so; the Done list, newest first, shows each outcome', () => {
    const p = project([task('x', { state: 'done', closedAt: 10, outcome: 'merged as abc1234' }), task('y', { state: 'done', closedAt: 20, outcome: 'dropped: not needed' })]);
    expect(render(p)).toContain('No work queued.');
    expect(doneTasks(p).map((i) => i.id)).toEqual(['y', 'x']);
    const row = renderToStaticMarkup(createElement(DoneTask, { p, i: doneTasks(p)[1] }));
    expect(row).toContain('<span class="pp-kind">done</span>');
    expect(row).toContain('merged as abc1234');
  });
});

describe('reordering the queue', () => {
  const tasks = [task('a', { rank: 1 }), task('b', { rank: 2 }), task('c', { rank: 3 })];
  it('a task moved up or down swaps ranks with its neighbour: those two, nothing else', () => {
    expect(moveRanks(tasks, 'c', -1)).toEqual([
      { item: 'c', rank: 2 },
      { item: 'b', rank: 3 },
    ]);
    expect(moveRanks(tasks, 'a', 1)).toEqual([
      { item: 'a', rank: 2 },
      { item: 'b', rank: 1 },
    ]);
    // the first can't go up, the last can't go down
    expect(moveRanks(tasks, 'a', -1)).toEqual([]);
    expect(moveRanks(tasks, 'c', 1)).toEqual([]);
  });

  it('gaps in the ranks (a rank set by the lead, a task done) leave the rows that stay where they are untouched', () => {
    // T3 ranked 0 by the lead, T4 opened after: T3(0) T1(1) T2(2) T4(3); T1 down the queue
    const q = [task('T3', { rank: 0 }), task('T1', { rank: 1 }), task('T2', { rank: 2 }), task('T4', { rank: 3 })];
    expect(moveRanks(q, 'T1', 1)).toEqual([
      { item: 'T1', rank: 2 },
      { item: 'T2', rank: 1 },
    ]);
    const gappy = [task('a', { rank: 1 }), task('b', { rank: 5 }), task('c', { rank: 9 })];
    expect(moveRanks(gappy, 'c', -1)).toEqual([
      { item: 'c', rank: 5 },
      { item: 'b', rank: 9 },
    ]);
  });

  it('tied with its neighbour: only the moved task changes, to a rank between its new neighbours', () => {
    const tied = [task('a', { rank: 1 }), task('b', { rank: 7, openedAt: 1 }), task('c', { rank: 7, openedAt: 2 }), task('d', { rank: 9 })];
    expect(moveRanks(tied, 'c', -1)).toEqual([{ item: 'c', rank: 4 }]);
    expect(moveRanks(tied, 'b', 1)).toEqual([{ item: 'b', rank: 8 }]);
    // at an end of the queue: a step past the one it passes
    const ends = [task('a', { rank: 2, openedAt: 1 }), task('b', { rank: 2, openedAt: 2 })];
    expect(moveRanks(ends, 'b', -1)).toEqual([{ item: 'b', rank: 1 }]);
    expect(moveRanks(ends, 'a', 1)).toEqual([{ item: 'a', rank: 3 }]);
  });

  it('ranks missing altogether: the queue is numbered 1, 2, 3… again (only the ranks that change)', () => {
    const loose = [task('a'), task('b', { rank: 7 }), task('c', { rank: 7 })];
    expect(moveRanks(loose, 'b', -1)).toEqual([
      { item: 'b', rank: 1 },
      { item: 'a', rank: 2 },
      { item: 'c', rank: 3 },
    ]);
  });
});

describe("a task's link, short", () => {
  it('a branch as itself; a merge or pull request by its number; a tree by its branch; anything else by its last part', () => {
    expect(shortLink('fix/role-notice-change')).toBe('fix/role-notice-change');
    expect(shortLink('https://gitlab.example.com/acme/cora/-/merge_requests/42')).toBe('!42');
    expect(shortLink('https://github.com/acme/cora/pull/7')).toBe('#7');
    expect(shortLink('https://gitlab.example.com/acme/cora/-/tree/feat/work-items')).toBe('feat/work-items');
    expect(shortLink('https://example.com/a/b/thing?x=1')).toBe('thing');
    expect(shortLink('a-very-long-branch-name-that-goes-on-and-on-for-ever')).toHaveLength(32);
  });
});
