import type { PendingKind, PendingRequest } from '@cora/shared';

/**
 * A time Claude waited on you (a permission prompt, a question, an MCP form). They aren't in the event stream, so
 * the dashboard keeps its own log of the requests it saw come and go (since it was opened).
 */
export type Wait = { id: string; sessionId: string; agentId: string; kind: PendingKind; toolName: string; toolUseId?: string; summary: string; from: number; to: number | null };

const MAX_WAITS = 400;

export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** One line for what a request is about: the command, the file, the question. */
export function requestSummary(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const q = Array.isArray(i.questions) ? (i.questions[0] as { question?: unknown } | undefined)?.question : undefined;
  const v = i.command ?? i.file_path ?? i.url ?? q ?? i.description ?? i.message ?? i.prompt;
  return typeof v === 'string' ? clip(v, 120) : '';
}

/** The wait log after the pending list changed: new requests open a wait, ones that went away close theirs. */
export function trackWaits(prev: Wait[], pending: PendingRequest[], now = Date.now()): Wait[] {
  const ids = new Set(pending.map((p) => p.id));
  let changed = false;
  const next = prev.map((w) => {
    if (w.to != null || ids.has(w.id)) return w;
    changed = true;
    return { ...w, to: now };
  });
  const known = new Set(prev.map((w) => w.id));
  for (const p of pending) {
    if (known.has(p.id)) continue;
    changed = true;
    next.push({ id: p.id, sessionId: p.sessionId, agentId: p.agentId, kind: p.kind, toolName: p.toolName, ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}), summary: requestSummary(p.toolInput), from: p.createdAt, to: null });
  }
  return changed ? next.slice(-MAX_WAITS) : prev;
}
