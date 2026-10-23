import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemePost, MemeTemplate } from '@cora/shared';
import { writeFileAtomic } from './fsx';
import { readSecret, writeSecret } from './secrets';

/** How long Imgflip's list of popular templates is kept before it's asked again. */
const TEMPLATES_MS = 24 * 3600_000;
const KEEP_PER_SESSION = 40;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The best template for a name the session gave ("distracted boyfriend", "this is fine"): the same name, else one that
 * starts with it or has it, else the one sharing the most words with it. Null: nothing close.
 */
export function matchTemplate(list: MemeTemplate[], name: string): MemeTemplate | null {
  const n = norm(name);
  if (!n) return null;
  const exact = list.find((t) => norm(t.name) === n);
  if (exact) return exact;
  const part = list.find((t) => norm(t.name).startsWith(n)) ?? list.find((t) => norm(t.name).includes(n)) ?? list.find((t) => n.includes(norm(t.name)));
  if (part) return part;
  const words = new Set(n.split(' ').filter((w) => w.length > 2));
  let best: MemeTemplate | null = null;
  let most = 0;
  for (const t of list) {
    const k = norm(t.name).split(' ').filter((w) => words.has(w)).length;
    if (k > most) (best = t), (most = k);
  }
  return most ? best : null;
}

/**
 * The Meme panel's memes: Imgflip's popular templates (its public list, no account needed; Cora draws the captions),
 * GIFs from Giphy when the user gave a key (kept sealed, like Cora's other keys), and each session's posts (kept
 * with the rest of its history).
 */
export class Memes {
  private templatesCache: { at: number; list: MemeTemplate[] } | null = null;
  private posts: Record<string, MemePost[]> = {};
  /** memes Claude drew: in memory only (never written anywhere; gone when Cora restarts) */
  private drawn: Record<string, MemePost[]> = {};
  private file: string | null;
  private keyFile: string | null;

  constructor(private o: { dataDir: string | null; fetch?: Fetch; now?(): number; /** a post was made (the open panels show it) */ onPost?(sessionId: string): void }) {
    this.file = o.dataDir ? join(o.dataDir, 'memes.json') : null;
    this.keyFile = o.dataDir ? join(o.dataDir, 'giphy.key') : null;
    try {
      if (this.file && existsSync(this.file)) this.posts = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, MemePost[]>;
    } catch {
      /* start afresh */
    }
  }

  private now = () => this.o.now?.() ?? Date.now();
  private get fetch(): Fetch {
    return this.o.fetch ?? ((u, i) => fetch(u, i));
  }
  private save() {
    try {
      if (this.file) writeFileAtomic(this.file, JSON.stringify(this.posts));
    } catch {
      /* not kept */
    }
  }

  /** Imgflip's popular templates (asked at most once a day). */
  async templates(): Promise<MemeTemplate[]> {
    if (this.templatesCache && this.now() - this.templatesCache.at < TEMPLATES_MS) return this.templatesCache.list;
    const r = await this.fetch('https://api.imgflip.com/get_memes', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Imgflip: HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { memes?: Array<{ id: string; name: string; url: string; width: number; height: number; box_count: number }> } };
    const list = (j.data?.memes ?? []).filter((m) => /^https:\/\/i\.imgflip\.com\//.test(m.url)).map((m) => ({ id: String(m.id), name: String(m.name), url: m.url, width: Number(m.width), height: Number(m.height), boxes: Number(m.box_count) }));
    if (list.length) this.templatesCache = { at: this.now(), list };
    return list;
  }

  /** The user's Giphy key, if they gave one. */
  giphyKey(): string | null {
    try {
      return this.keyFile && existsSync(this.keyFile) ? readSecret(this.keyFile).trim() || null : null;
    } catch {
      return null;
    }
  }
  setGiphyKey(key: string | null): void {
    if (!this.keyFile) return;
    writeSecret(this.keyFile, key?.trim() ?? '');
  }

  /** The best GIF for a few words (Giphy, rated PG-13 at most). */
  async gif(q: string): Promise<{ url: string; title: string; page: string } | null> {
    const key = this.giphyKey();
    if (!key) throw new Error('no-key');
    const r = await this.fetch(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=8&rating=pg-13&lang=en`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) throw new Error('bad-key');
    if (!r.ok) throw new Error(`Giphy: HTTP ${r.status}`);
    const j = (await r.json()) as { data?: Array<{ title?: string; url?: string; images?: Record<string, { url?: string }> }> };
    const pick = (j.data ?? []).find((g) => g.images?.downsized?.url || g.images?.fixed_height?.url);
    const url = pick?.images?.downsized?.url ?? pick?.images?.fixed_height?.url;
    return url && /^https:\/\/[a-z0-9.-]*giphy\.com\//.test(url) ? { url, title: String(pick?.title ?? ''), page: String(pick?.url ?? '') } : null;
  }

  /** Keep a post for its session (newest last): a drawn one in memory only, the others with the session's history. */
  post(sessionId: string, p: Omit<MemePost, 'id' | 'at'>): MemePost {
    const post: MemePost = { ...p, id: `${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: this.now() };
    if (post.kind === 'svg') {
      this.drawn[sessionId] = [...(this.drawn[sessionId] ?? []), post].slice(-KEEP_PER_SESSION);
      this.o.onPost?.(sessionId);
      return post;
    }
    this.posts[sessionId] = [...(this.posts[sessionId] ?? []), post].slice(-KEEP_PER_SESSION);
    this.save();
    this.o.onPost?.(sessionId);
    return post;
  }

  /** A session's posts, oldest first: the kept ones and the drawn ones together. */
  list(sessionId: string): MemePost[] {
    return [...(this.posts[sessionId] ?? []), ...(this.drawn[sessionId] ?? [])].sort((a, b) => a.at - b.at);
  }

  /** Posts older than history is kept go. */
  prune(cutoff: number): void {
    let changed = false;
    for (const [sid, list] of Object.entries(this.posts)) {
      const keep = list.filter((p) => p.at >= cutoff);
      if (keep.length === list.length) continue;
      changed = true;
      if (keep.length) this.posts[sid] = keep;
      else delete this.posts[sid];
    }
    if (changed) this.save();
  }
}
