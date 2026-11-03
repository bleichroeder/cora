import { afterEach, describe, expect, it, vi } from 'vitest';

// (closing the builder tells the server: what it was told is kept here)
const told = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, refuse: '' }));
vi.mock('../src/state/projects', async (orig) => ({ ...(await orig<typeof import('../src/state/projects')>()), call: async (method: string, url: string) => (told.calls.push([method, url]), told.refuse ? { ok: false, error: told.refuse } : { ok: true }) }));

import type { Project, SessionInfo } from '@cora/shared';
import { builderShown, closeBuilder, openBuilder, proposalDone, sayInTalk, setBuilderLeft, talkErrorSeen, useBuilder } from '../src/state/builder';
import { useProjects } from '../src/state/projects';
import { useBrain } from '../src/state/store';
import { watchSessions } from '../src/App';

const LOSE = "Leave the lead's proposal? Your edits to it are only on this screen, so they'll be lost.";
const ASK = { project: 'p1', text: LOSE };
const answer = (yes: boolean) => {
  const asked: string[] = [];
  vi.stubGlobal('window', { confirm: (q: string) => (asked.push(q), yes) });
  return asked;
};
afterEach(() => {
  vi.unstubAllGlobals();
  useBuilder.setState({ open: {}, leaveAsk: null, sending: {}, talkErrors: {} });
  useBrain.setState({ projectOpen: null, focus: null, overview: false, sessions: {} });
  useProjects.setState({ projects: [] });
  told.calls = [];
  told.refuse = '';
});

describe('what you said in Talk, while you come and go', () => {
  const why = (r: { error?: string }) => r.error ?? '';
  const texts = () => (useBuilder.getState().sending.p1 ?? []).map((s) => s.text);
  it("a reason once shown isn't said again when you come back, and never takes back what you sent since", async () => {
    openBuilder('p1');
    told.refuse = "Cora's session ended before she heard you.";
    await sayInTalk('p1', 'first', { live: false, why });
    expect(useBuilder.getState().talkErrors.p1).toEqual({ text: "Cora's session ended before she heard you." });
    expect(texts()).toEqual([]);
    // the builder showed it
    talkErrorSeen('p1');
    told.refuse = '';
    await sayInTalk('p1', 'second', { live: true, why });
    // (gone elsewhere and back: nothing to say again, and the words are still on their way)
    expect(useBuilder.getState().talkErrors).toEqual({});
    expect(texts()).toEqual(['second']);
    expect(useBuilder.getState().sending.p1[0].live).toBe(true);
  });
  it('a reason not shown yet is old news once later words are taken', async () => {
    openBuilder('p1');
    useBuilder.setState({ talkErrors: { p1: { text: 'old' } } });
    await sayInTalk('p1', 'hello', { live: false, why });
    expect(useBuilder.getState().talkErrors).toEqual({});
    expect(texts()).toEqual(['hello']);
  });
});

describe("leaving a lead's proposal you edited by opening something else", () => {
  it('asks first; No keeps the builder (and its project) on screen', () => {
    openBuilder('p1', { proposal: true });
    useBuilder.setState({ leaveAsk: ASK });
    const asked = answer(false);
    useBrain.getState().openProject('p2');
    expect(asked).toEqual([LOSE]);
    expect(useBrain.getState().projectOpen).toBe('p1');
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
  });
  it('No after picking a session: the proposal stays in front (the session stays picked behind it)', () => {
    openBuilder('p1', { proposal: true });
    useBuilder.setState({ leaveAsk: ASK });
    answer(false);
    useBrain.getState().setFocus('s1');
    expect(useBrain.getState().projectOpen).toBe('p1');
    expect(useBrain.getState().focus).toBe('s1');
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
  });
  for (const edited of [true, false])
    it(`the session behind the builder going away moves the focus on behind it: the builder stays, nothing asked (${edited ? 'with' : 'without'} proposal edits)`, () => {
      const S = (id: string, more: Partial<SessionInfo> = {}) => ({ id, state: 'idle', startedAt: 1, lastTs: 10, cwd: 'C:/w', ...more }) as SessionInfo;
      useBrain.setState({ sessions: { s1: S('s1'), s2: S('s2') }, focus: 's1' });
      openBuilder('p1', { proposal: true });
      if (edited) useBuilder.setState({ leaveAsk: ASK });
      const asked = answer(true);
      const stop = watchSessions();
      try {
        // the session in focus is dismissed: the focus moves on to s2; then the sessions change again
        useBrain.setState({ sessions: { s1: S('s1', { dismissedAt: 10 }), s2: S('s2') } });
        useBrain.setState({ sessions: { s1: S('s1', { dismissedAt: 10 }), s2: S('s2', { lastTs: 20 }) } });
        expect(asked).toEqual([]);
        expect(useBrain.getState().focus).toBe('s2');
        expect(useBrain.getState().projectOpen).toBe('p1');
        expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
      } finally {
        stop();
      }
    });
  it('the Overview kept through such a move, as before', () => {
    const S = (id: string, more: Partial<SessionInfo> = {}) => ({ id, state: 'idle', startedAt: 1, lastTs: 10, cwd: 'C:/w', ...more }) as SessionInfo;
    useBrain.setState({ sessions: { s1: S('s1'), s2: S('s2') }, focus: 's1', overview: true });
    const stop = watchSessions();
    try {
      useBrain.setState({ sessions: { s1: S('s1', { dismissedAt: 10 }), s2: S('s2') } });
      expect(useBrain.getState().focus).toBe('s2');
      expect(useBrain.getState().overview).toBe(true);
    } finally {
      stop();
    }
  });
  it('Yes goes: the other project opens; the builder stays open behind it (the edits are what was lost)', () => {
    openBuilder('p1', { proposal: true });
    useBuilder.setState({ leaveAsk: ASK });
    answer(true);
    useBrain.getState().openProject('p2');
    expect(useBrain.getState().projectOpen).toBe('p2');
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
    expect(told.calls).toEqual([]);
  });
  it("another project's builder asked for and refused: this one stays", () => {
    openBuilder('p1', { proposal: true });
    useBuilder.setState({ leaveAsk: ASK });
    answer(false);
    openBuilder('p2');
    expect(useBrain.getState().projectOpen).toBe('p1');
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
  });
  it("the same project's draft asked for instead: asked too (the proposal's screen would go)", () => {
    openBuilder('p1', { proposal: true });
    useBuilder.setState({ leaveAsk: ASK });
    const asked = answer(false);
    openBuilder('p1');
    expect(asked).toEqual([LOSE]);
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
    answer(true);
    openBuilder('p1');
    expect(useBuilder.getState().open).toEqual({ p1: {} });
  });
  it("another project's builder open too: going to it and saying No asks once and keeps the edits; leaving again still asks", () => {
    openBuilder('p2');
    openBuilder('p1', { proposal: true });
    useBuilder.setState({ leaveAsk: ASK });
    const asked = answer(false);
    useBrain.getState().openProject('p2');
    expect(asked).toEqual([LOSE]);
    expect(useBrain.getState().projectOpen).toBe('p1');
    expect(useBuilder.getState().leaveAsk).toEqual(ASK);
    useBrain.getState().openProject('p2');
    expect(asked).toEqual([LOSE, LOSE]);
    expect(useBrain.getState().projectOpen).toBe('p1');
  });
  it("what another project's builder would lose is never asked when you leave this one", () => {
    openBuilder('p2');
    openBuilder('p1');
    useBuilder.setState({ leaveAsk: { project: 'p2', text: LOSE } });
    const asked = answer(false);
    useBrain.getState().openProject('p3');
    expect(asked).toEqual([]);
    expect(useBrain.getState().projectOpen).toBe('p3');
  });
  it('nothing to lose: no question, it just goes (the builder stays open)', () => {
    openBuilder('p1', { proposal: true });
    const asked = answer(false);
    useBrain.getState().openProject('p2');
    expect(asked).toEqual([]);
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true } });
  });
});

describe('the builder stays open while you work elsewhere', () => {
  const S = (id: string) => ({ id, state: 'idle', startedAt: 1, lastTs: 10, cwd: 'C:/w' }) as SessionInfo;
  it('another session, another project or the Overview: it stays open and Cora is never told it closed', () => {
    useBrain.setState({ sessions: { s1: S('s1') } });
    openBuilder('p1');
    useBrain.getState().setFocus('s1');
    useBrain.getState().openProject('p2');
    useBrain.getState().toggleOverview(true);
    expect(useBuilder.getState().open).toEqual({ p1: {} });
    expect(told.calls).toEqual([]);
  });
  it('coming back to the project shows the builder, not the project view', () => {
    openBuilder('p1');
    useBrain.getState().openProject('p2');
    expect(builderShown(useBuilder.getState().open, useBrain.getState().projectOpen)).toBeNull();
    useBrain.getState().openProject('p1');
    expect(builderShown(useBuilder.getState().open, useBrain.getState().projectOpen)).toEqual({});
  });
  it("two projects' builders open at once, each where you left it", () => {
    openBuilder('p1');
    openBuilder('p2', { proposal: true });
    expect(useBuilder.getState().open).toEqual({ p1: {}, p2: { proposal: true } });
    expect(builderShown(useBuilder.getState().open, 'p1')).toEqual({});
    expect(builderShown(useBuilder.getState().open, 'p2')).toEqual({ proposal: true });
  });
  it("its Back closes only that builder, and Cora's session rests; what was on its way is gone with it", () => {
    openBuilder('p1');
    openBuilder('p2');
    useBuilder.setState({ sending: { p1: [{ id: 'x', text: 'hi', at: 1 }] }, talkErrors: { p1: { text: 'no' } } });
    closeBuilder('p1');
    expect(useBuilder.getState().open).toEqual({ p2: {} });
    expect(useBuilder.getState().sending).toEqual({});
    expect(useBuilder.getState().talkErrors).toEqual({});
    expect(told.calls).toEqual([['POST', '/api/projects/p1/builder/close']]);
    closeBuilder('p1');
    expect(told.calls.length).toBe(1);
  });
  it('a project archived or removed: its builder is no longer open (the server rested or ended its session)', () => {
    openBuilder('p1');
    openBuilder('p2');
    openBuilder('p3');
    useBuilder.setState({ talkErrors: { p1: { text: 'a' }, p2: { text: 'b' }, p3: { text: 'c' } } });
    useProjects.setState({ projects: [{ id: 'p1', name: 'a' } as Project, { id: 'p2', name: 'b', archivedAt: 5 } as Project] });
    expect(useBuilder.getState().open).toEqual({ p1: {} });
    expect(useBuilder.getState().talkErrors).toEqual({ p1: { text: 'a' } });
    expect(told.calls).toEqual([]);
  });
  it('switching between its draft and a proposal keeps the tab you were on', () => {
    openBuilder('p1');
    setBuilderLeft('p1', 'talk');
    openBuilder('p1', { proposal: true });
    expect(useBuilder.getState().open).toEqual({ p1: { proposal: true, left: 'talk' } });
    openBuilder('p1');
    expect(useBuilder.getState().open).toEqual({ p1: { left: 'talk' } });
  });
  it("a proposal approved or rejected in the builder: it's the draft's builder from then on (a later proposal doesn't take its place when you come back)", () => {
    openBuilder('p1', { proposal: true });
    setBuilderLeft('p1', 'talk');
    proposalDone('p1');
    expect(useBuilder.getState().open).toEqual({ p1: { left: 'talk' } });
    proposalDone('p9');
    expect(useBuilder.getState().open).toEqual({ p1: { left: 'talk' } });
  });
});
