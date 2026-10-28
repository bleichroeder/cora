import type { Debrief, DebriefKind } from './debrief';

/**
 * Debrief videos: a debrief as a short narrated video, made
 * from the debrief alone. Its settings, a video's state, and its slides with what each says.
 */

export const VIDEO_KEEP_HOURS = [1, 24, 168] as const;
export type VideoSize = '1080' | '720';
export type VideoSettings = {
  /** an ElevenLabs voice id; empty: Cora's own voice (Settings › Voice) */
  voiceId: string;
  /** the ElevenLabs model that voices it (VOICE_MODELS): quality first, it isn't live */
  model: string;
  voiceName: string;
  speed: number;
  size: VideoSize;
  /** the step's code on its slide (off: titles and words only) */
  code: boolean;
  /** hours a video is kept unless you save it */
  keepHours: (typeof VIDEO_KEEP_HOURS)[number];
  /** the orb on the title card */
  orb: boolean;
  /** what's said, under each slide (for watching on mute) */
  subtitles: boolean;
  /** its accent: your Cora colour, or the session's own */
  accent: 'cora' | 'session';
};
export const DEFAULT_VIDEO: VideoSettings = { voiceId: '', voiceName: '', model: 'eleven_v4', speed: 1, size: '1080', code: true, keepHours: 24, orb: true, subtitles: false, accent: 'cora' };

/** Why a video settings patch is wrong (none: fine). */
export function videoSettingsProblem(v: Partial<VideoSettings>): string | null {
  if (v.voiceId !== undefined && (typeof v.voiceId !== 'string' || v.voiceId.length > 64 || !/^[\w-]*$/.test(v.voiceId))) return 'video.voiceId must be a voice id';
  if (v.voiceName !== undefined && (typeof v.voiceName !== 'string' || v.voiceName.length > 80)) return 'video.voiceName must be a name';
  if (v.model !== undefined && (typeof v.model !== 'string' || !/^eleven_[\w]{1,40}$/.test(v.model))) return 'video.model must be an ElevenLabs model (eleven_…)';
  if (v.speed !== undefined && !(typeof v.speed === 'number' && v.speed >= 0.7 && v.speed <= 1.2)) return 'video.speed must be between 0.7 and 1.2';
  if (v.size !== undefined && v.size !== '1080' && v.size !== '720') return 'video.size must be 1080 or 720';
  if (v.code !== undefined && typeof v.code !== 'boolean') return 'video.code must be true or false';
  if (v.keepHours !== undefined && !VIDEO_KEEP_HOURS.includes(v.keepHours)) return 'video.keepHours must be 1, 24 or 168';
  if (v.orb !== undefined && typeof v.orb !== 'boolean') return 'video.orb must be true or false';
  if (v.subtitles !== undefined && typeof v.subtitles !== 'boolean') return 'video.subtitles must be true or false';
  if (v.accent !== undefined && v.accent !== 'cora' && v.accent !== 'session') return 'video.accent must be cora or session';
  return null;
}

/**
 * One video as you set it up (the Make a video modal): its slides (which, in what order, what each says; the title
 * card first), the title card's words, and how it sounds and looks. `color`: the accent, as a colour.
 */
export type VideoPlan = Omit<VideoSettings, 'voiceName' | 'accent'> & {
  title: string;
  sub: string;
  slides: Array<{ id: string; narration: string }>;
  color?: string;
};
const MAX_SLIDES = 60;
const MAX_SAY = 2000;

/** Why a plan is wrong (none: fine). */
export function videoPlanProblem(p: VideoPlan): string | null {
  if (!p || typeof p !== 'object') return 'a plan, please';
  const why = videoSettingsProblem(p);
  if (why) return why;
  if (typeof p.title !== 'string' || p.title.length > 200 || typeof p.sub !== 'string' || p.sub.length > 600) return 'the title card: a title (200 characters at most) and a line under it (600)';
  if (!Array.isArray(p.slides) || !p.slides.length || p.slides.length > MAX_SLIDES) return `slides: 1 to ${MAX_SLIDES}`;
  for (const x of p.slides) if (!x || typeof x.id !== 'string' || !/^[\w-]{1,40}$/.test(x.id) || typeof x.narration !== 'string' || x.narration.length > MAX_SAY) return `each slide: its id, and what it says (${MAX_SAY} characters at most)`;
  if (p.color !== undefined && !/^#[0-9a-f]{6}$/i.test(p.color)) return 'color: #rrggbb';
  return null;
}

/** The slides as the plan has them: those it keeps, in its order, saying what it says; the title card in its words. */
export function planSlides(all: VideoSlide[], p: Pick<VideoPlan, 'title' | 'sub' | 'slides' | 'orb' | 'subtitles'>): VideoSlide[] {
  const by = new Map(all.map((x) => [x.id, x]));
  const kept = p.slides.flatMap((x) => {
    const s = by.get(x.id);
    return s ? [{ ...s, narration: x.narration.trim(), ...(s.kind === 'title' ? { title: p.title.trim() || s.title, sub: p.sub.trim(), orb: p.orb } : {}) }] : [];
  });
  // the steps' places among those kept
  const steps = kept.filter((x) => x.kind === 'step');
  return kept.map((x) => (x.kind === 'step' ? { ...x, n: steps.indexOf(x) + 1, of: steps.length } : x));
}

/** What's said, as subtitles: a sentence or two at a time (each at most ~110 characters), in order. */
export function captions(text: string): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    const last = out.at(-1);
    if (last && last.length + s.length + 1 <= 110) out[out.length - 1] = `${last} ${s}`;
    else if (s.length <= 110) out.push(s);
    // a long one: at its commas, else its words
    else {
      let cur = '';
      for (const w of s.split(/(?<=,)\s+|\s+/)) {
        if (cur && cur.length + w.length + 1 > 110) (out.push(cur), (cur = w));
        else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

/** Where a video is: waiting for ffmpeg (your OK to download it), voicing, drawing its slides, putting it together, ready, failed. */
export type VideoStage = 'ffmpeg' | 'voicing' | 'drawing' | 'building' | 'ready' | 'failed';
export type VideoJob = {
  id: string;
  sessionId: string;
  debriefId: string;
  title: string;
  stage: VideoStage;
  /** of the stage: done / total (slides) */
  done: number;
  total: number;
  /** characters voiced (what ElevenLabs counts), cached lines not included */
  chars: number;
  createdAt: number;
  /** deleted after this, unless saved */
  expiresAt: number;
  size?: VideoSize;
  /** seconds, bytes (ready) */
  seconds?: number;
  bytes?: number;
  error?: string;
};
/** ffmpeg: found (where), being downloaded (how far), or not here. */
export type FfmpegState = { state: 'found'; path: string } | { state: 'downloading'; got: number; total: number } | { state: 'missing'; canDownload: boolean; error?: string };
export type VideosMsg = { t: 'videos'; jobs: VideoJob[]; ffmpeg: FfmpegState };

/** A slide: the title card, or a step (its code, when it has some and code is on). What it says is its narration. */
export type VideoSlide = {
  id: string;
  kind: 'title' | 'step';
  title: string;
  /** the title card: the task */
  sub?: string;
  /** a step: its place, its kind, its file */
  n?: number;
  of?: number;
  badge?: DebriefKind;
  file?: string;
  code?: { start: number; lines: string[]; lit: Array<[number, number]> };
  narration: string;
  /** the title card: its orb (default on) */
  orb?: boolean;
  /** a subtitle drawn under it */
  caption?: string;
  /** recorded moving (this many frames), not as one picture: the title's orb */
  record?: number;
};

/** Code shown on a slide: at most this many lines, around what the step is about. */
const MAX_LINES = 22;

/** A debrief's slides: a title card, then a slide per step; each with its narration (from the task, and the step's beats). */
export function videoSlides(d: Pick<Debrief, 'title' | 'task' | 'steps' | 'snaps'>, o: { code: boolean }): VideoSlide[] {
  const of = d.steps.length;
  const slides: VideoSlide[] = [{ id: '00-title', kind: 'title', title: d.title, sub: d.task, narration: forEar(`${d.title}. ${d.task}`) }];
  d.steps.forEach((s, i) => {
    const snap = d.snaps?.[i];
    const lit = [s.range, ...s.beats.map((b) => b.range)].filter((r): r is [number, number] => !!r);
    let code: VideoSlide['code'];
    if (o.code && snap?.lines.length) {
      // the lines it's about, a little around them; at most MAX_LINES (from the first lit line when there are more)
      const end = snap.start + snap.lines.length - 1;
      const lo = lit.length ? Math.min(...lit.map((r) => r[0])) : snap.start;
      const hi = lit.length ? Math.max(...lit.map((r) => r[1])) : end;
      let from = Math.max(snap.start, lo - 2);
      let to = Math.min(end, hi + 2);
      if (to - from + 1 > MAX_LINES) {
        from = Math.max(snap.start, lo - 1);
        to = Math.min(end, from + MAX_LINES - 1);
      }
      code = { start: from, lines: snap.lines.slice(from - snap.start, to - snap.start + 1), lit };
    }
    const file = s.path ? s.path.replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/') : undefined;
    slides.push({ id: `${String(i + 1).padStart(2, '0')}-step`, kind: 'step', title: s.title, n: i + 1, of, badge: s.kind, ...(file ? { file } : {}), ...(code ? { code } : {}), narration: forEar(s.beats.map((b) => b.text).join(' ')) });
  });
  return slides;
}

/** Text as it should be said: no markdown, no backticks, links as their words, no bare URLs; paths as their last part. */
export function forEar(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/])+([\w.-]+\.\w+)/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
