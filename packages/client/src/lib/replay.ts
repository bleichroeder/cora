import { useEffect } from 'react';
import type { AgentInfo, AgentState, BrainEvent } from '@cora/shared';
import type { Step } from './steps';
import { useBrain, type TimeCursor } from '../state/store';

/** A "thinking" agent quiet this long was really waiting (as the server decides it). */
const IDLE_AFTER_MS = 10 * 60_000;

/**
 * What each agent was doing at `at`, replaying the server's state machine over the events up to then: a call in
 * flight is working, any other activity is thinking, main's turn end (or an interrupt, or the session ending) is idle,
 * and a subagent's report is done. Events must be in time order.
 */
export function statesAt(events: BrainEvent[], at: number): Map<string, { state: AgentState; endedAt?: number }> {
  const flight = new Map<string, Set<string>>();
  const st = new Map<string, { state: AgentState; endedAt?: number }>();
  const fl = (aid: string) => flight.get(aid) ?? flight.set(aid, new Set()).get(aid)!;
  const set = (aid: string, state: AgentState, endedAt?: number) => {
    if (aid !== 'main' && st.get(aid)?.state === 'done') return;
    st.set(aid, endedAt != null ? { state, endedAt } : { state });
  };
  let last = 0;
  for (const e of events) {
    if (e.ts > at) break;
    last = e.ts;
    const f = fl(e.agentId);
    switch (e.kind) {
      case 'tool':
        if (e.toolUseId) e.phase === 'start' ? f.add(e.toolUseId) : f.delete(e.toolUseId);
        set(e.agentId, f.size ? 'working' : 'thinking');
        break;
      case 'prompt':
      case 'say':
      case 'think':
        set(e.agentId, f.size ? 'working' : 'thinking');
        break;
      case 'turn_end':
        if (e.agentId === 'main') {
          f.clear();
          set('main', 'idle');
        }
        break;
      case 'report':
        if (e.agentId !== 'main') {
          f.clear();
          set(e.agentId, 'done', e.ts);
        }
        break;
      case 'session_end':
        f.clear();
        set(e.agentId, 'idle');
        break;
      case 'interrupt':
        for (const x of flight.values()) x.clear();
        for (const [aid, s] of st) if (aid === 'main' || s.state !== 'done') set(aid, 'idle');
        break;
    }
  }
  if (at - last > IDLE_AFTER_MS) for (const [aid, s] of st) if (s.state === 'thinking' || (s.state === 'working' && !fl(aid).size)) set(aid, 'idle');
  return st;
}

/**
 * The session's agents as they were at `at`: ones not started yet are left out, ones that had ended are done, the
 * rest doing what the events say. Some state changes come without an event (Claude Code's Stop hook ends main's turn),
 * so an agent with nothing since is as it is now, and main whose next event is your prompt was waiting for it.
 * Times move by `shift` like the events'.
 */
export function agentsAt(agents: AgentInfo[], events: BrainEvent[], at: number, shift = 0): AgentInfo[] {
  const states = statesAt(events, at);
  const next = new Map<string, BrainEvent>();
  for (const e of events) if (e.ts > at && !next.has(e.agentId)) next.set(e.agentId, e);
  const out: AgentInfo[] = [];
  for (const a of agents) {
    const isMain = a.agentId === 'main';
    if (!isMain && a.startedAt > at) continue;
    const s = states.get(a.agentId);
    const ended = !isMain && a.endedAt != null && a.endedAt <= at ? a.endedAt : s?.state === 'done' ? s.endedAt ?? at : null;
    let state: AgentState = ended != null ? 'done' : s && s.state !== 'done' ? s.state : isMain ? 'idle' : 'thinking';
    if (ended == null && !next.has(a.agentId) && a.state !== 'done') state = a.state;
    else if (isMain && state === 'thinking' && next.get('main')?.kind === 'prompt' && !next.get('main')?.queue) state = 'idle';
    out.push({ ...a, startedAt: a.startedAt ? a.startedAt + shift : a.startedAt, endedAt: ended != null ? ended + shift : null, state });
  }
  return out;
}

let cache: { events: BrainEvent[]; agents: AgentInfo[]; at: number; shift: number; out: { events: BrainEvent[]; agents: AgentInfo[] } } | null = null;

/**
 * The scene's input at the playhead: the events up to `at` and the agents as they were, with every time moved
 * forward by `shift` ms. The scene (and its animations, which run on the wall clock) then plays that moment as if it
 * were happening now. Remembers its last answer, as the scene asks twice a second.
 */
export function replayAt(events: BrainEvent[], agents: AgentInfo[], at: number, shift: number): { events: BrainEvent[]; agents: AgentInfo[] } {
  if (cache && cache.events === events && cache.agents === agents && cache.at === at && cache.shift === shift) return cache.out;
  const upTo: BrainEvent[] = [];
  for (const e of events) if (e.ts <= at) upTo.push(shift ? { ...e, ts: e.ts + shift } : e);
  const out = { events: upTo, agents: agentsAt(agents, events, at, shift) };
  cache = { events, agents, at, shift, out };
  return out;
}

/**
 * The transcript step to show for the playhead: the one holding its event when it points at one (a marker, a block),
 * else the last step that had begun by then. -1 when there are no steps.
 */
export function stepAt(steps: Step[], c: Pick<TimeCursor, 'ts' | 'eventId' | 'toolUseId'>): number {
  if (c.eventId || c.toolUseId) {
    const head = c.eventId ? `${c.eventId}#step` : null;
    const tool = c.toolUseId ? `tool:${c.toolUseId}` : null;
    const i = steps.findIndex((s) => s.key === head || s.items.some((it) => it.key === tool || (c.eventId && it.key === c.eventId)));
    if (i >= 0) return i;
  }
  let at = -1;
  for (let i = 0; i < steps.length; i++) if (steps[i].ts <= c.ts) at = i;
  return at < 0 && steps.length ? 0 : at;
}

/**
 * The transcript's side of the playhead: scrolls to the step at it whenever it moves, and says which step that is
 * (its key) so it can be highlighted. Null while live.
 */
export function useCursorStep(sessionId: string, steps: Step[], scrollTo: (index: number) => void): string | null {
  const cursor = useBrain((s) => (s.cursor?.sessionId === sessionId ? s.cursor : null));
  const i = cursor ? stepAt(steps, cursor) : -1;
  useEffect(() => {
    if (i < 0) return;
    // a frame later: a transcript just opened scrolls to its end first (it follows new activity)
    const h = requestAnimationFrame(() => scrollTo(i));
    return () => cancelAnimationFrame(h);
    // only when the playhead moves, not as new steps arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);
  return i >= 0 ? steps[i].key : null;
}
