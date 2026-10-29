import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SnapshotReader, gitChanges, gitDiff, netChange } from '../src/changes';

const T0 = Date.parse('2026-10-13T10:00:00Z');
const T1 = Date.parse('2026-10-13T10:05:00Z');

/** A session: a transcript with snapshot records, Claude Code's backup files, and the project folder. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ab-ch-'));
  const proj = join(home, 'proj');
  mkdirSync(proj);
  const hist = join(home, '.claude', 'file-history', 'sid');
  mkdirSync(hist, { recursive: true });
  const transcript = join(home, 'sid.jsonl');
  writeFileSync(transcript, '');
  const snap = (messageId: string, ts: number, files: Record<string, string | null>, update = false) =>
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'file-history-snapshot', messageId, isSnapshotUpdate: update,
        snapshot: { messageId, timestamp: new Date(ts).toISOString(), trackedFileBackups: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, { backupFileName: b, version: 1, backupTime: new Date(ts).toISOString(), realParentDir: proj }])) },
      }) + '\n',
    );
  return { home, proj, hist, transcript, snap };
}

describe('SnapshotReader', () => {
  it('reads a transcript a piece at a time: lines across pieces, lines longer than a piece, the last line still being written', () => {
    const f = fixture();
    const noise = (n: number) => appendFileSync(f.transcript, JSON.stringify({ type: 'assistant', text: 'é'.repeat(n) }) + '\n');
    noise(10);
    f.snap('m1', T0, { 'a.ts': 'a@v1' });
    noise(500);
    f.snap('m2', T1, { 'b.ts': null });
    f.snap('m2', T1 + 1, { 'c.ts': 'c@v1' }, true);
    appendFileSync(f.transcript, '{"type":"file-history-snapshot","messageId":"m3"'); // not finished yet
    const r = new SnapshotReader(64);
    const list = r.read(f.transcript);
    expect(list.map((s) => [s.messageId, [...s.files.keys()].map((k) => k.split('/').pop())])).toEqual([
      ['m1', ['a.ts']],
      ['m2', ['b.ts', 'c.ts']],
    ]);
    expect(list[1].files.get([...list[1].files.keys()][0])).toEqual({ name: null });
    // the rest of the last line arrives: only it is read
    appendFileSync(f.transcript, `,"snapshot":{"messageId":"m3","timestamp":"${new Date(T1 + 5000).toISOString()}","trackedFileBackups":{"d.ts":{"backupFileName":"d@v1","realParentDir":${JSON.stringify(f.proj)}}}}}\n`);
    expect(r.read(f.transcript).map((s) => s.messageId)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('netChange', () => {
  it("diffs the file as it was at the turn's prompt against the file now", () => {
    const f = fixture();
    writeFileSync(join(f.hist, 'a@v1'), 'one\ntwo\nthree\n');
    f.snap('m1', T0 + 200, { 'a.ts': 'a@v1' });
    writeFileSync(join(f.proj, 'a.ts'), 'one\nTWO\nthree\n');
    const r = netChange({ transcript: f.transcript, sessionId: 'sid', path: join(f.proj, 'a.ts'), from: T0, to: null, home: f.home });
    expect(r).toMatchObject({ exact: true, before: 'snapshot', add: 1, del: 1 });
    expect(r.hunks![0].lines).toEqual([' one', '-two', '+TWO', ' three']);
  });

  it("an earlier turn ends at the next prompt's snapshot; a file first touched mid-turn comes from the update record", () => {
    const f = fixture();
    writeFileSync(join(f.hist, 'a@v1'), 'x\n');
    writeFileSync(join(f.hist, 'a@v2'), 'x\ny\n');
    f.snap('m1', T0 + 200, {});
    f.snap('m1', T0 + 30_000, { 'a.ts': 'a@v1' }, true);
    f.snap('m2', T1 + 200, { 'a.ts': 'a@v2' });
    writeFileSync(join(f.proj, 'a.ts'), 'x\ny\nz\n');
    const r = netChange({ transcript: f.transcript, sessionId: 'sid', path: join(f.proj, 'a.ts'), from: T0, to: T1, home: f.home });
    expect(r.hunks![0].lines).toEqual([' x', '+y']);
  });

  it('a file created during the turn diffs from nothing; with no snapshot it says so', () => {
    const f = fixture();
    f.snap('m1', T0 + 200, { 'new.ts': null });
    writeFileSync(join(f.proj, 'new.ts'), 'hello\n');
    expect(netChange({ transcript: f.transcript, sessionId: 'sid', path: join(f.proj, 'new.ts'), from: T0, to: null, home: f.home })).toMatchObject({ add: 1, del: 0, exact: true });
    expect(netChange({ transcript: f.transcript, sessionId: 'sid', path: join(f.proj, 'other.ts'), from: T0, to: null, home: f.home })).toMatchObject({ hunks: null, exact: false });
  });
});

describe('git changes', () => {
  it('lists uncommitted and untracked files with counts, and diffs them', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ab-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    g('add', '.');
    g('commit', '-qm', 'init');
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'b.txt'), 'b\nb\n');
    const r = await gitChanges(repo);
    expect(r.repo).toBe(true);
    const byName = Object.fromEntries(r.files.map((f) => [f.path.replace(/\\/g, '/').split('/').slice(-1)[0], f]));
    expect(byName['a.txt']).toMatchObject({ status: 'M', add: 2, del: 1 });
    expect(byName['b.txt']).toMatchObject({ status: '??', add: 2, del: 0 });
    const d = await gitDiff(repo, join(repo, 'a.txt'));
    expect('patch' in d && d.patch).toMatch(/-two\n\+2\n\+three/);
    const u = await gitDiff(repo, join(repo, 'src', 'b.txt'));
    expect('patch' in u && u.patch).toMatch(/\+b\n\+b/);
    expect(await gitDiff(repo, join(tmpdir(), 'elsewhere.txt'))).toEqual({ error: 'that file is outside the repository' });
    expect((await gitChanges(tmpdir())).repo).toBe(false);
    // a dozen git runs: slow to start on Windows, slower still with the whole suite running alongside
  }, 30_000);
});
