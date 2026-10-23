import { describe, expect, it } from 'vitest';
import type { Approval, GitlabTodo, IssueStartMode, SessionInfo } from '@cora/shared';
import { IssueStarts } from '../src/orchestrator/issueStart';

const todo = (over: Partial<GitlabTodo> = {}): GitlabTodo =>
  ({ id: 1, action: 'assigned', type: 'Issue', project: 'acme/web/app', ref: '#42', title: 'Saved search loses filters', who: 'Dana', link: 'https://gitlab.example.com/acme/web/app/-/issues/42', at: 1, text: '', ...over }) as GitlabTodo;
const sess = (id: string, cwd: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd, project: '', title: '', state: 'idle', startedAt: 1, lastTs: 1, cliVersion: '', transcriptPath: '', needsYou: 0, ...over });

function setup(mode: IssueStartMode, o: { checkout?: string | null; sessions?: SessionInfo[] } = {}) {
  const cards: Array<Omit<Approval, 'id' | 'createdAt' | 'waiting'>> = [];
  const launched: Array<{ cwd: string; prompt: string; plan?: boolean }> = [];
  const notes: string[] = [];
  let sessions = o.sessions ?? [sess('s1', 'C:\\code\\app'), sess('s2', 'C:\\code\\other')];
  const starts = new IssueStarts({
    mode: () => mode,
    sessions: () => sessions,
    isDir: () => true,
    folderFor: async () => (o.checkout === undefined ? 'C:\\code\\app' : o.checkout),
    issue: async (project, iid) => ({ project, iid, title: 'Saved search loses filters', url: 'u', state: 'opened', labels: ['bug'], description: 'Steps' }),
    approvals: { request: (a) => (cards.push(a), new Promise(() => {})), list: () => cards.map((a, i) => ({ ...a, id: `c${i}`, createdAt: 0, waiting: true }) as Approval) },
    launch: async (x) => (launched.push(x), { terminal: { sessionId: `new${launched.length}` }, sent: true }),
    prompts: () => 1,
    focus: () => {},
    note: (l) => notes.push(l),
    changed: () => {},
  });
  return { starts, cards, launched, notes, setSessions: (s: SessionInfo[]) => (sessions = s) };
}

describe('IssueStarts', () => {
  it('offers an assigned issue in your checkout of its project (other folders to pick from)', async () => {
    const { starts, cards, launched } = setup('offer');
    await starts.todos([todo()]);
    expect(launched).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'start', title: 'Start #42 in app', cwd: 'C:\\code\\app', ticket: { key: 'acme/web/app#42', summary: 'Saved search loses filters', who: 'Dana', source: 'gitlab' } });
    expect(cards[0].folders?.map((f) => f.cwd)).toEqual(['C:\\code\\app', 'C:\\code\\other']);
    // never twice
    await starts.todos([todo()]);
    expect(cards).toHaveLength(1);
  });

  it('on its own: starts it in plan mode, with the issue summed up and diagnosed', async () => {
    const { starts, cards, launched } = setup('auto');
    await starts.todos([todo()]);
    expect(cards).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ cwd: 'C:\\code\\app', plan: true });
    expect(launched[0].prompt.split('\n')[0]).toBe('GitLab issue acme/web/app#42: Saved search loses filters');
    expect(starts.started()[0]).toMatchObject({ project: 'acme/web/app', iid: 42, auto: true });
  });

  it("on its own, but no checkout of its project: offers it instead", async () => {
    const { starts, cards, launched } = setup('auto', { checkout: null });
    await starts.todos([todo()]);
    expect(launched).toEqual([]);
    expect(cards[0].detail).toMatch(/none of your folders is a checkout/);
  });

  it('just tell: nothing; not an issue, not assigned, or already a session on it: nothing', async () => {
    const t = setup('tell');
    await t.starts.todos([todo()]);
    expect(t.cards).toEqual([]);
    const o = setup('offer', { sessions: [sess('s1', 'C:\\code\\app', { issue: { project: 'acme/web/app', iid: 42, url: 'u', title: null } })] });
    await o.starts.todos([todo(), todo({ type: 'MergeRequest', ref: '!7' }), todo({ action: 'mentioned', ref: '#9' })]);
    expect(o.cards).toEqual([]);
  });
});
