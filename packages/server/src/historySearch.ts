import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HistoryItem } from '@cora/shared';
import { historyItem } from './history';
import { namerArgs, namerEnv, runCommand, type RunFn } from './namer';
import { defaultClaudeCmd } from './pty';

/** What's kept of a session to search: its prompts and Claude's words (not tool output: that's most of the bytes). */
const PER_SESSION = 60_000;

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
        this.docs.set(file, { file, slug, mtime: s.mtimeMs, size: s.size, text: await said(file) });
      }
    }
    for (const k of [...this.docs.keys()]) if (!seen.has(k)) this.docs.delete(k);
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

/** A transcript's prompts and Claude's words, capped; lines that can't be either aren't parsed at all. */
async function said(file: string): Promise<string> {
  const parts: string[] = [];
  let n = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (n >= PER_SESSION) break;
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
      /* a torn line */
    }
  }
  return parts.join('\n').slice(0, PER_SESSION);
}

const FINDER_SYSTEM = `You help someone find one of their past Claude Code sessions. They describe it in their own words; you get a list of their sessions, one per line: id | when | folder | title | first prompt. Reply with the ids that best fit what they describe, best first, at most 5, one id per line and nothing else. If nothing fits, reply NONE.`;

/**
 * "The one where I fixed the clip share 404s last week": Haiku picks from the session list (titles, folders, first
 * prompts, dates). The list is the user's own; the answer is only ids, checked against it.
 */
export async function askForSession(o: { description: string; items: HistoryItem[]; dataDir: string; run?: RunFn; claudeCmd?: string[]; timeoutMs?: number }): Promise<HistoryItem[]> {
  const dir = join(o.dataDir, 'finder');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ disableAllHooks: true }, null, 2) + '\n');
  writeFileSync(join(dir, 'system-prompt.md'), FINDER_SYSTEM);
  const one = (s: string, max: number) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, max);
  // a pasted block isn't what anyone remembers a session by: its first words of your own are
  const prompt = (p: string) => p.replace(/<pasted_content[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g, ' ').replace(/<[^>]+>/g, ' ');
  const list = o.items
    .slice(0, 300)
    .map((h) => `${h.sessionId} | ${new Date(h.mtime).toISOString().slice(0, 10)} | ${one(h.cwd, 60)} | ${one(h.title, 70)} | ${one(prompt(h.firstPrompt), 90)}`)
    .join('\n');
  const input = `What they're looking for: ${one(o.description, 500)}\n\nTheir sessions:\n${list}`;
  const r = await (o.run ?? runCommand)([...(o.claudeCmd ?? defaultClaudeCmd()), ...namerArgs(dir)], { cwd: dir, env: namerEnv(process.env), input, timeoutMs: o.timeoutMs ?? 60_000, maxOut: 4000 });
  if (r.timedOut || r.code !== 0) throw new Error(r.timedOut ? 'Claude took too long' : "Claude couldn't answer");
  const byId = new Map(o.items.map((h) => [h.sessionId, h]));
  const ids = r.stdout.split(/\s+/).filter((w) => byId.has(w));
  return [...new Set(ids)].slice(0, 5).map((id) => byId.get(id)!);
}
