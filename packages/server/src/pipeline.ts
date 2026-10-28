import type { BrainEvent, NewEvent } from '@cora/shared';
import { hookToEvents } from './hooks/normalize';
import type { Hub } from './hub';
import { isNamerCwd, isNamerSlug } from './namer';
import type { PendingManager } from './pending';
import type { Registry } from './registry';
import type { Store } from './store';
import { newParseCtx, parseLine, type ParseCtx } from './transcript/parse';
import type { TailInfo } from './transcript/tailer';

export type Pipeline = {
  ingestTranscript(file: string, objs: any[], info: TailInfo): void;
  ingestHook(event: string, payload: any, now?: number): void;
  ingestEvents(events: NewEvent[]): void;
  /** sessions pruned from history: their transcripts' parse state goes */
  forget(ids: string[]): void;
};

export type PipelineOptions = {
  /** a folder whose hook events and transcripts are Cora's own (the namer's `claude -p`): never a session */
  ignoreDir?: string;
  /** a main-agent prompt was stored (auto-names) */
  onPrompt?: (e: BrainEvent) => void;
  /** every event stored (the pipeline monitor reads commands from them) */
  onEvent?: (e: BrainEvent) => void;
  /** a slash command typed in a main session, read from its transcript (a session's ticket) */
  onCommand?: (sessionId: string, c: { id: string; text: string; ts: number }) => void;
  /** a recap Cora hadn't seen (Claude Code wrote it as you came back) */
  onRecap?: (sessionId: string, r: { text: string; at: number }) => void;
};

/** Wires parsers → store → registry → hub. */
export function createPipeline(store: Store, registry: Registry, hub: Hub, pending?: PendingManager, opts: PipelineOptions = {}): Pipeline {
  const ctxs = new Map<string, ParseCtx>();
  /** each transcript's session (its parse context goes when the session is pruned) */
  const fileSession = new Map<string, string>();
  const lineStats = new Map<string, { total: number; unknown: number }>();

  const ingestEvents = (events: NewEvent[]) => {
    for (const e of events) {
      const stored = store.upsertEvent(e);
      if (!stored) continue;
      registry.ingest(stored);
      hub.publish(stored);
      if (stored.kind === 'prompt' && stored.agentId === 'main' && !stored.queue) opts.onPrompt?.(stored);
      opts.onEvent?.(stored);
    }
  };

  return {
    ingestEvents,

    ingestTranscript(file, objs, info) {
      const dir = opts.ignoreDir;
      if (dir && (isNamerSlug(info.projectSlug, dir) || objs.some((o) => isNamerCwd(o?.cwd, dir)))) return;
      let ctx = ctxs.get(file);
      if (!ctx) ctxs.set(file, (ctx = newParseCtx()));
      fileSession.set(file, info.sessionId);
      const stats = lineStats.get(info.sessionId) ?? { total: 0, unknown: 0 };
      for (const obj of objs) {
        if (obj && typeof obj === 'object' && !obj.sessionId && !obj.session_id) obj.sessionId = info.sessionId;
        if (info.agentId !== 'main' && obj && typeof obj === 'object' && !obj.agentId) obj.agentId = info.agentId;
        const r = parseLine(obj, ctx);
        stats.total++;
        if (r.meta.unknown) stats.unknown++;
        // read before Cora (re)started: it's in the store already; it only told the parser what came before
        if (info.quiet) continue;
        const meta: Record<string, unknown> = {};
        if (r.meta.title) meta.title = r.meta.title;
        if (info.agentId === 'main') {
          if (r.meta.cwd) meta.cwd = r.meta.cwd;
          if (r.meta.cliVersion) meta.cliVersion = r.meta.cliVersion;
          if (r.meta.model) meta.model = r.meta.model;
          meta.transcriptPath = file;
        }
        if (r.meta.recap && info.agentId === 'main') {
          if (store.addRecap({ ...r.meta.recap, sessionId: info.sessionId })) opts.onRecap?.(info.sessionId, r.meta.recap);
          const cur = store.getSession(info.sessionId)?.recap;
          if (!cur || cur.at < r.meta.recap.at) meta.recap = { text: r.meta.recap.text, at: r.meta.recap.at };
        }
        if (Object.keys(meta).length) registry.updateSessionMeta(info.sessionId, meta);
        ingestEvents(r.events);
        if (r.meta.command && info.agentId === 'main') opts.onCommand?.(info.sessionId, r.meta.command);
        if (r.meta.link) registry.linkChild(info.sessionId, r.meta.link);
        if (r.meta.agentDone && store.getAgent(info.sessionId, r.meta.agentDone.agentId)) {
          registry.agentStopped(info.sessionId, r.meta.agentDone.agentId, r.meta.agentDone.ts);
        }
      }
      lineStats.set(info.sessionId, stats);
      registry.updateSessionMeta(info.sessionId, { totalLines: stats.total, unknownLines: stats.unknown });
    },

    forget(ids) {
      const gone = new Set(ids);
      for (const [file, sid] of fileSession)
        if (gone.has(sid)) {
          ctxs.delete(file);
          fileSession.delete(file);
        }
      for (const sid of ids) lineStats.delete(sid);
    },

    ingestHook(event, payload, now = Date.now()) {
      if (opts.ignoreDir && isNamerCwd(payload?.cwd, opts.ignoreDir)) return;
      const r = hookToEvents(event, payload, now);
      const sid = r.session?.id;
      if (!sid) return;
      const meta: Record<string, unknown> = {};
      if (r.session?.cwd) meta.cwd = r.session.cwd;
      if (r.session?.transcriptPath) meta.transcriptPath = r.session.transcriptPath;
      const known = store.getSession(sid);
      if (Object.keys(meta).length && !known?.cwd) registry.updateSessionMeta(sid, meta);
      // it moved (into a worktree, and back): where it works now
      else if (known?.cwd && r.session?.cwd) {
        const wd = r.session.cwd === known.cwd ? null : r.session.cwd;
        if ((known.wd ?? null) !== wd) registry.updateSessionMeta(sid, { wd });
      }
      // Claude Code's hidden helpers (e.g. the next-prompt suggestion) fire SubagentStop without ever starting:
      // they aren't subagents, so don't conjure an agent (or a "report") out of them.
      if (r.agentStop && !r.agentStart && !store.getAgent(sid, r.agentStop.agentId)) return;
      if (r.agentStart) registry.agentStarted(sid, r.agentStart.agentId, r.agentStart.agentType, now);
      ingestEvents(r.events);
      if (r.link) registry.linkChild(sid, r.link);
      if (r.agentStop) registry.agentStopped(sid, r.agentStop.agentId, now);
      if (r.turnEnded) {
        registry.turnEnded(sid, now);
        pending?.cancelSession(sid);
      }
      if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && payload.tool_use_id) pending?.cancelForToolUse(payload.tool_use_id);
      if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && payload.tool_name) pending?.cancelForTool(sid, payload.agent_id ?? 'main', String(payload.tool_name), payload.tool_input);
      // a new prompt: whatever was being asked before it has been settled in the terminal
      if (event === 'UserPromptSubmit') pending?.cancelSession(sid);
    },
  };
}
