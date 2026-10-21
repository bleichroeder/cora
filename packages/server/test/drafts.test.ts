import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrainEvent, SessionInfo } from '@cora/shared';
import { Drafts } from '../src/drafts';
import { Notes } from '../src/notes';
import { parseTemplate, stripHints } from '../src/noteTemplates';

const T0 = Date.parse('2026-10-17T13:00:00Z');
const ses = (id: string, cwd: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd, project: cwd.split('/').pop()!, title: id, state: 'ended', startedAt: T0, lastTs: T0 + 3600_000, ...o }) as SessionInfo;
let seq = 0;
const ev = (sid: string, at: number, kind: BrainEvent['kind'], o: Partial<BrainEvent> = {}): BrainEvent => ({ id: `e${seq}`, seq: seq++, sessionId: sid, agentId: 'main', ts: at, kind, icon: { name: 'x', family: 'run' }, source: 'transcript', ...o }) as BrainEvent;

const SESSIONS = [
  ses('s1', 'C:/code/orion-services', { ticket: { key: 'ACME-5301', site: null, summary: 'Chat product events' }, alias: 'chat events' }),
  ses('s2', 'C:/tmp/wt-cora', { alias: 'cora deploys' }),
  ses('s3', 'C:/github/aurora', { alias: 'aurora seek' }),
  ses('old', 'C:/code/orion-services', { startedAt: T0 - 5 * 86400_000, lastTs: T0 - 4 * 86400_000 }),
];
const EVENTS: Record<string, BrainEvent[]> = {
  s1: [
    ev('s1', T0 + 60_000, 'prompt', { text: '/jira ACME-5301' }),
    ev('s1', T0 + 120_000, 'tool', { phase: 'start', tool: { name: 'Bash', input: { command: 'git commit -m "ACME-5301: emit chat events"' }, summary: 'git commit' } }),
    ev('s1', T0 + 130_000, 'tool', { phase: 'start', tool: { name: 'Bash', input: { command: 'ls -la' }, summary: 'ls' } }),
    ev('s1', T0 + 140_000, 'tool', { phase: 'start', tool: { name: 'Edit', input: {}, summary: 'edit', change: { path: 'a.cs', kind: 'edit', add: 1, del: 0 } } }),
    ev('s1', T0 + 200_000, 'say', { text: 'long reply', said: 'Merged !2076 and bumped dev to 2.10.0-dev26.' }),
  ],
  s2: [ev('s2', T0 + 60_000, 'prompt', { text: 'build the deploy board' })],
  s3: [ev('s3', T0 + 60_000, 'prompt', { text: 'fix seek' })],
  old: [ev('old', T0 - 4 * 86400_000, 'prompt', { text: 'ancient' })],
};
const repoOf = async (cwd: string) => (cwd.includes('wt-cora') ? 'cora' : cwd.split('/').pop()!);

describe('templates', () => {
  it('front matter says whether Cora fills it, its window and title; hints come out for a plain note', () => {
    const t = parseTemplate('---\nfill: cora\nwindow: week   # the default\ntitle: Week of {date}\n---\n## Shipped\n<!-- cora: what shipped -->\n\n## Notes\n', 'Weekly');
    expect(t).toMatchObject({ fill: true, window: 'week', title: 'Week of {date}' });
    expect(stripHints(t.body)).toBe('## Shipped\n\n## Notes\n');
    expect(parseTemplate('# just text', 'Bug')).toEqual({ fill: false, window: 'since-last', title: 'Bug · {date}', body: '# just text' });
  });

  it('the first templates are made once; a note from one; "since last" is the last note from it', () => {
    let now = T0;
    const dir = join(mkdtempSync(join(tmpdir(), 'cora-tpl-')), 'notes');
    const n = new Notes({ dir, now: () => (now += 1000) });
    const tpls = n.list().filter((x) => x.kind === 'template');
    expect(tpls.map((x) => [x.title, x.fill])).toEqual([['Bug report', false], ['Meeting', true], ['Standup', true], ['Weekly review', true]]);
    n.remove('tpl-bug-report');
    expect(new Notes({ dir }).list().some((x) => x.id === 'tpl-bug-report')).toBe(false);
    // Restore default templates: the deleted starter comes back as it was; ones still there are left alone
    n.save('tpl-meeting', 'my own meeting template', n.read('tpl-meeting').version);
    expect(n.restoreTemplates()).toBe(1);
    expect(n.read('tpl-bug-report').text).toMatch(/## What happens/);
    expect(n.read('tpl-meeting').text).toBe('my own meeting template');
    expect(n.restoreTemplates()).toBe(0);
    n.remove('tpl-bug-report');
    expect(n.lastFrom('tpl-standup')).toBeNull();
    const id = n.fromTemplate('tpl-standup', { keepHints: false });
    expect(n.read(id)).toMatchObject({ title: expect.stringMatching(/^Standup · \w{3} \w{3} \d+$/), from: 'tpl-standup' });
    expect(n.read(id).text).not.toMatch(/cora:/);
    expect(n.lastFrom('tpl-standup')).toBe(n['idx'].notes[id].createdAt);
    // templates aren't notes to sessions
    expect(n.find('Standup')).not.toBe('tpl-standup');
    expect(n.search('Yesterday').some((h) => h.id.startsWith('tpl-'))).toBe(false);
  });
});

describe('drafts', () => {
  const deps = (run?: any) => ({ sessions: () => SESSIONS, events: (sid: string) => EVENTS[sid] ?? [], repoOf, dataDir: mkdtempSync(join(tmpdir(), 'cora-draft-')), jots: () => [{ id: 'j1', at: T0 + 1000, text: 'ask QA about staging' }], jira: () => [{ id: 'x', kind: 'status' as const, key: 'ACME-5301', summary: 'Chat product events', who: 'Ana', what: 'moved it to QA', at: T0 + 5000, link: '' }], run, claudeCmd: ['claude'], now: () => T0 + 7200_000 });
  const W = { since: T0, until: T0 + 7200_000 };

  it('the repos of a window (worktrees as their repo), busiest first', async () => {
    expect(await new Drafts(deps()).repos(W)).toEqual([{ repo: 'aurora', sessions: 1 }, { repo: 'cora', sessions: 1 }, { repo: 'orion-services', sessions: 1 }]);
  });

  it('the facts: sessions in the picked repos with their ticket, prompts, summaries and notable commands; jots and Jira', async () => {
    const f = await new Drafts(deps()).facts(W, ['orion-services', 'cora']);
    expect(f.counts).toMatchObject({ sessions: 2, tickets: ['ACME-5301'], mrs: ['!2076'], jots: 1, jira: 1 });
    expect(f.text).toMatch(/## Repo: orion-services\n### chat events \(ticket ACME-5301: Chat product events\)/);
    expect(f.text).toMatch(/- user asked: \/jira ACME-5301/);
    expect(f.text).toMatch(/- claude: Merged !2076 and bumped dev to 2\.10\.0-dev26\./);
    expect(f.text).toMatch(/- commands: git commit -m "ACME-5301: emit chat events"/);
    expect(f.text).not.toMatch(/ls -la|aurora seek|ancient/);
    expect(f.text).toMatch(/- edited 1 file/);
    expect(f.text).toMatch(/## Jira activity on your tickets\n- ACME-5301 \(Chat product events\): Ana moved it to QA/);
    expect(f.text).toMatch(/## The user's jots\n- ask QA about staging/);
  });

  it('writes the note with Claude (no tools, hooks off), from the template and the facts', async () => {
    const calls: Array<{ cmd: string[]; input: string }> = [];
    const run = async (cmd: string[], o: { input: string }) => (calls.push({ cmd, input: o.input }), { code: 0, stdout: '```markdown\n## Yesterday\n- **orion-services:** ACME-5301 merged (!2076)\n```\n', timedOut: false });
    const d = new Drafts(deps(run));
    const r = await d.write('## Yesterday\n<!-- cora: done -->\n', await d.facts(W));
    expect(r).toEqual({ ok: true, text: '## Yesterday\n- **orion-services:** ACME-5301 merged (!2076)\n' });
    expect(calls[0].cmd).toEqual(expect.arrayContaining(['-p', '--model', 'sonnet', '--tools', '', '--safe-mode', '--no-session-persistence']));
    expect(calls[0].input).toMatch(/<template>\n## Yesterday\n<!-- cora: done -->\n<\/template>[\s\S]*<facts>\nWindow:/);
    expect(await new Drafts(deps(async () => ({ code: 1, stdout: '', timedOut: false }))).write('x', await d.facts(W))).toMatchObject({ ok: false });
    // nothing added: no <user_adds>
    expect(calls[0].input).not.toMatch(/<user_adds>/);
  });

  it('what you add for a draft goes with it ("leave out project X")', async () => {
    const calls: string[] = [];
    const d = new Drafts(deps(async (_cmd: string[], o: { input: string }) => (calls.push(o.input), { code: 0, stdout: '## Yesterday\n- x\n', timedOut: false })));
    await d.write('## Yesterday\n<!-- cora: done -->\n', await d.facts(W), undefined, '  leave out aurora and anything personal  ');
    expect(calls[0]).toMatch(/<\/facts>\n\n<user_adds>\nleave out aurora and anything personal\n<\/user_adds>\n\nWrite the note now/);
  });
});
