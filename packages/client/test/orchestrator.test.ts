import { describe, expect, it } from 'vitest';
import type { OrchestratorStatus, SessionInfo } from '@cora/shared';
import { coraState } from '../src/state/orchestrator';
import { setHiddenSession, useBrain } from '../src/state/store';

const st = (o: Partial<OrchestratorStatus> = {}): OrchestratorStatus => ({ enabled: true, speak: true, model: 'opus', sessionId: 'agent', terminalId: 't', running: true, approvals: [], control: false, goal: null, ...o });
const sess = (id: string, state: SessionInfo['state'] = 'idle') => ({ id, cwd: 'C:\\x', project: 'x', title: '', state, startedAt: 1, lastTs: 1, cliVersion: '', transcriptPath: '', needsYou: 0 }) as SessionInfo;
const none = { listening: false, pending: 0 };

describe("Cora's eye", () => {
  it('shows what Cora is doing', () => {
    expect(coraState(null, null, none)).toBe('off');
    expect(coraState(st({ enabled: false }), null, none)).toBe('off');
    expect(coraState(st({ error: 'kept stopping' }), null, none)).toBe('error');
    expect(coraState(st({ running: false }), null, none)).toBe('starting');
    expect(coraState(st(), sess('agent'), none)).toBe('idle');
    expect(coraState(st(), sess('agent', 'working'), none)).toBe('thinking');
    expect(coraState(st(), sess('agent', 'working'), { listening: true, pending: 0 })).toBe('listening');
    expect(coraState(st({ approvals: [{ id: 'a', kind: 'send', title: 't', detail: '', createdAt: 1, waiting: true }] }), sess('agent'), { listening: true, pending: 0 })).toBe('needs-you');
    expect(coraState(st(), sess('agent'), { listening: false, pending: 1 })).toBe('needs-you');
    expect(coraState(st({ asking: ['Do you trust the files in this folder?'] }), sess('agent'), none)).toBe('needs-you');
    const g = (state: 'running' | 'waiting' | 'blocked' | 'done') => ({ id: 'g', text: 'x', state, createdAt: 1, updatedAt: 1, budget: 1, spent: 0, workers: [] });
    expect(coraState(st({ goal: g('running') }), sess('agent', 'working'), none)).toBe('autopilot');
    expect(coraState(st({ goal: g('running') }), sess('agent'), { listening: true, pending: 0 })).toBe('listening');
    expect(coraState(st({ goal: g('blocked') }), sess('agent'), none)).toBe('needs-you');
    expect(coraState(st({ goal: g('done') }), sess('agent'), none)).toBe('idle');
  });
});

describe("the agent's session", () => {
  it('is never in the session list, and goes back to being a session when it stops being the agent', () => {
    useBrain.setState({ sessions: {}, agentSession: null });
    useBrain.getState().upsertSession(sess('work'));
    useBrain.getState().upsertSession(sess('agent'));
    setHiddenSession('agent');
    expect(Object.keys(useBrain.getState().sessions)).toEqual(['work']);
    expect(useBrain.getState().agentSession?.id).toBe('agent');
    useBrain.getState().upsertSession(sess('agent', 'working'));
    expect(Object.keys(useBrain.getState().sessions)).toEqual(['work']);
    expect(useBrain.getState().agentSession?.state).toBe('working');
    setHiddenSession(null);
    expect(Object.keys(useBrain.getState().sessions).sort()).toEqual(['agent', 'work']);
    expect(useBrain.getState().agentSession).toBeNull();
  });
});
