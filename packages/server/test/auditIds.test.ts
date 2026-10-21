import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeId } from '@cora/shared';
import { tailInfo } from '../src/transcript/tailer';
import { hookToEvents } from '../src/hooks/normalize';
import { PtyManager, type PtyLike } from '../src/pty';
import { jumpToTerminal } from '../src/terminal';
import { transcriptFor } from '../src/toolDetail';

// docs/audit-2026-10-20.md S5, S6, S9: an id never reaches a script, a command line or a file name unless it is one
describe('ids from outside (file names, hooks, the dashboard)', () => {
  it('only letters, digits, _ and -, not starting with -', () => {
    for (const ok of ['3f2a9c1e-77aa-4c55-9b1e-0f1e2d3c4b5a', 'sim-brain-1', 'a1b2c3', 'agent_7']) expect(isSafeId(ok)).toBe(true);
    for (const bad of ["x'; calc; '", '--dangerously-skip-permissions', '../../etc/passwd', 'a b', '', 'a&b', '-x', 'a'.repeat(101)]) expect(isSafeId(bad)).toBe(false);
  });

  it("a transcript whose file name isn't an id is not a session", () => {
    const root = 'C:\\p';
    expect(tailInfo(root, 'C:\\p\\slug\\3f2a9c1e-77aa.jsonl')?.sessionId).toBe('3f2a9c1e-77aa');
    expect(tailInfo(root, "C:\\p\\slug\\x'; calc; '.jsonl")).toBeNull();
    expect(tailInfo(root, 'C:\\p\\slug\\abc\\subagents\\agent-..%2f.jsonl')).toBeNull();
  });

  it("a hook whose session or agent id isn't one is dropped", () => {
    expect(hookToEvents('Stop', { session_id: "x'; calc; '" }).events).toEqual([]);
    expect(hookToEvents('Stop', { session_id: 'abc-1', agent_id: '../../x' }).events).toEqual([]);
    expect(hookToEvents('Stop', { session_id: 'abc-1' }).session?.id).toBe('abc-1');
  });

  it('resume and fork take only an id, never something that reads as a flag', () => {
    const fake: PtyLike = { pid: 1, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} } as unknown as PtyLike;
    const pm = new PtyManager({ spawn: () => fake, claudeCmd: ['claude'], screen: null });
    const cwd = mkdtempSync(join(tmpdir(), 'cora-ids-'));
    expect(() => pm.launch({ mode: 'resume', cwd, sessionId: '--dangerously-skip-permissions' })).toThrow(/not a session id/);
    expect(() => pm.launch({ mode: 'fork', cwd, sessionId: 'a & calc' })).toThrow(/not a session id/);
  });

  it("Jump never builds a script from an id that isn't one", async () => {
    const r = await jumpToTerminal({ id: "x'; calc; '", cwd: 'C:\\' } as any);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't one/) });
  });

  it("a tool's transcript is found only from real ids (no ../ in a file name)", () => {
    expect(transcriptFor('C:\\p\\s\\abc.jsonl', 'abc', 'main')).toBe('C:\\p\\s\\abc.jsonl');
    expect(() => transcriptFor('C:\\p\\s\\abc.jsonl', 'abc', '..\\..\\secrets')).toThrow();
  });
});

describe("installed Cora's Node mode stays its own (audit S13)", () => {
  it('sessions and shells never inherit ELECTRON_RUN_AS_NODE', async () => {
    const { cleanEnv, shellEnv } = await import('../src/pty');
    expect(cleanEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x' })).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(shellEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x' })).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });
});

describe("the diff view reads only Claude Code's own snapshots (audit S9)", () => {
  it('a backup file name that is a path is ignored; a plain name is kept', async () => {
    const { writeFileSync } = await import('node:fs');
    const { snapshots } = await import('../src/changes');
    const d = mkdtempSync(join(tmpdir(), 'cora-snap-'));
    const t = join(d, 't.jsonl');
    const snap = (id: string, file: string, name: string) => JSON.stringify({ type: 'file-history-snapshot', messageId: id, snapshot: { timestamp: new Date().toISOString(), trackedFileBackups: { [file]: { backupFileName: name } } } });
    writeFileSync(t, [snap('m1', 'C:\\r\\a.ts', '..\\..\\..\\.ssh\\id_rsa'), snap('m2', 'C:\\r\\b.ts', '../../x'), snap('m3', 'C:\\r\\c.ts', 'c.ts@v1'), ''].join('\n'));
    const names = snapshots.read(t).flatMap((s) => [...s.files.values()].map((f) => f.name));
    expect(names).toEqual([null, null, 'c.ts@v1']);
  });
});
