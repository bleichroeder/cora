import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionInfo } from '@cora/shared';
import { spawnTree, spawnedLine } from '../src/lib/spawnedNav';
import { SpawnedRows } from '../src/components/SessionRail';

const S = (id: string, o: Partial<SessionInfo> = {}) => ({ id, cwd: 'C:/code/x', project: 'x', title: id, state: 'idle', startedAt: 1, lastTs: 10, cliVersion: '', transcriptPath: '', needsYou: 0, ...o }) as SessionInfo;
const E2E = 'C:\\Users\\D\\AppData\\Local\\Temp\\cora-e2e-1730000000\\work';

describe('spawned sessions in the nav', () => {
  it('each nests under its creator (in its project, when it has one), never loose; spawned ones are kept out of the groups', () => {
    const listed = [
      S('tester'),
      S('lead'),
      S('kid-1', { spawnedBy: 'tester', spawnWhy: 'e2e: port 4399' }),
      S('kid-2', { spawnedBy: 'tester', state: 'ended' }),
      S('kid-3', { spawnedBy: 'lead' }),
      S('mine'),
    ];
    const t = spawnTree(listed, new Set(['lead']));
    expect([...t.under]).toEqual([
      ['tester', [listed[2], listed[3]]],
      ['lead', [listed[4]]],
    ]);
    expect(t.loose).toEqual([]);
    expect([...t.ids].sort()).toEqual(['kid-1', 'kid-2', 'kid-3']);
  });

  it("one whose creator the nav doesn't show (or is unknown: a test root's session with no marker) goes in a folded group of its own", () => {
    const listed = [S('kid-1', { spawnedBy: 'gone-long-ago' }), S('kid-2', { cwd: E2E }), S('mine')];
    const t = spawnTree(listed, new Set());
    expect(t.under.size).toBe(0);
    expect(t.loose.map((s) => s.id)).toEqual(['kid-1', 'kid-2']);
    // a project's own member stays its project's, marked or not
    expect(spawnTree([S('kid', { spawnedBy: 'x' })], new Set(['kid'])).ids.size).toBe(0);
  });

  it("a spawned session that's gone from the list (ended and cleaned up) leaves its creator's sub-row", () => {
    const tester = S('tester');
    expect(spawnTree([tester, S('kid', { spawnedBy: 'tester' })], new Set()).under.get('tester')).toHaveLength(1);
    expect(spawnTree([tester], new Set()).under.has('tester')).toBe(false);
  });

  it('the sub-row, folded: how many, and why; open: their rows, set in under it', () => {
    const kids = [S('kid-1', { spawnedBy: 'tester', spawnWhy: 'e2e: port 4399' }), S('kid-2', { spawnedBy: 'tester', spawnWhy: 'e2e: port 4399' })];
    expect(spawnedLine(kids)).toEqual({ count: '2 spawned', why: 'e2e: port 4399' });
    expect(spawnedLine([kids[0], S('k3', { spawnedBy: 'tester', spawnWhy: 'a tool' })]).why).toBe('e2e: port 4399 …');
    const folded = renderToStaticMarkup(createElement(SpawnedRows, { creator: 'tester', kids, open: false, onToggle() {}, entry: (s: SessionInfo) => createElement('i', { key: s.id }, s.id) }));
    expect(folded).toMatch(/class="ses-spawn" data-spawned-by="tester"/);
    expect(folded).toMatch(/<span class="ses-sub-n">2 spawned<\/span><span class="ses-sub-why">e2e: port 4399<\/span>/);
    expect(folded).not.toContain('ses-kids');
    const open = renderToStaticMarkup(createElement(SpawnedRows, { creator: 'tester', kids, open: true, onToggle() {}, entry: (s: SessionInfo) => createElement('i', { key: s.id }, s.id) }));
    expect(open).toMatch(/class="ses-spawn open"/);
    expect(open).toContain('<div class="ses-kids"><i>kid-1</i><i>kid-2</i></div>');
    // one of them needs you: the count says so (in place, folded or not)
    expect(renderToStaticMarkup(createElement(SpawnedRows, { creator: 'tester', kids: [S('k', { spawnedBy: 'tester', state: 'needs-you' })], open: false, onToggle() {}, entry: () => null }))).toContain('class="ses-sub need"');
  });
});
