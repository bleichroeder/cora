import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DebriefScript } from '@cora/shared';
import { Debriefs } from '../src/debriefs';

let root: string;
let cwd: string;
const changed: string[] = [];
const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const script = (over: Partial<DebriefScript['steps'][number]> = {}): DebriefScript => ({
  title: 'The fix',
  task: 'Make it start.',
  depth: 'quick',
  steps: [
    { title: 'What was asked', kind: 'context', beats: [{ text: 'It stayed down.' }] },
    { title: 'The change', kind: 'change', path: 'src/a.ts', range: [50, 52], beats: [{ text: 'It retries.', range: [51, 51] }], ...over },
  ],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'debriefs-'));
  cwd = join(root, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), file(100));
  writeFileSync(join(root, 'outside.ts'), file(10));
  changed.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = (before?: string | null) => new Debriefs({ dir: join(root, 'debriefs'), onChange: (sid) => changed.push(sid), ...(before !== undefined ? { before: () => before } : {}) });

describe('debriefs', () => {
  it('keeps a step\'s lines with 20 around them, its file made absolute, and says the session changed', () => {
    const r = store().make('sess-1', cwd, null, script());
    expect(r.ok).toBe(true);
    const d = (r as { debrief: import('@cora/shared').Debrief }).debrief;
    expect(d.steps[1].path).toBe(join(cwd, 'src', 'a.ts'));
    expect(d.snaps[1].start).toBe(30);
    expect(d.snaps[1].lines[0]).toBe('line 30');
    expect(d.snaps[1].lines.at(-1)).toBe('line 72');
    expect(d.snaps[0]).toBeUndefined();
    expect(changed).toEqual(['sess-1']);
  });

  it("a step's picture: made absolute when it's the session's and there; refused otherwise", () => {
    writeFileSync(join(cwd, 'board.png'), 'png');
    const s = store();
    const r = s.make('sess-1', cwd, null, script({ path: undefined, range: undefined, beats: [{ text: 'The board.' }], shot: { file: 'board.png', focus: [0, 0, 0.5, 0.5] } }));
    expect(r.ok).toBe(true);
    expect((r as { debrief: import('@cora/shared').Debrief }).debrief.steps[1].shot).toEqual({ file: join(cwd, 'board.png'), focus: [0, 0, 0.5, 0.5] });
    writeFileSync(join(root, 'out.png'), 'png');
    expect(s.make('sess-1', cwd, null, script({ path: undefined, range: undefined, beats: [{ text: 'x' }], shot: { file: join(root, 'out.png') } }))).toMatchObject({ ok: false, errors: [expect.stringContaining("isn't in the session's folder")] });
    expect(s.make('sess-1', cwd, null, script({ path: undefined, range: undefined, beats: [{ text: 'x' }], shot: { file: 'gone.png' } }))).toMatchObject({ ok: false, errors: ["step 2: there's no picture gone.png"] });
    expect(s.make('sess-1', cwd, null, script({ path: undefined, range: undefined, beats: [{ text: 'x' }], shot: { file: 'notes.txt' } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('shot.file is a picture')] });
    expect(s.make('sess-1', cwd, null, script({ path: undefined, range: undefined, beats: [{ text: 'x' }], shot: { file: 'board.png', focus: [0.8, 0, 0.5, 0.5] } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('shot.focus')] });
  });

  it("refuses a file outside the folder, one that isn't there, and lines past the end; nothing saved", () => {
    const s = store();
    expect(s.make('sess-1', cwd, null, script({ path: join(root, 'outside.ts'), range: [1, 2] }))).toMatchObject({ ok: false, errors: [expect.stringContaining("isn't in the session's folder, a file it changed, or a repo it changed files in")] });
    expect(s.make('sess-1', cwd, null, script({ path: 'src/gone.ts' }))).toMatchObject({ ok: false, errors: ["step 2: there's no file src/gone.ts"] });
    const past = s.make('sess-1', cwd, null, script({ range: [99, 120], beats: [{ text: 'x', range: [101, 101] }] }));
    expect(past).toMatchObject({ ok: false });
    expect((past as { errors: string[] }).errors).toEqual(['step 2: lines 99-120 are past the end of src/a.ts (100 lines)', 'step 2, beat 1: lines 101-101 are past the end of src/a.ts (100 lines)']);
    expect(s.make('sess-1', cwd, null, { title: 'x' })).toMatchObject({ ok: false });
    expect(s.list('sess-1')).toEqual([]);
    expect(changed).toEqual([]);
  });

  it('a file in a repo the session changed files in is its own (changed through the shell); its before is the last commit', () => {
    const git = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const other = join(root, 'other-repo');
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(other, 'src', 'edited.ts'), file(10));
    writeFileSync(join(other, 'src', 'IFace.ts'), 'old\n');
    git(other, 'init', '-q');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'first');
    writeFileSync(join(other, 'src', 'IFace.ts'), 'new\n');
    // the session (in repo/) edited other-repo/src/edited.ts with its Edit tool: Claude Code's snapshot has it
    const transcript = join(root, 't.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1', snapshot: { timestamp: new Date().toISOString(), trackedFileBackups: { [join(other, 'src', 'edited.ts')]: { backupFileName: null } } } }) + '\n');
    const r = store().make('sess-1', cwd, transcript, script({ path: join(other, 'src', 'IFace.ts'), range: [1, 1], diff: true, beats: [{ text: 'Changed by a script.' }] }));
    expect(r.ok).toBe(true);
    expect((r as { debrief: import('@cora/shared').Debrief }).debrief.snaps[1].before?.replace(/\r\n/g, '\n')).toBe('old\n');
  });

  it('a diff step keeps the file as it was before the work', () => {
    const r = store('old text\n').make('sess-1', cwd, join(root, 't.jsonl'), script({ diff: true }));
    expect((r as { debrief: import('@cora/shared').Debrief }).debrief.snaps[1].before).toBe('old text\n');
  });

  it('lists newest first and reads them back after a restart', async () => {
    const a = store().make('sess-1', cwd, null, script());
    await new Promise((r) => setTimeout(r, 5));
    const b = store().make('sess-1', cwd, null, { ...script(), title: 'Second' });
    const again = store();
    const list = again.list('sess-1');
    expect(list.map((x) => x.title)).toEqual(['Second', 'The fix']);
    expect(list[0]).toMatchObject({ depth: 'quick', steps: 2 });
    expect(again.get('sess-1', (a as { debrief: { id: string } }).debrief.id)?.title).toBe('The fix');
    expect(again.get('sess-1', '../x')).toBeNull();
    expect(again.list('../..')).toEqual([]);
    expect(b.ok).toBe(true);
  });
});
