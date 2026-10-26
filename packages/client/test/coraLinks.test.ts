import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { coraLinks, HOLD_MS, IN_MS } from '../src/lib/coraLinks';

const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids = [A, B];
const ev = (o: Partial<BrainEvent> & { ts: number; kind: BrainEvent['kind'] }): BrainEvent => ({ id: `e${o.ts}${o.toolUseId ?? ''}`, seq: o.ts, sessionId: 'cora', agentId: 'main', ...o }) as BrainEvent;
const tool = (ts: number, phase: 'start' | 'end', use: string, name: string, id?: string, failed?: boolean) =>
  ev({ ts, kind: 'tool', phase, toolUseId: use, tool: { name: `mcp__cora__${name}`, input: id ? { id } : {}, summary: '', ...(failed ? { failed } : {}) } as never });

describe("Cora's links to sessions", () => {
  it('reaches a session while its tool runs and a moment after (the id or its start)', () => {
    const start = tool(1000, 'start', 't1', 'send_to_session', A.slice(0, 8));
    expect(coraLinks([start], ids, 2000)).toEqual({ [A]: 'out' });
    const end = tool(3000, 'end', 't1', 'send_to_session');
    expect(coraLinks([start, end], ids, 3000 + HOLD_MS - 1)).toEqual({ [A]: 'out' });
    expect(coraLinks([start, end], ids, 3000 + HOLD_MS + 1)).toEqual({});
    // a tool that isn't about a session, or a session it doesn't know: nothing
    expect(coraLinks([tool(1000, 'start', 't2', 'sessions'), tool(1000, 'start', 't3', 'send_to_session', 'zzzz9999')], ids, 2000)).toEqual({});
    // its end never came: it stops after a while
    expect(coraLinks([start], ids, 1000 + 61_000)).toEqual({});
  });

  it('looking into a session for you (its story, its recaps) reaches it; Cora brings back what it found (no trip back)', () => {
    const read = [tool(1000, 'start', 'l1', 'session', A.slice(0, 8)), tool(1200, 'end', 'l1', 'session')];
    expect(coraLinks(read.slice(0, 1), ids, 1100)).toEqual({ [A]: 'out' });
    expect(coraLinks(read, ids, 1200 + HOLD_MS + 10)).toEqual({});
    const ex = ev({ ts: 2000, kind: 'tool', phase: 'start', toolUseId: 'x1', tool: { name: 'mcp__cora__explains', input: { sessionId: B }, summary: '' } as never });
    expect(coraLinks([ex], ids, 2100)).toEqual({ [B]: 'out' });
    // the list of all sessions isn't about one
    expect(coraLinks([tool(1000, 'start', 'l2', 'sessions')], ids, 1100)).toEqual({});
  });

  it('a session reaching Cora by itself (its news) reaches Cora; its reply to what Cora asked does not', () => {
    const ask = [tool(1000, 'start', 'a1', 'ask_session', B), tool(5000, 'end', 'a1', 'ask_session')];
    expect(coraLinks(ask, ids, 5100)).toEqual({ [B]: 'out' });
    expect(coraLinks(ask, ids, 5000 + HOLD_MS + 10)).toEqual({});
    const news = ev({ ts: 9000, kind: 'prompt', text: `[Cora 14:05]\n- "canvas" (${A}) finished its turn: done` });
    expect(coraLinks([news], ids, 9500)).toEqual({ [A]: 'in' });
    expect(coraLinks([news], ids, 9000 + IN_MS + 1)).toEqual({});
    const reply = ev({ ts: 9000, kind: 'prompt', text: `[Cora 14:05]\n- "canvas" (${A}) replied to what you asked: all green` });
    expect(coraLinks([reply], ids, 9500)).toEqual({});
    // your own words to Cora name the session you're looking at the same way: that's not it reaching Cora
    const yours = ev({ ts: 9000, kind: 'prompt', text: `[Spoken; looking at: canvas (${A})]\nwhat is it doing?` });
    expect(coraLinks([yours], ids, 9500)).toEqual({});
  });
});

describe('a messenger between the cards', () => {
  it('goes when the open session’s link starts or turns round; one on its way first comes home', async () => {
    const { nextTrip, tripAt, tripEnd, TRIP_MS } = await import('../src/lib/coraLinks');
    // the session reaching Cora: one trip, its length
    const news = nextTrip({ armed: null }, 'A', 'in', [], 1000);
    expect(news).toEqual({ from: 'session', sid: 'A', at: 1000 });
    expect(tripEnd(news!)).toBe(1000 + TRIP_MS);
    // the same link still going: none
    expect(nextTrip({ armed: 'A', dir: 'in' }, 'A', 'in', [news!], 2000)).toBeNull();
    // Cora reaching it meanwhile: it goes once that one is home
    const cora = nextTrip({ armed: 'A', dir: 'in' }, 'A', 'out', [news!], 3000);
    expect(cora).toMatchObject({ from: 'cora', at: 1000 + TRIP_MS, hold: true });
    expect(tripAt([news!, cora!], 3000)).toBe(news);
    // no session open beside Cora's card: none
    expect(nextTrip({ armed: null }, null, undefined, [], 1000)).toBeNull();
  });

  it("Cora's stays circling the session while its call is going, then brings it home; the next one waits for it", async () => {
    const { nextTrip, settleTrips, tripEnd, tripTime, TRIP, TRIP_MS } = await import('../src/lib/coraLinks');
    const held = nextTrip({ armed: null }, 'A', 'out', [], 0)!;
    expect(tripEnd(held)).toBe(Infinity);
    // laps round and round while held (folded into the one lap on its timeline)
    const lap = TRIP.orbit - TRIP.arrive;
    expect(tripTime(held, TRIP.arrive + 3 * lap + 500)).toBe(TRIP.arrive + 500);
    // a trip queued behind it waits
    const next = nextTrip({ armed: 'A', dir: 'out' }, 'A', 'in', [held], 3000)!;
    expect(next.at).toBe(Infinity);
    // still busy: nothing changes; done: it lets go after the lap it's on, and the next one gets its start
    expect(settleTrips([held, next], new Set(['A']), 9000)).toEqual([held, next]);
    const [h, n] = settleTrips([held, next], new Set(), 9000);
    expect(h.release).toBe(9000);
    const laps = Math.ceil((9000 - TRIP.arrive) / lap);
    expect(tripEnd(h)).toBe(TRIP.arrive + laps * lap + (TRIP_MS - TRIP.orbit));
    expect(n.at).toBe(tripEnd(h));
    expect(tripTime(h, TRIP.arrive + laps * lap + 100)).toBe(TRIP.orbit + 100);
  });
});
