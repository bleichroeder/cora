import { randomBytes } from 'node:crypto';

/**
 * Cora and the IDE panel's VS Code talking (the Cora extension in it): Cora asks a window open on a folder to open a
 * file at a line, or a turn's diff; the window asks Cora which session works there, what Claude changed in a file,
 * and hands it what you selected to ask about. The extension calls in with its own token (never Cora's others).
 */
export type IdeCmd =
  | { kind: 'open'; path: string; line?: number }
  /** a turn's change to a file: the file as it was at `from` (Claude Code's snapshot) against the file now */
  | { kind: 'diff'; path: string; sessionId: string; from: number; to?: number | null; title: string };

/** A folder as both sides write it: forward slashes, no trailing slash, any case. */
export const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Is this file in this folder? */
export const inFolder = (file: string, folder: string) => folderKey(file).startsWith(`${folderKey(folder)}/`);

type Queue = { cmds: Array<{ cmd: IdeCmd; at: number }>; waiters: Set<(cmds: IdeCmd[]) => void>; seen: number };

export class IdeBridge {
  readonly token = randomBytes(24).toString('hex');
  private queues = new Map<string, Queue>();
  constructor(private o: { now?: () => number } = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
  private q(folder: string): Queue {
    const k = folderKey(folder);
    let q = this.queues.get(k);
    if (!q) this.queues.set(k, (q = { cmds: [], waiters: new Set(), seen: 0 }));
    return q;
  }

  /** Is a VS Code window open on this folder (it asked within the last while)? */
  connected(folder: string): boolean {
    const q = this.queues.get(folderKey(folder));
    return !!q && (q.waiters.size > 0 || (q.seen > 0 && this.now() - q.seen < 40_000));
  }

  /** The folders a window is open on (the one containing a file, the deepest first). */
  folderFor(file: string): string | null {
    const open = [...this.queues.keys()].filter((k) => this.connected(k) && inFolder(file, k)).sort((a, b) => b.length - a.length);
    return open[0] ?? null;
  }

  /** Something for the windows open on this folder: now if one's waiting, else when one next asks (a little while). */
  send(folder: string, cmd: IdeCmd): boolean {
    const q = this.q(folder);
    if (!this.connected(folder)) return false;
    if (q.waiters.size) {
      for (const w of q.waiters) w([cmd]);
      q.waiters.clear();
    } else q.cmds = [...q.cmds.filter((c) => this.now() - c.at < 30_000), { cmd, at: this.now() }];
    return true;
  }

  /** A window asks what's next for its folder: at once if something's waiting, else within `waitMs`. */
  next(folder: string, waitMs = 25_000): Promise<IdeCmd[]> {
    const q = this.q(folder);
    q.seen = this.now();
    if (q.cmds.length) {
      const out = q.cmds.map((c) => c.cmd);
      q.cmds = [];
      return Promise.resolve(out);
    }
    return new Promise((resolve) => {
      const done = (cmds: IdeCmd[]) => {
        clearTimeout(t);
        q.waiters.delete(done);
        q.seen = this.now();
        resolve(cmds);
      };
      const t = setTimeout(() => done([]), waitMs);
      q.waiters.add(done);
    });
  }
}
