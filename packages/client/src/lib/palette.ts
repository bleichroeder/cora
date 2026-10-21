/**
 * The command palette's matching and ranking (Ctrl+K). Pure: the component gathers the entries, this scores them.
 * Names (sessions, folders, commands, explains) match fuzzily; transcript text only as plain substrings, since a
 * scattered subsequence matches nearly any long reply.
 */

export type GroupId = 'recent' | 'session' | 'older' | 'new' | 'transcript' | 'explain' | 'note' | 'command';
export const GROUP_LABEL: Record<GroupId, string> = {
  recent: 'Recent',
  session: 'Sessions',
  older: 'Older sessions',
  new: 'New session',
  transcript: 'In transcripts',
  explain: 'Explains',
  note: 'Notes',
  command: 'Commands',
};

export type Hit = { score: number; hits: number[] };

export type Entry = {
  /** stable across opens: what the recent picks remember */
  id: string;
  group: Exclude<GroupId, 'recent'>;
  label: string;
  detail?: string;
  /** matched too (more weakly), never shown: synonyms, ids */
  keywords?: string;
  /** added to the match: the focused session, live ones, newer ones */
  boost?: number;
  /** already matched elsewhere (transcript hits): taken as is when there's a query */
  pre?: { score: number; labelHits: number[] };
  /** shown with no query (otherwise only the recent picks and sessions are) */
  featured?: boolean;
};

export type Ranked<E extends Entry> = { e: E; score: number; labelHits: number[]; detailHits: number[] };
export type Group<E extends Entry> = { id: GroupId; items: Ranked<E>[] };

export const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

const BOUNDARY = /[\s/\\\-_.:·,()[\]]/;
const isStart = (text: string, i: number) => i === 0 || BOUNDARY.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

/**
 * One query word against a text. A substring scores highest (more at the start of a word, more the more of the
 * text it covers); otherwise the letters in order, rewarding word starts and runs. Words under three letters must be
 * substrings: two scattered letters match almost anything.
 */
export function fuzzy(q: string, text: string, lower = text.toLowerCase()): Hit | null {
  if (!q) return { score: 0, hits: [] };
  const at = lower.indexOf(q);
  if (at >= 0) {
    // the first occurrence at a word start beats an earlier one mid-word ("set" in "reset settings")
    let i = at;
    for (let j = at; j >= 0 && !isStart(text, i); j = lower.indexOf(q, j + 1)) if (isStart(text, j)) i = j;
    const start = isStart(text, i);
    const score = 100 + (i === 0 ? 30 : start ? 18 : 0) + (q.length / Math.max(text.length, 1)) * 25 - Math.min(i, 40) * 0.25;
    return { score, hits: Array.from({ length: q.length }, (_, k) => i + k) };
  }
  if (q.length < 3) return null;
  const hits: number[] = [];
  let score = 0;
  let pos = 0;
  for (const c of q) {
    let j = lower.indexOf(c, pos);
    if (j < 0) return null;
    // a word start a little further on reads better than a stray letter here ("nsc" → New SCene, not New Session…c)
    const prev = hits[hits.length - 1];
    if (j !== (prev ?? -2) + 1 && !isStart(text, j)) {
      for (let k = lower.indexOf(c, j + 1); k >= 0 && k - j < 24; k = lower.indexOf(c, k + 1))
        if (isStart(text, k)) {
          j = k;
          break;
        }
    }
    const run = prev != null && j === prev + 1;
    score += 4 + (isStart(text, j) ? 9 : 0) + (run ? 7 : 0) - Math.min((j - (prev ?? -1) - 1) * 0.4, 6);
    hits.push(j);
    pos = j + 1;
  }
  // Too scattered to mean anything: a piece may begin mid-word once ("stv" → SeTtings: Voice), not more ("voi" isn't
  // Version and dev envIronment).
  let loose = 0;
  hits.forEach((h, k) => k && h !== hits[k - 1] + 1 && !isStart(text, h) && loose++);
  if (loose > 1 || (!isStart(text, hits[0]) && loose)) return null;
  return { score: Math.min(score, 95), hits };
}

/** Every query word must match the label, the detail or the keywords; the label counts most. */
export function matchEntry(tokens: string[], e: Pick<Entry, 'label' | 'detail' | 'keywords'>): Omit<Ranked<never>, 'e'> | null {
  let score = 0;
  const labelHits: number[] = [];
  const detailHits: number[] = [];
  const ll = e.label.toLowerCase();
  const dl = e.detail?.toLowerCase();
  const kl = e.keywords?.toLowerCase();
  for (const t of tokens) {
    const l = fuzzy(t, e.label, ll);
    const d = e.detail ? fuzzy(t, e.detail, dl) : null;
    const k = kl ? fuzzy(t, e.keywords!, kl) : null;
    const ls = l?.score ?? -1;
    const ds = d ? d.score * 0.6 : -1;
    const ks = k ? k.score * 0.5 : -1;
    const best = Math.max(ls, ds, ks);
    if (best < 0) return null;
    score += best;
    if (best === ls) labelHits.push(...l!.hits);
    else if (best === ds) detailHits.push(...d!.hits);
  }
  return { score: score / tokens.length + (tokens.length > 1 ? 5 * (tokens.length - 1) : 0), labelHits, detailHits };
}

export type RankOptions = {
  /** ids picked lately, newest first */
  recent: string[];
  /** most shown per group */
  caps?: Partial<Record<GroupId, number>>;
};
const CAPS: Record<GroupId, number> = { recent: 6, session: 8, older: 5, new: 4, transcript: 8, explain: 5, note: 6, command: 7 };
/** Group order with no query: what you most likely want first. */
const IDLE_ORDER: GroupId[] = ['recent', 'session', 'command', 'new', 'explain', 'note', 'older', 'transcript'];

/**
 * Score, group and cap. With a query, groups come in order of their best item (so Enter takes the best match
 * anywhere); with none, your recent picks first, then sessions and the featured entries. Recent picks get a lift
 * in any case, fading with how long ago they were picked.
 */
export function rank<E extends Entry>(entries: E[], query: string, o: RankOptions): Group<E>[] {
  const caps = { ...CAPS, ...o.caps };
  const tokens = tokensOf(query);
  const recency = new Map(o.recent.map((id, i) => [id, i]));
  const lift = (id: string) => {
    const i = recency.get(id);
    return i == null ? 0 : 24 * (1 - i / Math.max(o.recent.length, 8));
  };
  const by = new Map<GroupId, Ranked<E>[]>();
  const add = (g: GroupId, r: Ranked<E>) => (by.get(g) ?? by.set(g, []).get(g)!).push(r);

  if (!tokens.length) {
    const picked = new Set<string>();
    const recents = o.recent
      .map((id) => entries.find((e) => e.id === id))
      .filter((e): e is E => !!e)
      .slice(0, caps.recent);
    for (const e of recents) {
      picked.add(e.id);
      add('recent', { e, score: 0, labelHits: [], detailHits: [] });
    }
    for (const e of entries) {
      if (picked.has(e.id) || (e.group !== 'session' && !e.featured)) continue;
      add(e.group, { e, score: e.boost ?? 0, labelHits: [], detailHits: [] });
    }
    return IDLE_ORDER.filter((g) => by.has(g)).map((g) => ({ id: g, items: by.get(g)!.sort((a, b) => b.score - a.score).slice(0, caps[g]) }));
  }

  for (const e of entries) {
    if (e.pre) {
      add(e.group, { e, score: e.pre.score + (e.boost ?? 0), labelHits: e.pre.labelHits, detailHits: [] });
      continue;
    }
    const m = matchEntry(tokens, e);
    if (m) add(e.group, { e, score: m.score + (e.boost ?? 0) + lift(e.id), labelHits: m.labelHits, detailHits: m.detailHits });
  }
  const groups = [...by.entries()].map(([id, items]) => ({ id, items: items.sort((a, b) => b.score - a.score).slice(0, caps[id]) }));
  return groups.sort((a, b) => b.items[0].score - a.items[0].score);
}

/** Highlight runs from hit positions: [start, end) pairs, merged. */
export function runs(hits: number[]): Array<[number, number]> {
  const s = [...new Set(hits)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const h of s) {
    const last = out[out.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else out.push([h, h + 1]);
  }
  return out;
}

// ---------------------------------------------------------------- transcripts

/** A searchable line of a transcript: one reply, prompt, report or tool call, its text flattened to one line. */
export type Line = { id: string; ts: number; kind: string; text: string; lower: string; toolUseId?: string; agentId: string };

type EventLike = { id: string; ts: number; kind: string; agentId: string; phase?: string; toolUseId?: string; text?: string; tool?: { name: string; summary: string } };

/** What of an event is worth searching (null: nothing), with markdown noise and whitespace flattened. */
export function lineOf(e: EventLike): Line | null {
  let raw: string | undefined;
  if (e.kind === 'say' || e.kind === 'prompt' || e.kind === 'report') raw = e.text;
  else if (e.kind === 'tool' && e.phase === 'start' && e.tool) raw = `${e.tool.name.replace(/^mcp__[^_]+__/, '')} ${e.tool.summary}`;
  if (!raw) return null;
  const text = raw.replace(/\*\*|`+|^#+\s/gm, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return { id: e.id, ts: e.ts, kind: e.kind, agentId: e.agentId, text, lower: text.toLowerCase(), ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}) };
}

export type TextHit = { sessionId: string; line: Line; score: number; snippet: string; hits: number[] };

/**
 * Lines holding every query word, newest first, from each session in the order given (put the focused one first).
 * Stops after `max` hits so a common word in thousands of events stays cheap.
 */
export function searchLines(sources: Array<{ sessionId: string; lines: Line[]; boost?: number }>, tokens: string[], now: number, max = 200): TextHit[] {
  const out: TextHit[] = [];
  if (!tokens.length || tokens.join('').length < 3) return out;
  for (const src of sources) {
    // the same words again in one session (a repeated prompt, a retried command) show once: the newest
    const seen = new Set<string>();
    for (let i = src.lines.length - 1; i >= 0 && out.length < max; i--) {
      const l = src.lines[i];
      if (!tokens.every((t) => l.lower.includes(t)) || seen.has(l.lower)) continue;
      seen.add(l.lower);
      const ageH = Math.max(0, now - l.ts) / 3600_000;
      // below a good name match, above a weak one; your prompts and Claude's replies over tool calls
      const score = 55 + (src.boost ?? 0) + Math.max(0, 12 - ageH / 2) + (l.kind === 'tool' ? 0 : 6);
      out.push({ sessionId: src.sessionId, line: l, score, ...snippet(l.text, l.lower, tokens) });
    }
    if (out.length >= max) break;
  }
  return out.sort((a, b) => b.score - a.score);
}

/** About `width` characters around the first match, cut at word edges, with every match in it marked. */
export function snippet(text: string, lower: string, tokens: string[], width = 120): { snippet: string; hits: number[] } {
  const first = Math.min(...tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  let from = Math.max(0, first - Math.floor(width / 4));
  if (from > 0) {
    const sp = text.indexOf(' ', from);
    from = sp >= 0 && sp < first ? sp + 1 : from;
  }
  let to = Math.min(text.length, from + width);
  if (to < text.length) {
    const sp = text.lastIndexOf(' ', to);
    if (sp > first) to = sp;
  }
  const pre = from > 0 ? '…' : '';
  const s = pre + text.slice(from, to) + (to < text.length ? '…' : '');
  const sl = s.toLowerCase();
  const hits: number[] = [];
  for (const t of tokens) for (let i = sl.indexOf(t); i >= 0; i = sl.indexOf(t, i + t.length)) for (let k = 0; k < t.length; k++) hits.push(i + k);
  return { snippet: s, hits };
}

// ---------------------------------------------------------------- recent picks and folders

/** Put `id` first in the recent picks (once), keeping at most `max`. */
export const pushRecent = (list: string[], id: string, max = 20) => [id, ...list.filter((x) => x !== id)].slice(0, max);

/** Folders to start in: newest first, once each (paths compare case- and slash-insensitively, as Windows does). */
export function recentFolders(sources: Array<{ cwd: string; ts: number }>, max = 30): string[] {
  const best = new Map<string, { cwd: string; ts: number }>();
  for (const s of sources) {
    if (!s.cwd) continue;
    const k = s.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const had = best.get(k);
    if (!had || s.ts > had.ts) best.set(k, s);
  }
  return [...best.values()].sort((a, b) => b.ts - a.ts).slice(0, max).map((s) => s.cwd);
}
