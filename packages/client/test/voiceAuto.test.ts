import { describe, expect, it } from 'vitest';
import type { BrainEvent, PendingRequest, ToolInfo } from '@cora/shared';
import { announcement, failureAnnouncement, saidLine, voiceCues } from '../src/lib/voiceAuto';

let seq = 0;
const base = { sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'run' as const }, source: 'transcript' as const };
const tool = (id: string, ts: number, phase: 'start' | 'end', t: Partial<ToolInfo> & { name: string }): BrainEvent =>
  ({ ...base, seq: seq++, id: `tool:${id}:${phase}`, ts, kind: 'tool', phase, toolUseId: id, tool: { input: {}, summary: '', ...t } });
const said = (id: string, ts: number, text: string) => tool(id, ts, 'start', { name: 'mcp__cora__speak', input: { text } });

describe('voiceCues', () => {
  it('picks the speak calls made since the app opened, each once', () => {
    const seen = new Set<string>();
    const evs = [said('old', 500, 'From before the app opened.'), said('a', 2000, 'I fixed the login bug.'), tool('a', 2100, 'end', { name: 'mcp__cora__speak' }), tool('r', 2200, 'start', { name: 'Read' })];
    expect(voiceCues(evs, 1000, seen)).toEqual([{ kind: 'said', id: 'a', text: 'I fixed the login bug.' }]);
    // the same events again (another update to the session): nothing new
    expect(voiceCues(evs, 1000, seen)).toEqual([]);
    expect(voiceCues([...evs, said('b', 3000, 'Tests pass.'), said('c', 3100, 'Pushed it.')], 1000, seen).map((c) => c.id)).toEqual(['b', 'c']);
    expect(voiceCues([said('d', 4000, '   ')], 1000, seen)).toEqual([]);
  });

  it("picks a reply's say-line (the turn's spoken summary) under the id the transcript's button uses", () => {
    const seen = new Set<string>();
    const reply = (id: string, ts: number, saidText?: string): BrainEvent => ({ ...base, seq: seq++, id, ts, kind: 'say', text: 'Done.', ...(saidText ? { said: saidText } : {}) });
    const evs = [reply('old', 500, 'Before the app opened.'), reply('plain', 2000), reply('r1', 2100, 'Fixed the login bug.')];
    expect(voiceCues(evs, 1000, seen)).toEqual([{ kind: 'said', id: 'say:r1', text: 'Fixed the login bug.' }]);
    expect(voiceCues(evs, 1000, seen)).toEqual([]);
  });

  it("doesn't read out a turn your words from Cora's Slack DM started (you're away: it answers there)", () => {
    const seen = new Set<string>();
    const prompt = (id: string, ts: number, text: string): BrainEvent => ({ ...base, seq: seq++, id, ts, kind: 'prompt', text });
    const reply = (id: string, ts: number, saidText: string): BrainEvent => ({ ...base, seq: seq++, id, ts, kind: 'say', text: 'x', said: saidText });
    const evs = [
      prompt('p1', 2000, "[Slack · the user, from their Cora DM on their phone: reply briefly] what's running?"),
      reply('r1', 2100, 'Three sessions are working.'),
      said('t1', 2150, 'Also this.'),
      prompt('p2', 3000, 'and here at my desk?'),
      reply('r2', 3100, 'Still three.'),
    ];
    expect(voiceCues(evs, 1000, seen).map((c) => c.id)).toEqual(['say:r2']);
  });

  it('picks failed tools, not ones you declined or stopped, nor speak/present themselves', () => {
    const seen = new Set<string>();
    const evs = [
      tool('ok', 2000, 'end', { name: 'Bash', input: { command: 'npm test' } }),
      tool('bad', 2100, 'end', { name: 'Bash', input: { command: 'npm test' }, failed: true, resultSummary: 'Exit code 1' }),
      tool('no', 2200, 'end', { name: 'Edit', failed: true, preview: "The user doesn't want to proceed with this tool use. The tool use was rejected" }),
      tool('int', 2300, 'end', { name: 'Bash', failed: true, resultSummary: '[Request interrupted by user for tool use]' }),
      tool('sp', 2400, 'end', { name: 'mcp__cora__speak', failed: true, resultSummary: 'Spoken summaries are turned off' }),
    ];
    const cues = voiceCues(evs, 1000, seen);
    expect(cues.map((c) => [c.kind, c.id])).toEqual([['failed', 'fail:bad']]);
    expect(voiceCues(evs, 1000, seen)).toEqual([]);
  });

  it('only looks at the newest events', () => {
    const evs = [said('first', 2000, 'Way back.'), ...Array.from({ length: 50 }, (_, i) => tool(`r${i}`, 2001 + i, 'start', { name: 'Read' }))];
    expect(voiceCues(evs, 1000, new Set())).toEqual([]);
  });
});

describe('what gets said', () => {
  it("a summary says where it's from unless you're looking at that session", () => {
    expect(saidLine('Tests pass.', null)).toBe('Tests pass.');
    expect(saidLine('Tests pass.', 'aurora')).toBe('In aurora: Tests pass.');
  });

  it('a failure says what failed, and where', () => {
    expect(failureAnnouncement(tool('a', 0, 'end', { name: 'Bash', failed: true }), 'aurora')).toBe('A command failed in aurora.');
    expect(failureAnnouncement(tool('b', 0, 'end', { name: 'Edit', input: { file_path: 'C:\\code\\x\\src\\App.tsx' }, failed: true }), 'x')).toBe('Editing App.tsx failed in x.');
    expect(failureAnnouncement(tool('c', 0, 'end', { name: 'mcp__github__create_pr', failed: true }), 'x')).toBe('The github create_pr tool failed in x.');
  });
});

const req = (toolName: string, toolInput: unknown, kind: PendingRequest['kind'] = 'permission'): PendingRequest => ({ id: 'p', kind, sessionId: 's', agentId: 'main', toolName, toolInput, createdAt: 0, expiresAt: 0 });

describe('announcement', () => {
  it('says what a permission prompt wants, with paths and URLs cut to their last part', () => {
    expect(announcement(req('Bash', { command: 'docker push ghcr.io/acme/aurora:2.4.0 --quiet' }), 'aurora')).toBe('Claude wants to run docker push aurora:2.4.0 --quiet in aurora.');
    expect(announcement(req('PowerShell', { command: 'Remove-Item C:\\code\\x\\dist -Recurse' }), 'x')).toBe('Claude wants to run Remove-Item dist -Recurse in x.');
    expect(announcement(req('Edit', { file_path: 'C:\\code\\agent-brain\\packages\\client\\src\\App.tsx' }), 'agent-brain')).toBe('Claude wants to edit App.tsx in agent-brain.');
    expect(announcement(req('mcp__github__create_pr', {}), 'aurora')).toBe('Claude wants to use github create_pr in aurora.');
    expect(announcement(req('AskUserQuestion', {}, 'question'), 'aurora')).toBe('Claude has a question for you in aurora.');
  });
});

describe('taskAnnouncement', () => {
  it('says how a background command ended, and where', async () => {
    const { taskAnnouncement } = await import('../src/lib/voiceAuto');
    const t = { key: 'k', taskId: 'b1', agentId: 'main', label: 'Poll the pipeline', command: 'glab ci status', program: 'glab', startedAt: 0, endedAt: 360_000, status: 'completed' as const, exit: 0 };
    expect(taskAnnouncement(t, 'orion-services')).toBe('Poll the pipeline is done in 6m, in orion-services.');
    expect(taskAnnouncement({ ...t, status: 'failed', exit: 1, endedAt: 40_000 }, 'x')).toBe('Poll the pipeline failed (exit 1) after 40s, in x.');
    // no description: the command isn't read out
    const raw = { ...t, label: 'WT=C:/code/cora bash "$TEMP/x/simeye.sh"', command: 'WT=C:/code/cora bash "$TEMP/x/simeye.sh"', program: 'bash', status: 'failed' as const, exit: 1, endedAt: 40_000 };
    expect(taskAnnouncement(raw, 'agent-brain')).toBe('A background bash command failed (exit 1) after 40s, in agent-brain.');
    expect(taskAnnouncement({ ...raw, program: 'WT=C:/code/cora' }, 'x')).toBe('A background command failed (exit 1) after 40s, in x.');
  });
});
