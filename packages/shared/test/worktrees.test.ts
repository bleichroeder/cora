import { describe, expect, it } from 'vitest';
import { STALE_MS, branchFor, dirtyCount, folderFor, gateDecision, parseWorktreeList, stateOf } from '../src/worktrees';

describe('worktrees', () => {
  it("reads git's list: folders, branches, a detached one, a bare repo", () => {
    const out = 'worktree C:/code/cora\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/code/cora/.claude/worktrees/x\r\nHEAD bbb\r\nbranch refs/heads/fix/CORA-1-x\r\n\r\nworktree C:/tmp/d\nHEAD ccc\ndetached\n\nworktree C:/r.git\nbare\n';
    expect(parseWorktreeList(out)).toEqual([
      { path: 'C:/code/cora', branch: 'main', head: 'aaa', bare: false },
      { path: 'C:/code/cora/.claude/worktrees/x', branch: 'fix/CORA-1-x', head: 'bbb', bare: false },
      { path: 'C:/tmp/d', branch: null, head: 'ccc', bare: false },
      { path: 'C:/r.git', branch: null, head: '', bare: true },
    ]);
    expect(dirtyCount('## main...origin/main\n M a.ts\n?? b.ts\nA  c.ts\n')).toBe(3);
    expect(dirtyCount('## main\n')).toBe(0);
  });

  it('states: someone in it is active; merged and clean is done; a week untouched is stale; a main checkout is never done or stale', () => {
    const now = 100 * 86400_000;
    const t = { main: false, who: [] as string[], merged: false, dirty: 0, unpushed: 0, changedAt: now - 1000 };
    expect(stateOf({ ...t, who: ['s1'], merged: true }, now)).toBe('active');
    expect(stateOf({ ...t, merged: true }, now)).toBe('done');
    expect(stateOf({ ...t, merged: true, dirty: 1 }, now)).toBe('idle');
    expect(stateOf({ ...t, merged: true, unpushed: 2 }, now)).toBe('idle');
    expect(stateOf({ ...t, changedAt: now - STALE_MS - 1 }, now)).toBe('stale');
    expect(stateOf({ ...t, main: true, merged: true, changedAt: 0 }, now)).toBe('idle');
    expect(stateOf(t, now)).toBe('idle');
  });

  it('branch names: a ticket gives fix/ or feat/ with its key and title; else wt/; unique', () => {
    expect(branchFor({ ticket: 'cora-212', title: 'Port retry fails after reboot', taken: [] })).toBe('fix/CORA-212-port-retry-fails-after-reboot');
    expect(branchFor({ ticket: 'INS-881', title: 'Search suggestions', taken: [] })).toBe('feat/INS-881-search-suggestions');
    expect(branchFor({ name: 'Debrief polish!', taken: ['wt/debrief-polish', 'WT/debrief-polish-2'] })).toBe('wt/debrief-polish-3');
    expect(branchFor({ taken: [] })).toBe('wt/work');
    expect(folderFor('fix/CORA-212-port-retry')).toBe('cora-212-port-retry');
  });

  it('the gate: only edits in a main checkout; collide moves when another session is changing it; ask never', () => {
    expect(gateDecision({ mode: 'collide', inMain: true, othersEditing: 1 })).toBe('move');
    expect(gateDecision({ mode: 'collide', inMain: true, othersEditing: 0 })).toBe('allow');
    expect(gateDecision({ mode: 'collide', inMain: false, othersEditing: 3 })).toBe('allow');
    expect(gateDecision({ mode: 'always', inMain: true, othersEditing: 0 })).toBe('move');
    expect(gateDecision({ mode: 'ask', inMain: true, othersEditing: 2 })).toBe('allow');
  });
});
