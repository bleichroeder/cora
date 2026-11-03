import { describe, expect, it } from 'vitest';
import type { Post, Project, SessionInfo } from '@cora/shared';
import { bringUpOffer, changeKeys, cutOff, groupLine, teamActOutcome, teamFacts } from '../src/components/board/TeamPanel';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CrewMenuPanel, FIRST_SETTING, NO_PIN, postFate, replyPin, replyTarget, teamNotRunning, type ReplyPin } from '../src/components/board/ProjectPanels';

describe("the Team panel's Bring up", () => {
  it('a team stood down: always', () => {
    expect(bringUpOffer({ up: false, failing: false, down: [], seated: true })).toMatchObject({ enabled: true, go: true });
  });

  it('a team up and whole: not (nothing to bring up)', () => {
    expect(bringUpOffer({ up: true, failing: false, down: [], seated: true })).toEqual({ enabled: false, go: false, title: 'The team is up' });
  });

  it('up, with seats failing to start: to try them again', () => {
    expect(bringUpOffer({ up: true, failing: true, down: [], seated: true })).toMatchObject({ enabled: true, title: 'Try the seats that failed to start again' });
  });

  it('up, with a seat stood down on its own: to bring it back', () => {
    const o = bringUpOffer({ up: true, failing: false, down: ['Triage'], seated: true });
    expect(o).toMatchObject({ enabled: true, go: true });
    expect(o.title).toBe('Bring back Triage (stood down on its own)');
    expect(bringUpOffer({ up: true, failing: true, down: ['Triage', 'Fix'], seated: true }).title).toBe('Bring back Triage and Fix (stood down on their own), and try the seats that failed to start again');
  });

  it('up, with a standing seat below its minimum (dead, waiting out its back-off): to start it again now', () => {
    expect(bringUpOffer({ up: true, failing: false, down: [], short: ['Engineer'], seated: true })).toEqual({ enabled: true, go: true, title: 'Start Engineer again now (fewer running than its minimum)' });
    expect(bringUpOffer({ up: true, failing: false, down: [], short: ['Engineer', 'Tester'], seated: true }).title).toBe('Start Engineer and Tester again now (fewer running than their minimum)');
    expect(bringUpOffer({ up: true, failing: false, down: [], short: [], seated: true }).enabled).toBe(false);
  });
});

describe("the Team panel's facts about the team", () => {
  const t = { version: 1, seats: [{ id: 'triage', name: 'Triage', count: { min: 1, max: 1 } }, { id: 'enc', name: 'Encoder fixer', count: { min: 1, max: 2 } }], groups: [{ id: 'g', name: 'Encoders', members: ['enc'], dispatch: 'claim', grow: { seat: 'enc', max: 5 } }], labels: [], routes: [], fallback: 'seat:triage', escalation: [], lead: 'triage', skills: [{ name: 'runbook', description: '', body: '' }] } as never;
  it('who leads, where a refused message should go, the team skills; a pool grows only to its seat maximum', () => {
    expect(teamFacts(t)).toEqual(['Triage leads (its first member, once the team is up).', 'A message no route allows is refused, naming Triage to send it to instead when its sender may message Triage.', 'Team skills: runbook.']);
    expect(groupLine(t, (t as { groups: never[] }).groups[0])).toBe('Encoder fixer · first free claims it (grows to 2)');
    expect(teamFacts({ ...(t as object), lead: undefined, skills: [], fallback: 'user' } as never)).toEqual(['No seat leads.', 'A message no route allows is refused, naming the user to send it to instead when its sender may message the user.']);
  });
});

describe('a team up whose seats are cut off by the project settings', () => {
  const p = (more: Partial<Project> = {}) =>
    ({
      id: 'p', name: 'Ops', coordination: true, sessions: ['s1', 's2'],
      members: { s1: { hears: 'everything', canPost: true, wakes: true, seat: 'triage' }, s2: { hears: 'everything', canPost: false, wakes: true, seat: 'fix' } },
      team: { version: 1, seats: [{ id: 'triage', name: 'Triage' }, { id: 'fix', name: 'Fix' }], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] },
      ...more,
    }) as unknown as Project;
  it("coordination off: every seat can't post, hear the project or hand off, said once", () => {
    expect(cutOff(p({ coordination: false }), true)).toEqual(["Coordination is off (the project's header): its seats can't post, hear the project or hand off work. Turn it on for the team to work."]);
  });
  it('a seat a member of which may not post, or hears nothing: said by its seat', () => {
    expect(cutOff(p(), true)).toEqual(["Fix may not post (Crew): it can't message anyone or hand off work."]);
    const deaf = p();
    deaf.members.s1 = { ...deaf.members.s1, hears: 'nothing' };
    expect(cutOff(deaf, true)).toContain("Triage hears nothing of the project (Crew): it can't read its board or items.");
  });
  it('a team stood down: nothing to say', () => {
    expect(cutOff(p({ coordination: false }), false)).toEqual([]);
  });
});

describe("the Crew's reply line", () => {
  const mem = (id: string, state = 'idle') => ({ id, state }) as unknown as SessionInfo;

  it('goes to the one picked, else the first waiting on you, else the first', () => {
    const ms = [mem('a'), mem('b'), mem('c', 'needs-you')];
    expect(replyTarget(ms, NO_PIN, () => false).id).toBe('c');
    expect(replyTarget(ms, NO_PIN, (sid) => sid === 'b').id).toBe('b');
    expect(replyTarget(ms, { picked: 'a', typing: null }, (sid) => sid === 'b').id).toBe('a');
    expect(replyTarget([mem('a'), mem('b')], NO_PIN, () => false).id).toBe('a');
  });

  /** the line as MembersPanel drives it: typing, sending, picking */
  const line = (ms: SessionInfo[], asks: (sid: string) => boolean) => {
    let pin: ReplyPin = NO_PIN;
    return {
      to: () => replyTarget(ms, pin, asks).id,
      type: (text: string) => void (pin = replyPin(pin, { kind: 'type', text, target: replyTarget(ms, pin, asks).id })),
      sent: () => void (pin = replyPin(pin, { kind: 'sent' })),
      pick: (sid: string) => void (pin = replyPin(pin, { kind: 'pick', sid })),
    };
  };

  it('typing pins it: a member starting to ask mid-sentence does not change the To', () => {
    const asking = new Set<string>();
    const l = line([mem('a'), mem('b')], (sid) => asking.has(sid));
    // you start typing to a (nobody waiting on you)
    l.type('h');
    asking.add('b');
    l.type('hi');
    expect(l.to()).toBe('a');
    // picking another still moves it, and typing on keeps it there
    l.pick('b');
    l.type('hi b');
    expect(l.to()).toBe('b');
  });

  it('sent (or emptied), the pin from typing goes: the To follows the first waiting on you again', () => {
    const asking = new Set<string>();
    const l = line([mem('a'), mem('b'), mem('c')], (sid) => asking.has(sid));
    l.type('one');
    asking.add('b');
    expect(l.to()).toBe('a');
    l.sent();
    expect(l.to()).toBe('b');
    // the next one: pinned again as you type
    l.type('two');
    asking.delete('b');
    asking.add('c');
    expect(l.to()).toBe('b');
    // you clear the line: no pin
    l.type('');
    expect(l.to()).toBe('c');
  });

  it('a pick stays after sending (until you pick another)', () => {
    const asking = new Set<string>();
    const l = line([mem('a'), mem('b')], (sid) => asking.has(sid));
    l.pick('a');
    l.type('x');
    l.sent();
    asking.add('b');
    expect(l.to()).toBe('a');
    l.type('');
    expect(l.to()).toBe('a');
  });
});

describe('Needs you: Team not running', () => {
  const seat = { id: 'a', name: 'A', instructions: '', agent: {}, skills: [], folder: { path: 'C:/w' }, count: { min: 0, max: 1 }, startup: {} };
  const proj = (o: Partial<Project> = {}) => ({ id: 'p', name: 'Ops', sessions: [], members: {}, thread: [], decisions: [], team: { version: 1, seats: [seat], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] }, ...o }) as unknown as Project;

  it('a team defined that has never run: shown', () => {
    expect(teamNotRunning(proj())).toBe(true);
  });

  it('a team you stood down (its seats all count.min 0, so nothing of it is left): not shown', () => {
    expect(teamNotRunning(proj({ teamStoodDown: true }))).toBe(false);
  });

  it('a team up, or with a seated member: not shown; no team: not shown', () => {
    expect(teamNotRunning(proj({ teamUp: true }))).toBe(false);
    expect(teamNotRunning(proj(), true)).toBe(false);
    expect(teamNotRunning(proj({ sessions: ['s1'], members: { s1: { seat: 'a' } } as never }))).toBe(false);
    expect(teamNotRunning(proj({ team: undefined }))).toBe(false);
  });
});

describe("the Crew's Settings menu", () => {
  const s = { id: 's1', alias: 'Fixer', state: 'idle', cwd: 'C:/w' } as unknown as SessionInfo;
  const proj = (coordination: boolean) => ({ id: 'p', name: 'Ops', coordination, sessions: ['s1'], lead: 's1', members: { s1: { hears: 'everything', canPost: true, wakes: false } }, thread: [], decisions: [] }) as unknown as Project;
  const html = (coordination = true) => renderToStaticMarkup(createElement(CrewMenuPanel, { p: proj(coordination), s, onClose() {} }));

  it('is a dialog named for its member (it holds a text field and a choice of three, which a menu cannot)', () => {
    const h = html();
    expect(h).toMatch(/^<div class="pc-menu" role="dialog" tabindex="-1" aria-label="[^"]+: its settings in this project"/);
    expect(h).not.toMatch(/role="menu/);
  });

  it('its toggles are switches that say whether they are on; Hears is a group of pressed buttons; the seat name is labelled', () => {
    const h = html();
    expect([...h.matchAll(/role="switch" aria-checked="(true|false)"/g)].map((m) => m[1])).toEqual(['true', 'true', 'false']);
    expect(h).toContain('role="group" aria-label="Hears"');
    expect([...h.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1])).toEqual(['false', 'false', 'true']);
    expect(h).toMatch(/<input[^>]*aria-label="Seat name"/);
  });

  it('the focus goes to its first setting (the Lead switch), never to "Take out of the project"', () => {
    expect(FIRST_SETTING).toBe('button:not(.bad), input');
    // the first button without class bad, or input, in document order
    const first = /<(button)(?![^>]*class="[^"]*\bbad\b)[^>]*>([\s\S]*?)<\/button>|<input[^>]*>/.exec(html());
    expect(first?.[2]).toContain('Lead of the project');
    // no settings (coordination off): nothing but "Take out", so the menu itself takes it
    expect(/<button(?![^>]*class="[^"]*\bbad\b)[^>]*>|<input/.test(html(false))).toBe(false);
    expect(html(false)).toContain('class="mi bad"');
  });
});

describe("a proposal's change lines", () => {
  it('a line opened stays with that line, wherever it moves; another line in its place is not opened; twins are told apart', () => {
    const watch = { line: 'Triage instructions: "Watch…"', full: 'Watch the alerts.' };
    const fix = { line: 'Analyst instructions: "Fix…"', full: 'Fix the encoders.' };
    const before = changeKeys([watch]);
    // a newer proposal: a line before it, so it moved down one
    const after = changeKeys([fix, { ...watch }]);
    expect(after[1]).toBe(before[0]);
    expect(after[0]).not.toBe(before[0]);
    const twins = changeKeys([watch, watch]);
    expect(twins[0]).not.toBe(twins[1]);
  });
});

describe("the Team panel's actions", () => {
  it("say the team's problems, else what went wrong, and never throw (a request that threw too)", async () => {
    expect(await teamActOutcome(async () => ({ ok: true }))).toEqual({ problems: [], error: '' });
    expect(await teamActOutcome(async () => ({ ok: false, error: 'not live', problems: ['Triage has no folder.'] }))).toEqual({ problems: ['Triage has no folder.'], error: '' });
    expect(await teamActOutcome(async () => ({ ok: false }))).toEqual({ problems: [], error: 'That did not work.' });
    expect(await teamActOutcome(async () => { throw new Error('Failed to fetch'); })).toEqual({ problems: [], error: 'Failed to fetch' });
    expect(await teamActOutcome(() => { throw new Error('bad'); })).toEqual({ problems: [], error: 'bad' });
  });
});

describe("a post's fate on the board", () => {
  const post = (o: Partial<Post> = {}): Post => ({ id: 'x1', by: 'a', kind: 'handoff', text: 'yours', at: 10, to: ['b'], ...o });
  const proj = (o: Partial<Project> = {}) => ({ id: 'p1', name: 'P', thread: [], members: { b: { heardTo: 0 } }, sessions: ['a', 'b'], ...o }) as unknown as Project;
  it("waits for its turn; once Cora can't reach its member, not delivered (and that over waiting)", () => {
    expect(postFate(proj({ waiting: [{ post: 'x1', to: 'b', since: 1 }] }), post(), [], false)).toEqual({ t: 'waits for its turn', c: 'wait' });
    expect(postFate(proj({ waiting: [{ post: 'x1', to: 'b', since: 1, undelivered: 5 }] }), post(), [], false)).toEqual({ t: 'not delivered: not running here', c: 'lost' });
    // to two: one waits for its turn, one can't be reached
    expect(postFate(proj({ waiting: [{ post: 'x1', to: 'b', since: 1 }, { post: 'x1', to: 'c', since: 1, undelivered: 5 }] }), post({ to: ['b', 'c'] }), [], false)?.c).toBe('lost');
    // held for your OK still says so
    expect(postFate(proj({ waiting: [{ post: 'x1', to: 'b', since: 1, undelivered: 5 }] }), post(), [{ id: 'w', project: 'p1', from: 'a', to: 'b', text: '', at: 1, post: 'x1' }], false)?.c).toBe('held');
    expect(postFate(proj(), post({ deliveredAt: 20 }), [], false)).toEqual({ t: 'delivered', c: '' });
  });
});
