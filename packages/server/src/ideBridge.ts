import { randomBytes } from 'node:crypto';
import type { Debrief } from '@cora/shared';

/**
 * Cora and the IDE panel's VS Code talking (the Cora extension in it): Cora asks a window open on a folder to open a
 * file at a line, or a turn's diff; the window asks Cora which session works there, what Claude changed in a file,
 * and hands it what you selected to ask about. The extension calls in with its own token (never Cora's others).
 */
export type IdeCmd =
  | { kind: 'open'; path: string; line?: number }
  /** a turn's change to a file: the file as it was at `from` (Claude Code's snapshot) against the file now */
  | { kind: 'diff'; path: string; sessionId: string; from: number; to?: number | null; title: string }
  /** a debrief's step: its file (or, a step about no file, a page of the debrief's outline), its lines lit, the bubble */
  | DebriefStepCmd
  | { kind: 'debrief.end' }
  /** the session's answer to a question asked in the bubble */
  | { kind: 'debrief.reply'; text: string };

export type DebriefStepCmd = {
  kind: 'debrief.step';
  sessionId: string;
  id: string;
  /** the session's name (the bubble's author) */
  name: string;
  index: number;
  total: number;
  /** `3 / 7 · The fix` */
  header: string;
  /** the step's kind (change, test, risk…), beside the author */
  label: string;
  path?: string;
  /** a step about no file: the page it's shown on (the debrief's outline) */
  doc?: string;
  /** the step's lines, and the beat's (1-based, inclusive) */
  range?: [number, number];
  beatRange?: [number, number];
  /** show the file against how it was before the work (Cora kept it) */
  before?: boolean;
  beats: string[];
  beat: number;
  why?: string;
  links?: Array<{ title: string; url: string }>;
  playing: boolean;
  speak: boolean;
};

/** How many steps a debrief plays: its steps, and Teach me's quiz after them. */
export const debriefLength = (d: Pick<Debrief, 'steps' | 'quiz'>) => d.steps.length + (d.quiz?.length ? 1 : 0);

/** A kept debrief's step, as the IDE draws it. */
export function debriefStepCmd(d: Debrief, index: number, beat: number, o: { name: string; playing: boolean; speak: boolean }): DebriefStepCmd {
  const total = debriefLength(d);
  if (index >= d.steps.length && d.quiz?.length) {
    // Teach me's quiz, after the steps: its questions in the bubble; answers typed in its reply box go to the session
    const qs = d.quiz.map((q, i) => `${i + 1}. ${q.q}${['', ...q.options.map((x, j) => `   ${'abcde'[j]}) ${x}`)].join('  \n')}`);
    const doc = [`# ${d.title}`, '', 'Check your understanding: answer below, and the session tells you how you did.', ''].join('\n');
    return { kind: 'debrief.step', sessionId: d.sessionId, id: d.id, name: o.name, index, total, header: `${total} / ${total} · Check your understanding`, label: 'quiz', doc, range: [3, 3], beats: qs, beat: Math.min(beat, qs.length - 1), playing: o.playing, speak: o.speak };
  }
  const st = d.steps[index];
  const b = st.beats[beat] ? beat : 0;
  let doc: string | undefined;
  let range = st.range;
  if (!st.path) {
    // a step about no file: a page with the task and the steps, this one's line lit and the bubble under it
    const lines = [`# ${d.title}`, '', d.task, '', ...d.steps.map((x, i) => `${i + 1}. ${x.title}`), ''];
    doc = lines.join('\n');
    range = [5 + index, 5 + index];
  }
  return {
    kind: 'debrief.step',
    sessionId: d.sessionId,
    id: d.id,
    name: o.name,
    index,
    total,
    header: `${index + 1} / ${total} · ${st.title}`,
    label: st.kind,
    ...(st.path ? { path: st.path } : { doc }),
    ...(range ? { range } : {}),
    ...(st.path && st.beats[b].range ? { beatRange: st.beats[b].range } : {}),
    ...(st.diff && d.snaps[index]?.before != null ? { before: true } : {}),
    beats: st.beats.map((x) => x.text),
    beat: b,
    ...(st.why ? { why: st.why } : {}),
    ...(st.links?.length ? { links: st.links } : {}),
    playing: o.playing,
    speak: o.speak,
  };
}

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
