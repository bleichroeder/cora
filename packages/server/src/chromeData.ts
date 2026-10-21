import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

// loaded when it's needed (as the store does), so the CLI's warning filter is in place before node:sqlite
const sqlite = () => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** A page to suggest in Cora's browser: from Chrome's (or Edge's) bookmarks or history. */
export type WebSuggestion = { url: string; title: string; from: 'bookmark' | 'history'; visits?: number };

const KEEP_MS = 10 * 60_000;
const HISTORY_ROWS = 4000;

/** Where Chromium browsers keep their profiles (Windows): Chrome's, then Edge's, when they're there. */
export function chromiumRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return [join(local, 'Google', 'Chrome', 'User Data'), join(local, 'Microsoft', 'Edge', 'User Data')].filter((d) => existsSync(d));
}

const profiles = (root: string) => {
  try {
    return readdirSync(root).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)).map((d) => join(root, d));
  } catch {
    return [];
  }
};

/** A Chrome or Edge profile on this PC: `chrome:Default`, its name as that browser shows it, and its folder. */
export type ChromiumProfile = { id: string; name: string; dir: string };

/** Every profile under these roots, with the names their browser gives them (its Local State). */
export function chromiumProfiles(roots: string[]): ChromiumProfile[] {
  const out: ChromiumProfile[] = [];
  for (const root of roots) {
    const kind = /edge/i.test(root) ? 'edge' : 'chrome';
    let names: Record<string, { name?: string }> = {};
    try {
      names = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))?.profile?.info_cache ?? {};
    } catch {
      /* no names: the folder's */
    }
    for (const dir of profiles(root)) {
      const folder = basename(dir);
      out.push({ id: `${kind}:${folder}`, name: String(names[folder]?.name || folder), dir });
    }
  }
  return out;
}

/** A profile's bookmarks: the bar's first (they're the ones you use), then the rest. */
function bookmarksOf(profile: string): { bar: WebSuggestion[]; all: WebSuggestion[] } {
  const bar: WebSuggestion[] = [];
  const all: WebSuggestion[] = [];
  try {
    const j = JSON.parse(readFileSync(join(profile, 'Bookmarks'), 'utf8'));
    const walk = (n: any, into: WebSuggestion[]) => {
      if (!n) return;
      if (n.type === 'url' && typeof n.url === 'string' && /^https?:/i.test(n.url)) into.push({ url: n.url, title: String(n.name ?? ''), from: 'bookmark' });
      for (const c of n.children ?? []) walk(c, into);
    };
    walk(j?.roots?.bookmark_bar, bar);
    walk(j?.roots?.other, all);
    walk(j?.roots?.synced, all);
  } catch {
    /* none, or not readable */
  }
  return { bar, all: [...bar, ...all] };
}

/** A profile's most visited pages (from a copy: the browser keeps its own open). */
function historyOf(profile: string): WebSuggestion[] {
  const src = join(profile, 'History');
  if (!existsSync(src)) return [];
  const copy = join(tmpdir(), `cora-history-${process.pid}-${Date.now().toString(36)}.sqlite`);
  try {
    copyFileSync(src, copy);
    const db = new (sqlite().DatabaseSync)(copy, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT url, title, visit_count FROM urls WHERE hidden = 0 AND (url LIKE 'https://%' OR url LIKE 'http://%') ORDER BY visit_count DESC, last_visit_time DESC LIMIT ${HISTORY_ROWS}`).all() as Array<{ url: string; title: string; visit_count: number }>;
      return rows.map((r) => ({ url: r.url, title: r.title ?? '', from: 'history' as const, visits: r.visit_count }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    rmSync(copy, { force: true });
  }
}

/**
 * Your Chrome (and Edge) bookmarks and history, for Cora's browser: suggestions as you type an address, and the
 * bookmarks bar on a new tab. Read from this PC's own profiles, kept in memory for a while, never sent anywhere.
 * (Sign-ins can't come over: the browsers encrypt them for themselves.)
 */
export class ChromeData {
  /** by profile ('*': all of them) */
  private cache = new Map<string, { at: number; bar: WebSuggestion[]; bookmarks: WebSuggestion[]; history: WebSuggestion[] }>();

  constructor(private o: { roots?: () => string[]; now?: () => number } = {}) {}

  /** The Chrome and Edge profiles on this PC (to bring into Cora's browser). */
  profiles(): Array<{ id: string; name: string }> {
    return chromiumProfiles((this.o.roots ?? chromiumRoots)()).map(({ id, name }) => ({ id, name }));
  }

  /** One profile's bookmarks and history (`profile`: its id), or every profile's together. */
  private data(profile?: string) {
    const key = profile ?? '*';
    const now = this.o.now?.() ?? Date.now();
    const had = this.cache.get(key);
    if (had && now - had.at < KEEP_MS) return had;
    const bar: WebSuggestion[] = [];
    const bookmarks: WebSuggestion[] = [];
    const history: WebSuggestion[] = [];
    for (const p of chromiumProfiles((this.o.roots ?? chromiumRoots)())) {
      if (profile && p.id !== profile) continue;
      const b = bookmarksOf(p.dir);
      bar.push(...b.bar);
      bookmarks.push(...b.all);
      history.push(...historyOf(p.dir));
    }
    const once = (l: WebSuggestion[]) => {
      const seen = new Set<string>();
      return l.filter((s) => !seen.has(s.url) && (seen.add(s.url), true));
    };
    const d = { at: now, bar: once(bar), bookmarks: once(bookmarks), history: once(history) };
    this.cache.set(key, d);
    return d;
  }

  /** The bookmarks bar (under the address bar, and on a new tab): one profile's, or all of them. */
  bar(limit = 24, profile?: string): WebSuggestion[] {
    return this.data(profile).bar.slice(0, limit);
  }

  /** Pages for what's typed: every word in the address or title; bookmarks, then the most visited; a host that starts with it first. */
  suggest(query: string, limit = 8, profile?: string): WebSuggestion[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const d = this.data(profile);
    const hostOf = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
    const score = (s: WebSuggestion) => (hostOf(s.url).startsWith(words[0]) ? 100_000 : 0) + (s.from === 'bookmark' ? 50_000 : 0) + Math.min(49_999, s.visits ?? 0);
    const seen = new Set<string>();
    return [...d.bookmarks, ...d.history]
      .filter((s) => {
        const hay = `${s.url} ${s.title}`.toLowerCase();
        return words.every((w) => hay.includes(w)) && !seen.has(s.url) && (seen.add(s.url), true);
      })
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  }
}
