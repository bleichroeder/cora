import { describe, expect, it } from 'vitest';
import { computeHooksBlock, diffText, hooksAimed, isOurs, legacyHooks, mergeHooks, removeHooks } from '../src/settings';

const block = computeHooksBlock({ port: 4317, token: 'tok' });

describe('settings hooks block', () => {
  it('covers observation (async) and blocking events', () => {
    expect(Object.keys(block).sort()).toEqual([
      'Elicitation', 'Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse',
      'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
    ]);
    const pre = block.PreToolUse[0].hooks[0];
    expect(pre).toEqual({ type: 'http', url: 'http://127.0.0.1:4317/hook/PreToolUse', headers: { 'x-cora-token': 'tok' }, async: true });
    const perm = block.PermissionRequest[0].hooks[0];
    expect(perm.async).toBeUndefined();
    expect(perm.timeout).toBe(3600);
  });

  it('env-token mode uses interpolation + allowedEnvVars', () => {
    const b = computeHooksBlock({ port: 4317, token: 'tok', envToken: true });
    expect(b.Stop[0].hooks[0]).toMatchObject({ headers: { 'x-cora-token': '$CORA_TOKEN' }, allowedEnvVars: ['CORA_TOKEN'] });
  });

  it('hooks written before the rename are still ours, are found, and merging replaces them', () => {
    const old = { type: 'http', url: 'http://127.0.0.1:4317/hook/Stop', headers: { 'x-agent-brain-token': 'tok' }, async: true };
    const user = { type: 'command', command: 'echo hi' };
    const settings = { hooks: { Stop: [{ matcher: '*', hooks: [old] }, { matcher: '*', hooks: [user] }] } };
    expect(isOurs(old)).toBe(true);
    expect(legacyHooks(settings)).toEqual({ found: true, envToken: false });
    expect(legacyHooks(settings, { port: 4317, token: 'tok' }).found).toBe(true);
    expect(legacyHooks(settings, { port: 4321, token: 'tok' }).found).toBe(false);
    expect(legacyHooks(settings, { port: 4317, token: 'other' }).found).toBe(false);
    const next = mergeHooks(settings, block);
    expect(next.hooks.Stop.flatMap((m: any) => m.hooks)).toEqual([user, block.Stop[0].hooks[0]]);
    expect(legacyHooks(next).found).toBe(false);
    const envOld = { ...old, headers: { 'x-agent-brain-token': '$AGENT_BRAIN_TOKEN' } };
    expect(legacyHooks({ hooks: { Stop: [{ matcher: '*', hooks: [envOld] }] } })).toEqual({ found: true, envToken: true });
  });

  it('merge preserves user hooks and other settings, and is idempotent', () => {
    const user = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    const once = mergeHooks(user, block);
    const twice = mergeHooks(once, block);
    expect(twice).toEqual(once);
    expect(once.model).toBe('opus');
    expect(once.hooks.PreToolUse).toHaveLength(2);
    expect(once.hooks.PreToolUse[0]).toEqual(user.hooks.PreToolUse[0]);
    expect(isOurs(once.hooks.PreToolUse[1].hooks[0])).toBe(true);
  });

  it('merge replaces our hooks when the port changes', () => {
    const a = mergeHooks({}, block);
    const b = mergeHooks(a, computeHooksBlock({ port: 5000, token: 'tok' }));
    expect(b.hooks.Stop).toHaveLength(1);
    expect(b.hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:5000/hook/Stop');
  });

  it('remove deletes only ours and cleans up empties', () => {
    const user = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    const removed = removeHooks(mergeHooks(user, block));
    expect(removed).toEqual(user);
    expect(removeHooks(mergeHooks({ theme: 'dark' }, block))).toEqual({ theme: 'dark' });
  });

  it('diffText shows added and removed lines', () => {
    const d = diffText('{\n  "a": 1\n}', '{\n  "a": 2\n}');
    expect(d).toContain('-   "a": 1');
    expect(d).toContain('+   "a": 2');
  });
});

// docs/audit-2026-10-20.md B4: installed means aimed here, not just present
describe("whether Cora's hooks reach this Cora", () => {
  const here = { port: 4317, token: 'tok' };
  it('here, none, or elsewhere (another port, or an old key); an env-token reference counts as here', () => {
    expect(hooksAimed({}, here)).toEqual({ state: 'none' });
    expect(hooksAimed(mergeHooks({}, computeHooksBlock(here)), here)).toEqual({ state: 'here' });
    expect(hooksAimed(mergeHooks({}, computeHooksBlock({ port: 4333, token: 'tok' })), here)).toEqual({ state: 'elsewhere', port: 4333 });
    expect(hooksAimed(mergeHooks({}, computeHooksBlock({ port: 4317, token: 'old' })), here)).toEqual({ state: 'elsewhere' });
    expect(hooksAimed(mergeHooks({}, computeHooksBlock({ ...here, envToken: true })), here)).toEqual({ state: 'here' });
  });
});
