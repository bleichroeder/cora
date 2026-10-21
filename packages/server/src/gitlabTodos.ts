import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { GitlabTodo } from '@cora/shared';
import { classify, findGlab, json, nodeExec, type Exec } from './ci';
import { writeFileAtomic } from './fsx';
import { gitlabHost } from './gitlabHost';

/** How often your to-dos are read. */
export const TODO_POLL_MS = 60_000;
/** After glab says it isn't there or isn't signed in: try again this much later. */
const BACKOFF_MS = 5 * 60_000;
const KEEP_SEEN = 1000;

export type TodoStatus = { state: 'off' | 'ok' | 'no-glab' | 'signed-out' | 'offline' | 'error'; error?: string; checkedAt?: number };

type State = { seen: number[]; started: boolean };

/** A to-do as GitLab's API gives it, in Cora's words. */
export function toTodo(t: any): GitlabTodo | null {
  if (typeof t?.id !== 'number') return null;
  const type = String(t.target_type ?? '');
  // about your account, not an MR or issue (GitLab's own notices): not work
  if (type === 'User' || type === 'Namespace' || /^duo_/.test(String(t.action_name ?? ''))) return null;
  const iid = t.target?.iid;
  const ref = iid == null ? '' : type === 'MergeRequest' ? `!${iid}` : type === 'Issue' ? `#${iid}` : '';
  const title = String(t.target?.title ?? t.body ?? '').trim();
  return {
    id: t.id,
    action: String(t.action_name ?? ''),
    type,
    project: String(t.project?.path_with_namespace ?? ''),
    ref,
    title,
    who: String(t.author?.name ?? t.author?.username ?? 'Someone'),
    text: String(t.body ?? title).trim().slice(0, 1500),
    link: String(t.target_url ?? t.target?.web_url ?? ''),
    at: Date.parse(t.created_at) || Date.now(),
  };
}

/**
 * Your GitLab to-dos, read with `glab api todos` (GET only: it never marks one done). New ones are told once (kept
 * across restarts); on the very first read, what's already there comes in as already seen.
 */
export class GitlabTodos {
  private st: State = { seen: [], started: false };
  private status_: TodoStatus = { state: 'ok' };
  private timer?: NodeJS.Timeout;
  private pausedUntil = 0;
  private exec: Exec;
  private glabPath = 'glab';
  private onPath = true;

  constructor(
    private o: {
      file?: string;
      on(): boolean;
      /** new to-dos, to tell */
      onFresh(t: GitlabTodo[]): void;
      /** the first read: what was there already (the Inbox takes them, as read) */
      onFirst?(t: GitlabTodo[]): void;
      onChange?(): void;
      exec?: Exec;
      now?: () => number;
      log?(m: string): void;
    },
  ) {
    this.exec = o.exec ?? nodeExec;
    try {
      if (o.file && existsSync(o.file)) this.st = { ...this.st, ...(JSON.parse(readFileSync(o.file, 'utf8')) as State) };
    } catch {
      /* start afresh */
    }
  }

  private now = () => this.o.now?.() ?? Date.now();

  status(): TodoStatus {
    return this.o.on() ? this.status_ : { state: 'off' };
  }

  start(): void {
    const tick = () => void this.check().finally(() => (this.timer = setTimeout(tick, TODO_POLL_MS)));
    this.timer = setTimeout(tick, 5000);
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async glab(args: string[]): Promise<string> {
    const env = { ...process.env, GLAB_CHECK_UPDATE: 'false', NO_COLOR: '1', GLAB_NO_PROMPT: 'true' };
    const run = (file: string) => this.exec(file, [...args.slice(0, 1), '--hostname', gitlabHost(), ...args.slice(1)], { timeout: 30_000, env, cwd: homedir() });
    try {
      return (await run(this.onPath ? 'glab' : this.glabPath)).stdout;
    } catch (e: any) {
      // not on the server's PATH (an app started from the Start menu may not have it): its usual install folder
      if (e?.code !== 'ENOENT' || !this.onPath) throw e;
      this.onPath = false;
      this.glabPath = findGlab();
      return (await run(this.glabPath)).stdout;
    }
  }

  /** Read your pending to-dos; tell the new ones. */
  async check(): Promise<void> {
    if (!this.o.on() || this.now() < this.pausedUntil) return;
    let list: GitlabTodo[];
    try {
      list = (json(await this.glab(['api', 'todos?state=pending&per_page=50'])) as unknown[]).map(toTodo).filter((t): t is GitlabTodo => !!t);
    } catch (e) {
      const g = classify(e);
      const state = g.kind === 'no-glab' || g.kind === 'signed-out' || g.kind === 'offline' ? g.kind : 'error';
      if (state !== 'offline') this.pausedUntil = this.now() + BACKOFF_MS;
      this.set({ state, error: g.message });
      return;
    }
    const seen = new Set(this.st.seen);
    const fresh = list.filter((t) => !seen.has(t.id)).sort((a, b) => a.at - b.at);
    const first = !this.st.started;
    this.st = { started: true, seen: [...this.st.seen, ...fresh.map((t) => t.id)].slice(-KEEP_SEEN) };
    this.save();
    this.set({ state: 'ok', checkedAt: this.now() });
    if (!fresh.length) return;
    if (first) this.o.onFirst?.(fresh);
    else this.o.onFresh(fresh);
  }

  private set(s: TodoStatus): void {
    const changed = s.state !== this.status_.state || s.error !== this.status_.error;
    this.status_ = s;
    if (changed) this.o.onChange?.();
  }

  private save(): void {
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify(this.st));
    } catch {
      /* not kept */
    }
  }
}
