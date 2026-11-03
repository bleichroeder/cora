import { describe, expect, it } from 'vitest';
import { clone, type BuilderDraftView, type SessionInfo, type Team } from '@cora/shared';
import { received, saved, startingDraft } from '../src/state/builder';
import { setBuilderSessions, useBrain } from '../src/state/store';
import { drill, drillDraft, drillTheirs } from '@cora/shared/test/fixtures';

const view = (team: Team, rev: number, base = 4): BuilderDraftView => ({ team, rev, base, by: 'you', at: 1, turns: [] });

describe('the draft on this screen', () => {
  it('survives a reload: the draft kept on the server comes back as it was', () => {
    expect(startingDraft({ team: drill() }, view(drillDraft(), 3))).toEqual({ rev: 3, base: 4, server: drillDraft(), mine: drillDraft(), conflicts: [] });
  });

  it('no draft: the team as it is (revision 0); no team either: the start sheet (null)', () => {
    expect(startingDraft({ team: drill() }, null)).toEqual({ rev: 0, base: 4, server: drill(), mine: drill(), conflicts: [] });
    expect(startingDraft({}, null)).toBeNull();
  });

  it("a newer draft from the server replaces ours; your unsent edits go on top of it", () => {
    const s = startingDraft({ team: drill() }, view(drill(), 1))!;
    expect(received(s, view(drillTheirs(), 2)).mine).toEqual(drillTheirs());
    const mine = clone(drill());
    mine.seats[0].instructions = 'Mine.';
    const r = received({ ...s, mine }, view(drillTheirs(), 2));
    expect(r.rev).toBe(2);
    expect(r.mine.seats[0].instructions).toBe('Mine.');
    expect(r.mine.routes.find((x) => x.id === 'r-back')!.wake).toBe('never');
  });

  it('an older or the same revision changes nothing', () => {
    const s = startingDraft({ team: drill() }, view(drill(), 5))!;
    expect(received(s, view(drillTheirs(), 4))).toBe(s);
  });

  it("saved: the server's word, unless you typed more since", () => {
    const s = startingDraft({ team: drill() }, view(drill(), 1))!;
    const sent = drillDraft();
    expect(saved({ ...s, mine: sent }, sent, view(sent, 2))).toEqual({ rev: 2, base: 4, server: sent, mine: sent, conflicts: [] });
    const more = clone(sent);
    more.seats[1].name = 'Monitor 2';
    expect(saved({ ...s, mine: more }, sent, view(sent, 2)).mine).toEqual(more);
  });
});

describe('conflicts and stale replies', () => {
  it('both changed the same field: yours is kept and the clash is listed, until your edits are saved', () => {
    const s = startingDraft({ team: drill() }, view(drill(), 1))!;
    const theirs = clone(drillTheirs());
    theirs.seats[0].instructions = 'Theirs.';
    const mine = clone(drill());
    mine.seats[0].instructions = 'Mine.';
    const r = received({ ...s, mine }, view(theirs, 2));
    expect(r.mine.seats[0].instructions).toBe('Mine.');
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(saved(r, r.mine, view(r.mine, 3)).conflicts).toEqual([]);
  });

  it('a reply older than what came in since changes nothing', () => {
    const s = startingDraft({ team: drill() }, view(drill(), 1))!;
    const newer = received(s, view(drillTheirs(), 3));
    expect(saved(newer, newer.mine, view(drill(), 2))).toBe(newer);
  });

  it('an older revision with another base never lowers the revision', () => {
    const s = startingDraft({ team: drill() }, view(drill(), 5))!;
    expect(received(s, view(drillTheirs(), 3, 9))).toBe(s);
  });
});

describe("the builder's session is never in the session list", () => {
  it('marked: taken out, and kept out', () => {
    const s = { id: 'b-1', state: 'idle', cwd: 'C:/x', project: 'x', title: '', startedAt: 1, lastTs: 1, cliVersion: '', transcriptPath: '', needsYou: 0 } as SessionInfo;
    useBrain.getState().upsertSession(s);
    expect(useBrain.getState().sessions['b-1']).toBeDefined();
    setBuilderSessions(['b-1']);
    expect(useBrain.getState().sessions['b-1']).toBeUndefined();
    useBrain.getState().upsertSession({ ...s, lastTs: 2 });
    expect(useBrain.getState().sessions['b-1']).toBeUndefined();
  });

  it('a snapshot leaves the builder session and its pending asks out', () => {
    setBuilderSessions(['b-2']);
    const s = { id: 'b-2', state: 'idle', cwd: 'C:/x', project: 'x', title: '', startedAt: 1, lastTs: 1, cliVersion: '', transcriptPath: '', needsYou: 0 } as SessionInfo;
    const ask = { id: 'p1', sessionId: 'b-2' } as never;
    useBrain.getState().applySnapshot({ sessions: [s], agents: [], pending: [ask], lastSeq: 1, recent: {} });
    expect(useBrain.getState().sessions['b-2']).toBeUndefined();
    expect(useBrain.getState().pending).toEqual([]);
  });

  it('a pending ask from the builder session never lands in the list, its waits or a toast', () => {
    setBuilderSessions(['b-3']);
    const ask = { id: 'p3', kind: 'permission', sessionId: 'b-3', agentId: 'main', ts: 1, toolName: 'Bash' } as never;
    const other = { id: 'p4', kind: 'permission', sessionId: 's-9', agentId: 'main', ts: 1, toolName: 'Bash' } as never;
    useBrain.getState().setPending([ask, other]);
    expect(useBrain.getState().pending.map((p) => p.id)).toEqual(['p4']);
    expect(useBrain.getState().waits.map((w) => w.sessionId)).not.toContain('b-3');
    expect(useBrain.getState().toasts.map((t) => t.id)).not.toContain('p3');
  });
});
