import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Audit } from '../src/audit';
import { PendingManager } from '../src/pending';

const perm = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'docker push x' }, tool_use_id: 'toolu_9', hook_event_name: 'PermissionRequest' };

function setup(opts: { clients?: number; holdMs?: number; askAnswering?: boolean } = {}) {
  const auditFile = join(mkdtempSync(join(tmpdir(), 'ab-audit-')), 'audit.log');
  const changes: any[] = [];
  const pm = new PendingManager({
    holdMs: opts.holdMs ?? 1000,
    hasClients: () => (opts.clients ?? 1) > 0,
    onChange: (list) => changes.push(list),
    audit: new Audit(auditFile),
    askAnswering: opts.askAnswering ?? false,
  });
  return { pm, changes, auditFile };
}

describe('PendingManager', () => {
  it('answers immediately with no decision when no dashboard is connected', async () => {
    const { pm, changes } = setup({ clients: 0 });
    await expect(pm.request('permission', perm)).resolves.toEqual({});
    expect(changes).toHaveLength(0);
  });

  it('holds a permission request until allowed', async () => {
    const { pm, changes, auditFile } = setup();
    const p = pm.request('permission', perm);
    const [req] = pm.list();
    expect(req).toMatchObject({ kind: 'permission', sessionId: 's1', agentId: 'main', toolName: 'Bash', toolUseId: 'toolu_9' });
    expect(changes.at(-1)).toHaveLength(1);
    expect(pm.resolve(req.id, { decision: 'allow' })).toEqual({ ok: true });
    await expect(p).resolves.toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(pm.list()).toHaveLength(0);
    const log = JSON.parse(readFileSync(auditFile, 'utf8').trim());
    expect(log).toMatchObject({ decision: 'allow', edited: false, via: 'dashboard', tool: 'Bash' });
    expect(log.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.input).toBeUndefined();
  });

  it('allow + edit returns updatedInput; deny returns message', async () => {
    const { pm } = setup();
    const p1 = pm.request('permission', perm);
    pm.resolve(pm.list()[0].id, { decision: 'allow', updatedInput: { command: 'docker push y' } });
    await expect(p1).resolves.toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'docker push y' } } } });
    const p2 = pm.request('permission', perm);
    pm.resolve(pm.list()[0].id, { decision: 'deny', message: 'not now' });
    await expect(p2).resolves.toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not now' } } });
  });

  it('times out to no decision', async () => {
    vi.useFakeTimers();
    const { pm } = setup({ holdMs: 500 });
    const p = pm.request('permission', perm);
    vi.advanceTimersByTime(600);
    await expect(p).resolves.toEqual({});
    expect(pm.list()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('releases when the terminal answered (tool ran)', async () => {
    const { pm } = setup();
    const p = pm.request('permission', perm);
    pm.cancelForToolUse('toolu_9');
    await expect(p).resolves.toEqual({});
    expect(pm.list()).toHaveLength(0);
  });

  it('releases by tool when the hook carried no tool-use id: a question by name, a permission only with the same input', async () => {
    const { pm } = setup();
    const ask = { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?' }] } };
    const q = pm.request('permission', ask);
    // answered in the terminal: the finished call's input now carries the answers
    pm.cancelForTool('s1', 'main', 'AskUserQuestion', { questions: [{ question: 'Which?' }], answers: { 'Which?': 'A' } });
    await expect(q).resolves.toEqual({});
    const noId = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'docker push x' } };
    const p = pm.request('permission', noId);
    pm.cancelForTool('s1', 'main', 'Bash', { command: 'npm test' }); // another Bash finishing in parallel
    pm.cancelForTool('s2', 'main', 'Bash', { command: 'docker push x' }); // another session
    expect(pm.list()).toHaveLength(1);
    pm.cancelForTool('s1', 'main', 'Bash', { command: 'docker push x' });
    await expect(p).resolves.toEqual({});
  });

  it('closing a card from the dashboard releases it with no decision (the terminal decides)', async () => {
    const { pm, auditFile } = setup();
    const p = pm.request('permission', perm);
    expect(pm.release(pm.list()[0].id)).toEqual({ ok: true });
    await expect(p).resolves.toEqual({});
    expect(pm.release('nope').ok).toBe(false);
    expect(JSON.parse(readFileSync(auditFile, 'utf8').trim())).toMatchObject({ decision: 'released', via: 'terminal' });
  });

  it('AskUserQuestion becomes a question; answering only when enabled', async () => {
    const ask = { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }, tool_use_id: 'toolu_q' };
    const off = setup();
    void off.pm.request('permission', ask);
    expect(off.pm.list()[0]).toMatchObject({ kind: 'question', canAnswer: false });
    expect(off.pm.resolve(off.pm.list()[0].id, { decision: 'allow', answers: { 'Which?': 'A' } }).ok).toBe(false);

    const on = setup({ askAnswering: true });
    const p = on.pm.request('permission', ask);
    expect(on.pm.list()[0].canAnswer).toBe(true);
    on.pm.resolve(on.pm.list()[0].id, { decision: 'allow', answers: { 'Which?': 'A' } });
    await expect(p).resolves.toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ask.tool_input, answers: { 'Which?': 'A' } } } } });
  });

  it('elicitation accept returns action + content', async () => {
    const { pm } = setup();
    const p = pm.request('elicitation', { session_id: 's1', mcp_server_name: 'github', message: 'Pick repo', requested_schema: { type: 'object' } });
    const [req] = pm.list();
    expect(req).toMatchObject({ kind: 'elicitation', elicitation: { server: 'github', message: 'Pick repo' } });
    pm.resolve(req.id, { decision: 'accept', content: { repo: 'x' } });
    await expect(p).resolves.toEqual({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { repo: 'x' } } });
  });

  it('rejects mismatched decisions and unknown ids', () => {
    const { pm } = setup();
    void pm.request('permission', perm);
    expect(pm.resolve(pm.list()[0].id, { decision: 'accept' }).ok).toBe(false);
    expect(pm.resolve('nope', { decision: 'allow' }).ok).toBe(false);
  });
});
