import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO, captions, videoSlides, forEar, type Debrief, type VideoJob, type VideoSlide } from '@cora/shared';
import { Videos, type Run } from '../src/videos';

const debrief: Debrief = {
  id: 'd1',
  sessionId: 's1',
  createdAt: 1,
  title: 'Tag chips',
  task: 'Show tags as chips on the search page.',
  depth: 'quick',
  steps: [
    { title: 'The chip', kind: 'change', path: 'C:\\code\\app\\src\\Chip.tsx', range: [3, 4], beats: [{ text: 'A `Chip` renders one tag.' }, { text: 'See [the docs](https://x.io).' }] },
    { title: 'Nothing to say', kind: 'risk', beats: [] },
  ],
  snaps: { 0: { start: 1, lines: ['a', 'b', 'c', 'd', 'e', 'f'] } },
};

function setup(o: { ffmpeg?: boolean; now?: () => number; dir?: string; moving?: boolean } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'cora-videos-'));
  const calls: string[][] = [];
  const voiced: Array<{ text: string; previousText?: string }> = [];
  const drawn: Array<{ slides: VideoSlide[]; color?: string }> = [];
  let ffmpeg = o.ffmpeg ?? true;
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('-version')) return { code: ffmpeg ? 0 : 1, out: '', err: '' };
    if (cmd.includes('ffprobe')) return { code: 0, out: '2.5\n', err: '' };
    writeFileSync(args[args.length - 1], 'mp4');
    return { code: 0, out: '', err: '' };
  };
  let changes = 0;
  const v = new Videos({
    dir: join(dir, 'videos'),
    toolsDir: join(dir, 'tools'),
    debrief: (sid, id) => (sid === 's1' && id === 'd1' ? debrief : null),
    settings: () => ({ ...DEFAULT_VIDEO, coraVoice: 'cora-voice' }),
    voice: async (text, x) => (voiced.push({ text, ...(x.previousText ? { previousText: x.previousText } : {}) }), new Uint8Array([1, 2, 3])),
    draw: async (slides, color) => (drawn.push({ slides, ...(color ? { color } : {}) }), slides.map((x) => (o.moving && x.record ? [1, 2, 3, 4].map((n) => new Uint8Array([n])) : new Uint8Array([0x89, 0x50])))),
    onChange: () => void changes++,
    run,
    ...(o.now ? { now: o.now } : {}),
  });
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { v, dir, calls, voiced, drawn, until, changes: () => changes, ffmpegOn: () => void (ffmpeg = true) };
}

describe('debrief videos', () => {
  it("slides from the debrief: a title card, a slide a step (its code around its lines), narration for the ear", () => {
    const s = videoSlides(debrief, { code: true });
    expect(s.map((x) => x.id)).toEqual(['00-title', '01-step', '02-step']);
    expect(s[0]).toMatchObject({ kind: 'title', narration: 'Tag chips. Show tags as chips on the search page.' });
    expect(s[1]).toMatchObject({ n: 1, of: 2, badge: 'change', file: 'src/Chip.tsx', code: { start: 1, lines: ['a', 'b', 'c', 'd', 'e', 'f'], lit: [[3, 4]] }, narration: 'A Chip renders one tag. See the docs.' });
    expect(s[2].narration).toBe('');
    expect(videoSlides(debrief, { code: false })[1].code).toBeUndefined();
    expect(forEar('Open `C:\\code\\app\\src\\Chip.tsx` at https://x.io/a **now**')).toBe('Open Chip.tsx at a link now');
  });

  it('made: drawn, voiced (each line carrying on from the last; a line with nothing to say is quiet), put together, ready; again: no line voiced twice', async () => {
    const { v, voiced, calls, until } = setup();
    const j = v.make('s1', 'd1') as VideoJob;
    await until(() => j.stage === 'ready' || j.stage === 'failed');
    expect(j).toMatchObject({ stage: 'ready', seconds: expect.any(Number), size: '1080', title: 'Tag chips' });
    expect(j.error).toBeUndefined();
    expect(voiced.map((x) => x.text)).toEqual(['Tag chips. Show tags as chips on the search page.', 'A Chip renders one tag. See the docs.']);
    expect(voiced[1].previousText).toBe(voiced[0].text);
    expect(j.chars).toBe(voiced[0].text.length + voiced[1].text.length);
    expect(existsSync(v.file(j))).toBe(true);
    // the title's push-in; the quiet slide: silence
    const clips = calls.filter((c) => c[0] === 'ffmpeg' && c.includes('-loop'));
    expect(clips).toHaveLength(3);
    expect(clips[0].join(' ')).toMatch(/zoompan=z='1\+0\.05\*in\/\d+'.*d=1:s=1920x1080/);
    expect(clips[2].join(' ')).toContain('anullsrc');
    expect(calls.some((c) => c.includes('concat') && c.includes('+faststart'))).toBe(true);
    // the same lines again (the first with its own plan): nothing voiced twice; nothing to voice now costs nothing
    expect(v.estimate('', 1, [voiced[0].text, 'A new line.'])).toBe('A new line.'.length);
    const again = v.make('s1', 'd1', { ...DEFAULT_VIDEO, voiceId: '', size: '720', code: false, title: 'Tag chips', sub: 'Show tags as chips on the search page.', slides: [{ id: '00-title', narration: voiced[0].text }] }) as VideoJob;
    await until(() => again.stage === 'ready' || again.stage === 'failed');
    expect(again).toMatchObject({ stage: 'ready', size: '720', chars: 0 });
    expect(voiced).toHaveLength(2);
    expect(v.make('s1', 'nope')).toEqual({ error: 'no such debrief' });
    expect(v.make('s1', 'd1', { ...DEFAULT_VIDEO, title: 'x', sub: '', slides: [] })).toEqual({ error: expect.stringMatching(/slides/) });
  });

  it('as you set it up: steps left out and reordered, words changed, the title re-worded, its accent; subtitles a line at a time', async () => {
    const { v, voiced, calls, drawn, until } = setup();
    const j = v.make('s1', 'd1', {
      ...DEFAULT_VIDEO,
      subtitles: true,
      orb: false,
      color: '#3ddc97',
      title: 'Chips!',
      sub: 'Tags, as chips.',
      slides: [
        { id: '01-step', narration: 'First sentence is here and it runs on for a while to fill a line. A second one follows it and it is quite long too.' },
        { id: '00-title', narration: 'Chips.' },
      ],
    }) as VideoJob;
    await until(() => j.stage === 'ready' || j.stage === 'failed');
    expect(j).toMatchObject({ stage: 'ready', title: 'Chips!' });
    expect(voiced.map((x) => x.text)).toEqual(['First sentence is here and it runs on for a while to fill a line. A second one follows it and it is quite long too.', 'Chips.']);
    // drawn: the step with its subtitle lines, then the title card (no orb, its own words); in its accent
    expect(drawn[0].color).toBe('#3ddc97');
    expect(drawn[0].slides.map((s) => [s.id, s.caption, s.n, s.of])).toEqual([['01-step', 'First sentence is here and it runs on for a while to fill a line.', 1, 1], ['01-step', 'A second one follows it and it is quite long too.', 1, 1], ['00-title', 'Chips.', undefined, undefined]]);
    expect(drawn[0].slides[2]).toMatchObject({ title: 'Chips!', sub: 'Tags, as chips.', orb: false });
    // subtitles in turn: the step's two lines one after the other (the concat demuxer, timed by length); the title one picture
    const clips = calls.filter((c) => c[0] === 'ffmpeg' && c.some((x) => x.endsWith('.mp4')) && !c.includes('+faststart'));
    expect(clips[0].join(' ')).toMatch(/-f concat -safe 0 -i \S+01-step-seq\.txt/);
    expect(clips[1]).toContain('-loop');
    expect(captions('One. Two. ' + 'word '.repeat(40))).toEqual(['One. Two.', expect.stringMatching(/^word/), expect.stringMatching(/^word/)]);
  });

  it('the title moves: its orb recorded (frames asked for), looped forward and back, then pushed in; the steps stay still', async () => {
    const { v, calls, drawn, dir, until } = setup({ moving: true });
    const j = v.make('s1', 'd1') as VideoJob;
    await until(() => j.stage === 'ready' || j.stage === 'failed');
    expect(j.error).toBeUndefined();
    expect(drawn[0].slides.map((s) => s.record ?? 0)).toEqual([48, 0, 0]);
    // the frames written as a run: 4 recorded, played forward and back (6), then a clip of them, then the push-in on it
    const motion = calls.find((c) => c.includes('%04d') || c.some((x) => x.endsWith('-f%04d.jpg')));
    expect(motion?.join(' ')).toMatch(/-loop 1 -framerate 24 -i \S+00-title-0-f%04d\.jpg/);
    const titleClip = calls.find((c) => c.some((x) => x.endsWith('00-title.mp4')));
    expect(titleClip?.join(' ')).toMatch(/-i \S+00-title-m0\.mp4 .*zoompan/);
    expect(existsSync(join(dir, 'videos', j.id, '00-title-0-f0005.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'videos', j.id, '00-title-0-f0006.jpg'))).toBe(false);
  });

  it("no ffmpeg: it waits for your OK (nothing drawn or voiced); you'd rather not: it stops", async () => {
    const { v, voiced, until } = setup({ ffmpeg: false });
    await until(() => v.ffmpeg().state === 'missing');
    const j = v.make('s1', 'd1') as VideoJob;
    await until(() => j.stage === 'ffmpeg');
    expect(j.stage).toBe('ffmpeg');
    expect(voiced).toEqual([]);
    v.decline();
    expect(j).toMatchObject({ stage: 'failed', error: expect.stringMatching(/need ffmpeg/) });
  });

  it('kept until it expires (across a restart); then gone, files and all', async () => {
    let t = Date.now();
    const a = setup({ now: () => t });
    const j = a.v.make('s1', 'd1') as VideoJob;
    await a.until(() => j.stage === 'ready');
    const again = setup({ dir: a.dir, now: () => t });
    expect(again.v.list().map((x) => x.id)).toEqual([j.id]);
    t += 25 * 3_600_000;
    again.v.sweep();
    expect(again.v.list()).toEqual([]);
    expect(existsSync(again.v.file(j))).toBe(false);
    a.v.close();
    again.v.close();
  });
});
