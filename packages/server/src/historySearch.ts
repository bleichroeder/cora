import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HistoryItem } from '@cora/shared';
import { historyItem } from './history';
import { namerArgs, namerEnv, runCommand, type RunFn } from './namer';
import { defaultClaudeCmd } from './pty';

/** What's kept of a session to search: its prompts and Claude's words (not tool output: that's most of the bytes). */
const PER_SESSION = 400_000;
/** of which how it began */
const HEAD_CHARS = 60_000;
/** a big transcript: only this much of its end is read for the rest (prompts and replies are a small share of it) */
const TAIL_BYTES = 24 * 1024 * 1024;
/** Words too common to say which session it was. */
const STOP = new Set(
  'the and that this with from where what when which about into over then than there their they them were was have had has you your for not but are can could would should one session sessions find found look looking remember something some thing things want wanted did does done just like also been being only very much more most here how why who its our out all any each other made make using used use'.split(' '),
);

export type Found = HistoryItem & { snippet?: string };

type Doc = { file: string; slug: string; mtime: number; size: number; text: string };

/**
 * Finding an old session by what was said in it: an index of every transcript's prompts and replies, read once in the
 * background and then only where a transcript changed. Words are matched in any order, case aside.
 */
export class HistoryIndex {
  private docs = new Map<string, Doc>();
  private refreshing: Promise<void> | null = null;

  constructor(private o: { projectsDir: string; skip?: (slug: string) => boolean }) {}

  /** Up to date (only changed transcripts are read again); one refresh at a time. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  get busy(): boolean {
    return this.refreshing != null;
  }

  private async doRefresh(): Promise<void> {
    const seen = new Set<string>();
    for (const slug of await readdir(this.o.projectsDir).catch(() => [] as string[])) {
      if (this.o.skip?.(slug)) continue;
      const dir = join(this.o.projectsDir, slug);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.endsWith('.jsonl')) continue;
        const file = join(dir, f);
        const s = await stat(file).catch(() => null);
        if (!s?.isFile()) continue;
        seen.add(file);
        const had = this.docs.get(file);
        if (had && had.mtime === s.mtimeMs && had.size === s.size) continue;
        this.docs.set(file, { file, slug, mtime: s.mtimeMs, size: s.size, text: await said(file, s.size) });
      }
    }
    for (const k of [...this.docs.keys()]) if (!seen.has(k)) this.docs.delete(k);
  }

  /**
   * For the finder: the sessions where the most of what you describe was said (its words in any order, a rare word
   * counting for more than a common one), best first, each with a bit around its rarest (the latest place it was said).
   */
  evidence(description: string, limit = 40): Map<string, string> {
    const words = [...new Set(description.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]{2,}/gu) ?? [])].filter((w) => !STOP.has(w)).slice(0, 16);
    const out = new Map<string, string>();
    if (!words.length) return out;
    const docs = [...this.docs.values()].map((d) => ({ d, low: d.text.toLowerCase() }));
    const df = new Map(words.map((w) => [w, docs.filter((x) => x.low.includes(w)).length]));
    const weight = (w: string) => Math.log(1 + docs.length / Math.max(1, df.get(w) ?? 1));
    const scored = docs
      .map((x) => ({ ...x, has: words.filter((w) => x.low.includes(w)) }))
      .filter((x) => x.has.length)
      .map((x) => ({ ...x, score: x.has.reduce((s, w) => s + weight(w), 0) }))
      .sort((a, b) => b.score - a.score || b.d.mtime - a.d.mtime)
      .slice(0, limit);
    for (const x of scored) {
      // the place where the most of its words are said together (rarer ones counting for more), its latest
      let best = { at: 0, score: -1 };
      for (const w of x.has)
        for (let at = x.low.lastIndexOf(w), n = 0; at >= 0 && n < 20; at = x.low.lastIndexOf(w, at - 1), n++) {
          const near = x.low.slice(Math.max(0, at - 150), at + 150);
          const score = x.has.filter((v) => near.includes(v)).reduce((s, v) => s + weight(v), 0);
          if (score > best.score) best = { at, score };
        }
      out.set(basename(x.d.file, '.jsonl'), x.d.text.slice(Math.max(0, best.at - 90), best.at + 150).replace(/\s+/g, ' ').trim());
    }
    return out;
  }

  /** Sessions where every word appears, newest first, each with a bit of where. */
  async search(query: string, limit = 30): Promise<Found[]> {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 8);
    if (!words.length) return [];
    // lower-cased here, not kept so: the snippet shows the words as they were written
    const hits = [...this.docs.values()]
      .map((d) => ({ d, low: d.text.toLowerCase() }))
      .filter(({ low }) => words.every((w) => low.includes(w)))
      .sort((a, b) => b.d.mtime - a.d.mtime)
      .slice(0, limit);
    return Promise.all(
      hits.map(async ({ d, low }) => {
        const at = low.indexOf(words[0]);
        const snippet = d.text.slice(Math.max(0, at - 70), at + 110).replace(/\s+/g, ' ').trim();
        return { ...(await historyItem(d)), snippet };
      }),
    );
  }
}

/**
 * A transcript's prompts and Claude's words: how it began, and the most of its latest (a session that runs for days,
 * like Cora's own, is remembered by what came late in it); only the file's last TAIL_BYTES are read for that, so a
 * huge transcript costs little. Lines that can't be either aren't parsed at all.
 */
async function said(file: string, size: number): Promise<string> {
  const keep = (head: string, rest: string) => `${head}\n…\n${rest.slice(-(PER_SESSION - HEAD_CHARS))}`;
  if (size <= TAIL_BYTES) {
    const all = await saidIn(file, 0, Infinity);
    return all.length <= PER_SESSION ? all : keep(all.slice(0, HEAD_CHARS), all.slice(HEAD_CHARS));
  }
  return keep(await saidIn(file, 0, HEAD_CHARS), await saidIn(file, size - TAIL_BYTES, Infinity));
}

async function saidIn(file: string, start: number, max: number): Promise<string> {
  const parts: string[] = [];
  let n = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', start }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (n >= max) break;
    const prompt = line.includes('"type":"user"') && line.includes('"content":"') && !line.includes('"isMeta":true');
    const reply = line.includes('"type":"assistant"') && line.includes('"type":"text"');
    if (!prompt && !reply) continue;
    try {
      const o = JSON.parse(line);
      const c = o?.message?.content;
      const text = typeof c === 'string' ? (c.startsWith('<') ? '' : c) : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join('\n') : '';
      if (!text) continue;
      parts.push(text);
      n += text.length;
    } catch {
      /* a torn line (the tail's first, cut where it starts) */
    }
  }
  return parts.join('\n').slice(0, max);
}

const FINDER_SYSTEM = `You help someone find one of their past Claude Code sessions. They describe it in their own words; you get a list of their sessions, one per line: id | when (last active) | folder | name or title | first prompt, then, when there is one, "recap:" (where the session got to) and "said:" (words from inside the session that match their description: the strongest evidence, since a long session's title and first prompt often say little about what came later). A folder named "Cora (your assistant…)" is Cora's own conversation with them (their assistant, also called the orchestrator). Reply with the ids that best fit what they describe, best first, at most 5, one id per line and nothing else. If nothing fits, reply NONE.`;

/**
 * "The one where I fixed the clip share 404s last week": Haiku picks from the session list (titles, folders, first
 * prompts, dates). The list is the user's own; the answer is only ids, checked against it.
 */
export async function askForSession(o: {
  description: string;
  items: Array<HistoryItem & { name?: string; recap?: string }>;
  dataDir: string;
  /** from inside them (HistoryIndex.evidence): where what they describe was said, by session id */
  evidence?: Map<string, string>;
  run?: RunFn;
  claudeCmd?: string[];
  timeoutMs?: number;
}): Promise<HistoryItem[]> {
  const dir = join(o.dataDir, 'finder');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ disableAllHooks: true }, null, 2) + '\n');
  writeFileSync(join(dir, 'system-prompt.md'), FINDER_SYSTEM);
  const one = (s: string, max: number) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, max);
  // a pasted block isn't what anyone remembers a session by: its first words of your own are
  const prompt = (p: string) => p.replace(/<pasted_content[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g, ' ').replace(/<[^>]+>/g, ' ');
  // Cora's own conversations run in its folder: named for what they are, so "the Cora orchestrator" finds them
  const folder = (cwd: string) => (/[\\/]\.cora[\\/]orchestrator[\\/]?$/i.test(cwd) ? 'Cora (your assistant, its own conversation)' : one(cwd, 60));
  const list = o.items
    .slice(0, 300)
    .map((h) => {
      const said = o.evidence?.get(h.sessionId);
      return [h.sessionId, new Date(h.mtime).toISOString().slice(0, 10), folder(h.cwd), one(h.name || h.title, 70), one(prompt(h.firstPrompt), 90), h.recap ? `recap: ${one(h.recap, 160)}` : '', said ? `said: ${one(said, 240)}` : ''].filter(Boolean).join(' | ');
    })
    .join('\n');
  const input = `What they're looking for: ${one(o.description, 500)}\n\nTheir sessions:\n${list}`;
  const r = await (o.run ?? runCommand)([...(o.claudeCmd ?? defaultClaudeCmd()), ...namerArgs(dir)], { cwd: dir, env: namerEnv(process.env), input, timeoutMs: o.timeoutMs ?? 60_000, maxOut: 4000 });
  if (r.timedOut || r.code !== 0) throw new Error(r.timedOut ? 'Claude took too long' : "Claude couldn't answer");
  const byId = new Map(o.items.map((h) => [h.sessionId, h]));
  const ids = r.stdout.split(/\s+/).filter((w) => byId.has(w));
  return [...new Set(ids)].slice(0, 5).map((id) => byId.get(id)!);
}
