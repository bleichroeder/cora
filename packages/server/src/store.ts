import { createRequire } from 'node:module';
import { basename } from 'node:path';

// Loaded via require (not a static import) so the CLI's warning filter is installed before node:sqlite
// emits its ExperimentalWarning.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;
import { PRESENT_TOOLS, recapText, type AgentInfo, type BrainEvent, type NewEvent, type Recap, type SessionInfo } from '@cora/shared';

const MAX_FIELD = 8 * 1024;
/** Tools whose input is the payload itself and is kept whole: an explain's document (the tool caps it at 2 MB). */
const KEEP_INPUT = new Set<string>(PRESENT_TOOLS);

function truncateValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + '…[truncated]' : v;
  const j = JSON.stringify(v);
  if (j.length <= MAX_FIELD) return v;
  return { _truncated: true, preview: j.slice(0, MAX_FIELD) + '…[truncated]' };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Incoming defined values win; nested objects merge. */
function deepMerge<T>(a: T, b: Partial<T>): T {
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b as object)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export class Store {
  private db: DatabaseSync;
  private seq: number;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, tool_use_id TEXT, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ev_session ON events(session_id, agent_id, ts);
      CREATE INDEX IF NOT EXISTS ev_seq ON events(seq);
      CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (session_id, agent_id));
      CREATE TABLE IF NOT EXISTS recaps (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recap_ts ON recaps(ts);
      CREATE INDEX IF NOT EXISTS recap_session ON recaps(session_id, ts);
    `);
    this.seq = (this.db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null }).m ?? 0;
  }

  lastSeq(): number {
    return this.seq;
  }

  /** Insert or merge an event. Returns the stored event, or null if nothing changed. */
  upsertEvent(e: NewEvent): BrainEvent | null {
    const incoming: NewEvent = e.tool
      ? { ...e, tool: { ...e.tool, input: KEEP_INPUT.has(e.tool.name) ? e.tool.input : truncateValue(e.tool.input), ...(e.tool.preview ? { preview: truncateValue(e.tool.preview) as string } : {}) } }
      : e;
    const row = this.db.prepare('SELECT json FROM events WHERE id = ?').get(e.id) as { json: string } | undefined;
    let next: NewEvent;
    if (row) {
      const prev = JSON.parse(row.json) as BrainEvent;
      // A message you send while Claude works comes through the hook with the turn's prompt id: it isn't the turn's
      // prompt, and mustn't replace it (the transcript shows it where Claude got it: parse.ts, queue operations)
      if (prev.kind === 'prompt' && incoming.kind === 'prompt' && incoming.source === 'hook' && (prev.text ?? '').trim() !== (incoming.text ?? '').trim()) return null;
      const { seq: _s, ...prevNoSeq } = prev;
      next = deepMerge(prevNoSeq as NewEvent, incoming);
      next.ts = Math.min(prev.ts, incoming.ts);
      if (prev.source === 'hook' || incoming.source === 'hook') next.source = 'hook';
      // precise hook durations beat timestamp-derived transcript durations
      if (prev.source === 'hook' && prev.durationMs != null) next.durationMs = prev.durationMs;
      if (JSON.stringify(next) === JSON.stringify(prevNoSeq)) return null;
    } else {
      next = incoming;
    }
    const stored: BrainEvent = { ...next, seq: ++this.seq };
    this.db
      .prepare(`INSERT INTO events (id, seq, session_id, agent_id, ts, kind, tool_use_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, agent_id = excluded.agent_id, ts = excluded.ts, json = excluded.json`)
      .run(stored.id, stored.seq, stored.sessionId, stored.agentId, stored.ts, stored.kind, stored.toolUseId ?? null, JSON.stringify(stored));
    return stored;
  }

  eventsSince(seq: number, limit = 5000): BrainEvent[] {
    return (this.db.prepare('SELECT json FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  /** Events for one session ordered by ts; `before` pages backwards (latest `limit` before that ts). */
  eventsForSession(sessionId: string, opts: { before?: number; limit?: number } = {}): BrainEvent[] {
    const limit = opts.limit ?? 5000;
    const rows = (opts.before != null
      ? this.db.prepare('SELECT json FROM events WHERE session_id = ? AND ts < ? ORDER BY ts DESC, seq DESC LIMIT ?').all(sessionId, opts.before, limit)
      : this.db.prepare('SELECT json FROM events WHERE session_id = ? ORDER BY ts DESC, seq DESC LIMIT ?').all(sessionId, limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json)).reverse();
  }

  /** A session's events whose JSON matches a LIKE pattern, newest first (small lookups by id). */
  findEvents(sessionId: string, like: string, limit = 20): BrainEvent[] {
    return (this.db.prepare('SELECT json FROM events WHERE session_id = ? AND json LIKE ? ORDER BY ts DESC LIMIT ?').all(sessionId, like, limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  /** Documents shown with the `present` tool (their start events), newest first. */
  listExplains(sessionId?: string, limit = 200): BrainEvent[] {
    // the tool's current name, and its name before the rename (explains recorded then)
    const [like, legacy] = PRESENT_TOOLS.map((t) => `%"name":"${t}"%`);
    const rows = (sessionId
      ? this.db.prepare("SELECT json FROM events WHERE session_id = ? AND kind = 'tool' AND id LIKE 'tool:%:start' AND (json LIKE ? OR json LIKE ?) ORDER BY ts DESC LIMIT ?").all(sessionId, like, legacy, limit)
      : this.db.prepare("SELECT json FROM events WHERE kind = 'tool' AND id LIKE 'tool:%:start' AND (json LIKE ? OR json LIKE ?) ORDER BY ts DESC LIMIT ?").all(like, legacy, limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json));
  }

  /** Events that matter for usage (model calls with token counts, finished turns) since `ts`. */
  usageEvents(ts: number): BrainEvent[] {
    const rows = this.db.prepare(`SELECT json FROM events WHERE ts >= ? AND (kind = 'turn_end' OR json LIKE '%"tokens":%')`).all(ts) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as BrainEvent);
  }

  /** How many main-agent prompts a session has stored. */
  promptCount(sessionId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND agent_id = 'main' AND kind = 'prompt' AND json_extract(json, '$.queue') IS NULL").get(sessionId) as { n: number };
    return r.n;
  }

  /** The session's earliest main-agent prompt still stored. */
  firstPrompt(sessionId: string): BrainEvent | undefined {
    const r = this.db.prepare("SELECT json FROM events WHERE session_id = ? AND agent_id = 'main' AND kind = 'prompt' AND json_extract(json, '$.queue') IS NULL ORDER BY ts, seq LIMIT 1").get(sessionId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }

  getEvent(id: string): BrainEvent | undefined {
    const r = this.db.prepare('SELECT json FROM events WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }

  /** A session's finished commands that may commit, push or create a branch (for which branches it works on). */
  gitWork(sessionId: string, limit = 300): BrainEvent[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM events WHERE session_id = ? AND kind = 'tool' AND id LIKE 'tool:%:end' AND (json LIKE '%git%' OR json LIKE '%glab%') AND (json LIKE '%commit%' OR json LIKE '%push%' OR json LIKE '%checkout%' OR json LIKE '%switch%' OR json LIKE '%worktree%' OR json LIKE '%mr create%' OR json LIKE '%ci run%') ORDER BY ts DESC LIMIT ?",
        )
        .all(sessionId, limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }

  /** When the session last ended (its session_end), if nothing but a turn's end came after it. */
  endedAt(sessionId: string): number | null {
    const end = (this.db.prepare("SELECT MAX(ts) AS t FROM events WHERE session_id = ? AND kind = 'session_end'").get(sessionId) as { t: number | null }).t;
    if (end == null) return null;
    const after = this.db.prepare("SELECT 1 FROM events WHERE session_id = ? AND ts > ? AND kind NOT IN ('turn_end', 'session_end') LIMIT 1").get(sessionId, end);
    return after ? null : end;
  }

  getSession(id: string): SessionInfo | undefined {
    const r = this.db.prepare('SELECT json FROM sessions WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }

  upsertSession(s: Partial<SessionInfo> & { id: string }): SessionInfo {
    const prev = this.getSession(s.id);
    const now = Date.now();
    const base: SessionInfo = prev ?? {
      id: s.id, cwd: '', project: '', title: '', state: 'idle', startedAt: s.startedAt ?? s.lastTs ?? now,
      lastTs: s.lastTs ?? now, cliVersion: '', transcriptPath: '', needsYou: 0,
    };
    const next = deepMerge(base, s);
    if (prev && s.lastTs != null) next.lastTs = Math.max(prev.lastTs, s.lastTs);
    if (prev && s.startedAt != null) next.startedAt = Math.min(prev.startedAt, s.startedAt);
    if (next.cwd && !next.project) next.project = basename(next.cwd.replace(/\\/g, '/'));
    if (s.cwd) next.project = basename(s.cwd.replace(/\\/g, '/'));
    this.db.prepare('INSERT INTO sessions (id, last_ts, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_ts = excluded.last_ts, json = excluded.json')
      .run(next.id, next.lastTs, JSON.stringify(next));
    return next;
  }

  listSessions(): SessionInfo[] {
    return (this.db.prepare('SELECT json FROM sessions ORDER BY last_ts DESC').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  getAgent(sessionId: string, agentId: string): AgentInfo | undefined {
    const r = this.db.prepare('SELECT json FROM agents WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }

  upsertAgent(a: Partial<AgentInfo> & { sessionId: string; agentId: string }): AgentInfo {
    const prev = this.getAgent(a.sessionId, a.agentId);
    let base: AgentInfo;
    if (prev) base = prev;
    else {
      const subs = (this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE session_id = ? AND agent_id <> 'main'").get(a.sessionId) as { n: number }).n;
      base = {
        sessionId: a.sessionId, agentId: a.agentId, parentAgentId: null, parentToolUseId: null,
        label: a.agentId === 'main' ? 'main' : a.agentId.slice(0, 7), agentType: a.agentId === 'main' ? 'main' : 'subagent',
        colorIdx: a.agentId === 'main' ? -1 : subs, startedAt: a.startedAt ?? Date.now(), endedAt: null, state: 'thinking',
      };
    }
    const next = deepMerge(base, a);
    if (prev && a.startedAt != null) next.startedAt = Math.min(prev.startedAt, a.startedAt);
    this.db.prepare('INSERT INTO agents (session_id, agent_id, json) VALUES (?, ?, ?) ON CONFLICT(session_id, agent_id) DO UPDATE SET json = excluded.json')
      .run(next.sessionId, next.agentId, JSON.stringify(next));
    return next;
  }

  listAgents(sessionId?: string): AgentInfo[] {
    const rows = (sessionId
      ? this.db.prepare('SELECT json FROM agents WHERE session_id = ?').all(sessionId)
      : this.db.prepare('SELECT json FROM agents').all()) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json));
  }

  /**
   * Remove agents recorded from hidden helper "stops" before those were ignored (see the pipeline): generic type, no
   * parent call, zero lifetime, and nothing recorded for them but that one report. Returns how many were removed.
   */
  purgePhantomAgents(): number {
    let n = 0;
    const rows = this.db.prepare('SELECT session_id, agent_id, json FROM agents').all() as Array<{ session_id: string; agent_id: string; json: string }>;
    for (const r of rows) {
      const a = JSON.parse(r.json) as AgentInfo;
      if (a.agentId === 'main' || a.agentType !== 'subagent' || a.parentToolUseId || a.endedAt == null || a.endedAt !== a.startedAt) continue;
      const kinds = this.db.prepare('SELECT kind FROM events WHERE session_id = ? AND agent_id = ?').all(r.session_id, r.agent_id) as Array<{ kind: string }>;
      if (kinds.some((k) => k.kind !== 'report')) continue;
      this.db.prepare('DELETE FROM events WHERE session_id = ? AND agent_id = ?').run(r.session_id, r.agent_id);
      this.db.prepare('DELETE FROM agents WHERE session_id = ? AND agent_id = ?').run(r.session_id, r.agent_id);
      n++;
    }
    return n;
  }

  /** Delete events older than `cutoffTs` and sessions idle since before it. Returns deleted event count. */
  /** Keep a recap (each once: a transcript read again doesn't add it twice). True when it's new. */
  addRecap(r: Recap): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO recaps (id, session_id, ts, text) VALUES (?, ?, ?, ?)').run(r.id, r.sessionId, r.at, r.text).changes) > 0;
  }

  /** Recaps since a time, oldest first: one session's, or every session's. */
  recaps(q: { since?: number; sessionId?: string; limit?: number } = {}): Recap[] {
    const rows = (
      q.sessionId
        ? this.db.prepare('SELECT id, session_id, ts, text FROM recaps WHERE session_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?').all(q.sessionId, q.since ?? 0, q.limit ?? 200)
        : this.db.prepare('SELECT id, session_id, ts, text FROM recaps WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(q.since ?? 0, q.limit ?? 200)
    ) as Array<{ id: string; session_id: string; ts: number; text: string }>;
    return rows.reverse().map((r) => ({ id: r.id, sessionId: r.session_id, at: r.ts, text: recapText(r.text) }));
  }

  prune(cutoffTs: number): number {
    this.db.prepare('DELETE FROM recaps WHERE ts < ?').run(cutoffTs);
    const n = Number(this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoffTs).changes);
    const dead = (this.db.prepare('SELECT id FROM sessions WHERE last_ts < ?').all(cutoffTs) as { id: string }[]).map((r) => r.id);
    for (const id of dead) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM agents WHERE session_id = ?').run(id);
    }
    return n;
  }

  /**
   * Hand back the room old events left (SQLite keeps it otherwise): at start, when a good part of a sizeable file is
   * free. Takes a few seconds on a large one, so only then.
   */
  compact(): boolean {
    const n = (pragma: string) => Number(Object.values(this.db.prepare(`PRAGMA ${pragma}`).get() as object)[0]);
    const pages = n('page_count');
    const free = n('freelist_count');
    const size = pages * n('page_size');
    if (size < 20_000_000 || free < pages * 0.25) return false;
    this.db.exec('VACUUM');
    return true;
  }

  close(): void {
    this.db.close();
  }
}
