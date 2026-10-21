import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { programCard, programDetails, programOf } from '../src/scene/programs';

describe('programOf', () => {
  it('finds the program a command runs: last in a chain, past cd, env and sudo', () => {
    expect(programOf('git status --short')).toBe('git');
    expect(programOf('cd /c/code/x && npm run build')).toBe('npm');
    expect(programOf('FOO=1 sudo docker build -t a .')).toBe('docker');
    expect(programOf('npx vitest run 2>&1 | grep Tests')).toBe('grep');
    expect(programOf('C:\\Python312\\python.exe tools/x.py')).toBe('python');
    expect(programOf('glab mr view 35')).toBe('glab');
    expect(programOf('kubectl --context acmelive get pods')).toBe('kubectl');
    expect(programOf('ls ~/.claude')).toBe('ls');
  });
});

let seq = 0;
const base = { sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'run' as const }, source: 'hook' as const };
const sh = (command: string, preview: string, failed = false, durationMs = 300): BrainEvent[] => {
  const id = `t${seq++}`;
  return [
    { ...base, seq: seq++, id: `${id}:s`, ts: seq, kind: 'tool', phase: 'start', toolUseId: id, tool: { name: 'Bash', input: { command }, summary: command } },
    { ...base, seq: seq++, id: `${id}:e`, ts: seq, kind: 'tool', phase: 'end', toolUseId: id, durationMs, tool: { name: 'Bash', input: { command }, summary: command, preview, ...(failed ? { failed: true } : {}) } },
  ];
};

describe('programDetails', () => {
  it('picks out branch, commits and pushes for git; tests and builds for npm; MRs and pipelines for glab', () => {
    const d = programDetails([
      ...sh('git status', "On branch fix/hooks\nYour branch is ahead of 'origin/fix/hooks' by 1 commit.\n\tmodified:   a.ts"),
      ...sh('git add -A && git commit -m "fix: carry agent_id"', '[fix/hooks 4c1d] fix: carry agent_id'),
      ...sh('npm test', ' Tests  2 failed | 224 passed (226)', true),
      ...sh('npm run build', 'built in 11.2s', false, 3600),
      ...sh('glab mr view 35', 'title: fix: carry agent_id\nstate: opened'),
      ...sh('glab ci status', 'stages: ok ok run pending'),
    ]);
    expect(d.get('git')).toMatchObject({ n: 2, branch: 'fix/hooks', ahead: 2, dirty: 1, commits: ['fix: carry agent_id'] });
    expect(d.get('npm')).toMatchObject({ n: 2, ok: 1, bad: 1, tests: { pass: 224, fail: 2 }, build: { ok: true, ms: 3600 } });
    expect(d.get('glab')).toMatchObject({ mr: 35, mrTitle: 'fix: carry agent_id', mrState: 'opened', stages: ['ok', 'ok', 'run', 'pending'] });
    const card = programCard('npm', d.get('npm'));
    expect(card).toContain('224 passed');
    expect(card).toContain('3.6s');
  });
});
