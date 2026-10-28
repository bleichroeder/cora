import type { BrainEvent, Hunk } from '@cora/shared';
import { sessionEvents, useBrain, type DiffTarget } from '../state/store';

/** One file-changing tool call (Edit/Write/MultiEdit/NotebookEdit), with its hunks when they were small enough to carry. */
export type ChangeEv = { id: string; toolUseId: string; agentId: string; ts: number; path: string; tool: string; kind: 'edit' | 'create' | 'update'; hunks: Hunk[] | null; add: number; del: number };
/** Everything one turn did to one file. */
export type FileGroup = { path: string; rel: string; edits: ChangeEv[]; add: number; del: number; isNew: boolean; lastTs: number };
/** A turn: your prompt and the files Claude changed before the next one. */
export type Turn = { key: string; prompt: string; from: number; to: number | null; files: FileGroup[]; add: number; del: number };

const slash = (p: string) => p.replace(/\\/g, '/');
export const samePath = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase();

/** A path as shown: relative to the session folder when it's inside it. */
export function relPath(p: string, cwd: string | undefined): string {
  const s = slash(p);
  const base = cwd ? slash(cwd).replace(/\/+$/, '') + '/' : '';
  return base && s.toLowerCase().startsWith(base.toLowerCase()) ? s.slice(base.length) : s;
}

export function changeOf(e: BrainEvent): ChangeEv | null {
  const c = e.tool?.change;
  if (e.kind !== 'tool' || e.phase !== 'end' || !c || e.tool?.failed || !e.toolUseId) return null;
  return { id: e.id, toolUseId: e.toolUseId, agentId: e.agentId, ts: e.ts, path: c.path, tool: e.tool!.name, kind: c.kind, hunks: c.hunks ?? null, add: c.add, del: c.del };
}

/** The session's changes grouped by turn (oldest first): each prompt of yours to the next, files in path order. */
export function changeTurns(events: BrainEvent[], cwd: string | undefined): Turn[] {
  // (a message you sent mid-turn isn't a turn of its own; its queue entry isn't a prompt at all)
  const prompts = events.filter((e) => e.kind === 'prompt' && e.agentId === 'main' && !e.queue && !e.midTurn).sort((a, b) => a.ts - b.ts);
  const bounds = prompts.length ? prompts.map((p, i) => ({ key: p.id, prompt: p.text ?? '', from: p.ts, to: prompts[i + 1]?.ts ?? null })) : [];
  // edits before the first prompt we know of (a resumed session's history starts mid-way)
  bounds.unshift({ key: 'start', prompt: '', from: 0, to: prompts[0]?.ts ?? null });
  const turns: Turn[] = bounds.map((b) => ({ ...b, files: [], add: 0, del: 0 }));
  const by = new Map<string, FileGroup>();
  for (const e of events) {
    const c = changeOf(e);
    if (!c) continue;
    const ti = turns.findLastIndex((t) => t.from <= c.ts);
    const t = turns[Math.max(0, ti)];
    const path = e.tool!.change!.path;
    const k = `${t.key}|${slash(path).toLowerCase()}`;
    let g = by.get(k);
    if (!g) {
      g = { path, rel: relPath(path, cwd), edits: [], add: 0, del: 0, isNew: c.kind === 'create', lastTs: c.ts };
      by.set(k, g);
      t.files.push(g);
    }
    g.edits.push(c);
    g.add += c.add;
    g.del += c.del;
    g.lastTs = Math.max(g.lastTs, c.ts);
  }
  for (const t of turns) {
    t.files.sort((a, b) => a.rel.localeCompare(b.rel));
    for (const f of t.files) f.edits.sort((a, b) => a.ts - b.ts);
    t.add = t.files.reduce((n, f) => n + f.add, 0);
    t.del = t.files.reduce((n, f) => n + f.del, 0);
  }
  return turns.filter((t) => t.files.length);
}

/** Open a file's changes in the viewer: in the turn that last changed it, unless told which. */
export function openChanges(sessionId: string, path: string, opts: Partial<DiffTarget> & { toolUseId?: string } = {}): void {
  const st = useBrain.getState();
  if (opts.mode === 'git') return st.setDiff({ sessionId, path, mode: 'git' });
  if (opts.from == null) {
    const turns = changeTurns(sessionEvents(sessionId), st.sessions[sessionId]?.cwd);
    const t = turns.findLast((x) => x.files.some((f) => samePath(f.path, path)));
    if (t) opts = { ...opts, from: t.from, to: t.to };
    else opts = { ...opts, from: 0, to: null };
  }
  // opened from one tool call: show that edit
  let step = opts.step ?? -1;
  if (opts.toolUseId) {
    const turns = changeTurns(sessionEvents(sessionId), st.sessions[sessionId]?.cwd);
    const g = turns.find((t) => t.from === opts.from)?.files.find((f) => samePath(f.path, path));
    const i = g?.edits.findIndex((e) => e.toolUseId === opts.toolUseId) ?? -1;
    if (g && g.edits.length > 1 && i >= 0) step = i;
  }
  const { toolUseId: _ignored, ...rest } = opts;
  st.setDiff({ sessionId, path, mode: 'turn', follow: false, ...rest, step });
}

/** Totals for a list of hunks. */
export function hunkStats(hunks: Hunk[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) l[0] === '+' ? add++ : l[0] === '-' ? del++ : 0;
  return { add, del };
}

const turnCache = new Map<string, { v: number; turns: Turn[] }>();
/** changeTurns for a session, computed once per event version (many transcript rows ask). */
export function turnsFor(sessionId: string): Turn[] {
  const st = useBrain.getState();
  const v = st.versions[sessionId] ?? 0;
  const c = turnCache.get(sessionId);
  if (c && c.v === v) return c.turns;
  const turns = changeTurns(sessionEvents(sessionId), st.sessions[sessionId]?.cwd);
  turnCache.set(sessionId, { v, turns });
  return turns;
}
