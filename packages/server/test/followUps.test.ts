import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { FollowUps, parseWhen } from '../src/orchestrator/followUps';

const T0 = new Date(2026, 9, 30, 15, 0).getTime();
const ev = (kind: BrainEvent['kind'], ts: number, text?: string, o: Partial<BrainEvent> = {}): BrainEvent => ({ id: `${kind}${ts}`, seq: ts, sessionId: 'imp', agentId: 'main', ts, kind, text, icon: { name: 'x', family: 'run' }, source: 'transcript', ...o }) as BrainEvent;

function world() {
  let now = T0;
  let events: BrainEvent[] = [];
  const told: string[] = [];
  const file = join(mkdtempSync(join(tmpdir(), 'cora-follow-')), 'follow-ups.json');
  const mk = () => new FollowUps({ file, events: (_sid, since) => events.filter((e) => e.ts >= since), nameOf: () => 'Import Timeout', tell: (l) => told.push(l), now: () => now });
  return { mk, told, tick: (ms: number) => (now += ms), at: () => now, setEvents: (e: BrainEvent[]) => (events = e) };
}

describe("Cora's follow-ups", () => {
  it("when a session's turn ends: one line with what it said and did since, then gone", () => {
    const w = world();
    const f = w.mk();
    f.add({ about: 'what the import investigation finds', sessionId: 'imp', on: 'turn', left: 1, until: T0 + 12 * 3_600_000 });
    w.tick(60_000);
    w.setEvents([ev('tool', T0 + 10_000, undefined, { phase: 'start', tool: { name: 'Bash', input: {}, summary: '' } } as Partial<BrainEvent>), ev('say', T0 + 20_000, 'Both migrations hit the 6-hour [job] cap.')]);
    f.tick();
    expect(w.told).toEqual([]);
    w.setEvents([...[ev('say', T0 + 20_000, 'Both migrations hit the 6-hour [job] cap.')], ev('turn_end', T0 + 30_000)]);
    f.tick();
    expect(w.told).toEqual(['[Follow-up] what the import investigation finds: "Import Timeout" (imp) finished its turn:\nBoth migrations hit the 6-hour (job) cap.']);
    expect(f.list()).toEqual([]);
  });

  it('a few turns, if asked; at a time; every so often (a few times at most); run out, said so', () => {
    const w = world();
    const f = w.mk();
    f.add({ about: 'each check', sessionId: 'imp', on: 'turn', left: 2, until: T0 + 3_600_000 });
    w.tick(1000);
    w.setEvents([ev('say', w.at(), 'check 1 OK'), ev('turn_end', w.at() + 1)]);
    w.tick(2000);
    f.tick();
    expect(f.list()[0].left).toBe(1);
    w.setEvents([ev('say', w.at() + 10, 'check 2 OK'), ev('turn_end', w.at() + 20)]);
    w.tick(1000);
    f.tick();
    expect(w.told.map((l) => l.split(':\n')[1])).toEqual(['check 1 OK', 'check 2 OK']);
    expect(f.list()).toEqual([]);
    // every 15 minutes, twice
    w.told.length = 0;
    f.add({ about: 'the queue', on: 'time', next: w.at() + 15 * 60_000, everyMs: 15 * 60_000, left: 2, until: w.at() + 3_600_000 });
    w.tick(14 * 60_000);
    f.tick();
    expect(w.told).toEqual([]);
    w.tick(60_000);
    f.tick();
    w.tick(15 * 60_000);
    f.tick();
    expect(w.told).toEqual(['[Follow-up] the queue (at the time you set)', '[Follow-up] the queue (at the time you set)']);
    expect(f.list()).toEqual([]);
    // never came: it says so once and goes
    w.told.length = 0;
    f.add({ about: 'its answer', sessionId: 'imp', on: 'turn', left: 1, until: w.at() + 60_000 });
    w.setEvents([]);
    w.tick(2 * 60_000);
    f.tick();
    expect(w.told).toEqual(['[Follow-up] ran out: its answer ("Import Timeout" (imp)): nothing came in time.']);
    expect(f.list()).toEqual([]);
  });

  it('are kept across a restart, cancelled by id, and ten at most', () => {
    const w = world();
    const f = w.mk();
    const a = f.add({ about: 'a', sessionId: 'imp', on: 'turn', left: 1, until: T0 + 3_600_000 });
    expect('id' in a).toBe(true);
    expect(w.mk().list().map((x) => x.about)).toEqual(['a']);
    expect(w.mk().cancel((a as { id: string }).id)).toBe(true);
    expect(w.mk().list()).toEqual([]);
    const g = w.mk();
    for (let i = 0; i < 10; i++) g.add({ about: `${i}`, on: 'time', next: T0 + 1, left: 1, until: T0 + 10 });
    expect(g.add({ about: 'eleventh', on: 'time', next: T0 + 1, left: 1, until: T0 + 10 })).toEqual({ error: expect.stringMatching(/10 follow-ups/) });
  });

  it('reads times the way you say them', () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime();
    expect(parseWhen('in 45m', now)).toBe(now + 45 * 60_000);
    expect(parseWhen('2h', now)).toBe(now + 2 * 3_600_000);
    expect(parseWhen('16:30', now)).toBe(new Date(2026, 9, 30, 16, 30).getTime());
    expect(parseWhen('2:30 PM', now)).toBe(new Date(2026, 9, 31, 14, 30).getTime());
    expect(parseWhen('9am', now)).toBe(new Date(2026, 9, 31, 9, 0).getTime());
    expect(parseWhen('soon', now)).toBeNull();
  });
});
