import type { AgentInfo, AgentState, BrainEvent, SessionInfo, SessionState } from '@cora/shared';
import type { Store } from './store';
import type { LinkMeta } from './transcript/parse';

export type RegistryChange = { session?: SessionInfo; agent?: AgentInfo };

type Spawn = { toolUseId: string; parentAgentId: string; prompt?: string; description?: string; agentType?: string; linked?: string };

const ENDED_AFTER_MS = 30 * 60_000;
/** A "thinking" agent with no activity this long is really waiting (e.g. `claude -p` never writes a turn end). */
const IDLE_AFTER_MS = 10 * 60_000;
const STALE_TOOL_MS = 30 * 60_000;
const key = (sid: string, aid: string) => `${sid}/${aid}`;

/** Owns the agent tree and the session/agent state machines. */
export class Registry {
  private spawns = new Map<string, Spawn[]>(); // by session
  private inflight = new Map<string, Map<string, number>>(); // sid/aid → toolUseId → start ts
  private pending = new Map<string, number>();
  /** sessions that are over, and when they ended: only activity after that brings one back */
  private ended = new Map<string, number>();
  /** of those, the ones ended by 30 minutes' silence (not by Claude Code saying so, or their process exiting) */
  private silent = new Set<string>();

  /** `hosted`: the session has a live terminal in Cora (its process exiting ends it, so silence doesn't) */
  constructor(private store: Store, private onChange: (c: RegistryChange) => void, private o: { hosted?: (sessionId: string) => boolean } = {}) {
    // what had ended before Cora (re)started stays ended while it catches up on the transcripts: from the sessions'
    // saved state, or a session_end with nothing after it (which a restart could have hidden)
    for (const s of store.listSessions()) {
      if (s.state === 'ended') {
        this.ended.set(s.id, s.lastTs);
        if (store.endedAt(s.id) == null) this.silent.add(s.id);
      } else {
        const end = store.endedAt(s.id);
        if (end == null) continue;
        this.ended.set(s.id, end);
        this.refreshSession(s.id, {});
      }
    }
  }

  ingest(e: BrainEvent): void {
    const sid = e.sessionId;
    this.ensureAgent(sid, e.agentId, e.ts, e);
    if (e.kind === 'session_end') {
      this.ended.set(sid, e.ts);
      this.silent.delete(sid);
    }
    // new activity revives an ended session; catching up on its transcript (older than its end) doesn't
    else if (e.kind !== 'turn_end' && e.ts > (this.ended.get(sid) ?? Infinity)) {
      this.ended.delete(sid);
      // nothing from before it ended is still running
      for (const [k, m] of this.inflight) if (k.startsWith(sid + '/')) m.clear();
      this.store.upsertSession({ id: sid, exitReason: null });
    }

    if (e.kind === 'tool' && e.phase === 'start' && (e.tool?.name === 'Agent' || e.tool?.name === 'Task') && e.toolUseId) {
      const input = (e.tool.input ?? {}) as any;
      const list = this.spawns.get(sid) ?? [];
      if (!list.some((s) => s.toolUseId === e.toolUseId)) {
        list.push({ toolUseId: e.toolUseId, parentAgentId: e.agentId, prompt: input.prompt, description: input.description, agentType: input.subagent_type });
      }
      this.spawns.set(sid, list);
    }

    let agentState: AgentState | undefined;
    const fl = this.flight(sid, e.agentId);
    switch (e.kind) {
      case 'tool':
        if (e.toolUseId) {
          if (e.phase === 'start') fl.set(e.toolUseId, e.ts);
          else fl.delete(e.toolUseId);
        }
        agentState = fl.size ? 'working' : 'thinking';
        break;
      case 'prompt':
      case 'say':
      case 'think':
        if (e.agentId !== 'main' && this.store.getAgent(sid, e.agentId)?.state === 'done') break;
        agentState = fl.size ? 'working' : 'thinking';
        break;
      case 'turn_end':
        if (e.agentId === 'main') {
          fl.clear();
          agentState = 'idle';
        }
        break;
      case 'report':
        if (e.agentId !== 'main') {
          fl.clear();
          this.emitAgent(this.store.upsertAgent({ sessionId: sid, agentId: e.agentId, state: 'done', endedAt: e.ts }));
        }
        break;
      case 'session_end':
        fl.clear();
        agentState = 'idle';
        break;
      case 'interrupt':
        // the user stopped this turn: nothing is running any more and the session waits for input
        for (const [k, m] of this.inflight) if (k.startsWith(sid + '/')) m.clear();
        for (const a of this.store.listAgents(sid)) if (a.agentId === 'main' || a.state !== 'done') this.setAgentState(sid, a.agentId, 'idle');
        break;
    }
    if (agentState) this.setAgentState(sid, e.agentId, agentState);
    this.refreshSession(sid, { lastTs: e.ts, startedAt: e.ts });
  }

  linkChild(sessionId: string, link: LinkMeta): void {
    const spawn = this.spawns.get(sessionId)?.find((s) => s.toolUseId === link.toolUseId);
    if (spawn) spawn.linked = link.childAgentId;
    const label = link.description ?? spawn?.description;
    this.emitAgent(this.store.upsertAgent({
      sessionId, agentId: link.childAgentId, parentAgentId: spawn?.parentAgentId ?? 'main', parentToolUseId: link.toolUseId,
      ...(label ? { label } : {}), ...(spawn?.agentType ? { agentType: spawn.agentType } : {}),
    }));
  }

  agentStarted(sessionId: string, agentId: string, agentType: string, ts: number): void {
    const existing = this.store.getAgent(sessionId, agentId);
    this.ensureAgent(sessionId, agentId, ts);
    if (!existing?.parentToolUseId) {
      const spawn = this.spawns.get(sessionId)?.find((s) => !s.linked && (!s.agentType || s.agentType === agentType));
      if (spawn) this.linkChild(sessionId, { toolUseId: spawn.toolUseId, childAgentId: agentId });
    }
    this.emitAgent(this.store.upsertAgent({ sessionId, agentId, agentType, state: 'thinking' }));
    this.refreshSession(sessionId, { lastTs: ts });
  }

  /**
   * A session was just started, resumed or forked from Cora: it's live now, not when Claude Code's first hook
   * arrives (a resumed session would otherwise stay 'ended' for its first seconds, and quitting it before then
   * wouldn't register as it ending).
   */
  sessionLaunched(sessionId: string, ts: number): void {
    this.ended.delete(sessionId);
    this.silent.delete(sessionId);
    this.refreshSession(sessionId, { lastTs: ts, exitReason: null });
  }

  /** A hosted session's process exited: it is over now, not after 30 minutes of silence. */
  sessionExited(sessionId: string, ts: number): void {
    // gone, or already over (a terminal found dead when Cora starts): nothing changes, its last activity included
    if (!this.store.getSession(sessionId) || this.ended.has(sessionId)) return;
    for (const [k, m] of this.inflight) if (k.startsWith(sessionId + '/')) m.clear();
    for (const a of this.store.listAgents(sessionId)) if (a.state !== 'done') this.setAgentState(sessionId, a.agentId, 'idle');
    this.ended.set(sessionId, ts);
    this.refreshSession(sessionId, { lastTs: ts, exitReason: 'exited' });
  }

  agentStopped(sessionId: string, agentId: string, ts: number): void {
    this.flight(sessionId, agentId).clear();
    this.emitAgent(this.store.upsertAgent({ sessionId, agentId, state: 'done', endedAt: ts }));
    this.refreshSession(sessionId, { lastTs: ts });
  }

  turnEnded(sessionId: string, ts: number): void {
    this.flight(sessionId, 'main').clear();
    this.ensureAgent(sessionId, 'main', ts);
    this.setAgentState(sessionId, 'main', 'idle');
    this.refreshSession(sessionId, { lastTs: ts });
  }

  setPendingCount(sessionId: string, n: number): void {
    this.pending.set(sessionId, n);
    this.refreshSession(sessionId, { needsYou: n });
  }

  updateSessionMeta(sessionId: string, meta: Partial<SessionInfo>): void {
    const prev = this.store.getSession(sessionId);
    const changed = !prev || Object.entries(meta).some(([k, v]) => v !== undefined && (prev as any)[k] !== v);
    if (changed) this.refreshSession(sessionId, meta);
  }

  tick(now: number): void {
    for (const s of this.store.listSessions()) {
      if (s.state === 'ended') {
        // ended by silence, but its terminal in Cora is live: it never ended
        if (this.silent.has(s.id) && this.o.hosted?.(s.id)) {
          this.ended.delete(s.id);
          this.silent.delete(s.id);
          this.refreshSession(s.id, {});
        }
        continue;
      }
      for (const [k, fl] of this.inflight) {
        if (!k.startsWith(s.id + '/')) continue;
        for (const [id, ts] of fl) if (now - ts > STALE_TOOL_MS) fl.delete(id);
      }
      if (now - s.lastTs > IDLE_AFTER_MS) {
        for (const a of this.store.listAgents(s.id)) {
          if (a.state === 'thinking' || (a.state === 'working' && !this.flight(s.id, a.agentId).size)) this.setAgentState(s.id, a.agentId, 'idle');
        }
        this.refreshSession(s.id, {});
      }
      if (now - s.lastTs > ENDED_AFTER_MS && !(this.pending.get(s.id) ?? 0) && !this.o.hosted?.(s.id)) {
        this.ended.set(s.id, s.lastTs);
        this.silent.add(s.id);
        this.refreshSession(s.id, {});
      }
    }
  }

  // ---------------------------------------------------------------------------

  private flight(sid: string, aid: string): Map<string, number> {
    let m = this.inflight.get(key(sid, aid));
    if (!m) this.inflight.set(key(sid, aid), (m = new Map()));
    return m;
  }

  private ensureAgent(sid: string, aid: string, ts: number, e?: BrainEvent): void {
    if (aid !== 'main') this.ensureAgent(sid, 'main', ts);
    const existing = this.store.getAgent(sid, aid);
    if (!existing) this.emitAgent(this.store.upsertAgent({ sessionId: sid, agentId: aid, startedAt: ts, parentAgentId: aid === 'main' ? null : 'main' }));
    if (aid !== 'main' && !existing?.parentToolUseId && e?.kind === 'prompt' && e.text) {
      const spawn = this.spawns.get(sid)?.find((s) => !s.linked && s.prompt === e.text);
      if (spawn) this.linkChild(sid, { toolUseId: spawn.toolUseId, childAgentId: aid });
    }
  }

  private setAgentState(sid: string, aid: string, state: AgentState): void {
    const a = this.store.getAgent(sid, aid);
    if (a && a.state === state) return;
    if (a?.state === 'done' && aid !== 'main') return;
    this.emitAgent(this.store.upsertAgent({ sessionId: sid, agentId: aid, state }));
  }

  private computeState(sid: string): SessionState {
    if ((this.pending.get(sid) ?? 0) > 0) return 'needs-you';
    if (this.ended.has(sid)) return 'ended';
    const agents = this.store.listAgents(sid);
    if (agents.some((a) => a.state === 'working')) return 'working';
    if (agents.some((a) => a.state === 'thinking')) return 'thinking';
    return 'idle';
  }

  private refreshSession(sid: string, patch: Partial<SessionInfo>): void {
    const prev = this.store.getSession(sid);
    const state = this.computeState(sid);
    const next = this.store.upsertSession({ id: sid, ...patch, state });
    if (!prev || prev.state !== next.state || prev.lastTs !== next.lastTs || prev.needsYou !== next.needsYou || Object.keys(patch).some((k) => (prev as any)[k] !== (next as any)[k])) {
      this.onChange({ session: next });
    }
  }

  private emitAgent(a: AgentInfo): void {
    this.onChange({ agent: a });
  }
}
