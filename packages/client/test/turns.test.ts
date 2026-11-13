import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { buildSteps } from '../src/lib/steps';
import { buildTurns, workSummary } from '../src/lib/turns';

let seq = 0;
const E = (o: Partial<BrainEvent> & Pick<BrainEvent, 'kind'>): BrainEvent => ({
  id: `e${++seq}`, seq, sessionId: 's', agentId: 'main', ts: seq * 10, icon: { name: 'X', family: 'mind' }, source: 'transcript', ...o,
});
const FAMILY: Record<string, BrainEvent['icon']['family']> = { Read: 'look', Grep: 'look', Glob: 'look', Bash: 'run', Edit: 'change', Write: 'change' };
/** a tool call, start and end */
const call = (name: string, summary: string, o: { failed?: boolean; resource?: string } = {}) => {
  const id = `t${++seq}`;
  const icon = { name: 'X', family: FAMILY[name] ?? 'mcp' };
  return [
    E({ kind: 'tool', phase: 'start', toolUseId: id, icon, tool: { name, input: {}, summary, ...(o.resource ? { resource: o.resource } : {}) } }),
    E({ kind: 'tool', phase: 'end', toolUseId: id, icon, tool: { name, input: {}, summary, ...(o.failed ? { failed: true } : {}), ...(o.resource ? { resource: o.resource } : {}) } }),
  ];
};
const turns = (events: BrainEvent[], live = false) => buildTurns(buildSteps(events, 'all'), live);

describe('turns', () => {
  it('a prompt, its work and its answer are one turn: tools grouped by kind, the last thing it said is the answer', () => {
    const t = turns([
      E({ kind: 'prompt', text: 'Why is the build red?' }),
      E({ kind: 'say', text: 'Let me look at the config.' }),
      ...call('Read', 'a.ts'), ...call('Read', 'b.ts'), ...call('Read', 'c.ts'),
      ...call('Bash', 'npm test', { failed: true }), ...call('Bash', 'npm test'),
      E({ kind: 'think', durationMs: 1200 }),
      E({ kind: 'say', text: 'Fixed: the test imported the wrong path.' }),
      E({ kind: 'turn_end', durationMs: 42_000 }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].prompt?.text).toBe('Why is the build red?');
    expect(t[0].answer?.text).toBe('Fixed: the test imported the wrong path.');
    // the interim words are a note in the work, then the groups
    expect(t[0].work.map((p) => (p.kind === 'group' ? `${p.g.label}` : p.kind))).toEqual(['note', 'Read 3 files', 'Ran 2 commands']);
    expect(t[0].stats).toMatchObject({ ms: 42_000, tools: 5, failed: 1, thinkMs: 1200 });
    expect(workSummary(t[0])).toBe('read 3 files · ran 2 · 1 failed');
    expect(t[0].end?.kind).toBe('turn_end');
  });

  it('each prompt starts a turn; a message sent mid-turn stays in its turn', () => {
    const t = turns([
      E({ kind: 'prompt', text: 'one' }), ...call('Grep', 'x'), E({ kind: 'prompt', text: 'also this', midTurn: true }), E({ kind: 'say', text: 'done one' }), E({ kind: 'turn_end' }),
      E({ kind: 'prompt', text: 'two' }), E({ kind: 'say', text: 'done two' }), E({ kind: 'turn_end' }),
    ]);
    expect(t.map((x) => x.prompt?.text)).toEqual(['one', 'two']);
    expect(t[0].work.some((p) => p.kind === 'mid' && p.text === 'also this')).toBe(true);
    expect(t[1].answer?.text).toBe('done two');
  });

  it('while it works, words followed by more tools are not the answer yet; only the last turn is live', () => {
    const t = turns([
      E({ kind: 'prompt', text: 'one' }), E({ kind: 'say', text: 'ok' }), E({ kind: 'turn_end' }),
      E({ kind: 'prompt', text: 'two' }), E({ kind: 'say', text: 'Checking the tests next.' }), ...call('Bash', 'npm test'),
    ], true);
    expect(t.map((x) => x.live)).toEqual([false, true]);
    expect(t[1].answer).toBeUndefined();
    expect(t[1].work[0]).toMatchObject({ kind: 'note', text: 'Checking the tests next.' });
  });

  it('a scheduled wakeup starts a turn of its own; notices are kept as rows', () => {
    const t = turns([
      E({ kind: 'prompt', text: 'one' }), E({ kind: 'say', text: 'ok' }), E({ kind: 'turn_end' }),
      E({ kind: 'notice', notice: { type: 'wakeup', text: 'Running scheduled task: ingest' } }),
      ...call('Bash', 'ingest'),
      E({ kind: 'notice', notice: { type: 'error', text: 'API Error: Connection lost' } }),
      E({ kind: 'say', text: 'Ingested 40 pages.' }), E({ kind: 'turn_end' }),
    ]);
    expect(t).toHaveLength(2);
    expect(t[1].wake).toBe('Running scheduled task: ingest');
    expect(t[1].notices.map((n) => n.kind === 'notice' && n.e.notice?.type)).toEqual(['error']);
    expect(t[1].answer?.text).toBe('Ingested 40 pages.');
  });

  it('edits count the files, not the calls; other tools still group by kind', () => {
    const t = turns([E({ kind: 'prompt', text: 'go' }), ...call('Edit', 'a.ts', { resource: 'a.ts' }), ...call('Edit', 'a.ts', { resource: 'a.ts' }), ...call('Write', 'b.ts', { resource: 'b.ts' }), ...call('Grep', 'x'), ...call('Glob', 'y'), E({ kind: 'turn_end' })]);
    expect(t[0].work.map((p) => (p.kind === 'group' ? p.g.label : p.kind))).toEqual(['Edited 2 files', 'Searched 2 times']);
    expect(workSummary(t[0])).toBe('searched 2 · edited 2 files');
  });
});

describe('a turn that ended while a background agent works on', () => {
  it("is over: its last words are the answer, even with the session still busy", () => {
    const t = turns([E({ kind: 'prompt', text: 'review it' }), ...call('Bash', 'glab mr view'), E({ kind: 'say', text: 'No logic error found.' }), ...call('mcp__cora__present', 'Review'), E({ kind: 'turn_end', durationMs: 5000 })], true);
    expect(t[0].live).toBe(false);
    expect(t[0].answer?.text).toBe('No logic error found.');
  });
});

describe('turns, the details', () => {
  it('main working again after its turn ended (a background task reported) reopens the turn; its time is all of it', () => {
    const t = turns([E({ kind: 'prompt', text: 'go' }), E({ kind: 'say', text: 'Started it in the background.' }), E({ kind: 'turn_end', durationMs: 2000 }), ...call('Bash', 'cat out.log'), E({ kind: 'say', text: 'It passed.' }), E({ kind: 'turn_end', durationMs: 3000 })]);
    expect(t).toHaveLength(1);
    expect(t[0].answer?.text).toBe('It passed.');
    expect(t[0].stats.ms).toBe(5000);
    const still = turns([E({ kind: 'prompt', text: 'go' }), E({ kind: 'say', text: 'Started.' }), E({ kind: 'turn_end', durationMs: 2000 }), ...call('Bash', 'cat out.log')], true);
    expect(still[0].live).toBe(true);
  });
  it('a group says what was touched: commands by what ran, the task list and skills by name', () => {
    const t = turns([E({ kind: 'prompt', text: 'go' }), ...call('Bash', 'npm test', { resource: 'shell' }), ...call('TodoWrite', '3 tasks'), ...call('Skill', 'code-review'), E({ kind: 'turn_end' })]);
    const g = t[0].work.flatMap((p) => (p.kind === 'group' ? [`${p.g.label}|${p.g.detail}`] : []));
    expect(g).toEqual(['Ran 1 command|npm test', 'Updated its tasks|3 tasks', 'Used a skill|code-review']);
  });
});
