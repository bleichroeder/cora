import { EVENT_ICON, PRESENT_TOOL, iconFor, splitExplains, splitSay, summarizeTool, resultText } from '@cora/shared';
import type { NewEvent } from '@cora/shared';

/** Per-file parsing state (one per transcript file). */
export type ParseCtx = {
  lastTsByAgent: Map<string, number>;
  /** your messages queued while Claude works, oldest first (a dequeue takes the oldest: it doesn't say which) */
  queued: string[];
  seenMsgIds: Set<string>;
  tools: Map<string, { name: string; input: unknown; ts: number; agentId?: string }>;
  childByToolUse: Map<string, string>;
  /** message id of the previous assistant line per agent (blocks of one response share it) */
  lastMsgByAgent: Map<string, string>;
  cwd?: string;
  /** full model id from the "model" attachment, e.g. "claude-opus-5-5[1m]" (assistant lines omit the suffix) */
  modelId?: string;
};

export type LinkMeta = { toolUseId: string; childAgentId: string; prompt?: string; description?: string };

export type ParseMeta = {
  title?: string;
  cwd?: string;
  cliVersion?: string;
  model?: string;
  unknown?: boolean;
  link?: LinkMeta;
  /** a background subagent finished (task-notification); the pipeline marks it done */
  agentDone?: { agentId: string; ts: number };
  /**
   * a slash command typed in the main session, as typed ("/jira ACME-5206"). It isn't a prompt event (the hook's
   * prompt is, when hooks are on), but it's what finds the ticket of a session that only has its transcript.
   */
  command?: { id: string; text: string; ts: number };
};

export type ParseResult = { events: NewEvent[]; meta: ParseMeta };

export const newParseCtx = (): ParseCtx => ({
  lastTsByAgent: new Map(),
  queued: [],
  seenMsgIds: new Set(),
  tools: new Map(),
  childByToolUse: new Map(),
  lastMsgByAgent: new Map(),
});

/** Line types Claude Code writes that carry nothing we visualize. */
const IGNORED = new Set([
  'attachment', 'last-prompt', 'mode', 'permission-mode', 'atis-latch', 'file-history-snapshot',
  'file-history-delta', 'frame-link', 'pr-link', 'relocated', 'worktree-state', 'artifact-autoreact-ledger',
  'cost-state', 'artifact-comment-monitor', 'summary', 'custom-title', 'tag', 'agent-name', 'fork-context-ref',
]);

const SYSTEM_INJECTED = /^\s*<(task-notification|system-reminder|command-|local-command|bash-|user-memory)/;

/** A short, steady id for a message's text (FNV-1a): its queue entry and its delivery share it. */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function tag(s: string, name: string): string | undefined {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m?.[1]?.trim();
}

/** Report body of a "[Subagent hand-back]" message: everything after the fixed preamble, de-indented. */
function handbackBody(raw: string): string {
  const at = raw.indexOf('The report follows:');
  const body = at >= 0 ? raw.slice(at + 'The report follows:'.length) : raw;
  return body.replace(/<\/agent-message>\s*$/, '').replace(/^\n/, '').replace(/^ {2}/gm, '').trim();
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length && content.every((b: any) => b?.type === 'text')) {
    return content.map((b: any) => b.text).join('\n');
  }
  return undefined;
}

export function parseLine(obj: any, ctx: ParseCtx): ParseResult {
  const meta: ParseMeta = {};
  const events: NewEvent[] = [];
  if (!obj || typeof obj !== 'object') return { events, meta: { unknown: true } };

  const type = obj.type as string;
  if (type === 'ai-title') {
    if (obj.aiTitle) meta.title = String(obj.aiTitle);
    return { events, meta };
  }
  if (type === 'attachment') {
    const id = obj.attachment?.type === 'model' ? obj.attachment.identity?.modelId : undefined;
    if (typeof id === 'string' && id) {
      ctx.modelId = id;
      meta.model = id;
    }
    return { events, meta };
  }
  if (IGNORED.has(type)) return { events, meta };
  if (type === 'queue-operation') return parseQueueOp(obj, ctx);
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return { events, meta: { unknown: true } };

  if (obj.cwd) {
    meta.cwd = obj.cwd;
    ctx.cwd = obj.cwd;
  }
  if (obj.version) meta.cliVersion = obj.version;

  const sessionId: string = obj.sessionId ?? obj.session_id;
  const agentId: string = obj.agentId ?? 'main';
  const ts = Date.parse(obj.timestamp);
  if (!sessionId || Number.isNaN(ts)) return { events, meta };
  const prevTs = ctx.lastTsByAgent.get(agentId);
  ctx.lastTsByAgent.set(agentId, ts);
  const prevMsg = ctx.lastMsgByAgent.get(agentId);
  ctx.lastMsgByAgent.set(agentId, type === 'assistant' ? obj.message?.id ?? '' : '');
  const base = { sessionId, agentId, ts, source: 'transcript' as const };

  if (type === 'system') {
    if (obj.subtype === 'compact_boundary') events.push({ ...base, id: obj.uuid, kind: 'compact', icon: EVENT_ICON.compact });
    else if (obj.subtype === 'turn_duration') events.push({ ...base, id: obj.uuid, kind: 'turn_end', icon: EVENT_ICON.turn_end, durationMs: obj.durationMs });
    return { events, meta };
  }

  const msg = obj.message ?? {};

  if (type === 'assistant') {
    // keep the context-window suffix ("[1m]") the attachment carried
    if (msg.model) meta.model = ctx.modelId?.startsWith(msg.model) ? ctx.modelId : msg.model;
    let tokens: NewEvent['tokens'];
    if (msg.id && msg.usage && !ctx.seenMsgIds.has(msg.id)) {
      ctx.seenMsgIds.add(msg.id);
      const u = msg.usage;
      tokens = {
        in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        out: u.output_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
        ...(u.output_tokens_details?.thinking_tokens != null ? { thinking: u.output_tokens_details.thinking_tokens } : {}),
      };
    }
    let explainNo = 0;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        // Only time thinking from the start of the API call; later blocks of the same response have no own start.
        const timed = prevTs != null && (!msg.id || prevMsg !== msg.id);
        events.push({ ...base, id: obj.uuid, kind: 'think', phase: 'end', icon: EVENT_ICON.think, durationMs: timed ? Math.max(0, ts - prevTs!) : undefined, ...(tokens ? { tokens } : {}) });
        tokens = undefined;
      } else if (block?.type === 'text') {
        const inline = splitExplains(String(block.text ?? '').trim());
        const { text, said } = splitSay(inline.text);
        if (text || said) {
          events.push({ ...base, id: obj.uuid, kind: 'say', icon: EVENT_ICON.say, text, ...(said ? { said } : {}), ...(tokens ? { tokens } : {}) });
          tokens = undefined;
        }
        // an explain written in the reply: shown as if presented with the tool (it is, minus the extra request)
        for (const x of inline.explains) {
          const id = `explain-${obj.uuid}-${explainNo++}`;
          const input = { title: x.title, format: x.format, content: x.content };
          const s = summarizeTool(PRESENT_TOOL, input, undefined, undefined, ctx.cwd);
          const tool = { name: PRESENT_TOOL, input, summary: s.summary, resource: s.resource };
          events.push({ ...base, id: `tool:${id}:start`, kind: 'tool', phase: 'start', toolUseId: id, icon: iconFor(PRESENT_TOOL, input), tool, ...(tokens ? { tokens } : {}) });
          events.push({ ...base, id: `tool:${id}:end`, kind: 'tool', phase: 'end', toolUseId: id, icon: iconFor(PRESENT_TOOL, input), durationMs: 0, tool: { ...tool, resultSummary: 'shown in Cora' } });
          tokens = undefined;
        }
      } else if (block?.type === 'tool_use') {
        const name = String(block.name);
        ctx.tools.set(block.id, { name, input: block.input, ts, agentId });
        const s = summarizeTool(name, block.input, undefined, undefined, ctx.cwd);
        events.push({
          ...base, id: `tool:${block.id}:start`, kind: 'tool', phase: 'start', toolUseId: block.id,
          icon: iconFor(name, block.input), tool: { name, input: block.input, summary: s.summary, resource: s.resource },
          ...(tokens ? { tokens } : {}),
        });
        tokens = undefined;
        if (name === 'Agent' || name === 'Task') {
          events.push({ ...base, id: `spawn:${block.id}`, kind: 'spawn', toolUseId: block.id, icon: EVENT_ICON.spawn, text: s.summary });
        }
      }
    }
    return { events, meta };
  }

  // type === 'user'
  const content = msg.content;
  const text = userText(content);
  if (obj.origin?.kind === 'peer' && obj.origin.handback && obj.origin.from) {
    // Async subagent hand-back: the report body is in origin.body after a fixed preamble.
    const body = handbackBody(String(obj.origin.body ?? ''));
    const toolUseId = [...ctx.childByToolUse].find(([, child]) => child === obj.origin.from)?.[0];
    events.push({ ...base, agentId: obj.origin.from, id: `report:${obj.origin.from}`, kind: 'report', toolUseId, icon: EVENT_ICON.report, text: body.slice(0, 1500) });
    return { events, meta };
  }
  if (text !== undefined) {
    if (obj.isMeta) return { events, meta };
    if (text.startsWith('<task-notification>')) {
      const toolUseId = tag(text, 'tool-use-id');
      const child = toolUseId ? ctx.childByToolUse.get(toolUseId) : undefined;
      if (toolUseId && child) {
        const body = tag(text, 'result') ?? tag(text, 'summary') ?? '';
        events.push({ ...base, agentId: child, id: `report:${child}`, kind: 'report', toolUseId, icon: EVENT_ICON.report, text: body.slice(0, 1500) });
      } else {
        const t = taskEnded(text, ctx, sessionId, ts);
        if (t) events.push(t);
      }
      return { events, meta };
    }
    // a command the user ran themselves (`!` in Claude Code): shown as a shell call, then its output when it comes
    if (text.startsWith('<bash-input>') && agentId === 'main') {
      const id = `bang:${obj.uuid}`;
      const input = { command: tag(text, 'bash-input') ?? '', description: 'You ran it (! in the terminal)' };
      ctx.tools.set(id, { name: 'Bash', input, ts, agentId });
      const s = summarizeTool('Bash', input, undefined, undefined, ctx.cwd);
      events.push({ ...base, id: `tool:${id}:start`, kind: 'tool', phase: 'start', toolUseId: id, icon: iconFor('Bash', input), tool: { name: 'Bash', input, summary: s.summary, resource: s.resource } });
      return { events, meta };
    }
    const bang = /^<bash-(stdout|stderr)>/.test(text) && obj.parentUuid ? `bang:${obj.parentUuid}` : undefined;
    const ran = bang ? ctx.tools.get(bang) : undefined;
    if (bang && ran) {
      const out = [tag(text, 'bash-stdout'), tag(text, 'bash-stderr')].filter(Boolean).join('\n');
      const s = summarizeTool('Bash', ran.input, out, undefined, ctx.cwd, false);
      events.push({
        ...base, id: `tool:${bang}:end`, kind: 'tool', phase: 'end', toolUseId: bang, icon: iconFor('Bash', ran.input), durationMs: Math.max(0, ts - ran.ts),
        tool: { name: 'Bash', input: ran.input, summary: s.summary, resultSummary: s.resultSummary, preview: s.preview, resource: s.resource },
      });
      return { events, meta };
    }
    if (SYSTEM_INJECTED.test(text)) {
      const name = text.startsWith('<command-') && agentId === 'main' && obj.origin?.kind === 'human' ? tag(text, 'command-name') : undefined;
      if (name?.startsWith('/')) meta.command = { id: obj.promptId ? `prompt:${obj.promptId}` : obj.uuid, text: `${name} ${tag(text, 'command-args') ?? ''}`.trim(), ts };
      return { events, meta };
    }
    // Ctrl+C / Esc while Claude works: Claude Code records a synthetic user line. It's a marker, not a prompt.
    if (/^\[Request interrupted by user/.test(text.trim())) {
      events.push({ ...base, id: obj.uuid, kind: 'interrupt', icon: EVENT_ICON.interrupt, text: text.trim() });
      return { events, meta };
    }
    const human = obj.origin?.kind === 'human' || obj.promptSource === 'typed';
    const subTask = obj.agentId != null && obj.origin?.kind !== 'task-notification';
    if (human || subTask || (obj.origin == null && obj.promptSource == null)) {
      const id = agentId === 'main' && obj.promptId ? `prompt:${obj.promptId}` : obj.uuid;
      events.push({ ...base, id, kind: 'prompt', icon: EVENT_ICON.prompt, text });
    }
    return { events, meta };
  }

  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type !== 'tool_result') continue;
    const id = block.tool_use_id as string;
    const started = ctx.tools.get(id);
    const name = started?.name ?? 'unknown';
    const tur = obj.toolUseResult;
    const s = summarizeTool(name, started?.input, block.content, typeof tur === 'object' ? tur : undefined, ctx.cwd, Boolean(block.is_error));
    events.push({
      ...base, id: `tool:${id}:end`, kind: 'tool', phase: 'end', toolUseId: id,
      icon: s.failed ? EVENT_ICON.fail : iconFor(name, started?.input),
      durationMs: started ? Math.max(0, ts - started.ts) : undefined,
      tool: { name, input: started?.input, summary: s.summary, resultSummary: s.resultSummary, preview: s.preview, resource: s.resource, ...(s.failed ? { failed: true } : {}), ...(s.change ? { change: s.change } : {}), ...(s.background ? { background: s.background } : {}) },
    });
    if ((name === 'Agent' || name === 'Task') && tur && typeof tur === 'object' && tur.agentId) {
      ctx.childByToolUse.set(id, tur.agentId);
      meta.link = { toolUseId: id, childAgentId: tur.agentId, prompt: tur.prompt, description: tur.description };
      if (!tur.isAsync && tur.status !== 'async_launched') {
        const body = resultText(block.content);
        if (body) events.push({ ...base, agentId: tur.agentId, id: `report:${tur.agentId}`, kind: 'report', toolUseId: id, icon: EVENT_ICON.report, text: body.slice(0, 1500) });
      }
    }
  }
  return { events, meta };
}

/**
 * Messages that arrive while the agent is mid-turn are recorded as queue operations. Two matter here:
 * a subagent hand-back (its final report) and the task-notification saying a background subagent finished.
 */
function parseQueueOp(obj: any, ctx: ParseCtx): ParseResult {
  const meta: ParseMeta = {};
  const events: NewEvent[] = [];
  const content = obj.content;
  const sessionId: string = obj.sessionId ?? obj.session_id;
  const ts = Date.parse(obj.timestamp);
  if (!sessionId || Number.isNaN(ts)) return { events, meta };
  // the next turn took the oldest queued message (its own prompt shows it): no longer waiting
  if (obj.operation === 'dequeue') {
    const id = ctx.queued.shift();
    if (id) events.push({ sessionId, agentId: 'main', source: 'transcript', kind: 'prompt', icon: EVENT_ICON.prompt, id, ts, queue: 'delivered' });
    return { events, meta };
  }
  if (typeof content !== 'string') return { events, meta };
  // a message you sent while Claude was working: queued until Claude takes it ("remove"), or you take it back into the
  // input ("popAll"); taken mid-turn, it shows there, where Claude got it (Claude Code gives it the turn's prompt id:
  // it isn't a turn of its own)
  if (!content.startsWith('<') && !SYSTEM_INJECTED.test(content) && ['enqueue', 'remove', 'popAll'].includes(obj.operation)) {
    const id = `queued:${hashText(content)}`;
    const base = { sessionId, agentId: 'main', source: 'transcript' as const, kind: 'prompt' as const, icon: EVENT_ICON.prompt, text: content };
    if (obj.operation === 'enqueue') {
      events.push({ ...base, id, ts, queue: 'waiting' });
      ctx.queued.push(id);
      return { events, meta };
    }
    ctx.queued = ctx.queued.filter((q) => q !== id);
    events.push({ ...base, id, ts, queue: 'delivered' });
    if (obj.operation === 'remove' && obj.reason === 'absorbed_mid_turn') events.push({ ...base, id: `prompt:mid:${hashText(content)}:${ts}`, ts, midTurn: true });
    return { events, meta };
  }
  if (obj.operation !== 'enqueue') return { events, meta };
  const from = content.match(/^<agent-message from="([^"]+)">/)?.[1];
  if (from && content.includes('[Subagent hand-back]')) {
    const toolUseId = [...ctx.childByToolUse].find(([, child]) => child === from)?.[0];
    events.push({ sessionId, agentId: from, ts, source: 'transcript', id: `report:${from}`, kind: 'report', toolUseId, icon: EVENT_ICON.report, text: handbackBody(content).slice(0, 1500) });
  } else if (content.startsWith('<task-notification>')) {
    const status = tag(content, 'status') ?? '';
    const toolUseId = tag(content, 'tool-use-id');
    const started = toolUseId ? ctx.tools.get(toolUseId) : undefined;
    if (started && /^(Bash|PowerShell)$/.test(started.name) && !ctx.childByToolUse.has(toolUseId!)) {
      // a background shell command finished
      const t = taskEnded(content, ctx, sessionId, ts);
      if (t) events.push(t);
    } else {
      // a background subagent finished
      const child = (toolUseId && ctx.childByToolUse.get(toolUseId)) || tag(content, 'task-id');
      if (child && /completed|failed|killed|stopped/.test(status)) meta.agentDone = { agentId: child, ts };
    }
  }
  return { events, meta };
}

/**
 * A background command finished: Claude Code's task-notification names the task, the Bash call that started it, how
 * it ended and (in the summary) the exit code. It arrives twice (queued, then delivered); one id keeps one event.
 */
function taskEnded(content: string, ctx: ParseCtx, sessionId: string, ts: number): NewEvent | null {
  const id = tag(content, 'task-id');
  const status = tag(content, 'status');
  if (!id || !status) return null;
  const toolUseId = tag(content, 'tool-use-id');
  if (toolUseId && ctx.childByToolUse.has(toolUseId)) return null; // a background subagent: it reports as itself
  const summary = tag(content, 'summary') ?? '';
  const exit = summary.match(/exit code (-?\d+)/)?.[1];
  const outputFile = tag(content, 'output-file');
  const started = toolUseId ? ctx.tools.get(toolUseId) : undefined;
  if (started && !/^(Bash|PowerShell)$/.test(started.name)) return null;
  return {
    sessionId, agentId: started?.agentId ?? 'main', ts, source: 'transcript', id: `task:${id}`, kind: 'task', toolUseId, icon: EVENT_ICON.task, text: summary.slice(0, 300),
    task: { id, status, ...(exit != null ? { exit: Number(exit) } : {}), ...(outputFile ? { outputFile } : {}) },
  };
}
