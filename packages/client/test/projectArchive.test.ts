import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@cora/shared';
import { archiveAsk, archivedHomes, projectMembers, runningIn } from '../src/state/projects';
import { notice, oops, useOops } from '../src/state/oops';

const proj = (id: string, sessions: string[], o: Partial<Project> = {}) => ({ id, name: `P ${id}`, color: '#60a5fa', createdAt: 1, sessions, coordination: true, brief: '', briefAt: 1, decisions: [], thread: [], members: {}, ...o }) as Project;

describe("an archived project's sessions in the app", () => {
  afterEach(() => useOops.setState({ list: [] }));

  it("are hidden with it: the nav's groups (Ended too) leave out every project's members, an archived one's as well", () => {
    const hidden = projectMembers([proj('a', ['s1']), proj('b', ['s2', 's3'], { archivedAt: 5 })]);
    expect([...hidden].sort()).toEqual(['s1', 's2', 's3']);
  });

  it("in Resume, each says where it belongs: its archived project's name (a live project's aren't marked)", () => {
    const homes = archivedHomes([proj('a', ['s1']), proj('b', ['s2', 's3'], { name: 'Tags', archivedAt: 5 })]);
    expect([...homes]).toEqual([['s2', 'Tags'], ['s3', 'Tags']]);
  });

  it('archiving asks once first when sessions of it are running (how many), and nothing when none are', () => {
    const p = proj('a', ['s1', 's2', 's3', 'gone']);
    const n = runningIn(p, { s1: { state: 'idle' }, s2: { state: 'working' }, s3: { state: 'ended' } });
    expect(n).toBe(2);
    expect(archiveAsk('Tags', n)).toBe('Archive "Tags"? Its 2 running sessions will be stopped.');
    expect(archiveAsk('Tags', 1)).toBe('Archive "Tags"? Its 1 running session will be stopped.');
    expect(archiveAsk('Tags', 0)).toBeNull();
  });

  it('a notice (the project brought back) is said in the corner as information, not as a failure', () => {
    vi.useFakeTimers();
    notice('"Tags" is back from the archive', 'Its other 2 sessions are resuming in it too.');
    oops('Couldn’t resume');
    expect(useOops.getState().list.map((o) => [o.title, !!o.info])).toEqual([
      ['"Tags" is back from the archive', true],
      ['Couldn’t resume', false],
    ]);
    vi.useRealTimers();
  });
});
