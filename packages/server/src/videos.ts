import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VIDEO, SHOT_BOX, captions, planSlides, videoPlanProblem, videoSlides, type Debrief, type FfmpegState, type VideoJob, type VideoPlan, type VideoSettings, type VideoSlide } from '@cora/shared';

/**
 * Debrief videos: a debrief as a short narrated video. Its
 * slides drawn by the desktop app (out of sight), each step's beats voiced with Cora's ElevenLabs key (cached by line,
 * so a re-make voices only what changed), put together with ffmpeg (yours, or one Cora downloads when you say so), kept
 * in ~/.cora/videos/<id>/ until it expires (unless you saved a copy: yours).
 */
export type Run = (cmd: string, args: string[]) => Promise<{ code: number; out: string; err: string }>;
type Opts = {
  dir: string;
  toolsDir: string;
  /** the debrief */
  debrief(sessionId: string, id: string): Debrief | null;
  /** the settings now, and the voice to use when they name none (Cora's own) */
  settings(): VideoSettings & { coraVoice: string };
  /** a clip of narration */
  voice(text: string, o: { voiceId: string; speed: number; model?: string; previousText?: string }): Promise<Uint8Array>;
  /** the slides as pictures (the desktop app), 1920×1080 PNGs; in this accent (none: your Cora colour) */
  draw(slides: VideoSlide[], color?: string): Promise<Array<Uint8Array | Uint8Array[]>>;
  onChange(): void;
  run?: Run;
  now?: () => number;
  /** where ffmpeg comes from when Cora downloads it (Windows) */
  downloadUrl?: string;
  fetch?: typeof fetch;
};

const FPS = 30;
/** the title's orb moves: this many frames of it are recorded (at REC_FPS), played forward and back, looped */
const REC_FRAMES = 48;
const REC_FPS = 24;
const LEAD = 0.4;
const TAIL = 0.9;
const FADE = 0.35;
/** a step's picture is pushed in at most this far (its focus fills the box, or as near as this gets) */
const MAX_PUSH = 1.5;
/** a slide with nothing to say stays this long */
const QUIET = 3;
const VOICE_KEEP_MS = 7 * 86_400_000;
const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const EXE = process.platform === 'win32' ? '.exe' : '';

export const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });

type Tools = { ffmpeg: string; ffprobe: string };

export class Videos {
  private jobs = new Map<string, VideoJob>();
  private ff: FfmpegState = { state: 'missing', canDownload: process.platform === 'win32' };
  private tools: Tools | null = null;
  /** videos waiting for ffmpeg: carried on when it's here */
  private waiting = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval>;
  private run: Run;
  private now: () => number;

  constructor(private o: Opts) {
    this.run = o.run ?? run;
    this.now = o.now ?? Date.now;
    mkdirSync(o.dir, { recursive: true });
    // videos from before a restart (the ones not expired), the rest gone
    for (const id of safeList(o.dir)) {
      if (id === 'voice') continue;
      const meta = join(o.dir, id, 'meta.json');
      try {
        const j = JSON.parse(readFileSync(meta, 'utf8')) as VideoJob;
        if (j.stage === 'ready' && j.expiresAt > this.now() && existsSync(this.file(j))) this.jobs.set(j.id, j);
        else rmSync(join(o.dir, id), { recursive: true, force: true });
      } catch {
        rmSync(join(o.dir, id), { recursive: true, force: true });
      }
    }
    this.timer = setInterval(() => this.sweep(), 3_600_000);
    this.timer.unref?.();
    void this.locate();
  }

  list(): VideoJob[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  ffmpeg(): FfmpegState {
    return this.ff;
  }
  get(id: string): VideoJob | undefined {
    return this.jobs.get(id);
  }
  /** a ready video's MP4 */
  file(j: Pick<VideoJob, 'id' | 'title'>): string {
    return join(this.o.dir, j.id, `${fileName(j.title)}.mp4`);
  }

  /**
   * Make a video of a debrief (it carries on in the background; its progress comes with onChange): as you set it up
   * (the plan), else as your settings have it.
   */
  make(sessionId: string, debriefId: string, plan?: VideoPlan): VideoJob | { error: string } {
    const d = this.o.debrief(sessionId, debriefId);
    if (!d) return { error: 'no such debrief' };
    if (plan) {
      const why = videoPlanProblem(plan);
      if (why) return { error: why };
    }
    const s = this.o.settings();
    const p: VideoPlan = plan ?? { ...s, title: d.title, sub: d.task, slides: videoSlides(d, { code: s.code }).map((x) => ({ id: x.id, narration: x.narration })) };
    const at = this.now();
    const job: VideoJob = { id: `${at.toString(36)}-${randomBytes(3).toString('hex')}`, sessionId, debriefId, title: p.title.trim() || d.title, stage: 'drawing', done: 0, total: p.slides.length, chars: 0, createdAt: at, expiresAt: at + p.keepHours * 3_600_000, size: p.size };
    this.jobs.set(job.id, job);
    void this.build(job, d, { ...p, voiceId: p.voiceId || s.coraVoice, model: p.model || s.model || DEFAULT_VIDEO.model });
    this.o.onChange();
    return job;
  }

  /** What voicing these lines would cost: the characters not voiced before (with this voice, model and pace). */
  estimate(voiceId: string, speed: number, lines: string[], model?: string): number {
    const v = voiceId || this.o.settings().coraVoice;
    const m = model || this.o.settings().model;
    return lines.reduce((n, t) => (t.trim() && !existsSync(this.voiced(v, speed, t.trim(), m)) ? n + t.trim().length : n), 0);
  }
  private voiced(voiceId: string, speed: number, text: string, model: string): string {
    return join(this.o.dir, 'voice', `${createHash('sha1').update(`${voiceId}|${model}|${speed}|${text}`).digest('hex')}.mp3`);
  }

  /** Take a video away (and its files). */
  remove(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    this.jobs.delete(id);
    this.waiting.delete(id);
    rmSync(join(this.o.dir, id), { recursive: true, force: true });
    this.o.onChange();
    return true;
  }

  /** You'd rather install ffmpeg yourself: the videos waiting for it stop. */
  decline(): void {
    for (const id of [...this.waiting.keys()]) this.fail(this.jobs.get(id), 'Debrief videos need ffmpeg: install it, then make the video again');
    this.waiting.clear();
  }

  /** Download ffmpeg into Cora's folder (after you said so), then carry on with the videos waiting for it. */
  async download(): Promise<void> {
    if (this.ff.state === 'downloading' || this.ff.state === 'found') return;
    if (process.platform !== 'win32') {
      this.ff = { state: 'missing', canDownload: false, error: 'Install ffmpeg with your package manager (brew install ffmpeg, apt install ffmpeg)' };
      return this.o.onChange();
    }
    this.ff = { state: 'downloading', got: 0, total: 0 };
    this.o.onChange();
    const zip = join(this.o.toolsDir, 'ffmpeg.zip');
    const tmp = join(this.o.toolsDir, 'ffmpeg-new');
    try {
      mkdirSync(this.o.toolsDir, { recursive: true });
      const r = await (this.o.fetch ?? fetch)(this.o.downloadUrl ?? FFMPEG_ZIP, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`the download failed (${r.status})`);
      const total = Number(r.headers.get('content-length')) || 0;
      let got = 0;
      let told = 0;
      const out = createWriteStream(zip);
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
        if (got - told > 2_000_000) {
          told = got;
          this.ff = { state: 'downloading', got, total };
          this.o.onChange();
        }
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      // Windows' own tar opens a zip (Git's doesn't: by its full path)
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      const x = await this.run(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', tmp]);
      if (x.code !== 0) throw new Error(`unpacking it failed: ${x.err.trim().slice(0, 200)}`);
      const bin = findBin(tmp);
      if (!bin) throw new Error("ffmpeg wasn't in the download");
      const dest = join(this.o.toolsDir, 'ffmpeg');
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      renameSync(bin, join(dest, 'bin'));
      rmSync(tmp, { recursive: true, force: true });
      rmSync(zip, { force: true });
      await this.locate();
      if (!this.tools) throw new Error("the downloaded ffmpeg doesn't run");
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(zip, { force: true });
      this.ff = { state: 'missing', canDownload: true, error: (e as Error).message };
      this.o.onChange();
    }
  }

  /** ffmpeg: Cora's own download, else one on your PATH. Videos waiting for it carry on. */
  private async locate(): Promise<void> {
    const own = join(this.o.toolsDir, 'ffmpeg', 'bin');
    const mine: Tools = { ffmpeg: join(own, `ffmpeg${EXE}`), ffprobe: join(own, `ffprobe${EXE}`) };
    const path: Tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
    for (const t of existsSync(mine.ffmpeg) ? [mine, path] : [path]) {
      const [a, b] = await Promise.all([this.run(t.ffmpeg, ['-version']), this.run(t.ffprobe, ['-version'])]);
      if (a.code === 0 && b.code === 0) {
        this.tools = t;
        this.ff = { state: 'found', path: t.ffmpeg };
        for (const go of [...this.waiting.values()]) go();
        this.waiting.clear();
        return this.o.onChange();
      }
    }
    if (this.ff.state !== 'downloading') this.ff = { state: 'missing', canDownload: process.platform === 'win32', ...(this.ff.state === 'missing' && this.ff.error ? { error: this.ff.error } : {}) };
  }

  private set(j: VideoJob, patch: Partial<VideoJob>): void {
    Object.assign(j, patch);
    this.o.onChange();
  }
  private fail(j: VideoJob | undefined, why: string): void {
    if (!j) return;
    this.set(j, { stage: 'failed', error: why });
    rmSync(join(this.o.dir, j.id), { recursive: true, force: true });
  }

  private async build(j: VideoJob, d: Debrief, p: VideoPlan): Promise<void> {
    const dir = join(this.o.dir, j.id);
    try {
      // ffmpeg first: nothing is drawn or voiced (paid for) without it
      if (!this.tools) await this.locate();
      if (!this.tools) {
        this.set(j, { stage: 'ffmpeg' });
        await new Promise<void>((go) => this.waiting.set(j.id, go));
        if (!this.jobs.has(j.id) || j.stage === 'failed') return;
      }
      const tools = this.tools!;
      if (!p.voiceId) throw new Error('no voice: choose one in Settings › Voice');
      const slides = planSlides(videoSlides(d, { code: p.code }), p);
      if (!slides.length) throw new Error('no slides left in it');
      mkdirSync(dir, { recursive: true });
      // the slides, drawn and fitted, before anything is voiced; with subtitles, once a line of them
      const lines = slides.map((s) => (p.subtitles && s.narration ? captions(s.narration) : []));
      // the title with its orb: recorded moving, not one picture
      const moving = (s: VideoSlide) => s.kind === 'title' && s.orb !== false;
      const draws = slides.flatMap((s, i) => (lines[i].length ? lines[i].map((c) => ({ ...s, caption: c })) : [s]).map((x) => (moving(s) ? { ...x, record: REC_FRAMES } : x)));
      this.set(j, { stage: 'drawing', done: 0, total: slides.length });
      const pics = await this.o.draw(draws, p.color);
      if (pics.length !== draws.length) throw new Error("the slides weren't all drawn");
      // a picture per slide (per subtitle line); a moving one's frames as a numbered run, forward then back (it loops
      // without a jump)
      const files: string[][] = [];
      let k = 0;
      slides.forEach((s, i) => {
        files[i] = [];
        for (let c = 0; c < Math.max(1, lines[i].length); c++) {
          const pic = pics[k++];
          if (Array.isArray(pic) && pic.length > 1) {
            const run = [...pic, ...pic.slice(1, -1).reverse()];
            run.forEach((f, n) => writeFileSync(join(dir, `${s.id}-${c}-f${String(n).padStart(4, '0')}.jpg`), f));
            files[i].push(join(dir, `${s.id}-${c}-f%04d.jpg`));
          } else {
            const f = join(dir, `${s.id}-${c}.png`);
            writeFileSync(f, Array.isArray(pic) ? pic[0] : pic);
            files[i].push(f);
          }
        }
      });
      // their narration, each carrying on from the last (a line said before comes from the cache)
      this.set(j, { stage: 'voicing', done: 0 });
      mkdirSync(join(this.o.dir, 'voice'), { recursive: true });
      const audio: Array<string | null> = [];
      for (let i = 0; i < slides.length; i++) {
        const text = slides[i].narration;
        if (!text) {
          audio.push(null);
        } else {
          const f = this.voiced(p.voiceId, p.speed, text, p.model);
          if (!existsSync(f)) {
            writeFileSync(f, await this.o.voice(text, { voiceId: p.voiceId, speed: p.speed, model: p.model, ...(i ? { previousText: slides[i - 1].narration } : {}) }));
            j.chars += text.length;
          }
          audio.push(f);
        }
        if (!this.jobs.has(j.id)) return;
        this.set(j, { done: i + 1 });
      }
      // a clip a slide (the title's a slow push-in; with subtitles, its lines in turn), then one after the other
      this.set(j, { stage: 'building', done: 0 });
      const [W, H] = p.size === '720' ? [1280, 720] : [1920, 1080];
      const parts: string[] = [];
      let seconds = 0;
      for (let i = 0; i < slides.length; i++) {
        const a = audio[i];
        const said = a ? await this.duration(tools, a) : 0;
        const total = a ? LEAD + said + TAIL : QUIET;
        const frames = Math.round(total * FPS);
        const out = join(dir, `${slides[i].id}.mp4`);
        let picture: string[];
        let vf: string;
        // its share of what's said, a subtitle line at a time (the first from the start, the last to the end)
        const lens = lines[i].map((c) => c.length);
        const sum = lens.reduce((x, y) => x + y, 0);
        const times = files[i].length > 1 ? lens.map((n, c) => (said * n) / sum + (c === 0 ? LEAD : 0) + (c === lens.length - 1 ? TAIL : 0)) : [total];
        if (files[i].some((f) => f.includes('%04d'))) {
          // moving: its frames looped for each line's time, one after the other, then pushed in like a still title
          const clips: string[] = [];
          for (let c = 0; c < files[i].length; c++) {
            const clip = join(dir, `${slides[i].id}-m${c}.mp4`);
            const src = files[i][c].includes('%04d') ? ['-loop', '1', '-framerate', String(REC_FPS), '-i', files[i][c]] : ['-loop', '1', '-framerate', String(FPS), '-i', files[i][c]];
            const r = await this.run(tools.ffmpeg, ['-y', '-v', 'error', ...src, '-t', times[c].toFixed(3), '-vf', `fps=${FPS},format=yuv420p`, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', clip]);
            if (r.code !== 0) throw new Error(`ffmpeg failed on slide ${i + 1}'s motion: ${r.err.trim().split('\n').pop()?.slice(0, 200)}`);
            clips.push(clip);
          }
          let video = clips[0];
          if (clips.length > 1) {
            const list = join(dir, `${slides[i].id}-m.txt`);
            writeFileSync(list, clips.map((x) => `file '${concatPath(x)}'\n`).join(''));
            video = join(dir, `${slides[i].id}-m.mp4`);
            const r = await this.run(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
            if (r.code !== 0) throw new Error(`ffmpeg failed joining slide ${i + 1}'s motion: ${r.err.trim().split('\n').pop()?.slice(0, 200)}`);
          }
          picture = ['-i', video];
          vf = `scale=${W * 2}:-1,zoompan=z='1+0.05*in/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
        } else if (files[i].length > 1) {
          const seq = join(dir, `${slides[i].id}-seq.txt`);
          writeFileSync(seq, files[i].map((f, c) => `file '${concatPath(f)}'\nduration ${times[c].toFixed(3)}\n`).join('') + `file '${concatPath(files[i][files[i].length - 1])}'\n`);
          picture = ['-f', 'concat', '-safe', '0', '-i', seq];
          vf = `scale=${W}:${H},fps=${FPS}`;
        } else {
          picture = ['-loop', '1', '-framerate', String(FPS), '-i', files[i][0]];
          vf = slides[i].kind === 'title' ? `scale=${W * 2}:-1,zoompan=z='1+0.05*in/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}` : `scale=${W}:${H},fps=${FPS}`;
        }
        const fades = `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(total - FADE).toFixed(3)}:d=${FADE},format=yuv420p`;
        const ms = Math.round(LEAD * 1000);
        const sound = a ? ['-i', a] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
        const af = a ? `adelay=${ms}|${ms},apad,atrim=0:${total.toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo` : `atrim=0:${total.toFixed(3)}`;
        const shot = slides[i].shot;
        const args = shot
          ? // its picture (or clip: played once, then held) in the slide's frame, pushed in toward what it's about
            [...picture, ...(shot.clip ? ['-i', shot.file] : ['-loop', '1', '-framerate', String(FPS), '-i', shot.file]), ...sound, '-filter_complex', `${shotGraph(shot, W, H, frames, vf, fades)};[2:a]${af}[a]`, '-map', '[v]', '-map', '[a]']
          : [...picture, ...sound, '-vf', `${vf},${fades}`, '-af', af];
        const r = await this.run(tools.ffmpeg, ['-y', '-v', 'error', ...args, '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', out]);
        if (r.code !== 0) throw new Error(`ffmpeg failed on slide ${i + 1}: ${r.err.trim().split('\n').pop()?.slice(0, 200)}`);
        parts.push(out);
        seconds += total;
        if (!this.jobs.has(j.id)) return;
        this.set(j, { done: i + 1 });
      }
      const list = join(dir, 'list.txt');
      writeFileSync(list, parts.map((x) => `file '${concatPath(x)}'\n`).join(''));
      const mp4 = this.file(j);
      const r = await this.run(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', mp4]);
      if (r.code !== 0) throw new Error(`ffmpeg couldn't join the slides: ${r.err.trim().split('\n').pop()?.slice(0, 200)}`);
      for (const x of [...parts, list]) rmSync(x, { force: true });
      this.set(j, { stage: 'ready', seconds: Math.round(seconds), bytes: statSync(mp4).size, done: slides.length });
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(j));
    } catch (e) {
      if (this.jobs.has(j.id)) this.fail(j, (e as Error).message);
    }
  }

  private async duration(t: Tools, f: string): Promise<number> {
    const r = await this.run(t.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]);
    const s = Number.parseFloat(r.out.trim());
    if (!Number.isFinite(s)) throw new Error(`couldn't read the narration's length (${r.err.trim().slice(0, 120)})`);
    return s;
  }

  /** Videos past their time go (with their files), failed ones after a while; the voice cache keeps a week. */
  sweep(): void {
    const now = this.now();
    let changed = false;
    for (const j of [...this.jobs.values()]) {
      if (j.expiresAt <= now || (j.stage === 'failed' && now - j.createdAt > 3_600_000)) {
        this.jobs.delete(j.id);
        rmSync(join(this.o.dir, j.id), { recursive: true, force: true });
        changed = true;
      }
    }
    const cache = join(this.o.dir, 'voice');
    for (const f of safeList(cache)) {
      try {
        if (now - statSync(join(cache, f)).mtimeMs > VOICE_KEEP_MS) rmSync(join(cache, f), { force: true });
      } catch {
        /* gone */
      }
    }
    if (changed) this.o.onChange();
  }

  close(): void {
    clearInterval(this.timer);
  }
}

const safeList = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The folder holding ffmpeg (and ffprobe) somewhere in what was unpacked. */
/**
 * A step's picture on its slide, as an ffmpeg graph: the slide's frame (input 0, through `bg`), the picture (input 1; a
 * clip plays once, then holds its last frame) fitted into SHOT_BOX and eased from the whole of it toward its focus over
 * most of the slide (no focus: a gentle push-in), laid on the frame; out as [v].
 */
export function shotGraph(shot: NonNullable<VideoSlide['shot']>, W: number, H: number, frames: number, bg: string, fades: string): string {
  const k = W / 1920;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const [bw, bh] = [even(SHOT_BOX.w * k), even(SHOT_BOX.h * k)];
  const [fx, fy, fw, fh] = shot.focus ?? [0, 0, 1, 1];
  const zoom = shot.focus ? Math.min(MAX_PUSH, Math.max(1, 0.92 / Math.max(fw, fh))) : 1.04;
  const [cx, cy] = [fx + fw / 2, fy + fh / 2];
  const n = Math.max(1, Math.round(frames * 0.65));
  // smoothstep over the first two thirds, then held
  const e = `(pow(min(1,on/${n}),2)*(3-2*min(1,on/${n})))`;
  const z = `1+${(zoom - 1).toFixed(4)}*${e}`;
  const x = `max(0,min(iw-iw/zoom,(0.5+${(cx - 0.5).toFixed(4)}*${e})*iw-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,(0.5+${(cy - 0.5).toFixed(4)}*${e})*ih-ih/zoom/2))`;
  const hold = shot.clip ? 'tpad=stop_mode=clone:stop_duration=3600,' : '';
  return (
    `[0:v]${bg}[b];` +
    `[1:v]${hold}fps=${FPS},scale=${bw * 2}:${bh * 2}:force_original_aspect_ratio=increase,crop=${bw * 2}:${bh * 2},setsar=1,zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${bw}x${bh}:fps=${FPS}[m];` +
    `[b][m]overlay=${Math.round(SHOT_BOX.x * k)}:${Math.round(SHOT_BOX.y * k)}:eof_action=repeat,${fades}[v]`
  );
}

function findBin(root: string, depth = 0): string | null {
  if (existsSync(join(root, `ffmpeg${EXE}`)) && existsSync(join(root, `ffprobe${EXE}`))) return root;
  if (depth > 3) return null;
  for (const name of safeList(root)) {
    const p = join(root, name);
    try {
      if (statSync(p).isDirectory()) {
        const hit = findBin(p, depth + 1);
        if (hit) return hit;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/** A path as the concat demuxer reads it. */
const concatPath = (p: string) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");

/** A title as a file name. */
export const fileName = (t: string) => t.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Debrief';
