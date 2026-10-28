import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { sessionNow } from '../src/lib/sessionNow';
import { pickVoice, voiceOf } from '../src/lib/sessionVoices';
import { DEFAULT_VOICE } from '@cora/shared';
import { ideFolder } from '../src/components/board/IdePanel';

const ev = (o: Partial<BrainEvent> & { ts: number; kind: BrainEvent['kind'] }): BrainEvent => ({ id: `e${o.ts}`, seq: o.ts, sessionId: 's', agentId: 'main', ...o }) as BrainEvent;

describe("the session card's line", () => {
  it('is the tool running now (the newest still open) and since when; none: when its turn ended', () => {
    const events = [
      ev({ ts: 1, kind: 'tool', phase: 'start', toolUseId: 'a', tool: { name: 'Read', summary: 'Reading src/retry.ts' } as never }),
      ev({ ts: 2, kind: 'tool', phase: 'end', toolUseId: 'a', tool: { name: 'Read' } as never }),
      ev({ ts: 3, kind: 'tool', phase: 'start', toolUseId: 'b', tool: { name: 'Bash', summary: 'npm test' } as never, tokens: { in: 50_000, out: 2_000 } as never }),
    ];
    expect(sessionNow(events)).toMatchObject({ doing: { label: 'npm test', since: 3 }, ctx: { used: 52_000, max: 200_000 }, restedAt: null });
    const done = [...events, ev({ ts: 4, kind: 'tool', phase: 'end', toolUseId: 'b', tool: { name: 'Bash' } as never }), ev({ ts: 5, kind: 'turn_end' })];
    expect(sessionNow(done)).toMatchObject({ doing: null, restedAt: 5 });
    // a compaction since: the context is empty again
    expect(sessionNow([...done, ev({ ts: 6, kind: 'compact' })]).ctx?.used).toBe(0);
    // a 1M model's window
    expect(sessionNow(events, 'claude-opus-5-5[1m]').ctx?.max).toBe(1_000_000);
    // around a restart: its end came before its start in the list; or never came, but the turn ended since
    const start = ev({ ts: 10, kind: 'tool', phase: 'start', toolUseId: 'r', tool: { name: 'PowerShell', summary: 'restart Cora' } as never });
    const end = ev({ ts: 11, kind: 'tool', phase: 'end', toolUseId: 'r', tool: { name: 'PowerShell' } as never });
    expect(sessionNow([end, start]).doing).toBeNull();
    expect(sessionNow([start, ev({ ts: 12, kind: 'turn_end' })]).doing).toBeNull();
  });

  it('its latest turn: from your prompt, to its end once it ends', () => {
    const p = ev({ ts: 10, kind: 'prompt' });
    expect(sessionNow([p]).turn).toEqual({ since: 10, until: null });
    expect(sessionNow([ev({ ts: 5, kind: 'turn_end' }), p]).turn).toEqual({ since: 10, until: null });
    expect(sessionNow([p, ev({ ts: 40, kind: 'turn_end' })]).turn).toEqual({ since: 10, until: 40 });
    expect(sessionNow([]).turn).toBeNull();
  });

  it('counts what it and its agents changed: files once each, lines added and removed', () => {
    const edit = (ts: number, path: string, add: number, del: number, agentId = 'main') => ev({ ts, kind: 'tool', phase: 'end', agentId, toolUseId: `x${ts}`, tool: { name: 'Edit', change: { path, kind: 'edit', add, del } } as never });
    expect(sessionNow([edit(1, 'a.ts', 10, 2), edit(2, 'a.ts', 3, 1), edit(3, 'b.ts', 5, 0, 'sub1')]).changed).toEqual({ files: 2, add: 18, del: 3 });
    expect(sessionNow([]).changed).toEqual({ files: 0, add: 0, del: 0 });
  });
});

describe("sessions' voices", () => {
  const pool = [
    { id: 'aaaaaaaa', name: 'Aria' },
    { id: 'bbbbbbbb', name: 'Roger' },
    { id: 'cccccccc', name: 'Sarah' },
  ];
  it('a new session gets one of the voices least in use among the open ones, at random', () => {
    const first = () => 0;
    const last = () => 0.999;
    // all tied: any of them (not always the first)
    expect(pickVoice(pool, {}, [], first)).toBe('aaaaaaaa');
    expect(pickVoice(pool, {}, [], last)).toBe('cccccccc');
    expect(new Set(Array.from({ length: 60 }, () => pickVoice(pool, {}, []))).size).toBeGreaterThan(1);
    // one in use: one of the other two
    expect(pickVoice(pool, { s1: 'aaaaaaaa' }, ['s1'], first)).toBe('bbbbbbbb');
    expect(pickVoice(pool, { s1: 'aaaaaaaa' }, ['s1'], last)).toBe('cccccccc');
    // the only least used: always it
    expect(pickVoice(pool, { s1: 'aaaaaaaa', s2: 'bbbbbbbb', s3: 'cccccccc', s4: 'aaaaaaaa', s5: 'cccccccc' }, ['s1', 's2', 's3', 's4', 's5'], last)).toBe('bbbbbbbb');
    // closed sessions don't count
    expect(pickVoice(pool, { gone: 'aaaaaaaa' }, [], first)).toBe('aaaaaaaa');
    expect(pickVoice([], {}, [])).toBeUndefined();
  });

  it("its voice: the one you picked on its card (any voice); else one given from your set; else the sessions' voice", () => {
    const each = { ...DEFAULT_VOICE, sessionVoices: { each: true, pool } };
    // picked on its card: kept, even one not in the set, and whether there's a set or not
    expect(voiceOf('s', each, { s: { id: 'zzzzzzzz', name: 'Zed' } }, [])).toEqual({ id: 'zzzzzzzz', name: 'Zed' });
    expect(voiceOf('s', DEFAULT_VOICE, { s: { id: 'zzzzzzzz', name: 'Zed' } }, [])).toEqual({ id: 'zzzzzzzz', name: 'Zed' });
    // given from the set: kept while it's in the set, else given again
    expect(voiceOf('s', each, { s: { id: 'cccccccc', name: 'Sarah', auto: true } }, [])).toEqual({ id: 'cccccccc', name: 'Sarah', auto: true });
    expect(['bbbbbbbb', 'cccccccc']).toContain(voiceOf('s', each, { s: { id: 'gone0000', name: 'Old', auto: true }, o: { id: 'aaaaaaaa', name: 'Aria', auto: true } }, ['s', 'o'])?.id);
    // no set, nothing picked: the sessions' voice
    expect(voiceOf('s', DEFAULT_VOICE, { s: { id: 'cccccccc', name: 'Sarah', auto: true } }, [])).toBeUndefined();
  });
});

describe('the IDE panel', () => {
  it('opens VS Code at the folder as its web address wants it', () => {
    expect(ideFolder(String.raw`C:\code\cora`)).toBe('/c:/code/cora');
    expect(ideFolder('/home/me/app')).toBe('/home/me/app');
  });
});
