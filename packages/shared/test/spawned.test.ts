import { describe, expect, it } from 'vitest';
import { inTestRoot, spawnMarker, spawnOf, spawnedGone, type SessionInfo } from '../src';

const S = (id: string, o: Partial<SessionInfo> = {}) => ({ id, cwd: 'C:/code/x', state: 'idle', lastTs: 10, ...o }) as SessionInfo;
const headers = (h: Record<string, string>) => (name: string) => h[name];

describe('a spawned session', () => {
  it("its marker, from its hooks' headers: the creator's id and why; nothing when the variable wasn't set or isn't an id", () => {
    expect(spawnMarker(headers({ 'x-cora-spawned-by': 'c0ab849e-5582', 'x-cora-spawn-why': ' e2e: a throwaway Cora on port 4399 ' }))).toEqual({ by: 'c0ab849e-5582', why: 'e2e: a throwaway Cora on port 4399' });
    expect(spawnMarker(headers({ 'x-cora-spawned-by': 'tester-1' }))).toEqual({ by: 'tester-1', why: null });
    // unset: sent empty, or left as written
    expect(spawnMarker(headers({ 'x-cora-spawned-by': '', 'x-cora-spawn-why': '' }))).toBeNull();
    expect(spawnMarker(headers({ 'x-cora-spawned-by': '$CORA_SPAWNED_BY', 'x-cora-spawn-why': '$CORA_SPAWN_WHY' }))).toBeNull();
    expect(spawnMarker(headers({ 'x-cora-spawned-by': 'abc', 'x-cora-spawn-why': '$CORA_SPAWN_WHY' }))).toEqual({ by: 'abc', why: null });
    expect(spawnMarker(headers({ 'x-cora-spawned-by': 'not an id; rm -rf' }))).toBeNull();
    expect(spawnMarker(headers({}))).toBeNull();
    expect(spawnMarker(headers({ 'x-cora-spawned-by': 'a', 'x-cora-spawn-why': 'w'.repeat(300) }))!.why).toHaveLength(200);
  });

  it("who started it: its marker; else a folder in a throwaway Cora's test root counts, its creator unknown", () => {
    expect(spawnOf(S('a', { spawnedBy: 'tester', spawnWhy: 'e2e' }))).toEqual({ by: 'tester', why: 'e2e' });
    expect(spawnOf(S('b', { cwd: 'C:\\Users\\D\\AppData\\Local\\Temp\\cora-e2e-1730000000\\work' }))).toEqual({ by: null, why: "a throwaway Cora's test session" });
    expect(spawnOf(S('c', { cwd: 'C:/code/x', wd: '/tmp/cora-e2e-5/work/.claude/worktrees/w' }))).toMatchObject({ by: null });
    expect(spawnOf(S('d'))).toBeNull();
    expect(inTestRoot('C:/code/cora-e2e')).toBe(false);
    expect(inTestRoot('C:/code/my-cora-e2e-notes')).toBe(false);
  });

  it('off the list once it has ended and its folder is gone (not while it runs, nor while its folder is there)', () => {
    const list = [
      S('ended-gone', { state: 'ended', cwd: 'T/cora-e2e-1/work' }),
      S('ended-there', { state: 'ended', cwd: 'T/cora-e2e-2/work' }),
      S('live-gone', { state: 'idle', cwd: 'T/cora-e2e-1/work' }),
      S('marked-gone', { state: 'ended', spawnedBy: 'x', cwd: 'C:/code/gone' }),
      S('plain-gone', { state: 'ended', cwd: 'C:/code/gone' }),
      S('already-off', { state: 'ended', cwd: 'T/cora-e2e-1/work', dismissedAt: 20 }),
    ];
    const gone = new Set(['T/cora-e2e-1/work', 'C:/code/gone']);
    expect(spawnedGone(list, () => true)).toEqual([]);
    expect(spawnedGone(list, (d) => !gone.has(d)).map((s) => s.id)).toEqual(['ended-gone', 'marked-gone']);
  });
});
