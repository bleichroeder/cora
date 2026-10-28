import { randomUUID } from 'node:crypto';
import type { PendingDecision, PendingKind, PendingRequest } from '@cora/shared';
import type { Audit } from './audit';

type Held = { req: PendingRequest; resolve: (out: object) => void; timer: NodeJS.Timeout };

export type PendingOptions = {
  holdMs: number;
  hasClients: () => boolean;
  onChange: (list: PendingRequest[]) => void;
  audit: Audit;
  askAnswering: boolean;
};

const NO_DECISION = {};

/** Holds blocking hook requests (PermissionRequest / Elicitation) until the dashboard answers. */
export class PendingManager {
  private held = new Map<string, Held>();

  constructor(private o: PendingOptions) {}

  list(): PendingRequest[] {
    return [...this.held.values()].map((h) => h.req).sort((a, b) => a.createdAt - b.createdAt);
  }

  countFor(sessionId: string): number {
    return this.list().filter((r) => r.sessionId === sessionId).length;
  }

  /** Resolves with the JSON body to return to Claude Code. `{}` means "no decision". */
  request(hook: 'permission' | 'elicitation', p: any): Promise<object> {
    if (!this.o.hasClients()) return Promise.resolve(NO_DECISION);
    // not from a session (a malformed hook call): nothing to hold it for
    if (!p?.session_id) return Promise.resolve(NO_DECISION);
    const now = Date.now();
    const kind: PendingKind = hook === 'elicitation' ? 'elicitation' : p.tool_name === 'AskUserQuestion' ? 'question' : 'permission';
    const req: PendingRequest = {
      id: randomUUID(),
      kind,
      sessionId: p.session_id,
      agentId: p.agent_id ?? 'main',
      toolName: hook === 'elicitation' ? `mcp:${p.mcp_server_name ?? p.server_name ?? 'server'}` : p.tool_name,
      toolInput: hook === 'elicitation' ? p.requested_schema ?? p.schema ?? null : p.tool_input,
      ...(p.tool_use_id ? { toolUseId: p.tool_use_id } : {}),
      createdAt: now,
      expiresAt: now + this.o.holdMs,
      ...(hook === 'elicitation'
        ? { elicitation: { server: String(p.mcp_server_name ?? p.server_name ?? 'server'), message: String(p.message ?? ''), schema: p.requested_schema ?? p.schema ?? null } }
        : {}),
      ...(kind === 'question' ? { canAnswer: this.o.askAnswering } : {}),
      ...(p.yours ? { yours: true } : {}),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(req.id, NO_DECISION, 'timeout', 'timeout'), this.o.holdMs);
      this.held.set(req.id, { req, resolve, timer });
      this.o.onChange(this.list());
    });
  }

  /**
   * Ask you something a session's tool needs (a secret's first use), shown as a permission prompt with Allow / Deny;
   * only you can answer it. True when you allowed it (no dashboard open, or no answer in time: false).
   */
  /** Something done on your say-so (a command run with a secret), in the audit log beside the decisions. */
  note(e: import('./audit').AuditEntry): void {
    this.o.audit.log(e);
  }

  async ask(o: { sessionId: string; toolName: string; toolInput: unknown }): Promise<boolean> {
    const out = (await this.request('permission', { session_id: o.sessionId, tool_name: o.toolName, tool_input: o.toolInput, yours: true })) as { hookSpecificOutput?: { decision?: { behavior?: string } } };
    return out.hookSpecificOutput?.decision?.behavior === 'allow';
  }

  /**
   * Hold a request longer (it went to your phone while you're away): until `ms` from now, at most as long as Claude
   * Code waits for the hook. False when it's no longer held.
   */
  extend(id: string, ms: number): boolean {
    const h = this.held.get(id);
    if (!h) return false;
    clearTimeout(h.timer);
    h.req.expiresAt = Date.now() + ms;
    h.timer = setTimeout(() => this.finish(id, NO_DECISION, 'timeout', 'timeout'), ms);
    this.o.onChange(this.list());
    return true;
  }

  /** `by`: the orchestrator decided (under its mandate), and by which rule. */
  resolve(id: string, d: PendingDecision, by?: { via: 'orchestrator'; rule: string }): { ok: boolean; error?: string } {
    const h = this.held.get(id);
    if (!h) return { ok: false, error: 'not found (already answered or expired)' };
    const { req } = h;
    if (req.kind === 'elicitation') {
      if (!['accept', 'decline', 'cancel'].includes(d.decision)) return { ok: false, error: 'elicitation needs accept|decline|cancel' };
      const out = { hookSpecificOutput: { hookEventName: 'Elicitation', action: d.decision, ...(d.decision === 'accept' && d.content ? { content: d.content } : {}) } };
      this.finish(id, out, d.decision, 'dashboard', false);
      return { ok: true };
    }
    if (req.yours && by?.via === 'orchestrator') return { ok: false, error: 'only the user can answer this' };
    if (d.decision !== 'allow' && d.decision !== 'deny') return { ok: false, error: 'permission needs allow|deny' };
    if (req.kind === 'question' && d.answers && !req.canAnswer) return { ok: false, error: 'answering questions from the dashboard is disabled' };
    let decision: Record<string, unknown>;
    let edited = false;
    if (d.decision === 'deny') decision = { behavior: 'deny', ...(d.message ? { message: d.message } : {}) };
    else if (req.kind === 'question' && d.answers) {
      decision = { behavior: 'allow', updatedInput: { ...(req.toolInput as object), answers: d.answers } };
    } else {
      edited = d.updatedInput !== undefined && JSON.stringify(d.updatedInput) !== JSON.stringify(req.toolInput);
      decision = { behavior: 'allow', ...(edited ? { updatedInput: d.updatedInput } : {}) };
    }
    this.finish(id, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }, d.decision, by?.via ?? 'dashboard', edited, by?.rule);
    return { ok: true };
  }

  /** The tool ran or failed, so the terminal prompt was answered: release any held request for it. */
  cancelForToolUse(toolUseId: string): void {
    for (const h of this.held.values()) if (h.req.toolUseId === toolUseId) this.finish(h.req.id, NO_DECISION, 'answered-in-terminal', 'terminal');
  }

  /**
   * A tool finished without its id matching a held request (Claude Code's permission hooks may not carry the
   * tool-use id): release the request for that tool in that session and agent. Questions match by tool alone (your
   * answers change their input); permissions also need the same input, so a parallel call of the same tool doesn't
   * release another's prompt.
   */
  cancelForTool(sessionId: string, agentId: string, toolName: string, toolInput: unknown): void {
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    for (const h of this.held.values()) {
      const r = h.req;
      if (r.sessionId !== sessionId || r.agentId !== agentId || r.toolName !== toolName) continue;
      if (r.kind === 'question' || same(r.toolInput, toolInput)) this.finish(r.id, NO_DECISION, 'answered-in-terminal', 'terminal');
    }
  }

  /** The dashboard closed it: no decision from here, so the terminal's own prompt (already showing) decides. */
  release(id: string): { ok: boolean; error?: string } {
    if (!this.held.has(id)) return { ok: false, error: 'not found (already answered or expired)' };
    this.finish(id, NO_DECISION, 'released', 'terminal');
    return { ok: true };
  }

  cancelSession(sessionId: string): void {
    for (const h of this.held.values()) if (h.req.sessionId === sessionId) this.finish(h.req.id, NO_DECISION, 'answered-in-terminal', 'terminal');
  }

  private finish(id: string, out: object, decision: string, via: 'dashboard' | 'timeout' | 'terminal' | 'orchestrator', edited = false, rule?: string): void {
    const h = this.held.get(id);
    if (!h) return;
    clearTimeout(h.timer);
    this.held.delete(id);
    this.o.audit.log({ ts: Date.now(), sessionId: h.req.sessionId, agentId: h.req.agentId, kind: h.req.kind, tool: h.req.toolName, input: h.req.toolInput, decision, edited, via, ...(rule ? { rule } : {}) });
    h.resolve(out);
    this.o.onChange(this.list());
  }
}
