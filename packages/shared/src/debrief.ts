import { DEFAULT_VIDEO, SHOT_CLIP, SHOT_STILL, type VideoSettings } from './debriefVideo';
/**
 * Debrief: the session that did the work walks the user through
 * it in the IDE panel, step by step, the lines it's about lit and a bubble beside them saying what changed and why;
 * read aloud in the session's voice if they like. The session writes the script (its `debrief` tool); Cora checks it
 * against the files, keeps the code it points at, and plays it.
 */

/** A sentence or two of a step, and the lines it's about (the highlight moves to them as it's read). */
export type Beat = { text: string; range?: [number, number] };

export type DebriefKind = 'context' | 'change' | 'test' | 'verify' | 'risk' | 'concept';
export const DEBRIEF_KINDS: DebriefKind[] = ['context', 'change', 'test', 'verify', 'risk', 'concept'];

/** One step: a file and its lines (or none: the task, the approach), what it says, and why. */
export type DebriefStep = {
  title: string;
  kind: DebriefKind;
  /** the file (absolute, or in the session's folder) and its lines now (1-based, inclusive) */
  path?: string;
  range?: [number, number];
  /** shown as the turn's change to the file: as it was when the work began against now */
  diff?: boolean;
  beats: Beat[];
  why?: string;
  /** Teach me: where to read more */
  links?: Array<{ title: string; url: string }>;
  /** a picture of it (a screenshot, or a short screen recording): its video shows it, pushed in toward `focus` */
  shot?: DebriefShot;
};

/**
 * A step's picture in its video: a screenshot (png, jpg, webp) or a short clip (mp4, webm; it plays once, then holds),
 * absolute or in the session's folder. `focus`: the part to push in toward, [x, y, width, height] as fractions of it.
 */
export type DebriefShot = { file: string; focus?: [number, number, number, number] };

export type DebriefQuiz = { q: string; options: string[]; answer: number; why: string };

/** What the session writes. */
export type DebriefScript = { title: string; task: string; depth: 'quick' | 'teach'; steps: DebriefStep[]; quiz?: DebriefQuiz[] };

/** A step's code as it was when the debrief was made: its lines and some around them, and (a diff step) the file before. */
export type DebriefSnap = { start: number; lines: string[]; before?: string };

/** A debrief as kept: the script, whose it is, when, the turns it covers, and its code as it was. */
/** What a debrief covers of the changes: the files changed in its span, and those of them none of its steps mention. */
export type DebriefCovers = { changed: string[]; missed: string[] };
export type Debrief = DebriefScript & { id: string; sessionId: string; createdAt: number; from?: number; to?: number | null; snaps: Record<number, DebriefSnap>; covers?: DebriefCovers };
export type DebriefSummary = { id: string; title: string; depth: 'quick' | 'teach'; steps: number; createdAt: number; from?: number; changed?: number; missed?: string[] };

/**
 * The work a debrief is about: from the start of the earliest turn (a prompt) that made the latest change to one of
 * the files its steps point at, up to now; the files changed in that span, and those none of its steps mention.
 * Null when its files weren't changed in the session.
 */
export function debriefSpan(o: { prompts: number[]; changes: Array<{ path: string; ts: number }>; files: string[]; now: number; key(p: string): string }): ({ from: number } & DebriefCovers) | null {
  const want = new Set(o.files.map(o.key));
  const latest = new Map<string, number>();
  for (const c of o.changes) if (want.has(o.key(c.path))) latest.set(o.key(c.path), Math.max(latest.get(o.key(c.path)) ?? 0, c.ts));
  if (!latest.size) return null;
  const prompts = [...o.prompts].sort((a, b) => a - b);
  const turnOf = (ts: number) => prompts.filter((p) => p <= ts).pop() ?? ts;
  const from = Math.min(...[...latest.values()].map(turnOf));
  const changed = new Map<string, string>();
  for (const c of o.changes) if (c.ts >= from && c.ts <= o.now && !changed.has(o.key(c.path))) changed.set(o.key(c.path), c.path);
  return { from, changed: [...changed.values()], missed: [...changed].filter(([k]) => !want.has(k)).map(([, p]) => p) };
}
export type DebriefsMsg = { t: 'debriefs'; sessionId: string; list: DebriefSummary[] };

export const DEBRIEF_LIMITS = { steps: 12, beats: 4, beat: 400, quiz: 2, title: 120, task: 800, why: 600 } as const;
/** Its setting (Settings › Sessions › Debrief): when sessions offer one, the depth they start at, speaking as you step. */
export type DebriefSettings = { offer: 'bigger' | 'always' | 'never'; depth: 'quick' | 'teach'; speak: boolean; /** its videos (debriefVideo.ts) */ video: VideoSettings };
export const DEFAULT_DEBRIEF: DebriefSettings = { offer: 'bigger', depth: 'quick', speak: false, video: DEFAULT_VIDEO };

const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const range = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1) && v[0] <= v[1];

/** Is this a script Cora can play (its shape and limits)? The files and lines are checked against the disk after. */
export function checkScript(s: unknown): { ok: true; script: DebriefScript } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  if (!str(o.title, DEBRIEF_LIMITS.title)) e.push(`title: a short title (at most ${DEBRIEF_LIMITS.title} characters)`);
  if (!str(o.task, DEBRIEF_LIMITS.task)) e.push(`task: what was asked, in a sentence or two (at most ${DEBRIEF_LIMITS.task} characters)`);
  if (o.depth !== 'quick' && o.depth !== 'teach') e.push('depth: quick or teach');
  const steps = Array.isArray(o.steps) ? o.steps : [];
  if (!steps.length || steps.length > DEBRIEF_LIMITS.steps) e.push(`steps: 1 to ${DEBRIEF_LIMITS.steps}`);
  steps.slice(0, DEBRIEF_LIMITS.steps).forEach((raw, i) => {
    const st = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const at = `step ${i + 1}`;
    if (!str(st.title, DEBRIEF_LIMITS.title)) e.push(`${at}: a title`);
    if (!DEBRIEF_KINDS.includes(st.kind as DebriefKind)) e.push(`${at}: kind is one of ${DEBRIEF_KINDS.join(', ')}`);
    if (st.path !== undefined && !str(st.path, 1000)) e.push(`${at}: path is a file`);
    if (st.range !== undefined && !range(st.range)) e.push(`${at}: range is [first line, last line], 1-based`);
    if ((st.range !== undefined || st.diff) && st.path === undefined) e.push(`${at}: lines need a file (path)`);
    if (st.why !== undefined && !str(st.why, DEBRIEF_LIMITS.why)) e.push(`${at}: why is a sentence or two (at most ${DEBRIEF_LIMITS.why} characters)`);
    const beats = Array.isArray(st.beats) ? st.beats : [];
    if (!beats.length || beats.length > DEBRIEF_LIMITS.beats) e.push(`${at}: 1 to ${DEBRIEF_LIMITS.beats} beats`);
    beats.forEach((b, j) => {
      const bt = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
      if (!str(bt.text, DEBRIEF_LIMITS.beat)) e.push(`${at}, beat ${j + 1}: a sentence or two (at most ${DEBRIEF_LIMITS.beat} characters)`);
      if (bt.range !== undefined && (!range(bt.range) || st.path === undefined)) e.push(`${at}, beat ${j + 1}: range is [first, last] lines of the step's file`);
    });
    if (st.shot !== undefined) {
      const sh = (st.shot && typeof st.shot === 'object' ? st.shot : {}) as Record<string, unknown>;
      if (!str(sh.file, 1000) || !(SHOT_STILL.test(String(sh.file)) || SHOT_CLIP.test(String(sh.file)))) e.push(`${at}: shot.file is a picture (png, jpg, webp) or a clip (mp4, webm, mov)`);
      const f = sh.focus;
      if (f !== undefined && !(Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === 'number' && n >= 0 && n <= 1) && f[2] > 0.05 && f[3] > 0.05 && f[0] + f[2] <= 1.001 && f[1] + f[3] <= 1.001))
        e.push(`${at}: shot.focus is [x, y, width, height], fractions of the picture (0 to 1)`);
    }
    if (st.links !== undefined && (!Array.isArray(st.links) || st.links.some((l) => !l || typeof l !== 'object' || !str((l as { title?: unknown }).title, 200) || !/^https?:\/\//.test(String((l as { url?: unknown }).url ?? ''))))) e.push(`${at}: links are { title, url } (http or https)`);
  });
  const quiz = o.quiz === undefined ? [] : Array.isArray(o.quiz) ? o.quiz : null;
  if (!quiz || quiz.length > DEBRIEF_LIMITS.quiz) e.push(`quiz: at most ${DEBRIEF_LIMITS.quiz} questions`);
  else
    quiz.forEach((q, i) => {
      const x = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
      const opts = Array.isArray(x.options) ? x.options : [];
      if (!str(x.q, 400) || opts.length < 2 || opts.length > 5 || opts.some((t) => !str(t, 200)) || !Number.isInteger(x.answer) || (x.answer as number) < 0 || (x.answer as number) >= opts.length || !str(x.why, 600))
        e.push(`quiz ${i + 1}: { q, options (2 to 5), answer (its index), why }`);
    });
  if (e.length) return { ok: false, errors: e };
  const script = o as unknown as DebriefScript;
  return { ok: true, script: { title: script.title.trim(), task: script.task.trim(), depth: script.depth, steps: script.steps, ...(script.quiz?.length ? { quiz: script.quiz } : {}) } };
}

/** A debrief as markdown (a PR description, a ticket comment, for a teammate): the task, each step with its code, the quiz. */
export function debriefMarkdown(d: Debrief, rel: (path: string) => string = (p) => p): string {
  const out: string[] = [`# ${d.title}`, '', `**Task:** ${d.task}`, ''];
  d.steps.forEach((st, i) => {
    out.push(`## ${i + 1}. ${st.title}`);
    if (st.path) out.push(`\`${rel(st.path)}${st.range ? `:${st.range[0]}${st.range[1] !== st.range[0] ? `-${st.range[1]}` : ''}` : ''}\``);
    out.push('');
    for (const b of st.beats) out.push(b.text, '');
    const snap = d.snaps[i];
    if (snap && st.range) {
      const from = st.range[0] - snap.start;
      const lines = snap.lines.slice(Math.max(0, from), Math.max(0, from) + (st.range[1] - st.range[0] + 1));
      if (lines.length) out.push('```', ...lines, '```', '');
    }
    if (st.why) out.push(`**Why:** ${st.why}`, '');
    if (st.links?.length) out.push(...st.links.map((l) => `- [${l.title}](${l.url})`), '');
  });
  if (d.quiz?.length) {
    out.push('## Check your understanding', '');
    d.quiz.forEach((q, i) => out.push(`${i + 1}. ${q.q}`, ...q.options.map((o, j) => `   - ${j === q.answer ? '**' : ''}${o}${j === q.answer ? '**' : ''}`), `   ${q.why}`, ''));
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Where a debrief is playing: its step, and the beat in it. */
export type Playing = { step: number; beat: number };

/** The next beat (into the next step after a step's last), or null at the end. */
export function nextBeat(d: Pick<DebriefScript, 'steps'>, p: Playing): Playing | null {
  if (p.beat + 1 < (d.steps[p.step]?.beats.length ?? 0)) return { step: p.step, beat: p.beat + 1 };
  return nextStep(d, p);
}
/** The next step's first beat, or null after the last. */
export const nextStep = (d: Pick<DebriefScript, 'steps'>, p: Playing): Playing | null => (p.step + 1 < d.steps.length ? { step: p.step + 1, beat: 0 } : null);
/** The step before's first beat (the first step stays). */
export const prevStep = (_d: Pick<DebriefScript, 'steps'>, p: Playing): Playing => ({ step: Math.max(0, p.step - 1), beat: 0 });
