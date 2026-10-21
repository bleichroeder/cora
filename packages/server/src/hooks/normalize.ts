import { EVENT_ICON, iconFor, isSafeId, summarizeTool } from '@cora/shared';
import type { NewEvent, SessionInfo } from '@cora/shared';
import type { LinkMeta } from '../transcript/parse';

export type HookResult = {
  events: NewEvent[];
  session?: Partial<SessionInfo> & { id: string };
  agentStart?: { agentId: string; agentType: string };
  agentStop?: { agentId: string };
  link?: LinkMeta;
  turnEnded?: boolean;
  notification?: { type: string; message: string };
};

const SYSTEM_INJECTED = /^\s*<(task-notification|system-reminder|command-|local-command|bash-)/;

/** Pure mapping from one Claude Code hook payload to brain events + registry hints. */
export function hookToEvents(event: string, p: any, now = Date.now()): HookResult {
  const sessionId: string | undefined = p?.session_id;
  // an id that isn't one never becomes a session (it would reach file names and command lines)
  if (!isSafeId(sessionId) || (p.agent_id != null && !isSafeId(p.agent_id))) return { events: [] };
  const agentId: string = p.agent_id ?? 'main';
  const cwd: string | undefined = p.cwd;
  const base = { sessionId, agentId, ts: now, source: 'hook' as const };
  const session = { id: sessionId, ...(cwd ? { cwd } : {}), ...(p.transcript_path ? { transcriptPath: p.transcript_path } : {}) };

  switch (event) {
    case 'UserPromptSubmit': {
      const text = String(p.prompt ?? '');
      if (!text || SYSTEM_INJECTED.test(text)) return { events: [], session };
      return { events: [{ ...base, id: `prompt:${p.prompt_id}`, kind: 'prompt', icon: EVENT_ICON.prompt, text }], session };
    }
    case 'PreToolUse': {
      const s = summarizeTool(p.tool_name, p.tool_input, undefined, undefined, cwd);
      return {
        session,
        events: [{
          ...base, id: `tool:${p.tool_use_id}:start`, kind: 'tool', phase: 'start', toolUseId: p.tool_use_id,
          icon: iconFor(p.tool_name, p.tool_input), tool: { name: p.tool_name, input: p.tool_input, summary: s.summary, resource: s.resource },
        }],
      };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const failed = event === 'PostToolUseFailure';
      const s = summarizeTool(p.tool_name, p.tool_input, failed ? p.error : undefined, failed ? undefined : p.tool_response, cwd, failed);
      const out: HookResult = {
        session,
        events: [{
          ...base, id: `tool:${p.tool_use_id}:end`, kind: 'tool', phase: 'end', toolUseId: p.tool_use_id,
          icon: s.failed ? EVENT_ICON.fail : iconFor(p.tool_name, p.tool_input),
          ...(p.duration_ms != null ? { durationMs: Number(p.duration_ms) } : {}),
          tool: { name: p.tool_name, input: p.tool_input, summary: s.summary, resultSummary: s.resultSummary, preview: s.preview, resource: s.resource, ...(s.failed ? { failed: true } : {}), ...(s.change ? { change: s.change } : {}), ...(s.background ? { background: s.background } : {}) },
        }],
      };
      const r = p.tool_response;
      if (!failed && (p.tool_name === 'Agent' || p.tool_name === 'Task') && r && typeof r === 'object' && r.agentId) {
        out.link = { toolUseId: p.tool_use_id, childAgentId: r.agentId, prompt: r.prompt ?? p.tool_input?.prompt, description: r.description ?? p.tool_input?.description };
      }
      return out;
    }
    case 'SubagentStart':
      return { events: [], session, agentStart: { agentId: p.agent_id, agentType: p.agent_type ?? 'subagent' } };
    case 'SubagentStop': {
      const text = String(p.last_assistant_message ?? '').trim();
      return {
        session,
        agentStop: { agentId: p.agent_id },
        events: text ? [{ ...base, id: `report:${p.agent_id}`, kind: 'report', icon: EVENT_ICON.report, text: text.slice(0, 1500) }] : [],
      };
    }
    case 'Stop':
      return { events: [], session, turnEnded: true };
    case 'SessionStart':
      return { events: [{ ...base, id: `session_start:${sessionId}`, kind: 'session_start', icon: EVENT_ICON.session_start }], session };
    case 'SessionEnd':
      return { events: [{ ...base, id: `session_end:${sessionId}`, kind: 'session_end', icon: EVENT_ICON.session_end, text: p.reason }], session };
    case 'PreCompact':
      return { events: [], session };
    case 'Notification':
      return { events: [], session, notification: { type: String(p.notification_type ?? 'unknown'), message: String(p.message ?? '') } };
    default:
      return { events: [] };
  }
}
