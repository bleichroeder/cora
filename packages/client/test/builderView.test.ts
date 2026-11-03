import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkTeam, clone, type BuilderDraftView, type Project, type SessionInfo } from '@cora/shared';
import { appliedOutcome, applyRev, clampLeftWidth, leftDrag, leftKeyWidth, draftMoved, folderCheck, layoutNote, leftWidthStyle, loadLeftWidth, saveLeftWidth, LEFT_W_KEY, BuilderView, waitIn, clashWords, defaultFolder, draftGone, draftSender, DRAFT_MOVED, keyAction, leavingAsk, openingState, plainError, proposalMoved, seatStateOf, TALK_OFF_PROPOSAL, thenForm, traceExamples, usuallyIdle } from '../src/components/builder/BuilderView';
import { StartSheet } from '../src/components/builder/StartSheet';
import { proposalMarks } from '../src/components/builder/geometry';
import { isTyping } from '../src/components/builder/draftOps';
import { Strip } from '../src/components/builder/Strip';
import { Talk } from '../src/components/builder/Talk';
import { builderEntry } from '../src/components/board/TeamPanel';
import { startingDraft, useBuilder } from '../src/state/builder';
import { drill, drillDraft, drillProposal, drillTheirs } from '@cora/shared/test/fixtures';

// (a render on the server reads a store's initial state: the project the view shows is handed to it here)
const shown = vi.hoisted(() => ({ project: undefined as Project | undefined }));
vi.mock('../src/state/projects', async (orig) => ({ ...(await orig<typeof import('../src/state/projects')>()), useProject: (id: string | null) => (shown.project?.id === id ? shown.project : undefined) }));

const S = (id: string, state: SessionInfo['state'], cwd = 'C:/work') => ({ id, state, cwd }) as SessionInfo;
const project = (more: Partial<Project> = {}): Project => ({ id: 'p1', name: 'Native Drill', color: '#60a5fa', createdAt: 1, sessions: ['s1', 's2'], coordination: true, brief: '', briefAt: 1, decisions: [], thread: [], members: { s1: { hears: 'everything', canPost: true, wakes: true, seat: 'triage' }, s2: { hears: 'everything', canPost: true, wakes: true, seat: 'analyst-enc' } }, team: drill(), ...more });
const view = (rev: number): BuilderDraftView => ({ team: drillDraft(), rev, base: 4, by: 'you', at: 1, turns: [] });

describe('opening the builder', () => {
  it('the draft kept on the server comes back (it survives a reload)', () => {
    expect(openingState(project(), view(3), false)).toMatchObject({ sync: { rev: 3, mine: drillDraft() }, prop: null, sheet: null });
  });

  it('no team and no draft: the start sheet', () => {
    expect(openingState(project({ team: undefined }), null, false)).toEqual({ sync: null, prop: null, sheet: 'start' });
  });

  it("a lead's proposal opens as a draft on the current team, with its marks", () => {
    const o = openingState(project({ teamProposal: { team: drillProposal(), why: 'ingest', by: 's1', at: 7, base: 4 } }), view(3), true);
    expect(o.prop).toEqual({ team: drillProposal(), at: 7, edited: false });
    expect(o.sheet).toBeNull();
    const m = proposalMarks(drill(), o.prop!.team);
    expect(m.seat['analyst-ing']).toBe('add');
    expect(m.goneSeats.map((s) => s.id)).toEqual(['monitor-b']);
  });
});

describe('what the canvas shows of running seats', () => {
  const sessions = { s1: S('s1', 'working'), s2: S('s2', 'idle') };
  it('working, idle, stood down; a seat not applied yet has no state', () => {
    expect(seatStateOf(project(), drill(), sessions, 'triage')).toBe('work');
    expect(seatStateOf(project(), drill(), sessions, 'analyst-enc')).toBe('idle');
    expect(seatStateOf(project(), drill(), sessions, 'monitor-a')).toBe('down');
    expect(seatStateOf(project(), drill(), sessions, 'analyst-ing')).toBe('none');
  });
  it('usually idle: running, and every member idle', () => {
    expect(usuallyIdle(project(), sessions, 'analyst-enc')).toBe(true);
    expect(usuallyIdle(project(), sessions, 'triage')).toBe(false);
    expect(usuallyIdle(project(), sessions, 'monitor-a')).toBe(false);
  });
  it("a new seat's folder: the team's, else a member's", () => {
    expect(defaultFolder(project(), sessions, drill())).toBe('C:\\ops\\drill');
    expect(defaultFolder(project(), sessions, null)).toBe('C:/work');
  });
});

describe('try a message', () => {
  it("examples from the team's own routes", () => {
    const ex = traceExamples(drill());
    expect(ex.map(([l]) => l)).toEqual(['Monitor A, Monitor B → Triage', 'Triage → Analysts', 'Analysts → Triage']);
    expect(ex[1][1]).toEqual({ from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } });
    expect(ex[2][1].from).toBe('seat:analyst-enc');
  });
  it('Then what? continues from the seat it reached, along its first route out', () => {
    expect(thenForm(drill(), 'analyst-enc')).toEqual({ from: 'seat:analyst-enc', to: 'seat:triage', kind: 'note', labels: {} });
    expect(thenForm(drill(), 'nobody')).toEqual({ from: 'seat:nobody', to: 'user', kind: 'direct', labels: {} });
  });
});

describe('the way in', () => {
  it('Build a team when there is none; Edit when there is', () => {
    expect(builderEntry({}).label).toBe('Build a team');
    expect(builderEntry({ team: drill() }).label).toBe('Edit');
  });
});

describe('the top bar', () => {
  afterEach(() => (shown.project = undefined));
  it('a ? replays the tour, next to Start over, Fit and Tidy', () => {
    shown.project = project();
    const h = renderToStaticMarkup(createElement(BuilderView, { id: 'p1' }));
    expect(h).toContain('title="Show me around (the tour)"');
    expect(h).toMatch(/class="iconbtn help"[^>]*>\?<\/button>/);
    expect(h).toContain('Start over');
    expect(h).toContain('Tidy');
  });
});

describe("the left panel's width", () => {
  const box = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const refusing = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  it('at least 240px, at most half the builder', () => {
    expect(clampLeftWidth(100, 1400)).toBe(240);
    expect(clampLeftWidth(360.4, 1400)).toBe(360);
    expect(clampLeftWidth(900, 1400)).toBe(700);
    // a builder too narrow for both: the least it can be
    expect(clampLeftWidth(300, 400)).toBe(240);
  });
  it('kept in this browser; a double-click (null) forgets it; storage refused or garbage: the default', () => {
    const s = box();
    saveLeftWidth(360, s);
    expect(s.m.get(LEFT_W_KEY)).toBe('360');
    expect(loadLeftWidth(s)).toBe(360);
    saveLeftWidth(null, s);
    expect(s.m.has(LEFT_W_KEY)).toBe(false);
    expect(loadLeftWidth(s)).toBeNull();
    expect(loadLeftWidth(box({ [LEFT_W_KEY]: 'wide' }))).toBeNull();
    expect(loadLeftWidth(box({ [LEFT_W_KEY]: '-5' }))).toBeNull();
    expect(loadLeftWidth(refusing)).toBeNull();
    expect(() => saveLeftWidth(300, refusing)).not.toThrow();
  });
  it("its column follows the width kept, clamped by the builder's own width as it changes; none kept: the default; collapsed: unchanged", () => {
    expect(leftWidthStyle(360, true)).toEqual({ '--lw': 'max(240px, min(360px, 50%))' });
    expect(leftWidthStyle(null, true)).toBeUndefined();
    expect(leftWidthStyle(360, false)).toBeUndefined();
  });
  const drag = () => {
    const el = new EventTarget();
    const root = { dataset: {} as Record<string, string | undefined> };
    const moved: number[] = [];
    const done: Array<number | null> = [];
    const stop = leftDrag(el, { x0: 100, w0: 300, total: 1400, root, onMove: (w) => moved.push(w), onDone: (w) => done.push(w) });
    const fire = (type: string, clientX = 0) => el.dispatchEvent(Object.assign(new Event(type), { clientX }));
    return { root, moved, done, stop, fire };
  };
  it('a drag follows the pointer, clamped, and ends however the pointer goes (let go, cancelled, capture lost): the app is never left mid-drag', () => {
    for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      const d = drag();
      expect(d.root.dataset.tbDrag).toBe('1');
      d.fire('pointermove', 160);
      d.fire('pointermove', 2000);
      expect(d.moved).toEqual([360, 700]);
      d.fire(end);
      expect(d.root.dataset.tbDrag).toBeUndefined();
      expect(d.done).toEqual([700]);
      d.fire('pointermove', 200);
      d.fire('pointerup');
      expect(d.moved).toEqual([360, 700]);
      expect(d.done).toEqual([700]);
    }
  });
  it('the builder going away mid-drag ends it too; a click that never moved keeps the width', () => {
    const d = drag();
    d.fire('pointermove', 150);
    d.stop();
    d.stop();
    expect(d.root.dataset.tbDrag).toBeUndefined();
    expect(d.done).toEqual([350]);
    const c = drag();
    c.fire('pointerup');
    expect(c.done).toEqual([null]);
  });
  it('from the keyboard: arrows move it 16px (Shift: 64), clamped; Home and End go to the least and the most; other keys do nothing', () => {
    expect(leftKeyWidth('ArrowRight', false, 300, 1400)).toBe(316);
    expect(leftKeyWidth('ArrowLeft', true, 300, 1400)).toBe(240);
    expect(leftKeyWidth('ArrowRight', true, 690, 1400)).toBe(700);
    expect(leftKeyWidth('Home', false, 500, 1400)).toBe(240);
    expect(leftKeyWidth('End', false, 300, 1400)).toBe(700);
    expect(leftKeyWidth('a', false, 300, 1400)).toBeNull();
  });
  it('the builder draws its edge to drag, with the width kept', () => {
    shown.project = project();
    vi.stubGlobal('localStorage', box({ [LEFT_W_KEY]: '420' }));
    try {
      const h = renderToStaticMarkup(createElement(BuilderView, { id: 'p1' }));
      expect(h).toContain('class="main" style="--lw:max(240px, min(420px, 50%))"');
      expect(h).toMatch(/class="lgrip"[^>]*title="Drag to resize · double-click for the default"/);
      // reachable from the keyboard, and says what it is
      expect(h).toMatch(/class="lgrip" tabindex="0" role="separator" aria-orientation="vertical" aria-label="Resize Talk and In words \(arrow keys\)" aria-valuemin="240" aria-valuenow="420"/);
    } finally {
      vi.unstubAllGlobals();
      shown.project = undefined;
    }
  });
});

describe('back to a builder still open', () => {
  afterEach(() => {
    shown.project = undefined;
    useBuilder.setState({ open: {}, drafts: {} });
  });
  it('the draft already known draws at once (no empty canvas, never the start sheet), on the tab you left', () => {
    shown.project = project({ team: undefined });
    useBuilder.setState({ open: { p1: { left: 'talk' } }, drafts: { p1: view(3) } });
    const h = renderToStaticMarkup(createElement(BuilderView, { id: 'p1' }));
    expect(h).toContain('class="canvas"');
    expect(h).toContain('Triage');
    expect(h).not.toContain('class="shape"');
    expect(h).toMatch(/class="tab on"[^>]*>Talk</);
  });
  it('not known yet: nothing drawn until the server answers (and still no start sheet)', () => {
    shown.project = project({ team: undefined });
    const h = renderToStaticMarkup(createElement(BuilderView, { id: 'p1' }));
    expect(h).not.toContain('class="canvas"');
    expect(h).toMatch(/class="tab on"[^>]*>In words</);
  });
});

describe('when theirs and yours meet', () => {
  it("Cora's change where you also changed something: said with her name, yours kept", () => {
    expect(clashWords(['Seat Triage, instructions: they set Hers., your draft has Mine.. Yours is kept.', "The team's labels: you both changed it. Yours is kept."], 'cora')).toEqual(['Seat Triage, instructions: Cora set Hers., your draft has Mine.. Yours is kept.', "The team's labels: Cora and you both changed it. Yours is kept."]);
    expect(clashWords(['Seat Triage: they removed it, your draft changes it. Kept.'], 'you')).toEqual(['Seat Triage: another edit removed it, your draft changes it. Kept.']);
  });

  it('the values quoted in a clash stay as they were written', () => {
    expect(clashWords(['Seat Triage, instructions: they set Ask if they agree, your draft has Say you both agree. Yours is kept.'], 'cora')).toEqual(['Seat Triage, instructions: Cora set Ask if they agree, your draft has Say you both agree. Yours is kept.']);
  });

  it('the draft gone (applied, thrown away): the team as it is now, your unsent edits still on top', () => {
    const s = startingDraft(project(), view(3))!;
    const mine = clone(s.mine);
    mine.seats[0].instructions = 'Mine.';
    const r = draftGone({ ...s, mine }, { team: drillTheirs() })!;
    expect(r.rev).toBe(0);
    expect(r.server).toEqual(drillTheirs());
    expect(r.mine.seats[0].instructions).toBe('Mine.');
    // nothing unsent: just the team
    expect(draftGone(s, { team: drill() })).toEqual(startingDraft(project(), null));
    expect(draftGone(s, {})).toBeNull();
  });
});

describe("a lead's proposal that moves on elsewhere", () => {
  const prop = { team: drillProposal(), at: 7, edited: false };
  const now = (at: number) => ({ team: drill(), why: 'x', by: 's1', at, base: 4 });
  it('still the same one: nothing to say', () => {
    expect(proposalMoved(prop, now(7))).toBeNull();
  });
  it('replaced: the new one is shown, and it says so (your edits to the old one were not kept)', () => {
    expect(proposalMoved({ ...prop, edited: true }, now(9))).toEqual({ prop: { team: drill(), at: 9, edited: false }, note: 'The lead sent a new proposal; this is it now. Your edits to it were not kept.' });
  });
  it('approved or rejected elsewhere: the team as it is now, and it says so', () => {
    expect(proposalMoved(prop, undefined)).toEqual({ prop: null, note: "The lead's proposal was approved, rejected or set aside (the team changed) elsewhere; this is the team as it is now." });
  });
});

describe('trouble reads as a warning', () => {
  it('a warning notice is a warning in Checks and counts in its badge; a delete or move note stays info', () => {
    const h = renderToStaticMarkup(
      createElement(Strip, { tab: 'checks', onTab() {}, checks: checkTeam(drill()), notices: [{ text: "Your last edit isn't saved yet: Cora isn't answering.", level: 'warn' }, { text: 'Monitor A left Monitors.', level: 'info' }], isSelected: () => false, onPickCheck() {}, sum: { text: '', tone: '' }, applyLabel: 'Apply', applyDisabled: false, applyTitle: '', onApply() {}, tryPanel: null }),
    ).replace(/&#x27;/g, "'");
    expect(h).toContain('<i class="w">2</i>');
    expect(h).toMatch(/class="ck warn"><span class="g"><\/span><span class="t">Your last edit isn't saved yet: Cora isn't answering.<\/span><span class="lv">warning<\/span>/);
    expect(h).toMatch(/class="ck info"><span class="g"><\/span><span class="t">Monitor A left Monitors.<\/span><span class="lv">done<\/span>/);
  });
  it("Talk says when an Undo didn't work", () => {
    const h = renderToStaticMarkup(createElement(Talk, { lines: [], busy: false, offline: '', note: "That Undo didn't work: The draft changed since.", chips: [], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 })).replace(/&#x27;/g, "'");
    expect(h).toContain("That Undo didn't work: The draft changed since.");
  });
});

describe('your edits on their way to the server', () => {
  afterEach(() => vi.useRealTimers());
  it('typing sends once, a quarter second after the last key', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => false);
    const q = draftSender(run);
    for (let i = 0; i < 10; i++) (q.poke(), await vi.advanceTimersByTimeAsync(100));
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('long typing still saves, at most a second and a half after the first edit', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => false);
    const q = draftSender(run);
    for (let i = 0; i < 16; i++) (q.poke(), await vi.advanceTimersByTimeAsync(100));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('one at a time: an edit made while one is on its way goes after it', async () => {
    vi.useFakeTimers();
    let done = () => {};
    const run = vi.fn(() => new Promise<boolean>((r) => (done = () => r(false))));
    const q = draftSender(run);
    q.poke();
    await vi.advanceTimersByTimeAsync(250);
    q.poke();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    done();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refused as stale: sent again, on top of the live draft', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const q = draftSender(run);
    q.poke();
    await vi.advanceTimersByTimeAsync(600);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('flush: what is waiting goes now (before Apply, and when the builder closes)', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => false);
    const q = draftSender(run);
    q.poke();
    await q.now();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('keys', () => {
  const at = (more: Partial<Parameters<typeof keyAction>[1]> = {}) => ({ tour: false, sheet: false, typing: false, sel: true, ...more });
  it('Delete or Backspace deletes what is selected, but not while you type, nor under a sheet', () => {
    expect(keyAction('Delete', at())).toBe('delete');
    expect(keyAction('Backspace', at())).toBe('delete');
    expect(keyAction('Delete', at({ typing: true }))).toBeNull();
    expect(keyAction('Delete', at({ sheet: true }))).toBeNull();
    expect(keyAction('Delete', at({ sel: false }))).toBeNull();
  });
  it('Escape: out of the field, else nothing selected; a sheet closes itself (not while it works)', () => {
    expect(keyAction('Escape', at({ typing: true }))).toBe('blur');
    expect(keyAction('Escape', at())).toBe('deselect');
    expect(keyAction('Escape', at({ sheet: true }))).toBeNull();
  });
  it('the tour takes Enter, the right arrow and Escape', () => {
    expect(keyAction('Enter', at({ tour: true }))).toBe('tour-next');
    expect(keyAction('ArrowRight', at({ tour: true }))).toBe('tour-next');
    expect(keyAction('Escape', at({ tour: true }))).toBe('tour-end');
    expect(keyAction('Delete', at({ tour: true }))).toBeNull();
  });
  it('typing: an input, a text area, a select, or editable text', () => {
    expect(isTyping({ tagName: 'INPUT' } as Element)).toBe(true);
    expect(isTyping({ tagName: 'SELECT' } as Element)).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(true);
    expect(isTyping({ tagName: 'BUTTON' } as Element)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('Apply sends the draft you reviewed', () => {
  const s = (rev: number, mine = drill()) => ({ rev, base: 4, server: drill(), mine, conflicts: [] });
  it('the revision recorded when the sheet opened, once it is still the one there', () => {
    expect(applyRev(s(3), 3, '')).toEqual({ rev: 3 });
  });
  it("Cora changed it while the sheet was open: refused here, and the next click applies what's shown now", () => {
    expect(applyRev(s(4), 3, '')).toEqual({ error: DRAFT_MOVED, seen: 4 });
    expect(DRAFT_MOVED).toBe('The draft changed since you opened this; review it again.');
  });
  it("an edit of yours not on the server, or the sheet still saving: nothing is applied", () => {
    const mine = clone(drill());
    mine.seats[0].instructions = 'Mine.';
    expect(applyRev(s(3, mine), 3, '')).toEqual({ error: 'Your last edit is still on its way, so nothing was applied. Apply again in a moment.' });
    expect(applyRev(s(3, mine), 3, "Cora isn't answering.")).toEqual({ error: "Your last edit isn't saved (Cora isn't answering), so nothing was applied." });
    expect(applyRev(s(3), null, '')).toEqual({ error: 'Your edits are still being saved. Apply again in a moment.' });
    expect(applyRev(null, 3, '')).toEqual({ error: 'There is no draft to apply.' });
  });
});

describe("a lead's proposal on screen", () => {
  it('Talk is off, and says why: no box to type in, no chips, no Undo', () => {
    const turn = { ids: ['t1'], summary: 'added Monitor C', undone: false };
    const h = renderToStaticMarkup(createElement(Talk, { lines: [{ id: 'l1', who: 'cora', at: 1, text: 'Done.', turn }] as never, busy: false, off: TALK_OFF_PROPOSAL, offline: '', chips: ['Add a seat'], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 })).replace(/&#x27;/g, "'");
    expect(h).toContain("Talk edits your draft; you're looking at the lead's proposal.");
    expect(h).toMatch(/<textarea[^>]*disabled=""/);
    expect(h).not.toContain('Add a seat');
    expect(h).not.toContain('>Undo<');
  });
  it('Back asks first when you edited it (the edits are only on this screen); otherwise it just goes', () => {
    expect(leavingAsk({ team: drillProposal(), at: 7, edited: true })).toBe("Leave the lead's proposal? Your edits to it are only on this screen, so they'll be lost.");
    expect(leavingAsk({ team: drillProposal(), at: 7, edited: false })).toBeNull();
    expect(leavingAsk(null)).toBeNull();
  });
});

describe('throwing a draft away', () => {
  const sheet = (more: object = {}) => renderToStaticMarkup(createElement(StartSheet, { name: 'Native Drill', version: 4, coraDown: false, onCora() {}, onBuild() {}, onClose() {}, ...more })).replace(/&#x27;/g, "'");
  it('Start over offers Discard draft when there is a draft (and only then)', () => {
    expect(sheet({ onDiscard() {} })).toMatch(/<button class="btn bad"[^>]*>Discard draft<\/button>/);
    expect(sheet()).not.toContain('Discard draft');
  });
});

describe('after Apply', () => {
  const t = drill();
  it('applied: its version, and who restarts when you say', () => {
    expect(appliedOutcome({ ok: true, version: 5, restart: ['triage'] }, false, t)).toEqual({ sum: 'Applied as v5: Triage restarts when you say (Team panel)', tone: 'ok', notes: [] });
    expect(appliedOutcome({ ok: true, version: 5 }, false, t).sum).toBe('Applied as v5');
  });
  it('applied and brought up: how many started', () => {
    expect(appliedOutcome({ ok: true, version: 5, started: ['a', 'b'] }, true, t)).toEqual({ sum: 'Applied as v5 and brought up: 2 sessions started', tone: 'ok', notes: [] });
  });
  it('a bring-up that failed after the team was applied is reported, not a failed apply', () => {
    const o = appliedOutcome({ ok: true, version: 5, started: ['a'], upProblems: ["Monitor A's folder isn't on this PC."] }, true, t);
    expect(o.sum).toBe("Applied as v5, but it didn't all come up (see Checks)");
    expect(o.tone).toBe('bad');
    expect(o.notes).toEqual([
      { text: '1 session started.', level: 'info' },
      { text: "Didn't come up: Monitor A's folder isn't on this PC.", level: 'warn' },
    ]);
  });
  it("a draft whose team moved on (Cora, a rollback, an approval): said, and Apply goes through the rebase first", () => {
    const s = { rev: 3, base: 4, server: drill(), mine: drill(), conflicts: [] };
    expect(draftMoved(s, 5)).toBe(true);
    expect(draftMoved(s, 4)).toBe(false);
    // nothing of yours on it (revision 0): it just follows the team
    expect(draftMoved({ ...s, rev: 0 }, 5)).toBe(false);
    expect(draftMoved(null, 5)).toBe(false);
  });
  it("the folder check's answer: its lists; not checked, none and a note; no folders left, nothing and no note", () => {
    expect(folderCheck({ ok: true, missing: ['C:/a'], notRepo: ['C:/b'], missingFiles: ['C:/w/ci.log'] })).toEqual({ missing: ['C:/a'], notRepo: ['C:/b'], missingFiles: ['C:/w/ci.log'], note: '' });
    expect(folderCheck({ ok: true, missing: [] })).toEqual({ missing: [], notRepo: [], missingFiles: [], note: '' });
    expect(folderCheck({ ok: false })).toEqual({ missing: [], notRepo: [], missingFiles: [], note: "The seats' folders couldn't be checked on this PC just now." });
    expect(folderCheck(null)).toEqual({ missing: [], notRepo: [], missingFiles: [], note: '' });
  });
  it('a layout that did not save is said, plainly; one that did, nothing', () => {
    expect(layoutNote({ ok: true })).toBe('');
    expect(layoutNote({ ok: false, error: 'Failed to fetch' })).toBe("Where the seats are drawn wasn't saved: Cora isn't answering.");
  });
  it("the runtime's problems on Apply (a seat that didn't start, files not written) are said, never a green Applied", () => {
    const o = appliedOutcome({ ok: true, version: 5, restart: [], problems: ["repo/x isn't a full path, so Cora won't make it."] }, false, t);
    expect(o.sum).toBe('Applied as v5, but not all of it took (see Checks)');
    expect(o.tone).toBe('bad');
    expect(o.notes).toEqual([{ text: "Didn't take: repo/x isn't a full path, so Cora won't make it.", level: 'warn' }]);
    const up = appliedOutcome({ ok: true, version: 5, started: ['a'], problems: ['Files not written.'] }, true, t);
    expect(up.tone).toBe('bad');
    expect(up.notes).toContainEqual({ text: "Didn't take: Files not written.", level: 'warn' });
  });
  it("errors in plain words: Cora not answering, else the server's own words", () => {
    expect(plainError({ ok: false, error: 'Failed to fetch' })).toBe("Cora isn't answering. Nothing changed.");
    expect(plainError({ ok: false, error: 'failed (502)' })).toBe("Cora isn't answering. Nothing changed.");
    expect(plainError({ ok: false, error: 'There is no draft to apply.' })).toBe('There is no draft to apply.');
    expect(plainError({ ok: false, error: 'x', problems: ['Triage has no folder.', 'Nobody hears Analysts.'] })).toBe('Triage has no folder. Nobody hears Analysts.');
    expect(plainError({ ok: false })).toBe('That did not work.');
  });
});

describe("the builder's waits", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('one that has run is no longer held (only those still to come are, to clear on closing)', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
    const waits: number[] = [];
    const ran: string[] = [];
    waitIn(waits, 100, () => ran.push('a'));
    waitIn(waits, 300, () => ran.push('b'));
    expect(waits).toHaveLength(2);
    vi.advanceTimersByTime(150);
    expect(ran).toEqual(['a']);
    expect(waits).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(ran).toEqual(['a', 'b']);
    expect(waits).toEqual([]);
  });
});
