import { create } from 'zustand';
import type { BrainEvent } from '@cora/shared';

/**
 * Who Cora is reaching for, and who's reaching for Cora, from Cora's own session's events: its tools that act on a
 * session or look into it (send_to_session, ask_session, session, recaps, ...) reach out to it while they run and a
 * moment after (what Cora asked for, it fetches: its messenger brings it home); a session reaching Cora by itself (its
 * news: the feed's lines name it by id) reaches Cora for a moment.
 */
export type LinkDir = 'out' | 'in';

/** Cora's tools that reach a session (by its id, or the start of it): acting on it, or looking into it for you */
const REACH = new Set(['send_to_session', 'ask_session', 'ask_copy', 'resume_session', 'end_session', 'rename_session', 'focus', 'session', 'recaps', 'explains', 'show_explain']);
/** after a tool ends, its reach stays this long */
export const HOLD_MS = 4000;
/** a tool whose end never came stops reaching after this */
const OPEN_MAX_MS = 60_000;
/** a session's answer or news reaches Cora for this long */
export const IN_MS = 5000;

const toolName = (e: BrainEvent) => (e.tool?.name ?? '').split('__').pop() ?? '';

/** The links live at `now`: a session's id → which way (Cora reaching it wins over it reaching Cora). */
export function coraLinks(events: BrainEvent[], sessionIds: string[], now: number, /** filled with the sessions a call of Cora's is still on */ busy?: Set<string>): Record<string, LinkDir> {
  const resolve = (id: unknown) => {
    if (typeof id !== 'string' || id.length < 4) return null;
    return sessionIds.find((s) => s === id) ?? sessionIds.find((s) => s.startsWith(id)) ?? null;
  };
  const starts = new Map<string, { sid: string; ts: number; name: string }>();
  const out: Record<string, LinkDir> = {};
  const reach: Array<[string, 1 | -1]> = [];
  for (const e of events) {
    if (e.agentId !== 'main') continue;
    if (e.kind === 'prompt' && now - e.ts < IN_MS && e.text) {
      // the feed's lines (a `[Cora 14:05]` block): `- "name" (session-id) finished its turn…`; not your own words,
      // which say which session you're looking at the same way
      if (!/^\s*\[Cora \d/.test(e.text)) continue;
      // (a reply to what Cora asked it isn't it reaching out: Cora went and got that)
      for (const line of e.text.split('\n')) {
        if (/replied to what you asked|\[Follow-up\]/.test(line)) continue;
        for (const m of line.matchAll(/\(([0-9a-f]{8}-[0-9a-f-]{27,})\)/g)) {
          const sid = resolve(m[1]);
          if (sid) reach.push([sid, -1]);
        }
      }
      continue;
    }
    if (e.kind !== 'tool' || !e.toolUseId) continue;
    if (e.phase === 'start') {
      const name = toolName(e);
      const inp = e.tool?.input as { id?: unknown; sessionId?: unknown } | undefined;
      const sid = REACH.has(name) ? resolve(inp?.id ?? inp?.sessionId) : null;
      if (sid) starts.set(e.toolUseId, { sid, ts: e.ts, name });
      continue;
    }
    const st = starts.get(e.toolUseId);
    if (!st) continue;
    starts.delete(e.toolUseId);
    if (now - e.ts < HOLD_MS) reach.push([st.sid, 1]);
  }
  for (const st of starts.values()) if (now - st.ts < OPEN_MAX_MS) (reach.push([st.sid, 1]), busy?.add(st.sid));
  for (const [sid, way] of reach) if (way > 0) out[sid] = 'out';
  for (const [sid, way] of reach) if (way < 0) out[sid] ??= 'in';
  return out;
}

/**
 * The links now, for the cards and the session list: `armed` is the session whose card is open beside Cora's (they
 * reach for each other through the cards); others show it on their row (Cora reaching them) or around Cora's orb (them
 * reaching Cora).
 */
export const useCoraLinks = create<{ links: Record<string, LinkDir>; armed: string | null; /** messages between Cora's card and the open session's, one after another: who sent each, and when it starts (the orbs play them) */ trips: Trip[] }>(() => ({ links: {}, armed: null, trips: [] }));

/**
 * A message between Cora and the open session, carried by a small copy of the sender, in ms from its start: it buds
 * off the sender and flies out of its card; comes into the other's card, circles that orb (touching it), and leaves;
 * then comes home and is taken back in. Cora's (`hold`) stays circling the session for as long as Cora's call is
 * still going (an ask waiting for the answer), and brings what it got home when it's done.
 */
export const TRIP = { bud: 500, out: 1100, inStart: 1500, arrive: 2100, orbit: 4100, leave: 4700, back: 5100, home: 5700, end: 6100 } as const;
const LAP = TRIP.orbit - TRIP.arrive;

export type Trip = { from: 'cora' | 'session'; sid: string; at: number; /** circles until `release` (Cora's call still going) */ hold?: boolean; release?: number };
/** a trip's length when nothing holds it (its timeline: TRIP) */
export const TRIP_MS = TRIP.end + 100;

/** How many laps round the other orb (Infinity: still held). */
const laps = (t: Trip) => (!t.hold ? 1 : t.release == null ? Infinity : Math.max(1, Math.ceil((t.release - t.at - TRIP.arrive) / LAP)));

/** When a trip is over (Infinity: still held at the other orb). */
export const tripEnd = (t: Trip) => t.at + TRIP.arrive + laps(t) * LAP + (TRIP_MS - TRIP.orbit);

/** Where a trip is at `now` on its timeline (TRIP), its laps folded into one; negative before it starts. */
export function tripTime(t: Trip, now: number): number {
  const e = now - t.at;
  if (e < TRIP.arrive) return e;
  const orbitsEnd = TRIP.arrive + laps(t) * LAP;
  if (e < orbitsEnd) return TRIP.arrive + ((e - TRIP.arrive) % LAP);
  return TRIP.orbit + (e - orbitsEnd);
}

/** A new trip when the open session's link starts or turns round: now, or once the last one is home. */
export function nextTrip(prev: { armed: string | null; dir?: LinkDir }, armed: string | null, dir: LinkDir | undefined, trips: Trip[], now: number): Trip | null {
  if (!armed || !dir || (prev.armed === armed && prev.dir === dir)) return null;
  const last = trips[trips.length - 1];
  return { from: dir === 'out' ? 'cora' : 'session', sid: armed, at: last ? Math.max(now, tripEnd(last)) : now, ...(dir === 'out' ? { hold: true } : {}) };
}

/** Cora's call on the session is done: a held trip lets go, and the ones after it get their start. */
export function settleTrips(trips: Trip[], busy: Set<string>, now: number): Trip[] {
  let changed = false;
  const out: Trip[] = [];
  for (const t of trips) {
    let x = t;
    if (x.hold && x.release == null && !busy.has(x.sid) && now >= x.at) (x = { ...x, release: now }), (changed = true);
    const prev = out[out.length - 1];
    if (prev && !Number.isFinite(x.at) && Number.isFinite(tripEnd(prev))) (x = { ...x, at: Math.max(now, tripEnd(prev)) }), (changed = true);
    out.push(x);
  }
  const live = out.filter((t) => tripEnd(t) > now);
  return changed || live.length !== trips.length ? live : trips;
}

/** The trip playing at `now` (none between them). */
export const tripAt = (trips: Trip[], now: number) => trips.find((t) => now >= t.at && now < tripEnd(t)) ?? null;

export const sameLinks = (a: Record<string, LinkDir>, b: Record<string, LinkDir>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
