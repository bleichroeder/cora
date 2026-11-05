import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, pastNudge, rereads, type BrainEvent } from '@cora/shared';
import { drill } from '@cora/shared/test/fixtures';
import { ContextNudges } from '../src/contextNudge';
import { applyPatch } from '../src/prefs';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

const NOW = 10_000_000;
const turn = (sid: string, inTok: number, o: Partial<BrainEvent> = {}) => ({ id: `${sid}-${inTok}-${o.agentId ?? 'main'}`, seq: 1, sessionId: sid, agentId: 'main', ts: NOW, kind: 'say', icon: { name: 'MessageSquare', family: 'mind' as const }, tokens: { in: inTok, out: 2_000 }, source: 'transcript', ...o }) as BrainEvent;

describe('the context nudge', () => {
  it('past the threshold (300k by default; a setting, 0 never): each turn rereads it all', () => {
    expect(DEFAULT_SETTINGS.context?.nudgeAt).toBe(300_000);
    expect(pastNudge(299_999, 300_000)).toBe(false);
    expect(pastNudge(300_000, 300_000)).toBe(true);
    expect(pastNudge(900_000, 0)).toBe(false);
    expect(rereads(461_400)).toBe('each turn rereads ~461k');
    expect(applyPatch(DEFAULT_SETTINGS, { context: { nudgeAt: 500_000 } }).context).toEqual({ nudgeAt: 500_000 });
    expect(applyPatch(DEFAULT_SETTINGS, { context: { nudgeAt: 0 } }).context).toEqual({ nudgeAt: 0 });
    expect(() => applyPatch(DEFAULT_SETTINGS, { context: { nudgeAt: 123 } })).toThrow(/context.nudgeAt/);
  });

  it("nudges a session once, the first time its main agent's context is past it; never a subagent's, nor a turn from long ago", () => {
    const told: Array<[string, number, number]> = [];
    const nudged = new Set<string>();
    let over = 300_000;
    const n = new ContextNudges({ threshold: () => over, nudged: (sid) => nudged.has(sid), nudge: (sid, t, o) => (told.push([sid, t, o]), nudged.add(sid)), now: () => NOW });
    n.event(turn('a', 250_000));
    expect(told).toEqual([]);
    n.event(turn('a', 310_000));
    expect(told).toEqual([['a', 312_000, 300_000]]);
    // once: later turns, bigger still, say nothing
    n.event(turn('a', 400_000));
    expect(told).toHaveLength(1);
    // a subagent's own context isn't the session's; a turn read back from an old transcript isn't news
    n.event(turn('b', 500_000, { agentId: 'sub-1' }));
    n.event(turn('b', 500_000, { ts: NOW - 11 * 60_000 }));
    expect(told).toHaveLength(1);
    // the nudge off: nothing
    over = 0;
    n.event(turn('c', 900_000));
    expect(told).toHaveLength(1);
  });
});

describe('the context nudge in Cora', () => {
  let dir: string;
  let srv: Running | undefined;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-nudge-'))));
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks the session (when, how big, past what), and a team seat's lead hears it on the board, once", async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const now = Date.now();
    for (const sid of ['sess-lead', 'sess-seat', 'sess-solo']) srv.store.upsertSession({ id: sid, cwd: dir, state: 'idle', startedAt: now, lastTs: now } as never);
    const p = srv.projects.create('Drill');
    for (const sid of ['sess-lead', 'sess-seat']) srv.projects.add(p.id, sid);
    srv.projects.setTeam(p.id, drill(), 'you');
    srv.projects.setSeat(p.id, 'sess-seat', 'analyst-ing', 1);
    srv.projects.update(p.id, { lead: 'sess-lead' });
    const ev = (sid: string, inTok: number, k: number) => ({ id: `${sid}-${k}`, sessionId: sid, agentId: 'main', ts: Date.now(), kind: 'say' as const, icon: { name: 'MessageSquare', family: 'mind' as const }, tokens: { in: inTok, out: 1_000 }, source: 'transcript' as const });
    srv.pipeline.ingestEvents([ev('sess-seat', 200_000, 1), ev('sess-solo', 350_000, 1)]);
    expect(srv.store.getSession('sess-seat')!.contextNudge).toBeUndefined();
    expect(srv.store.getSession('sess-solo')!.contextNudge).toMatchObject({ tokens: 351_000, over: 300_000 });
    srv.pipeline.ingestEvents([ev('sess-seat', 320_000, 2), ev('sess-seat', 420_000, 3)]);
    expect(srv.store.getSession('sess-seat')!.contextNudge).toMatchObject({ tokens: 321_000, over: 300_000 });
    const notes = srv.projects.get(p.id)!.thread.filter((x) => x.by === 'cora' && /context/.test(x.text));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'note', to: ['sess-lead'] });
    expect(notes[0].text).toMatch(/\(analyst-ing\) has ~321k of context: each turn rereads ~321k\. A handover .* or \/compact .*Yours to suggest; Cora won't do it\./);
  });
});
