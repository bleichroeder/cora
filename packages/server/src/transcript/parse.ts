import { EVENT_ICON, PRESENT_TOOL, iconFor, recapText, splitExplains, splitSay, summarizeTool, resultText } from '@cora/shared';
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
  /** a `/` command Claude Code answers itself, waiting for its output line (the line before it names it) */
  command?: string;
  /** merge requests already said (Claude Code writes its link again and again: each is a notice once) */
  links?: Set<string>;
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
  /** Claude Code's recap of the session (`away_summary`): where it stands, what's next */
  recap?: { id: string; text: string; at: number };
  /** Claude Code's permission mode ('default', 'plan', 'auto'…), as it wrote it */
  permissionMode?: string;
  /** a limit stopped it (what it said, when); null: it's replying again */
  limit?: { text: string; at: number } | null;
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
  'attachment', 'last-prompt', 'mode', 'atis-latch', 'file-history-snapshot',
  'file-history-delta', 'frame-link', 'relocated', 'worktree-state', 'artifact-autoreact-ledger',
  'cost-state', 'artifact-comment-monitor', 'summary', 'custom-title', 'tag', 'agent-name', 'fork-context-ref',
  // Claude Code's own bookkeeping of its API calls and the tools it offered
  'api-request', 'api-request-blob', 'api-request-shape', 'tools-used', 'agent-setting',
]);
/** Line types met that Cora doesn't know yet: each said once in the log (so it's easy to add above). */
const NEW_TYPES = new Set<string>();

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

/** Claude Code escapes a command's output in its <bash-stdout> and <bash-stderr> (`&amp;` for `&`): as it was printed. */
export function unescapeOutput(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * The output of a command you ran yourself (`!`), from Claude Code's line after it: stdout and stderr as printed
 * ("(Bash completed with no output)" is none), and, when it ran past Claude Code's time limit, the background task it
 * became. `refused`: Claude Code didn't run it (only its "Command failed: …" came back).
 */
export function bangOutput(text: string): { out: string; refused: boolean; background?: { taskId: string; outputFile?: string } } {
  const stdout = unescapeOutput(tag(text, 'bash-stdout') ?? '').replace(/^\(Bash completed with no output\)$/, '');
  const stderr = unescapeOutput(tag(text, 'bash-stderr') ?? '');
  const out = [stdout, stderr].filter(Boolean).join('\n');
  const bg = stdout.match(/moved to the background \(ID: (\w+)\)/)?.[1];
  const file = stdout.match(/Output is being written to: (.+?\.output)/)?.[1];
  return { out, refused: !text.includes('<bash-stdout>') && /^Command failed/.test(stderr), ...(bg ? { background: { taskId: bg, ...(file ? { outputFile: file } : {}) } } : {}) };
}

/** Report body of a "[Subagent hand-back]" message: everything after the fixed preamble, de-indented. */
function handbackBody(raw: string): string {
  const at = raw.indexOf('The report follows:');
  const body = at >= 0 ? raw.slice(at + 'The report follows:'.length) : raw;
  return body.replace(/<\/agent-message>\s*$/, '').replace(/^\n/, '').replace(/^ {2}/gm, '').trim();
}

/**
 * The model a /model line chose, as its id: Claude Code writes "Set model to `Sonnet 5.5` and saved as your default…"
 * (2.1.316) the moment you choose. Its marketing name becomes the id the replies will carry (claude-sonnet-5-5; with
 * "1M" in it, the [1m] context window). A name it can't read (Default, an alias): null, and the next reply says.
 */
export function modelFromSetLine(text: string): string | null {
  const m = /^\s*<local-command-stdout>\s*Set model to `?([^`\n<]+?)`?(?:\s+and saved\b[^<]*)?\s*(?:<\/local-command-stdout>|$)/i.exec(text);
  const name = m?.[1].trim();
  const id = name && /^(opus|sonnet|haiku|fable)\s+(\d+)(?:\.(\d+))?\b/i.exec(name);
  if (!id) return null;
  return `claude-${id[1].toLowerCase()}-${id[2]}${id[3] ? `-${id[3]}` : ''}${/\b1M\b/i.test(name) ? '[1m]' : ''}`;
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length && content.every((b: any) => b?.type === 'text')) {
    return content.map((b: any) => b.text).join('\n');
  }
  return undefined;
}

/** A notice from a line that carries no message (an attachment, a merge request link): its session and time, or nothing. */
function noticeEvent(obj: any, ctx: ParseCtx, notice: NonNullable<NewEvent['notice']>): NewEvent | null {
  const sessionId: string = obj.sessionId ?? obj.session_id;
  const ts = Date.parse(obj.timestamp);
  if (!sessionId || Number.isNaN(ts)) return null;
  const agentId: string = obj.agentId ?? 'main';
  void ctx;
  return { sessionId, agentId, ts, source: 'transcript', id: String(obj.uuid ?? `notice:${notice.type}:${sessionId}:${ts}`), kind: 'notice', icon: EVENT_ICON.notice, notice };
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
  if (type === 'permission-mode') {
    if (typeof obj.permissionMode === 'string' && obj.permissionMode) meta.permissionMode = obj.permissionMode;
    return { events, meta };
  }
  if (type === 'attachment') {
    const at = obj.attachment ?? {};
    const id = at.type === 'model' ? at.identity?.modelId : undefined;
    if (typeof id === 'string' && id) {
      ctx.modelId = id;
      meta.model = id;
    }
    // what the terminal said that the conversation doesn't: Cora's hook couldn't get through, plan mode left
    if (at.type === 'hook_non_blocking_error' && /127\.0\.0\.1|ECONNREFUSED/.test(String(at.stderr ?? ''))) {
      const n = noticeEvent(obj, ctx, { type: 'missed', text: `Claude Code couldn't reach Cora (${at.hookEvent ?? 'a hook'}): some of this turn may be missing here` });
      if (n) events.push(n);
    } else if (at.type === 'plan_mode_exit') {
      const n = noticeEvent(obj, ctx, { type: 'mode', text: 'Left plan mode: Claude can change files now' });
      if (n) events.push(n);
    }
    return { events, meta };
  }
  if (type === 'pr-link' && obj.prUrl) {
    const url = String(obj.prUrl);
    const said = (ctx.links ??= new Set());
    if (said.has(url)) return { events, meta };
    said.add(url);
    const n = noticeEvent(obj, ctx, { type: 'link', text: `Merge request !${obj.prNumber}${obj.prRepository ? ` · ${obj.prRepository}` : ''}`, url });
    if (n) events.push({ ...n, id: `notice:link:${n.sessionId}:${url}` });
    return { events, meta };
  }
  if (IGNORED.has(type)) return { events, meta };
  if (type === 'queue-operation') return parseQueueOp(obj, ctx);
  if (type !== 'user' && type !== 'assistant' && type !== 'system') {
    const name = String(type).slice(0, 60);
    if (!NEW_TYPES.has(name) && NEW_TYPES.size < 100) {
      NEW_TYPES.add(name);
      console.log(`  transcript: a line type Cora doesn't know yet: "${name}"${obj.message ? ' (it carries a message: counted as not recognised)' : ' (bookkeeping: not counted)'}`);
    }
    // only one that carries a message may be something Cora should show: bookkeeping isn't a format change
    return { events, meta: obj.message ? { unknown: true } : {} };
  }
  // a message whose shape isn't understood (no content Cora can read): that is (whatever else it says is still read)
  if ((type === 'user' || type === 'assistant') && typeof obj.message?.content !== 'string' && !Array.isArray(obj.message?.content)) meta.unknown = true;

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
    else if (obj.subtype === 'local_command' && typeof obj.content === 'string') {
      // a `/` command Claude Code answers itself (/mcp, /context…): one line names it, the next is what it said
      const name = tag(obj.content, 'command-name');
      const out = /<local-command-std(?:out|err)>([\s\S]*?)(?:<\/local-command-std(?:out|err)>|$)/.exec(obj.content);
      if (name) ctx.command = `${name.startsWith('/') ? name : `/${name}`} ${tag(obj.content, 'command-args') ?? ''}`.trim();
      else if (out) {
        const run = obj.commandRun?.command ? `/${obj.commandRun.command} ${obj.commandRun.args ?? ''}`.trim() : ctx.command;
        const said = out[1].replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
        if (run) events.push({ ...base, id: obj.uuid, kind: 'command', icon: EVENT_ICON.command, command: run, ...(said ? { text: said.slice(0, 4000) } : {}) });
        ctx.command = undefined;
      }
    } else if (obj.subtype === 'away_summary' && typeof obj.content === 'string' && recapText(obj.content)) meta.recap = { id: String(obj.uuid ?? `${sessionId}:${ts}`), text: recapText(obj.content), at: ts };
    else if (obj.subtype === 'scheduled_task_fire' && typeof obj.content === 'string') {
      const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
      events.push({ ...base, id: obj.uuid, kind: 'notice', icon: EVENT_ICON.notice, notice: { type: 'wakeup', text: `${obj.content}${prompt ? `: ${prompt.slice(0, 200)}` : ''}` } });
    } else if (obj.subtype === 'informational' && typeof obj.content === 'string' && obj.content.trim())
      events.push({ ...base, id: obj.uuid, kind: 'notice', icon: EVENT_ICON.notice, notice: { type: 'info', text: obj.content.trim().slice(0, 400) } });
    return { events, meta };
  }

  const msg = obj.message ?? {};

  if (type === 'assistant') {
    // keep the context-window suffix ("[1m]") the attachment carried; a synthetic line (an interrupted or failed turn,
    // "<synthetic>") names no model
    if (msg.model && !String(msg.model).startsWith('<')) meta.model = ctx.modelId?.startsWith(msg.model) ? ctx.modelId : msg.model;
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
    // an API error or a limit Claude Code wrote as if Claude said it: a notice; a limit stops the session
    if (obj.isApiErrorMessage) {
      const said = (Array.isArray(msg.content) ? msg.content : []).map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join(' ').trim();
      if (said) {
        const limit = /\blimit\b/i.test(said) && /spend|usage|weekly|reset/i.test(said);
        events.push({ ...base, id: obj.uuid, kind: 'notice', icon: EVENT_ICON.notice, notice: { type: limit ? 'limit' : 'error', text: said.slice(0, 600) } });
        if (limit && agentId === 'main') meta.limit = { text: said.slice(0, 600), at: ts };
      }
      return { events, meta };
    }
    if (agentId === 'main' && (Array.isArray(msg.content) ? msg.content : []).some((b: any) => b?.type === 'text' || b?.type === 'tool_use')) meta.limit = null;
    let explainNo = 0;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        // Only time thinking from the start of the API call; later blocks of the same response have no own start.
        const timed = prevTs != null && (!msg.id || prevMsg !== msg.id);
        // its text, when there is some: newer models write short notes on their progress there, which the terminal shows
        const note = block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking.trim() : '';
        events.push({ ...base, id: obj.uuid, kind: 'think', phase: 'end', icon: EVENT_ICON.think, durationMs: timed ? Math.max(0, ts - prevTs!) : undefined, ...(note ? { text: note } : {}), ...(tokens ? { tokens } : {}) });
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
    // a command you ran yourself (`!` in Claude Code): a shell call of yours (`byYou`), then its output. Claude Code
    // writes both lines once it has finished, the first with the time it started.
    if (text.startsWith('<bash-input>') && agentId === 'main') {
      const id = `bang:${obj.uuid}`;
      const input = { command: tag(text, 'bash-input') ?? '' };
      ctx.tools.set(id, { name: 'Bash', input, ts, agentId });
      const s = summarizeTool('Bash', input, undefined, undefined, ctx.cwd);
      events.push({ ...base, id: `tool:${id}:start`, kind: 'tool', phase: 'start', toolUseId: id, icon: iconFor('Bash', input), tool: { name: 'Bash', input, summary: s.summary, resource: s.resource, byYou: true } });
      // typed while Claude worked, it was queued; Claude Code runs it with no line saying it left the queue: it has now
      const q = [input.command, input.command.trim()].map((c) => queuedId(ctx, c)).find((x) => x);
      if (q) {
        ctx.queued = ctx.queued.filter((x) => x !== q);
        events.push({ ...base, id: q, kind: 'prompt', icon: EVENT_ICON.prompt, text: input.command.trim(), queue: 'delivered' });
      }
      return { events, meta };
    }
    const bang = /^<bash-(stdout|stderr)>/.test(text) && obj.parentUuid ? `bang:${obj.parentUuid}` : undefined;
    const ran = bang ? ctx.tools.get(bang) : undefined;
    if (bang && ran) {
      const o = bangOutput(text);
      const s = summarizeTool('Bash', ran.input, o.out, undefined, ctx.cwd, o.refused);
      // past Claude Code's time limit it goes on in the background (its task-notification ends it, as for Claude's)
      const resultSummary = o.background ? 'running in background' : o.out || o.refused ? s.resultSummary : 'no output';
      events.push({
        ...base, id: `tool:${bang}:end`, kind: 'tool', phase: 'end', toolUseId: bang, icon: o.refused ? EVENT_ICON.fail : iconFor('Bash', ran.input), durationMs: Math.max(0, ts - ran.ts),
        tool: { name: 'Bash', input: ran.input, summary: s.summary, resultSummary, preview: s.preview, resource: s.resource, byYou: true, ...(o.refused ? { failed: true } : {}), ...(o.background ? { background: o.background } : {}) },
      });
      return { events, meta };
    }
    if (SYSTEM_INJECTED.test(text)) {
      // you chose another model (/model): it's the session's now, not only once its next reply says
      const chosen = agentId === 'main' ? modelFromSetLine(text) : null;
      if (chosen) {
        ctx.modelId = chosen;
        meta.model = chosen;
      }
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
    // answered: what's kept of the call is what comes later needs (its name, time and agent: a background command's
    // end); its input (a whole file written, a long command) isn't held for the rest of the transcript
    if (started) ctx.tools.set(id, { name: started.name, input: undefined, ts: started.ts, agentId: started.agentId });
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
/** The oldest message still queued with these words (its id), if there is one. */
const queuedId = (ctx: ParseCtx, content: string): string | undefined => {
  const h = `queued:${hashText(content)}`;
  return ctx.queued.find((q) => q === h || q.startsWith(`${h}:`));
};

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
  // input ("popAll"); taken mid-turn, it shows there, where Claude got it (it isn't a turn of its own: the prompt its
  // hook brought is put by: pipeline.ts)
  if (!content.startsWith('<') && !SYSTEM_INJECTED.test(content) && ['enqueue', 'remove', 'popAll'].includes(obj.operation)) {
    const base = { sessionId, agentId: 'main', source: 'transcript' as const, kind: 'prompt' as const, icon: EVENT_ICON.prompt, text: content };
    if (obj.operation === 'enqueue') {
      // its own id each time it's queued: the same words sent again ("yes", "continue") are another message, not the
      // earlier one come back (merged into it, it kept the old time and never showed as waiting)
      const id = `queued:${hashText(content)}:${ts}`;
      events.push({ ...base, id, ts, queue: 'waiting' });
      ctx.queued.push(id);
      return { events, meta };
    }
    // (one queued before this change, or before Cora knew of it: the id it had then)
    const id = queuedId(ctx, content) ?? `queued:${hashText(content)}`;
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
  const summary = unescapeOutput(tag(content, 'summary') ?? '');
  const exit = summary.match(/exit code (-?\d+)/)?.[1];
  const outputFile = tag(content, 'output-file');
  const started = toolUseId ? ctx.tools.get(toolUseId) : undefined;
  if (started && !/^(Bash|PowerShell)$/.test(started.name)) return null;
  return {
    sessionId, agentId: started?.agentId ?? 'main', ts, source: 'transcript', id: `task:${id}`, kind: 'task', toolUseId, icon: EVENT_ICON.task, text: summary.slice(0, 300),
    task: { id, status, ...(exit != null ? { exit: Number(exit) } : {}), ...(outputFile ? { outputFile } : {}) },
  };
}
