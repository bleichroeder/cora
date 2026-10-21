import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitlabTodo } from '@cora/shared';
import { GitlabTodos, toTodo } from '../src/gitlabTodos';
import { fromGitlabTodo } from '../src/inboxFeeds';

const api = (id: number, action: string, extra: object = {}) => ({
  id,
  action_name: action,
  target_type: 'MergeRequest',
  target: { iid: 12, title: 'Retry the export job', web_url: 'https://gitlab.acme.io/acme/app/-/merge_requests/12' },
  target_url: 'https://gitlab.acme.io/acme/app/-/merge_requests/12#note_9',
  project: { path_with_namespace: 'acme/app' },
  author: { name: 'Dana Scully', username: 'dana' },
  body: 'can you take a look?',
  state: 'pending',
  created_at: '2026-10-21T15:00:00Z',
  ...extra,
});

function setup(file?: string) {
  let out: unknown[] = [];
  let fail: Error | null = null;
  const calls: string[][] = [];
  const told: GitlabTodo[][] = [];
  const first: GitlabTodo[][] = [];
  let now = 1_000_000;
  const w = new GitlabTodos({
    file,
    on: () => true,
    onFresh: (t) => told.push(t),
    onFirst: (t) => first.push(t),
    exec: async (_f, args) => {
      calls.push(args);
      if (fail) throw fail;
      return { stdout: JSON.stringify(out), stderr: '' };
    },
    now: () => now,
  });
  return { w, calls, told, first, set: (l: unknown[]) => (out = l), fail: (e: Error | null) => (fail = e), tick: (ms: number) => (now += ms) };
}

describe('your GitLab to-dos', () => {
  it("read-only (GET todos); the first read is what's already there; then only new ones, once each, across restarts", async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-todos-')), 'gitlab-todos.json');
    const a = setup(file);
    a.set([api(1, 'assigned')]);
    await a.w.check();
    expect(a.calls[0]).toEqual(['api', '--hostname', 'gitlab.com', 'todos?state=pending&per_page=50']);
    expect(a.first.map((l) => l.map((t) => t.id))).toEqual([[1]]);
    expect(a.told).toEqual([]);
    a.set([api(1, 'assigned'), api(2, 'review_requested')]);
    await a.w.check();
    expect(a.told.map((l) => l.map((t) => [t.id, t.action]))).toEqual([[[2, 'review_requested']]]);
    // a restart: nothing told again
    const b = setup(file);
    b.set([api(1, 'assigned'), api(2, 'review_requested'), api(3, 'mentioned')]);
    await b.w.check();
    expect(b.first).toEqual([]);
    expect(b.told.map((l) => l.map((t) => t.id))).toEqual([[3]]);
  });

  it('signed out of glab: says so, and waits a while before trying again', async () => {
    const s = setup();
    s.fail(Object.assign(new Error('glab: 401 Unauthorized'), { stderr: '401 Unauthorized' }));
    await s.w.check();
    expect(s.w.status().state).toBe('signed-out');
    s.fail(null);
    await s.w.check();
    expect(s.calls).toHaveLength(1);
    s.tick(6 * 60_000);
    await s.w.check();
    expect(s.calls).toHaveLength(2);
    expect(s.w.status().state).toBe('ok');
  });

  it('a to-do in Cora\'s words, and as an Inbox item (one per MR, each to-do an entry)', () => {
    const t = toTodo(api(7, 'review_requested'))!;
    expect(t).toMatchObject({ id: 7, action: 'review_requested', type: 'MergeRequest', project: 'acme/app', ref: '!12', title: 'Retry the export job', who: 'Dana Scully', text: 'can you take a look?' });
    expect(toTodo(api(8, 'mentioned', { target_type: 'Issue', target: { iid: 34, title: 'Login loops' } }))!.ref).toBe('#34');
    expect(fromGitlabTodo(t)).toMatchObject({ source: 'gitlab', key: 'gl:acme/app!12', title: 'app !12 · Retry the export job', why: 'your review was requested (MR)', entry: { id: 'todo:7', who: 'Dana Scully', text: 'can you take a look?' } });
    expect(toTodo({ nope: true })).toBeNull();
    expect(toTodo(api(9, 'duo_core_access_granted', { target_type: 'User' }))).toBeNull();
    expect(toTodo(api(10, 'review_submitted'))!.action).toBe('review_submitted');
  });
});
