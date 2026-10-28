import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tailer, type TailInfo } from '../src/transcript/tailer';

let root: string;
let got: Array<{ file: string; objs: any[]; info: TailInfo }>;
let tailer: Tailer;
const line = (o: object) => JSON.stringify(o) + '\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ab-tail-'));
  mkdirSync(join(root, 'C--proj', 'sess-1', 'subagents'), { recursive: true });
  got = [];
});
afterEach(async () => {
  await tailer?.stop();
  rmSync(root, { recursive: true, force: true });
});

const mk = (opts = {}) => (tailer = new Tailer(root, (file, objs, info) => got.push({ file, objs, info }), { watch: false, ...opts }));

describe('Tailer', () => {
  it('reads recent files from the start and identifies session/agent', async () => {
    writeFileSync(join(root, 'C--proj', 'sess-1.jsonl'), line({ a: 1 }) + line({ a: 2 }));
    writeFileSync(join(root, 'C--proj', 'sess-1', 'subagents', 'agent-abc.jsonl'), line({ b: 1 }));
    await mk().start();
    const main = got.find((g) => g.info.agentId === 'main')!;
    expect(main.objs).toEqual([{ a: 1 }, { a: 2 }]);
    expect(main.info).toEqual({ sessionId: 'sess-1', agentId: 'main', projectSlug: 'C--proj' });
    expect(got.find((g) => g.info.agentId === 'abc')!.info.sessionId).toBe('sess-1');
  });

  it('only delivers appended bytes and buffers partial lines', async () => {
    const f = join(root, 'C--proj', 'sess-1.jsonl');
    writeFileSync(f, line({ n: 1 }));
    await mk().start();
    got = [];
    const l2 = line({ n: 2, text: 'héllo' });
    appendFileSync(f, l2.slice(0, 7));
    await tailer.pollOnce();
    expect(got.flatMap((g) => g.objs)).toEqual([]);
    appendFileSync(f, l2.slice(7) + line({ n: 3 }));
    await tailer.pollOnce();
    expect(got.flatMap((g) => g.objs)).toEqual([{ n: 2, text: 'héllo' }, { n: 3 }]);
  });

  it('picks up new files created after start', async () => {
    await mk().start();
    writeFileSync(join(root, 'C--proj', 'sess-2.jsonl'), line({ z: 1 }));
    await tailer.pollOnce();
    expect(got.find((g) => g.info.sessionId === 'sess-2')!.objs).toEqual([{ z: 1 }]);
  });

  it('re-reads from 0 when a file shrinks', async () => {
    const f = join(root, 'C--proj', 'sess-1.jsonl');
    writeFileSync(f, line({ n: 1 }) + line({ n: 2 }));
    await mk().start();
    got = [];
    truncateSync(f, 0);
    appendFileSync(f, line({ n: 9 }));
    await tailer.pollOnce();
    expect(got.flatMap((g) => g.objs)).toEqual([{ n: 9 }]);
  });

  it('skips history of old files but follows their new appends', async () => {
    const f = join(root, 'C--proj', 'old.jsonl');
    writeFileSync(f, line({ old: true }));
    const past = new Date(Date.now() - 3 * 86400_000);
    utimesSync(f, past, past);
    await mk({ sinceMs: 86400_000 }).start();
    expect(got).toHaveLength(0);
    appendFileSync(f, line({ fresh: true }));
    await tailer.pollOnce();
    expect(got.flatMap((g) => g.objs)).toEqual([{ fresh: true }]);
  });

  it('counts and skips malformed lines', async () => {
    writeFileSync(join(root, 'C--proj', 'sess-1.jsonl'), '{bad json\n' + line({ ok: 1 }));
    await mk().start();
    expect(got.flatMap((g) => g.objs)).toEqual([{ ok: 1 }]);
    expect(tailer.badLines).toBe(1);
  });
});

describe('Tailer, across a restart', () => {
  it("what was read before comes again quietly (the parser's context), only what's new is news; a file rewritten shorter: all news", async () => {
    const reads = new Map<string, number>();
    const store = { get: (f: string) => reads.get(f), set: (f: string, n: number) => void reads.set(f, n) };
    const f = join(root, 'C--proj', 'sess-1.jsonl');
    writeFileSync(f, line({ n: 1 }) + line({ n: 2 }) + '{"n":3');
    await mk({ reads: store }).start();
    expect(got.map((g) => [g.objs, !!g.info.quiet])).toEqual([[[{ n: 1 }, { n: 2 }], false]]);
    expect(reads.get(f)).toBe(line({ n: 1 }).length + line({ n: 2 }).length);
    await tailer.stop();
    // Cora restarts; meanwhile the half-written line was finished and another came
    appendFileSync(f, '}\n' + line({ n: 4 }));
    got = [];
    await mk({ reads: store }).start();
    expect(got.map((g) => [g.objs, !!g.info.quiet])).toEqual([
      [[{ n: 1 }, { n: 2 }], true],
      [[{ n: 3 }, { n: 4 }], false],
    ]);
    // and as it grows: news
    appendFileSync(f, line({ n: 5 }));
    got = [];
    await tailer.pollOnce();
    expect(got.map((g) => [g.objs, !!g.info.quiet])).toEqual([[[{ n: 5 }], false]]);
    await tailer.stop();
    // rewritten, shorter than what was read: nothing in it is known
    writeFileSync(f, line({ n: 9 }));
    got = [];
    await mk({ reads: store }).start();
    expect(got.map((g) => [g.objs, !!g.info.quiet])).toEqual([[[{ n: 9 }], false]]);
  });
});

describe('Tailer, a big transcript', () => {
  it('is read a piece at a time: every line once, in order, split anywhere', async () => {
    const f = join(root, 'C--proj', 'sess-1.jsonl');
    // ~40 MB of lines (more than two pieces), some long
    const pad = 'x'.repeat(4000);
    let text = '';
    const n = 10_000;
    for (let i = 0; i < n; i++) text += line({ i, pad: i % 7 ? '' : pad });
    while (text.length < 40 * 1024 * 1024) text += line({ filler: pad });
    writeFileSync(f, text);
    await mk().start();
    const all = got.flatMap((g) => g.objs);
    expect(got.length).toBeGreaterThan(1);
    expect(all.slice(0, n).map((o) => o.i)).toEqual([...Array(n).keys()]);
    expect(all.length).toBe(text.split('\n').length - 1);
  });
});
