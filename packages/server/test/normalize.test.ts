import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookToEvents } from '../src/hooks/normalize';

// Real payloads captured from `claude -p --settings <http hooks>` (see scripts/capture-hooks.mjs).
const dir = join(__dirname, 'fixtures', 'hooks');
const all = readdirSync(dir).sort().map((f) => ({ f, body: JSON.parse(readFileSync(join(dir, f), 'utf8')).body }));
const find = (event: string, pred: (b: any) => boolean = () => true) => all.find((x) => x.body.hook_event_name === event && pred(x.body))!.body;

const prompt = find('UserPromptSubmit', (b) => !b.prompt.startsWith('<'));
const SID = prompt.session_id;
const subStart = find('SubagentStart');
const CHILD = subStart.agent_id;

describe('hookToEvents (real captured payloads)', () => {
  it('UserPromptSubmit → prompt keyed by prompt_id, with session info', () => {
    const r = hookToEvents('UserPromptSubmit', prompt, 1000);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ id: `prompt:${prompt.prompt_id}`, kind: 'prompt', sessionId: SID, agentId: 'main', source: 'hook', ts: 1000 });
    expect(r.session).toMatchObject({ id: SID, cwd: 'C:\\work\\capdemo' });
    expect(r.session?.transcriptPath).toMatch(/\.jsonl$/);
  });

  it('task-notification prompts are not user prompts', () => {
    expect(hookToEvents('UserPromptSubmit', find('UserPromptSubmit', (b) => b.prompt.startsWith('<task-notification>'))).events).toHaveLength(0);
  });

  it('PreToolUse → tool start with summary and icon', () => {
    const p = find('PreToolUse', (b) => b.tool_name === 'Bash' && b.tool_input.command.startsWith('wc'));
    const [e] = hookToEvents('PreToolUse', p).events;
    expect(e).toMatchObject({ id: `tool:${p.tool_use_id}:start`, kind: 'tool', phase: 'start', toolUseId: p.tool_use_id, agentId: 'main' });
    expect(e.tool).toMatchObject({ name: 'Bash', summary: 'wc -l README.md', resource: 'shell' });
    expect(e.icon.family).toBe('run');
  });

  it('PostToolUse → tool end with duration and result summary', () => {
    const p = find('PostToolUse', (b) => b.tool_name === 'Read' && !b.agent_id);
    const [e] = hookToEvents('PostToolUse', p).events;
    expect(e).toMatchObject({ id: `tool:${p.tool_use_id}:end`, kind: 'tool', phase: 'end', durationMs: Number(p.duration_ms) });
    expect(e.tool).toMatchObject({ name: 'Read', summary: 'package.json', resultSummary: expect.stringMatching(/line/) });
  });

  it('Agent PostToolUse links the child agent', () => {
    const p = find('PostToolUse', (b) => b.tool_name === 'Agent');
    expect(hookToEvents('PostToolUse', p).link).toEqual({ toolUseId: p.tool_use_id, childAgentId: CHILD, prompt: expect.stringContaining('README'), description: 'Read readme' });
  });

  it('tool calls inside a subagent carry its agent id', () => {
    const [e] = hookToEvents('PreToolUse', find('PreToolUse', (b) => b.agent_id)).events;
    expect(e.agentId).toBe(CHILD);
  });

  it('SubagentStart / SubagentStop → agent lifecycle + report', () => {
    expect(hookToEvents('SubagentStart', subStart).agentStart).toEqual({ agentId: CHILD, agentType: 'general-purpose' });
    const stop = hookToEvents('SubagentStop', find('SubagentStop'));
    expect(stop.agentStop).toEqual({ agentId: CHILD });
    expect(stop.events[0]).toMatchObject({ id: `report:${CHILD}`, kind: 'report', agentId: CHILD, text: expect.stringContaining('Hello agent-brain') });
  });

  it('Stop → turn ended (state only); SessionEnd → session_end', () => {
    const stop = hookToEvents('Stop', find('Stop'));
    expect(stop.events).toHaveLength(0);
    expect(stop.turnEnded).toBe(true);
    expect(hookToEvents('SessionEnd', find('SessionEnd')).events[0]).toMatchObject({ id: `session_end:${SID}`, kind: 'session_end' });
  });

  it('PostToolUseFailure → failed tool end', () => {
    const p = find('PostToolUseFailure');
    const [e] = hookToEvents('PostToolUseFailure', p).events;
    expect(e).toMatchObject({ id: `tool:${p.tool_use_id}:end`, phase: 'end', icon: { name: 'TriangleAlert' } });
    expect(e.tool).toMatchObject({ failed: true, resultSummary: 'Exit code 1' });
  });

  it('Notification passes type and message through', () => {
    expect(hookToEvents('Notification', { session_id: 's', notification_type: 'permission_prompt', message: 'Claude needs permission' }).notification)
      .toEqual({ type: 'permission_prompt', message: 'Claude needs permission' });
  });

  it('unknown events are ignored', () => {
    expect(hookToEvents('SomethingElse', { session_id: 's' })).toEqual({ events: [] });
  });
});
