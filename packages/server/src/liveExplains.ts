import { watch, type FSWatcher } from 'node:fs';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { explainSlug, shareFileName } from '@cora/shared';

/**
 * Live explains: a session keeps an explain current while
 * it works. Each one is a folder, `<root>/<session>/<slug>/`, where the session writes `page.html` once and rewrites
 * `data.json` as it goes. Cora watches the root: a page write becomes a new version (`onVersion`), a data write is sent
 * on (`onData`). Only regular files directly in an explain's folder are read (no links: a session can't make Cora
 * show something from elsewhere on the PC), and only up to a size.
 */

export const PAGE = 'page.html';
export const DATA = 'data.json';
const META = 'meta.json';
export const PAGE_MAX = 2_000_000;
export const DATA_MAX = 256_000;
const SETTLE_MS = 150;
const SID = /^[\w-]{8,80}$/;

/** A title as a folder name: lower case, letters, digits and dashes, never empty. */
export const slugOf = explainSlug;

/** What Cora types into a session to have it publish (or update) the shared copy of one of its explains. */
export function sharePrompt(title: string, file: string, url?: string): string {
  const name = title.replace(/\s+/g, ' ').trim().replace(/"/g, "'");
  const asIs =
    "It's a finished, self-contained page: publish it exactly as it is, without rewriting or redesigning it (if the Artifact tool can't publish from that folder, copy the file unchanged into your scratchpad and publish the copy). Then reply with just the link.";
  return url
    ? `Update the shared copy of the explain "${name}" (asked from Cora): republish ${file} to the existing artifact ${url}. ${asIs}`
    : `Share the explain "${name}" (asked from Cora): publish ${file} as a private claude.ai artifact titled "${name}". ${asIs}`;
}

export type LiveVersion ={ sessionId: string; slug: string; title: string; html: string };
export type LiveData = { sessionId: string; slug: string; data: unknown };

export class LiveExplains {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private latest = new Map<string, unknown>();
  /** the page last sent for each explain, so a save that changes nothing isn't a new version */
  private pages = new Map<string, string>();

  constructor(private o: { root: string; onVersion(v: LiveVersion): void; onData(d: LiveData): void; log?(m: string): void; settleMs?: number }) {}

  /** An explain's folder (made if missing), and the two files the session writes. The same title, the same folder. */
  start(sessionId: string, title: string): { slug: string; dir: string; page: string; data: string } {
    if (!SID.test(sessionId)) throw new Error('not a session');
    const name = title.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw new Error('give it a title');
    const slug = slugOf(name);
    const dir = join(this.o.root, sessionId, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, META), JSON.stringify({ title: name, sessionId, at: Date.now() }));
    return { slug, dir, page: join(dir, PAGE), data: join(dir, DATA) };
  }

  /** Write the copy of an explain its session publishes when you share it; returns where. */
  share(sessionId: string, title: string, html: string): string {
    if (!SID.test(sessionId)) throw new Error('not a session');
    const name = title.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw new Error('give it a title');
    if (!html.trim() || html.length > PAGE_MAX) throw new Error('nothing to share, or too big');
    const dir = join(this.o.root, sessionId, slugOf(name));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, shareFileName(name));
    writeFileSync(file, html);
    return file;
  }

  /** The newest good data an explain has (read from its file if it changed before Cora started). */
  latestData(sessionId: string, slug: string): unknown {
    const key = `${sessionId}/${slug}`;
    if (this.latest.has(key)) return this.latest.get(key);
    const d = this.read(sessionId, slug, DATA, DATA_MAX);
    if (d == null) return null;
    try {
      const v = JSON.parse(d);
      this.latest.set(key, v);
      return v;
    } catch {
      return null;
    }
  }

  watch(): void {
    mkdirSync(this.o.root, { recursive: true });
    try {
      this.watcher = watch(this.o.root, { recursive: true }, (_ev, name) => name && this.changed(String(name)));
    } catch (e) {
      this.o.log?.(`live explains: can't watch ${this.o.root} (${(e as Error).message})`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Remove explains not touched since `cutoff` (their events are pruned on the same schedule). */
  prune(cutoff: number): number {
    let n = 0;
    for (const sid of this.dirs(this.o.root)) {
      for (const slug of this.dirs(join(this.o.root, sid))) {
        const dir = join(this.o.root, sid, slug);
        const newest = Math.max(0, ...this.files(dir).map((f) => this.mtime(join(dir, f))));
        if (newest < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          n++;
        }
      }
      if (!this.dirs(join(this.o.root, sid)).length) rmSync(join(this.o.root, sid), { recursive: true, force: true });
    }
    return n;
  }

  /** A path under the root changed: once it settles, read it if it's one of an explain's two files. */
  changed(name: string): void {
    const parts = name.split(/[\\/]/);
    if (parts.length !== 3) return;
    const [sid, slug, file] = parts;
    if (!SID.test(sid) || !/^[\w-]{1,60}$/.test(slug) || (file !== PAGE && file !== DATA)) return;
    const key = `${sid}/${slug}/${file}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (file === PAGE) this.page(sid, slug);
        else this.data(sid, slug);
      }, this.o.settleMs ?? SETTLE_MS),
    );
  }

  private page(sessionId: string, slug: string): void {
    const html = this.read(sessionId, slug, PAGE, PAGE_MAX);
    if (html == null || !html.trim()) return;
    const key = `${sessionId}/${slug}`;
    if (this.pages.get(key) === html) return;
    this.pages.set(key, html);
    this.o.onVersion({ sessionId, slug, title: this.title(sessionId, slug), html });
  }

  private data(sessionId: string, slug: string): void {
    const text = this.read(sessionId, slug, DATA, DATA_MAX);
    if (text == null) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return; // half-written or wrong: the last good data stays
    }
    this.latest.set(`${sessionId}/${slug}`, data);
    this.o.onData({ sessionId, slug, data });
  }

  private title(sessionId: string, slug: string): string {
    const m = this.read(sessionId, slug, META, 10_000);
    try {
      return String(JSON.parse(m ?? '{}').title || slug);
    } catch {
      return slug;
    }
  }

  /** One of an explain's files, if it's a regular file (not a link) inside its folder and not too big. */
  private read(sessionId: string, slug: string, file: string, max: number): string | null {
    const dir = join(this.o.root, sessionId, slug);
    const path = join(dir, file);
    if (relative(this.o.root, path).split(sep).length !== 3) return null;
    try {
      for (const p of [join(this.o.root, sessionId), dir, path]) if (lstatSync(p).isSymbolicLink()) return null;
      const st = lstatSync(path);
      if (!st.isFile()) return null;
      if (st.size > max) {
        this.o.log?.(`live explains: ${sessionId}/${slug}/${file} is too big (${st.size} bytes): ignored`);
        return null;
      }
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  private dirs(p: string): string[] {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }
  private files(p: string): string[] {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  }
  private mtime(p: string): number {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }
}
