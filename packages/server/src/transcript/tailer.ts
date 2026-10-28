import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { isSafeId } from '@cora/shared';

/** `quiet`: lines read before Cora (re)started: parsed for what they tell the parser, never stored or told again */
export type TailInfo = { sessionId: string; agentId: string; projectSlug: string; quiet?: boolean };
/** `quiet`: the bytes up to here were read before (the restart's catch-up re-reads them quietly) */
type FileState = { offset: number; rest: Buffer; info: TailInfo; busy: Promise<void>; quiet: number };

/** at most this much of a file is read (and turned into lines) at once */
const CHUNK = 16 * 1024 * 1024;

export type TailerOptions = {
  /** On startup, files modified within this window are read from the start; older ones only from their end. */
  sinceMs?: number;
  /** Use a filesystem watcher in addition to polling (default true). */
  watch?: boolean;
  pollMs?: number;
  /** startup backfill progress: files read so far, of how many */
  onProgress?: (done: number, total: number) => void;
  /**
   * How far each transcript was read before (kept across restarts). With it, a restart re-reads a file's earlier lines
   * quietly (the parser needs them: which call a result answers, the folder, the subagents) and only what's new as news.
   */
  reads?: { get(file: string): number | undefined; set(file: string, offset: number): void };
};

/** Identify session/agent from a transcript path under the projects root. */
export function tailInfo(root: string, file: string): TailInfo | null {
  const rel = file.slice(root.length).split(/[\\/]/).filter(Boolean);
  if (rel.length === 2 && rel[1].endsWith('.jsonl')) {
    const sessionId = basename(rel[1], '.jsonl');
    return isSafeId(sessionId) ? { projectSlug: rel[0], sessionId, agentId: 'main' } : null;
  }
  if (rel.length === 4 && rel[2] === 'subagents' && /^agent-.+\.jsonl$/.test(rel[3])) {
    const agentId = basename(rel[3], '.jsonl').slice('agent-'.length);
    return isSafeId(rel[1]) && isSafeId(agentId) ? { projectSlug: rel[0], sessionId: rel[1], agentId } : null;
  }
  return null;
}

/** Follows Claude Code transcript JSONL files, delivering only newly appended complete lines. */
export class Tailer {
  badLines = 0;
  private files = new Map<string, FileState>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private started = Date.now();

  constructor(
    private root: string,
    private onLines: (file: string, objs: any[], info: TailInfo) => void,
    private opts: TailerOptions = {},
  ) {}

  async start(): Promise<void> {
    this.started = Date.now();
    await this.scan(true);
    const files = [...this.files.keys()];
    for (let i = 0; i < files.length; i++) {
      await this.read(files[i]);
      this.opts.onProgress?.(i + 1, files.length);
    }
    if (this.opts.watch !== false) {
      this.watcher = chokidar.watch(this.root, { ignoreInitial: true, depth: 3 });
      const onFs = (p: string) => {
        if (!p.endsWith('.jsonl')) return;
        if (!this.files.has(p)) this.track(p, 0);
        void this.read(p);
      };
      this.watcher.on('add', onFs).on('change', onFs);
      this.timer = setInterval(() => void this.pollOnce(), this.opts.pollMs ?? 2000);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.watcher?.close();
  }

  /** Discover new files and read any growth. Deterministic hook for tests and the safety poll. */
  async pollOnce(): Promise<void> {
    await this.scan(false);
    for (const f of [...this.files.keys()]) await this.read(f);
  }

  private track(file: string, offset: number): FileState | undefined {
    const info = tailInfo(this.root, file);
    if (!info) return undefined;
    const st: FileState = { offset, rest: Buffer.alloc(0), info, busy: Promise.resolve(), quiet: 0 };
    this.files.set(file, st);
    return st;
  }

  private async scan(initial: boolean): Promise<void> {
    const since = this.opts.sinceMs ?? 24 * 3600_000;
    const consider = async (file: string) => {
      if (this.files.has(file)) return;
      if (!initial) return void this.track(file, 0);
      const s = await stat(file).catch(() => null);
      if (!s) return;
      const st = this.track(file, Date.now() - s.mtimeMs <= since ? 0 : s.size);
      // read before: those lines come again quietly
      const known = this.opts.reads?.get(file);
      if (st && st.offset === 0 && known && known <= s.size) st.quiet = known;
    };
    let projects: string[];
    try {
      projects = await readdir(this.root);
    } catch {
      return;
    }
    for (const p of projects) {
      const dir = join(this.root, p);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) await consider(join(dir, e.name));
        else if (e.isDirectory()) {
          const sub = join(dir, e.name, 'subagents');
          const subs = await readdir(sub).catch(() => [] as string[]);
          for (const s of subs) if (s.endsWith('.jsonl')) await consider(join(sub, s));
        }
      }
    }
  }

  private read(file: string): Promise<void> {
    const st = this.files.get(file);
    if (!st) return Promise.resolve();
    st.busy = st.busy.then(() => this.readNow(file, st)).catch(() => {});
    return st.busy;
  }

  private async readNow(file: string, st: FileState): Promise<void> {
    const s = await stat(file).catch(() => null);
    if (!s) return;
    if (s.size < st.offset) {
      st.offset = 0;
      st.rest = Buffer.alloc(0);
    }
    // rewritten shorter than what was read: all of it is news
    if (s.size < st.quiet) st.quiet = 0;
    if (s.size === st.offset) return;
    const fh = await open(file, 'r');
    try {
      // a piece at a time: a transcript can be hundreds of MB, more than one string can hold
      while (st.offset < s.size) {
        const len = Math.min(CHUNK, s.size - st.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, st.offset);
        if (!bytesRead) break;
        // where `data` starts in the file
        const at = st.offset - st.rest.length;
        st.offset += bytesRead;
        const data = Buffer.concat([st.rest, buf.subarray(0, bytesRead)]);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl < 0) {
          st.rest = data;
          continue;
        }
        st.rest = Buffer.from(data.subarray(lastNl + 1));
        // the lines read before the restart (up to a line's end), then the new ones
        const cut = Math.max(0, Math.min(lastNl + 1, st.quiet - at));
        const quiet = this.parse(data.subarray(0, cut));
        const news = this.parse(data.subarray(cut, lastNl));
        if (quiet.length) this.onLines(file, quiet, { ...st.info, quiet: true });
        if (news.length) this.onLines(file, news, st.info);
        if (at + lastNl + 1 >= st.quiet) st.quiet = 0;
        this.opts.reads?.set(file, at + lastNl + 1);
      }
    } finally {
      await fh.close();
    }
  }

  private parse(b: Buffer): any[] {
    const objs: any[] = [];
    for (const line of b.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        objs.push(JSON.parse(t));
      } catch {
        this.badLines++;
      }
    }
    return objs;
  }
}

