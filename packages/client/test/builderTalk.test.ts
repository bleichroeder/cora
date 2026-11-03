import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILDER_FIRST_PROMPT, checkTeam, emptyTeam, type BrainEvent, type TerminalInfo } from '@cora/shared';
import { builderRunning, SENDING_MAX_MS, sendingGone, sendingStopped, stillSending, suggestions, talkActivity, talkBusy, talkLines, turnClock, withSending } from '../src/components/builder/talkLines';
import { Talk } from '../src/components/builder/Talk';
import { drill } from '@cora/shared/test/fixtures';

let n = 0;
const ev = (kind: BrainEvent['kind'], ts: number, text?: string): BrainEvent => ({ id: `e${++n}`, seq: n, sessionId: 'b', agentId: 'main', ts, kind, icon: {} as never, source: 'hook', ...(text ? { text } : {}) });
const un = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const render = (el: ReturnType<typeof createElement>) => un(renderToStaticMarkup(el));
const turn = (id: string, at: number, summary: string, undone = false) => ({ id, at, summary, ...(undone ? { undone: true as const } : {}) });

describe("Talk's lines", () => {
  const evs = [ev('prompt', 1, BUILDER_FIRST_PROMPT), ev('say', 2, "What's the team for?"), ev('turn_end', 3), ev('prompt', 10, 'I need a team that watches our encoders'), ev('say', 12, 'Here is a start.'), ev('say', 14, 'What kinds of issues?'), ev('turn_end', 15), ev('prompt', 20, 'encoder and network')];

  it('hides her own first prompt; your words and hers in order', () => {
    expect(talkLines(evs, []).map((l) => [l.who, l.text])).toEqual([
      ['cora', "What's the team for?"],
      ['you', 'I need a team that watches our encoders'],
      ['cora', 'Here is a start.'],
      ['cora', 'What kinds of issues?'],
      ['you', 'encoder and network'],
    ]);
  });

  it("each turn's changes go under the last thing she said in that turn, one line, with Undo for that turn", () => {
    const lines = talkLines(evs, [turn('t1', 11, 'added Monitor A'), turn('t2', 13, 'route Monitor A → Triage')]);
    expect(lines[3].turn).toEqual({ ids: ['t1', 't2'], summary: 'added Monitor A · route Monitor A → Triage', undone: false });
    expect(lines[2].turn).toBeUndefined();
  });

  it('a change with nothing said still shows', () => {
    const lines = talkLines([ev('prompt', 1, 'go'), ev('turn_end', 3)], [turn('t1', 2, 'added Triage', true)]);
    expect(lines.at(-1)).toMatchObject({ who: 'cora', turn: { undone: true, summary: 'added Triage' } });
  });

  it('Undo covers only the turns still in the draft; undone ones show struck', () => {
    const lines = talkLines(evs, [turn('t1', 11, 'added Monitor A', true), turn('t2', 13, 'route Monitor A → Triage')]);
    expect(lines[3].turn).toEqual({ ids: ['t2'], summary: 'route Monitor A → Triage', undone: false, struck: ['added Monitor A'] });
    const all = talkLines(evs, [turn('t1', 11, 'a', true), turn('t2', 13, 'b', true)]);
    expect(all[3].turn).toMatchObject({ ids: [], undone: true });
  });

  it("a message sent mid-turn is shown but doesn't start a new turn; a change before her words keeps its line's id", () => {
    const mid = { ...ev('prompt', 13, 'also the network'), midTurn: true };
    const lines = talkLines([ev('prompt', 10, 'go'), ev('say', 12, 'On it.'), mid, ev('say', 14, 'Done.')], [turn('t1', 11, 'added A'), turn('t2', 15, 'added B')]);
    expect(lines.map((l) => l.who)).toEqual(['you', 'cora', 'you', 'cora']);
    expect(lines[3].turn?.ids).toEqual(['t1', 't2']);
    const go = ev('prompt', 10, 'go');
    const before = talkLines([go], [turn('t1', 11, 'added A')]);
    const after = talkLines([go, ev('say', 12, 'Done.')], [turn('t1', 11, 'added A')]);
    expect(before[1].id).toBe(after[1].id);
  });

  it('busy while your words wait for her turn to end', () => {
    expect(talkBusy(evs)).toBe(true);
    expect(talkBusy(evs.slice(0, 7))).toBe(false);
  });

  it("not busy once her session isn't running: ended or killed mid-turn, no turn end was ever recorded", () => {
    expect(evs.at(-1)?.kind).toBe('prompt');
    expect(talkBusy(evs, true)).toBe(true);
    expect(talkBusy(evs, false)).toBe(false);
  });

  it('her session is running while its terminal is alive here (ended: none, or a dead one)', () => {
    const T = (sessionId: string, alive: boolean, shell?: string) => ({ terminalId: `t-${sessionId}-${alive}`, sessionId, cwd: 'C:/b', mode: shell ? 'shell' : 'new', alive, startedAt: 1, ...(shell ? { shell } : {}) }) as TerminalInfo;
    expect(builderRunning([T('b', true)], 'b')).toBe(true);
    expect(builderRunning([T('b', false)], 'b')).toBe(false);
    expect(builderRunning([T('x', true)], 'b')).toBe(false);
    expect(builderRunning([T('b', true, 'Git Bash')], 'b')).toBe(false);
    expect(builderRunning([T('b', true)], null)).toBe(false);
  });

  it("what you sent while she was running stops showing as sending when she stops; what you sent to start her waits for her", () => {
    const sent = [
      { id: 'a', text: 'while running', at: 1, live: true as const },
      { id: 'b', text: 'to start her', at: 2 },
    ];
    expect(sendingStopped(sent, true)).toBe(sent);
    expect(sendingStopped(sent, false).map((s) => s.id)).toEqual(['b']);
    expect(sendingStopped([sent[1]], false)).toEqual([sent[1]]);
  });

  it('suggestions for the obvious next steps', () => {
    expect(suggestions(emptyTeam(), [])).toEqual(['I need a team that watches our encoders']);
    expect(suggestions(drill(), checkTeam(drill()))).toEqual(['what is still missing?', 'try a message', 'are we ready?']);
    expect(suggestions({ ...drill(), escalation: [] }, [])).toEqual(['add an escalation', 'try a message', 'are we ready?']);
    expect(suggestions({ ...drill(), escalation: [] }, [{ severity: 'error', message: 'x' } as never])).toEqual(['what is still missing?', 'add an escalation', 'are we ready?']);
  });
});

describe('what Cora is doing while she drafts', () => {
  const tool = (name: string, phase: 'start' | 'end', id: string, ts: number): BrainEvent => ({ ...ev('tool', ts), phase, toolUseId: id, tool: { name, input: {}, summary: '' } });
  const go = ev('prompt', 1_000, 'I need a team');
  it('the tool in progress, in words; Thinking when her latest step is a think; how long the turn has run', () => {
    expect(talkActivity([go], 1_000)).toEqual({ step: 'Working', clock: '00:00' });
    expect(talkActivity([go, tool('Skill', 'start', 'k', 1_100)], 2_000)).toEqual({ step: 'Looking up how to build teams', clock: '00:01' });
    const read = [go, tool('Skill', 'start', 'k', 1_100), tool('Skill', 'end', 'k', 1_200), tool('mcp__cora__team_draft_get', 'start', 'g', 1_300)];
    expect(talkActivity(read, 84_000)?.step).toBe('Reading the draft');
    expect(talkActivity(read, 84_000)?.clock).toBe('01:23');
    const set = [...read, tool('mcp__cora__team_draft_get', 'end', 'g', 1_400), ev('think', 1_500)];
    expect(talkActivity(set, 2_000)?.step).toBe('Thinking');
    expect(talkActivity([...set, tool('mcp__cora__team_draft_set', 'start', 's', 1_600)], 2_000)?.step).toBe('Saving changes');
    expect(talkActivity([...set, tool('mcp__cora__team_trace', 'start', 't', 1_600)], 2_000)?.step).toBe('Tracing a message');
    expect(talkActivity([...set, tool('Read', 'start', 'r', 1_600)], 2_000)?.step).toBe('Read');
    // a think that isn't her latest step, and no tool open: just working
    expect(talkActivity([...set, ev('say', 1_600, 'Here it is.')], 2_000)?.step).toBe('Working');
  });
  it("a tool whose end never came stops being her step once she has moved on (said or thought something since)", () => {
    const stuck = [go, tool('mcp__cora__team_draft_set', 'start', 's', 1_100)];
    expect(talkActivity(stuck, 2_000)?.step).toBe('Saving changes');
    expect(talkActivity([...stuck, ev('say', 1_200, 'Done.')], 2_000)?.step).toBe('Working');
    expect(talkActivity([...stuck, ev('think', 1_200)], 2_000)?.step).toBe('Thinking');
    expect(talkActivity([...stuck, ev('think', 1_200), tool('Read', 'start', 'r', 1_300)], 2_000)?.step).toBe('Read');
    expect(talkActivity([...stuck, ev('say', 1_200, 'Next.'), tool('Read', 'start', 'r', 1_300), tool('Read', 'end', 'r', 1_400)], 2_000)?.step).toBe('Working');
  });
  it("words you add mid-turn don't restart the clock; her helpers' events aren't hers; none between turns", () => {
    const mid = { ...ev('prompt', 30_000, 'also the network'), midTurn: true };
    expect(talkActivity([go, mid], 61_000)?.clock).toBe('01:00');
    expect(talkActivity([go, { ...ev('think', 1_100), agentId: 'helper' }], 2_000)?.step).toBe('Working');
    expect(talkActivity([go, ev('turn_end', 2_000)], 3_000)).toBeNull();
    expect(talkActivity([], 3_000)).toBeNull();
  });
  it('the clock is minutes and seconds', () => {
    expect(turnClock(0)).toBe('00:00');
    expect(turnClock(9_999)).toBe('00:09');
    expect(turnClock(61 * 60_000 + 5_000)).toBe('61:05');
    expect(turnClock(-5)).toBe('00:00');
  });
  it('Talk shows it under her name, with the dots beside the words, and the time the turn has run', () => {
    const h = render(createElement(Talk, { lines: [], busy: true, activity: () => ({ step: 'Reading the draft', clock: '01:23' }), offline: '', chips: [], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 }));
    expect(h).toMatch(/<div class="who">Cora<time>01:23<\/time><\/div><div class="doing"><span class="dots">(<i><\/i>){3}<\/span><span class="step">Reading the draft<\/span><\/div>/);
    const starting = render(createElement(Talk, { lines: [], busy: true, activity: () => null, offline: '', chips: [], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 }));
    expect(starting).toContain('<span class="step">Getting started</span>');
  });
});

describe('Talk', () => {
  it("her name in her colour, her turn's line with Undo, the composer; and when she isn't available, it says so", () => {
    const lines = talkLines([ev('prompt', 1, 'go'), ev('say', 2, 'Done.')], [turn('t1', 1.5, 'added Triage')]);
    const h = render(createElement(Talk, { lines, busy: false, offline: '', chips: ['add an escalation'], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 }));
    expect(h).toContain('class="msg2 cora"');
    expect(h).toContain('added Triage');
    expect(h).toContain('>Undo<');
    expect(h).toContain('placeholder="Tell Cora…');
    expect(h).toContain('add an escalation');
    const off = render(createElement(Talk, { lines: [], busy: false, offline: "Cora couldn't start: claude not found", chips: [], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 }));
    expect(off).toContain('class="offline"');
    expect(off).toContain("Cora couldn't start: claude not found");
    expect(off).toContain('Tell Cora what the team is for.');
  });

  it('undone and mixed lines, the busy dots, and markup in words stays text', () => {
    const none = { onSend() {}, onUndo() {}, onChip() {}, focusKey: 0, chips: [], offline: '' };
    const lines = talkLines([ev('prompt', 1, '<script>alert(1)</script>'), ev('say', 2, 'hi <script>x</script>')], [turn('t1', 1.5, 'added A', true), turn('t2', 1.6, 'added B')]);
    const h = render(createElement(Talk, { ...none, lines, busy: true }));
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;alert(1)');
    expect(h).toContain('<s> · added A</s>');
    expect(h).toContain('>Undo<');
    expect(h).toContain('class="dots"');
    const gone = render(createElement(Talk, { ...none, lines: talkLines([ev('prompt', 1, 'go'), ev('say', 2, 'ok')], [turn('t1', 1.5, 'added A', true)]), busy: false }));
    expect(gone).toContain('<em>undone</em>');
    expect(gone).not.toContain('>Undo<');
    expect(gone).not.toContain('class="dots"');
    const off = render(createElement(Talk, { ...none, lines: [], busy: false, offline: "Cora isn't running (claude not found)." }));
    expect(off).toContain("Cora isn't running (claude not found); you can still build by hand or from a shape.");
  });
});

describe('the Talk box', () => {
  it('is a box that grows like the session composer (Enter sends, Shift+Enter a new line), not a single-line field', () => {
    const h = renderToStaticMarkup(createElement(Talk, { lines: [], busy: false, offline: '', chips: [], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 }));
    expect(h).toMatch(/<textarea[^>]*rows="1"/);
    expect(h).toContain('Shift+Enter new line');
    expect(h).not.toMatch(/<input[^>]*Tell Cora/);
  });
});

describe('what you just sent', () => {
  const sent = (id: string, text: string, at: number) => ({ id, text, at });
  it('shows at once as yours, marked sending, until it arrives in the conversation', () => {
    const lines = talkLines([ev('prompt', 1, BUILDER_FIRST_PROMPT), ev('say', 2, "What's the team for?"), ev('turn_end', 3)], []);
    const shown = withSending(lines, [sent('p1', 'a team for our encoders', 5)]);
    expect(shown.at(-1)).toMatchObject({ id: 'p1', who: 'you', text: 'a team for our encoders', sending: true });
    expect(stillSending([sent('p1', 'a team for our encoders', 5)], lines)).toHaveLength(1);
  });
  it('once it arrives (even typed with its leading-slash guard, or its spacing changed), the sending line goes', () => {
    const lines = talkLines([ev('prompt', 1, BUILDER_FIRST_PROMPT), ev('prompt', 6, '​/split the analysts\nby label')], []);
    const pending = [sent('p1', '/split the analysts\n by label', 5)];
    expect(stillSending(pending, lines)).toEqual([]);
    expect(withSending(lines, pending).filter((l) => l.sending)).toEqual([]);
  });
  it('the same words said again earlier do not count as this one arriving', () => {
    const lines = talkLines([ev('prompt', 1, 'yes'), ev('turn_end', 2)], []);
    expect(stillSending([sent('p2', 'yes', 50_000)], lines)).toHaveLength(1);
  });
  it("what never arrives (Cora restarted while her session was starting) is given up on after a while, never sending for ever", () => {
    const pending = [sent('p1', 'a', 1000), sent('p2', 'b', 1000 + SENDING_MAX_MS)];
    expect(sendingGone(pending, 1000 + SENDING_MAX_MS - 1)).toEqual([]);
    expect(sendingGone(pending, 1000 + SENDING_MAX_MS).map((p) => p.id)).toEqual(['p1']);
    expect(SENDING_MAX_MS).toBeGreaterThan(90_000);
  });
  it('Cora shows as working from the moment you send', () => {
    const h = render(createElement(Talk, { lines: withSending([], [sent('p1', 'hello', 5)]), busy: true, offline: '', chips: [], onSend() {}, onUndo() {}, onChip() {}, focusKey: 0 }));
    expect(h).toContain('sending');
    expect(h).toContain('class="dots"');
  });
});
