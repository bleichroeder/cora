import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { dataProblem } from './dashboardCheck';
import { explainSlug, shareFileName } from '@cora/shared';

/**
 * Live explains: a session keeps an explain current while
 * it works. Each one is a folder, `<root>/<session>/<slug>/`, where the session writes `page.html` once and rewrites
 * `data.json` as it goes. Cora watches the root: a page write becomes a new version (`onVersion`), a data write is sent
 * on (`onData`). Only regular files directly in an explain's folder are read (no links: a session can't make Cora
 * show something from elsewhere on the PC), and only up to a size.
 */

/** in the head of every kit page: how an earlier one is told from a session's own page */
export const KIT_MARK = '<meta name="generator" content="cora-dashboard-kit">';
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

/** A page's new version: `at` is when its file was written (never when Cora noticed). */
export type LiveVersion = { sessionId: string; slug: string; title: string; html: string; at: number };
/** Where each page's content hash as last seen is kept (`<session>/<slug>`; null forgets it): Cora's store. */
export type SeenPages = { get(key: string): string | undefined; set(key: string, hash: string | null): void };
const hashOf = (html: string) => createHash('sha256').update(html).digest('hex');
export type LiveData = { sessionId: string; slug: string; data: unknown };

export class LiveExplains {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private latest = new Map<string, unknown>();
  /**
   * each explain's page as last seen (its content's hash), so only a page whose content changed is a new version: not a
   * save that changes nothing, nor a file only read (with last-access updates on, a read is a change to the watcher),
   * nor the first such event after a restart
   */
  private seen: SeenPages;

  constructor(private o: { root: string; onVersion(v: LiveVersion): void; onData(d: LiveData): void; log?(m: string): void; settleMs?: number; seen?: SeenPages }) {
    const mem = new Map<string, string>();
    this.seen = o.seen ?? { get: (k) => mem.get(k), set: (k, h) => void (h == null ? mem.delete(k) : mem.set(k, h)) };
  }

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

  /**
   * A kit dashboard: an explain's folder with Cora's own page in it (the session writes only the data). A page already
   * there that is the session's own (it took the dashboard over) is left as it is; an earlier kit page (it says so in
   * its head) is brought up to this one.
   */
  startKit(sessionId: string, title: string, page: string): { slug: string; dir: string; page: string; data: string; wrote: boolean } {
    const f = this.start(sessionId, title);
    const there = this.read(sessionId, f.slug, PAGE, PAGE_MAX);
    if (there?.trim() && (there === page || !there.includes(KIT_MARK))) return { ...f, wrote: false };
    writeFileSync(f.page, page);
    return { ...f, wrote: true };
  }

  /**
   * What's wrong with the data file a session just wrote (`file`: the path it gave its Write or Edit), to tell it; null
   * when it's fine, or the file isn't an explain's data. A kit dashboard's (its page is `kitPage`) has its blocks
   * checked too.
   */
  dataProblem(file: string, kitPage: string): string | null {
    if (!file) return null;
    const parts = relative(this.o.root, resolve(file)).split(sep);
    if (parts.length !== 3 || parts[0] === '..' || parts[2] !== DATA) return null;
    const [sid, slug] = parts;
    if (!SID.test(sid) || !/^[\w-]{1,60}$/.test(slug)) return null;
    // (read to a little past the most, so "too big" is said rather than nothing)
    const text = this.read(sid, slug, DATA, DATA_MAX * 4);
    if (text == null) return null;
    const page = this.read(sid, slug, PAGE, PAGE_MAX);
    return dataProblem(text, { kit: page != null && page === kitPage, max: DATA_MAX });
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
    // the pages already there are known as they are (one Cora hasn't seen yet too): only a change from now is a version
    this.seed();
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

  /** Each page there now that has no hash yet gets its current one (no version: it was there before). */
  seed(): void {
    for (const sid of this.dirs(this.o.root)) {
      if (!SID.test(sid)) continue;
      for (const slug of this.dirs(join(this.o.root, sid))) {
        const key = `${sid}/${slug}`;
        if (this.seen.get(key) !== undefined) continue;
        const html = this.read(sid, slug, PAGE, PAGE_MAX);
        if (html?.trim()) this.seen.set(key, hashOf(html));
      }
    }
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
          this.seen.set(`${sid}/${slug}`, null);
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
    const hash = hashOf(html);
    if (this.seen.get(key) === hash) return;
    this.seen.set(key, hash);
    // when the session wrote it: a version noticed late never makes its session look active now
    const at = Math.round(this.mtime(join(this.o.root, sessionId, slug, PAGE))) || Date.now();
    this.o.onVersion({ sessionId, slug, title: this.title(sessionId, slug), html, at });
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
