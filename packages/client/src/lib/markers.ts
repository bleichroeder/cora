import { isPresentTool, shortToolName, type BrainEvent, type PendingKind } from '@cora/shared';
import { changeOf } from './changes';
import { backgroundTasks, outcome } from './background';
import { clip, requestSummary, type Wait } from './waits';
import { fileOf } from '../scene/derive';

export type MarkerKind = 'needs' | 'fail' | 'prompt' | 'explain' | 'edit' | 'task' | 'compact' | 'ci';

/** Something worth finding again on the timeline. */
export type Marker = {
  key: string;
  kind: MarkerKind;
  ts: number;
  agentId: string;
  title: string;
  detail?: string;
  /** lucide icon */
  icon: string;
  /** a wait's end (null: still waiting) */
  to?: number | null;
  /** the event to scroll the transcript to (a step's narration/prompt, or an item in it) */
  eventId?: string;
  toolUseId?: string;
  /** a file edit: the file, for its diff */
  path?: string;
  /** an explain: its call, for the viewer */
  explain?: BrainEvent;
  /** ended badly (a background command or a pipeline that failed) */
  bad?: boolean;
};

/** Which marker speaks for a cluster: the one most likely to matter. */
export const MARKER_RANK: Record<MarkerKind, number> = { needs: 0, fail: 1, prompt: 2, explain: 3, edit: 4, task: 5, ci: 5, compact: 6 };

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const REQUEST_TITLE: Record<PendingKind, string> = { permission: 'asked permission', question: 'asked you a question', elicitation: 'asked for input' };

/** The markers in a session's events (and the waits the dashboard saw), oldest first. */
export function markersFrom(events: BrainEvent[], waits: Wait[] = [], now = Date.now()): Marker[] {
  const out: Marker[] = [];
  const waited = new Set(waits.map((w) => w.toolUseId).filter(Boolean));
  for (const w of waits) {
    out.push({
      key: `wait:${w.id}`, kind: 'needs', ts: w.from, to: w.to, agentId: w.agentId, icon: w.kind === 'question' ? 'MessageCircleQuestion' : 'ShieldAlert',
      title: `${shortToolName(w.toolName)}: ${REQUEST_TITLE[w.kind]}`, detail: [w.summary, w.to == null ? 'still waiting' : `waited ${dur(w.to - w.from)}`].filter(Boolean).join(' · '),
      ...(w.toolUseId ? { toolUseId: w.toolUseId } : {}),
    });
  }
  const explained = new Set<string>();
  for (const e of events) {
    const name = e.tool?.name ?? '';
    if (e.kind === 'prompt' && e.agentId === 'main') {
      out.push({ key: `prompt:${e.id}`, kind: 'prompt', ts: e.ts, agentId: e.agentId, icon: 'User', title: 'Your prompt', detail: clip(e.text ?? '', 160), eventId: e.id });
    } else if (e.kind === 'compact') {
      out.push({ key: `compact:${e.id}`, kind: 'compact', ts: e.ts, agentId: e.agentId, icon: 'Archive', title: 'Context compacted', eventId: e.id });
    } else if (e.kind === 'permission' || e.kind === 'question' || e.kind === 'elicitation') {
      // not sent today, but the stream has room for them
      if (e.toolUseId && waited.has(e.toolUseId)) continue;
      out.push({ key: `ask:${e.id}`, kind: 'needs', ts: e.ts, agentId: e.agentId, icon: e.icon.name, title: REQUEST_TITLE[e.kind], detail: clip(e.text ?? e.tool?.summary ?? '', 160), eventId: e.id, ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}) });
    } else if (e.kind === 'tool' && e.toolUseId) {
      if (e.phase === 'start' && name === 'AskUserQuestion' && !waited.has(e.toolUseId)) {
        out.push({ key: `ask:${e.toolUseId}`, kind: 'needs', ts: e.ts, agentId: e.agentId, icon: 'MessageCircleQuestion', title: 'asked you a question', detail: requestSummary(e.tool?.input), toolUseId: e.toolUseId });
      }
      if (isPresentTool(name) && !explained.has(e.toolUseId)) {
        explained.add(e.toolUseId);
        const t = (e.tool?.input as { title?: unknown } | undefined)?.title;
        out.push({ key: `explain:${e.toolUseId}`, kind: 'explain', ts: e.ts, agentId: e.agentId, icon: 'Presentation', title: typeof t === 'string' && t ? clip(t, 80) : 'Explain', detail: 'an explain', toolUseId: e.toolUseId, explain: e });
      }
      if (e.phase !== 'end') continue;
      if (e.tool?.failed) {
        out.push({ key: `fail:${e.toolUseId}`, kind: 'fail', ts: e.ts, agentId: e.agentId, icon: 'TriangleAlert', title: `${shortToolName(name)} failed`, detail: clip(e.tool.resultSummary || e.tool.summary || '', 160), toolUseId: e.toolUseId });
        continue;
      }
      const c = changeOf(e);
      const f = c ? null : fileOf(e);
      if (c || (f && f.op !== 'read')) {
        const path = c?.path ?? f!.path;
        const what = c ? (c.kind === 'create' ? 'Created' : 'Edited') : f!.op === 'write' ? 'Wrote' : 'Edited';
        out.push({ key: `edit:${e.toolUseId}`, kind: 'edit', ts: e.ts, agentId: e.agentId, icon: 'FilePen', title: `${what} ${base(path)}`, detail: c ? `+${c.add} −${c.del} · ${path}` : path, toolUseId: e.toolUseId, path });
      }
    }
  }
  // background commands: when they went off, and how they ended
  for (const t of backgroundTasks(events, now)) {
    out.push({ key: `bg:${t.key}`, kind: 'task', ts: t.startedAt, agentId: t.agentId, icon: 'Timer', title: `In the background: ${t.label}`, detail: t.endedAt == null ? 'running' : outcome(t), toolUseId: t.key });
    if (t.endedAt != null) {
      const ok = t.status === 'completed';
      out.push({ key: `bg-end:${t.key}`, kind: 'task', ts: t.endedAt, agentId: t.agentId, icon: ok ? 'CircleCheck' : 'CircleX', title: `${t.label}`, detail: outcome(t), toolUseId: t.key, bad: !ok });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
}
