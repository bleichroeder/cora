import { describe, expect, it } from 'vitest';
import { bangOutput, newParseCtx, parseLine, unescapeOutput } from '../src/transcript/parse';

const SID = 's-1';
const T0 = Date.parse('2026-10-12T13:27:02.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const usage = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 93, output_tokens_details: { thinking_tokens: 27 } };

const asst = (uuid: string, msgId: string, block: any, ms: number, extra: any = {}) => ({
  type: 'assistant', uuid, timestamp: iso(ms), sessionId: SID, isSidechain: false, cwd: 'C:\\code\\proj', version: '2.1.281',
  message: { id: msgId, model: 'claude-opus-5-5', role: 'assistant', content: [block], usage }, ...extra,
});
const result = (uuid: string, toolUseId: string, content: any, ms: number, toolUseResult?: any, isError = false) => ({
  type: 'user', uuid, timestamp: iso(ms), sessionId: SID, cwd: 'C:\\code\\proj',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
  ...(toolUseResult ? { toolUseResult } : {}),
});

describe('parseLine', () => {
  it('model attachment keeps the context-window suffix on later assistant lines', () => {
    const ctx = newParseCtx();
    const a = parseLine({ type: 'attachment', uuid: 'at1', timestamp: iso(0), sessionId: SID, attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } } }, ctx);
    expect(a).toEqual({ events: [], meta: { model: 'claude-opus-5-5[1m]' } });
    const b = parseLine(asst('a1', 'm1', { type: 'text', text: 'hi' }, 10), ctx);
    expect(b.meta.model).toBe('claude-opus-5-5[1m]');
    expect(parseLine(asst('a2', 'm2', { type: 'text', text: 'hi' }, 20), newParseCtx()).meta.model).toBe('claude-opus-5-5');
  });

  it('human prompt → prompt event', () => {
    const ctx = newParseCtx();
    const { events, meta } = parseLine({ type: 'user', uuid: 'u1', promptId: 'p1', timestamp: iso(0), sessionId: SID, cwd: 'C:\\code\\proj', version: '2.1.281', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Look at the design' } }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'prompt:p1', kind: 'prompt', agentId: 'main', sessionId: SID, text: 'Look at the design', ts: T0, source: 'transcript' });
    expect(meta).toMatchObject({ cwd: 'C:\\code\\proj', cliVersion: '2.1.281' });
  });

  it('meta / system-injected user strings are not prompts', () => {
    const ctx = newParseCtx();
    expect(parseLine({ type: 'user', uuid: 'u2', timestamp: iso(0), sessionId: SID, isMeta: true, message: { role: 'user', content: 'x' } }, ctx).events).toHaveLength(0);
    expect(parseLine({ type: 'user', uuid: 'u3', timestamp: iso(0), sessionId: SID, message: { role: 'user', content: '<task-notification>…' } }, ctx).events).toHaveLength(0);
  });

  it('a command you ran yourself (! in the terminal) is a shell call, then its output', () => {
    const ctx = newParseCtx();
    const u = (uuid: string, content: string, ms: number, parentUuid?: string) => ({ type: 'user', uuid, parentUuid, promptId: 'p9', timestamp: iso(ms), sessionId: SID, userType: 'external', message: { role: 'user', content } });
    const start = parseLine(u('b1', '<bash-input>hs account use acme-development</bash-input>', 0), ctx).events;
    expect(start).toEqual([expect.objectContaining({ kind: 'tool', phase: 'start', toolUseId: 'bang:b1', tool: expect.objectContaining({ name: 'Bash', input: expect.objectContaining({ command: 'hs account use acme-development' }) }) })]);
    const end = parseLine(u('b2', '<bash-stdout>[SUCCESS] Account set</bash-stdout><bash-stderr></bash-stderr>', 1200, 'b1'), ctx).events;
    expect(end).toEqual([expect.objectContaining({ kind: 'tool', phase: 'end', toolUseId: 'bang:b1', durationMs: 1200 })]);
    expect(JSON.stringify(end[0].tool)).toContain('Account set');
    // output nobody started (another line's) stays out, as before
    expect(parseLine(u('b3', '<bash-stdout>x</bash-stdout>', 2000, 'nope'), ctx).events).toHaveLength(0);
  });

  it("a command you ran is marked yours, its output as printed (Claude Code's own lines read as what they mean)", () => {
    const ctx = newParseCtx();
    const u = (uuid: string, content: string, ms: number, parentUuid?: string) => ({ type: 'user', uuid, parentUuid, promptId: 'p9', timestamp: iso(ms), sessionId: SID, message: { role: 'user', content } });
    // as Claude Code writes them (2.1.281): the command with the space you typed after `!`, then stdout and stderr
    const [start] = parseLine(u('c1', '<bash-input> aws login</bash-input>', 0), ctx).events;
    expect(start.tool).toMatchObject({ name: 'Bash', input: { command: 'aws login' }, byYou: true });
    expect(start.tool?.input).not.toHaveProperty('description');
    const [end] = parseLine(u('c2', '<bash-stdout>open https://x.test/a?b=1&amp;c=2\r\nUpdated profile</bash-stdout><bash-stderr></bash-stderr>', 900, 'c1'), ctx).events;
    expect(end.tool).toMatchObject({ byYou: true, resultSummary: '2 lines' });
    expect(end.tool?.preview).toContain('b=1&c=2');
    expect(end.tool?.failed).toBeUndefined();
    // nothing printed
    parseLine(u('d1', '<bash-input>sed -i x f</bash-input>', 1000), ctx);
    const [quiet] = parseLine(u('d2', '<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>', 1100, 'd1'), ctx).events;
    expect(quiet.tool).toMatchObject({ resultSummary: 'no output' });
    expect(quiet.tool?.preview).toBeUndefined();
    // past Claude Code's 2 minutes: in the background, its task-notification ends it
    parseLine(u('e1', '<bash-input> cd /c/code/cora && node scripts/package.mjs --publish</bash-input>', 2000), ctx);
    const bg = '<bash-stdout>Command did not complete within its 120s timeout and was moved to the background (ID: b1glfwtcg). Output is being written to: C:\\Users\\D\\tasks\\b1glfwtcg.output. You will be notified when it completes.</bash-stdout><bash-stderr></bash-stderr>';
    const [moved] = parseLine(u('e2', bg, 122_000, 'e1'), ctx).events;
    expect(moved.tool).toMatchObject({ resultSummary: 'running in background', background: { taskId: 'b1glfwtcg', outputFile: 'C:\\Users\\D\\tasks\\b1glfwtcg.output' } });
    // refused: only Claude Code's error came back
    parseLine(u('f1', '<bash-input>git -C ../other push</bash-input>', 3000), ctx);
    const [refused] = parseLine(u('f2', '<bash-stderr>Command failed: This session is isolated in the worktree C:\\w</bash-stderr>', 3100, 'f1'), ctx).events;
    expect(refused.tool).toMatchObject({ failed: true });
    expect(refused.tool?.resultSummary).toContain('Command failed');
  });

  it("a command's output: stdout then stderr, unescaped", () => {
    expect(unescapeOutput('a &lt;b&gt; &amp;amp; &quot;c&quot; &#39;d&#39;')).toBe(`a <b> &amp; "c" 'd'`);
    expect(bangOutput('<bash-stdout></bash-stdout><bash-stderr>/usr/bin/bash: awscli: command not found\n</bash-stderr>')).toEqual({ out: '/usr/bin/bash: awscli: command not found', refused: false });
    expect(bangOutput('<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>').out).toBe('ok\nwarn');
  });

  it('interrupt markers are interrupt events, not prompts', () => {
    const ctx = newParseCtx();
    const e1 = parseLine({ type: 'user', uuid: 'i1', timestamp: iso(0), sessionId: SID, interruptedMessageId: 'm', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, ctx).events;
    expect(e1).toEqual([expect.objectContaining({ id: 'i1', kind: 'interrupt', agentId: 'main' })]);
    const e2 = parseLine({ type: 'user', uuid: 'i2', timestamp: iso(1), sessionId: SID, message: { role: 'user', content: '[Request interrupted by user for tool use]' } }, ctx).events;
    expect(e2[0].kind).toBe('interrupt');
  });

  it('subagent first message → prompt on that agent', () => {
    const ctx = newParseCtx();
    const { events } = parseLine({ type: 'user', uuid: 'u4', timestamp: iso(0), sessionId: SID, agentId: 'a111', isSidechain: true, message: { role: 'user', content: 'Count lines in README' } }, ctx);
    expect(events[0]).toMatchObject({ kind: 'prompt', agentId: 'a111', text: 'Count lines in README' });
  });

  it('thinking → think end with duration since previous line and thinking tokens once per message', () => {
    const ctx = newParseCtx();
    parseLine({ type: 'user', uuid: 'u1', timestamp: iso(0), sessionId: SID, origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } }, ctx);
    const th = parseLine(asst('a1', 'msgA', { type: 'thinking', thinking: '' }, 2000), ctx).events[0];
    expect(th).toMatchObject({ kind: 'think', phase: 'end', durationMs: 2000, icon: { name: 'Brain' } });
    expect(th.tokens).toEqual({ in: 152, out: 93, cached: 100, thinking: 27 });
    const tx = parseLine(asst('a2', 'msgA', { type: 'text', text: 'Let me look.' }, 2100), ctx).events[0];
    expect(tx).toMatchObject({ kind: 'say', text: 'Let me look.' });
    expect(tx.tokens).toBeUndefined();
  });

  it("a reply's say-line comes out of the text as its spoken summary", () => {
    const ctx = newParseCtx();
    const tx = parseLine(asst('s1', 'msgS', { type: 'text', text: 'All green.\n\n<!-- say: The build passes now. -->' }, 100), ctx).events[0];
    expect(tx).toMatchObject({ kind: 'say', text: 'All green.', said: 'The build passes now.' });
    expect(parseLine(asst('s2', 'msgT', { type: 'text', text: 'No line.' }, 200), ctx).events[0].said).toBeUndefined();
  });

  it('an explain written in a reply becomes a present call (start and end), and leaves the reply', () => {
    const ctx = newParseCtx();
    const text = 'Done.\n<!-- cora:explain title="Diff summary" format="markdown" -->\n| file | change |\n|---|---|\n<!-- /cora:explain -->\n<!-- say: I summarised the diff. -->';
    const evs = parseLine(asst('e1', 'msgE', { type: 'text', text }, 100), ctx).events;
    expect(evs[0]).toMatchObject({ kind: 'say', text: 'Done.', said: 'I summarised the diff.' });
    expect(evs[1]).toMatchObject({ kind: 'tool', phase: 'start', toolUseId: 'explain-e1-0', tool: { name: 'mcp__cora__present', input: { title: 'Diff summary', format: 'markdown', content: '| file | change |\n|---|---|' } } });
    expect(evs[2]).toMatchObject({ kind: 'tool', phase: 'end', toolUseId: 'explain-e1-0' });
    // a reply that is only an explain: no empty reply
    expect(parseLine(asst('e2', 'msgF', { type: 'text', text: '<!-- cora:explain title="X" -->y<!-- /cora:explain -->' }, 200), ctx).events.map((e) => e.kind)).toEqual(['tool', 'tool']);
  });

  it("a thinking block with words (a model's note on its progress, shown in the terminal) keeps them; an empty one has none", () => {
    const ctx = newParseCtx();
    const note = parseLine(asst('n1', 'msgN', { type: 'thinking', thinking: '  Confirmed the buttons only send `{ isActive }`. Doing one last check.  ' }, 1000), ctx).events[0];
    expect(note).toMatchObject({ kind: 'think', text: 'Confirmed the buttons only send `{ isActive }`. Doing one last check.' });
    const hidden = parseLine(asst('n2', 'msgO', { type: 'thinking', thinking: '' }, 2000), ctx).events[0];
    expect(hidden.text).toBeUndefined();
    expect(parseLine(asst('n3', 'msgP', { type: 'redacted_thinking', data: 'x' }, 3000), ctx).events[0].text).toBeUndefined();
  });

  it('a second thinking block of the same response is not timed', () => {
    const ctx = newParseCtx();
    parseLine({ type: 'user', uuid: 'u1', timestamp: iso(0), sessionId: SID, origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } }, ctx);
    parseLine(asst('b1', 'msgZ', { type: 'thinking', thinking: '' }, 3000), ctx);
    const second = parseLine(asst('b2', 'msgZ', { type: 'thinking', thinking: '' }, 3004), ctx).events[0];
    expect(second.durationMs).toBeUndefined();
  });

  it('empty text blocks are skipped', () => {
    const ctx = newParseCtx();
    expect(parseLine(asst('a3', 'msgB', { type: 'text', text: '  ' }, 0), ctx).events).toHaveLength(0);
  });

  it('tool_use → tool start; tool_result → tool end merged by toolUseId', () => {
    const ctx = newParseCtx();
    const st = parseLine(asst('a4', 'msgC', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\code\\proj\\src\\a.ts' } }, 1000), ctx).events[0];
    expect(st).toMatchObject({ id: 'tool:toolu_1:start', kind: 'tool', phase: 'start', toolUseId: 'toolu_1', icon: { name: 'FileText', family: 'look' } });
    expect(st.tool).toMatchObject({ name: 'Read', summary: 'src/a.ts', resource: 'files:src' });
    const en = parseLine(result('u5', 'toolu_1', '1\tx', 1500, { type: 'text', file: { filePath: 'C:\\code\\proj\\src\\a.ts', numLines: 19 } }), ctx).events[0];
    expect(en).toMatchObject({ id: 'tool:toolu_1:end', kind: 'tool', phase: 'end', toolUseId: 'toolu_1', durationMs: 500 });
    expect(en.tool).toMatchObject({ name: 'Read', resultSummary: '19 lines' });
  });

  it('failed tool_result is flagged', () => {
    const ctx = newParseCtx();
    parseLine(asst('a5', 'msgD', { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'false' } }, 0), ctx);
    const en = parseLine(result('u6', 'toolu_2', 'Exit code 1', 100, undefined, true), ctx).events[0];
    expect(en.tool?.failed).toBe(true);
    expect(en.icon).toEqual({ name: 'TriangleAlert', family: 'human' });
  });

  it('Agent tool_use also emits spawn; its result links the child agent', () => {
    const ctx = newParseCtx();
    const evs = parseLine(asst('a6', 'msgE', { type: 'tool_use', id: 'toolu_3', name: 'Agent', input: { description: 'Verify hooks', prompt: 'Check the docs', subagent_type: 'Explore' } }, 0), ctx).events;
    expect(evs.map((e) => e.kind)).toEqual(['tool', 'spawn']);
    expect(evs[1]).toMatchObject({ id: 'spawn:toolu_3', toolUseId: 'toolu_3', text: 'Verify hooks', agentId: 'main' });
    const r = parseLine(result('u7', 'toolu_3', 'Async agent launched', 50, { agentId: 'a111', description: 'Verify hooks', prompt: 'Check the docs', isAsync: true, status: 'async_launched' }), ctx);
    expect(r.meta?.link).toEqual({ toolUseId: 'toolu_3', childAgentId: 'a111', prompt: 'Check the docs', description: 'Verify hooks' });
  });

  it('async subagent hand-back → report on the child agent', () => {
    const ctx = newParseCtx();
    parseLine(asst('a7', 'msgF', { type: 'tool_use', id: 'toolu_4', name: 'Agent', input: { description: 'Scan', prompt: 'p' } }, 0), ctx);
    parseLine(result('u8', 'toolu_4', 'launched', 10, { agentId: 'a222', isAsync: true, status: 'async_launched' }), ctx);
    const r = parseLine({
      type: 'user', uuid: 'u9', timestamp: iso(5000), sessionId: SID, isMeta: true,
      origin: { kind: 'peer', from: 'a222', handback: true, body: '[Subagent hand-back] preamble. The report follows:\n  ## Findings\n  all good' },
      message: { role: 'user', content: 'Another Claude session sent a message: …' },
    }, ctx).events[0];
    expect(r).toMatchObject({ id: 'report:a222', kind: 'report', agentId: 'a222', toolUseId: 'toolu_4', text: '## Findings\nall good' });
  });

  it('mid-turn hand-back recorded as a queue-operation → report; task-notification → agentDone', () => {
    const ctx = newParseCtx();
    parseLine(asst('a8', 'msgG', { type: 'tool_use', id: 'toolu_5', name: 'Agent', input: { description: 'List files', prompt: 'p' } }, 0), ctx);
    parseLine(result('u10', 'toolu_5', 'launched', 10, { agentId: 'a333', isAsync: true, status: 'async_launched' }), ctx);
    const ho = parseLine({
      type: 'queue-operation', operation: 'enqueue', timestamp: iso(4000), sessionId: SID,
      content: '<agent-message from="a333">\n[Subagent hand-back] preamble. The report follows:\n  - app.ts: builds the app\n  - cli.ts: entry point\n</agent-message>',
    }, ctx);
    expect(ho.events[0]).toMatchObject({ id: 'report:a333', kind: 'report', agentId: 'a333', toolUseId: 'toolu_5', text: '- app.ts: builds the app\n- cli.ts: entry point' });
    const tn = parseLine({
      type: 'queue-operation', operation: 'enqueue', timestamp: iso(5000), sessionId: SID,
      content: '<task-notification>\n<task-id>a333</task-id>\n<tool-use-id>toolu_5</tool-use-id>\n<status>completed</status>\n<summary>Agent "List files" finished</summary>\n</task-notification>',
    }, ctx);
    expect(tn.events).toHaveLength(0);
    expect(tn.meta.agentDone).toEqual({ agentId: 'a333', ts: T0 + 5000 });
    expect(parseLine({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(6000), sessionId: SID }, ctx)).toEqual({ events: [], meta: {} });
  });

  it("a message you send while Claude works: queued until it's taken; taken mid-turn, a prompt where Claude got it", () => {
    const ctx = newParseCtx();
    const msg = 'also, add a home button';
    const q = parseLine({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(1000), sessionId: SID, content: msg }, ctx).events;
    expect(q).toEqual([expect.objectContaining({ kind: 'prompt', agentId: 'main', queue: 'waiting', text: msg, ts: T0 + 1000 })]);
    const got = parseLine({ type: 'queue-operation', operation: 'remove', timestamp: iso(9000), sessionId: SID, content: msg, reason: 'absorbed_mid_turn' }, ctx).events;
    expect(got).toEqual([
      expect.objectContaining({ id: q[0].id, queue: 'delivered' }),
      expect.objectContaining({ kind: 'prompt', midTurn: true, text: msg, ts: T0 + 9000 }),
    ]);
    expect(got[1].queue).toBeUndefined();
    // taken as a turn of its own (the turn's own prompt shows it): only the queue entry ends
    const own = parseLine({ type: 'queue-operation', operation: 'remove', timestamp: iso(9500), sessionId: SID, content: 'next thing' }, ctx).events;
    expect(own).toEqual([expect.objectContaining({ queue: 'delivered', text: 'next thing' })]);
    // the next turn takes the oldest (dequeue names none); taken back into the input (popAll): no longer waiting
    const a = parseLine({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(9700), sessionId: SID, content: 'first' }, ctx).events[0];
    parseLine({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(9710), sessionId: SID, content: 'second' }, ctx);
    expect(parseLine({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(9800), sessionId: SID }, ctx).events).toEqual([expect.objectContaining({ id: a.id, queue: 'delivered' })]);
    expect(parseLine({ type: 'queue-operation', operation: 'popAll', timestamp: iso(9900), sessionId: SID, content: 'second' }, ctx).events).toEqual([expect.objectContaining({ queue: 'delivered', text: 'second' })]);
    expect(parseLine({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(9950), sessionId: SID }, ctx).events).toEqual([]);
    // system messages that queue (a task notification, a hand-back) aren't yours
    expect(parseLine({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(9600), sessionId: SID, content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' }, ctx).events).toEqual([]);
  });

  it('system lines and titles', () => {
    const ctx = newParseCtx();
    expect(parseLine({ type: 'system', subtype: 'compact_boundary', uuid: 'y1', timestamp: iso(0), sessionId: SID }, ctx).events[0].kind).toBe('compact');
    expect(parseLine({ type: 'system', subtype: 'turn_duration', uuid: 'y2', timestamp: iso(0), sessionId: SID, durationMs: 4000 }, ctx).events[0]).toMatchObject({ kind: 'turn_end', durationMs: 4000 });
    expect(parseLine({ type: 'ai-title', aiTitle: 'Design review', sessionId: SID }, ctx).meta?.title).toBe('Design review');
  });

  it('known bookkeeping types produce nothing; unknown types are flagged', () => {
    const ctx = newParseCtx();
    expect(parseLine({ type: 'mode', mode: 'normal', sessionId: SID }, ctx)).toEqual({ events: [], meta: {} });
    expect(parseLine({ type: 'never-seen-before', sessionId: SID }, ctx).meta?.unknown).toBe(true);
  });
});

describe('background commands', () => {
  const notification = (status: string, summary: string) =>
    `<task-notification>\n<task-id>bpoll1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<output-file>C:/tmp/tasks/bpoll1.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

  it('a Bash call sent to the background is marked, and its task-notification ends it (once, at the queued time)', () => {
    const ctx = newParseCtx();
    parseLine(asst('a1', 'm1', { type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'glab ci status --live', description: 'Poll the pipeline', run_in_background: true } }, 0), ctx);
    const text = 'Command running in background with ID: bpoll1. Output is being written to: C:/tmp/tasks/bpoll1.output. You will be notified when it completes.';
    const end = parseLine(result('r1', 'toolu_bg', text, 300, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bpoll1' }), ctx).events[0];
    expect(end.tool).toMatchObject({ resultSummary: 'running in background', background: { taskId: 'bpoll1', outputFile: 'C:/tmp/tasks/bpoll1.output' } });
    const queued = parseLine({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(60_000), sessionId: SID, content: notification('completed', 'Background command "Poll the pipeline" completed (exit code 0)') }, ctx);
    expect(queued.meta.agentDone).toBeUndefined();
    expect(queued.events).toEqual([
      expect.objectContaining({ id: 'task:bpoll1', kind: 'task', toolUseId: 'toolu_bg', agentId: 'main', ts: T0 + 60_000, task: { id: 'bpoll1', status: 'completed', exit: 0, outputFile: 'C:/tmp/tasks/bpoll1.output' } }),
    ]);
    const delivered = parseLine({ type: 'user', uuid: 'u9', timestamp: iso(61_000), sessionId: SID, origin: { kind: 'task-notification' }, message: { role: 'user', content: notification('completed', 'Background command "Poll the pipeline" completed (exit code 0)') } }, ctx);
    expect(delivered.events.map((e) => e.id)).toEqual(['task:bpoll1']);
  });

  it('reads a failure and its exit code', () => {
    const ctx = newParseCtx();
    parseLine(asst('a1', 'm1', { type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'npm test', run_in_background: true } }, 0), ctx);
    const e = parseLine({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(9000), sessionId: SID, content: notification('failed', 'Background command "npm test" failed with exit code 1') }, ctx).events[0];
    expect(e.task).toMatchObject({ status: 'failed', exit: 1 });
  });
});
