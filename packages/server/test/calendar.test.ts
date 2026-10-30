import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, findRefs, headline, looksLikeStandup, mergeRefs, refsLine, type BrainEvent, type CalEvent, type CalendarMsg, type SessionInfo } from '@cora/shared';
import { Calendar, dueNow, mapEvent, plainText, startingNow, withWhom } from '../src/calendar';
import { draftPrep, journalTrail } from '../src/calendarPrep';
import { Drafts } from '../src/drafts';
import { Journal, parseStamp, repoName } from '../src/journal';
import { Notes } from '../src/notes';
import { Prefs } from '../src/prefs';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const S = { id: 'abcdef12-3456-7890-abcd-ef1234567890', name: 'ACME-5340 · Fix seek', cwd: 'C:/code/aurora', startedAt: new Date(2026, 9, 29, 9, 0).getTime(), ticket: 'ACME-5340 · Fix seek' };

describe('Journal 2: refs', () => {
  it('finds Jira keys (of your projects), merge requests, issues and links (claude.ai pages as artifacts) in an entry', () => {
    const r = findRefs('Fixed ACME-5340 (and UTF-8 noise), MR !412 merged, see #212 and https://gitlab.example.com/g/p/-/merge_requests/413. Report: https://claude.ai/code/artifact/abc-123.', { projects: ['ACME'] });
    expect(r).toEqual({ tickets: ['ACME-5340'], mrs: ['!412', '!413'], issues: ['#212'], artifacts: ['https://claude.ai/code/artifact/abc-123'], links: ['https://gitlab.example.com/g/p/-/merge_requests/413'] });
    // no projects known: any key; a "#1" or "a!1" isn't an issue or a merge request
    expect(findRefs('UTF-8 #1 a!2')).toEqual({ tickets: ['UTF-8'] });
  });
  it("gives an entry's headline: its first line, markdown off, short", () => {
    expect(headline('**#421 overnight check 1/3 (06:17Z): OK**\n- Prod rollover `000728` → `000729`')).toBe('#421 overnight check 1/3 (06:17Z): OK');
    expect(headline('\n## Found it\nmore')).toBe('Found it');
    expect(headline('- `npm test` green')).toBe('npm test green');
    expect(headline('x'.repeat(300))).toHaveLength(160);
  });
  it('merges refs in order without repeats, and writes the line under an entry', () => {
    const r = mergeRefs({ tickets: ['ACME-1'], explains: [{ id: 'e1', title: 'Plan' }] }, { tickets: ['ACME-1', 'ACME-2'], mrs: ['!4'], explains: [{ id: 'e1', title: 'Plan' }] });
    expect(r).toEqual({ tickets: ['ACME-1', 'ACME-2'], mrs: ['!4'], explains: [{ id: 'e1', title: 'Plan' }] });
    expect(refsLine(r, 'decision')).toBe('Refs: decision · ACME-1 · ACME-2 · !4 · explain "Plan"');
    expect(refsLine({})).toBe('');
  });
});

describe('Journal 2: the index', () => {
  it('keeps every entry with its refs, searchable by time, ticket, merge request, repo, kind and words', () => {
    const dir = tmp('cora-j2-');
    const data = tmp('cora-j2-data-');
    const at = (h: number) => new Date(2026, 9, 29, h, 0).getTime();
    const j = new Journal({ dir: () => dir, dataDir: data, projects: () => ['ACME'] });
    j.add(S, 'entry', 'Found the seek bug: the index is off by one.', at(10), { refs: { tickets: ['ACME-5340'] }, tag: 'finding' });
    j.add(S, 'entry', 'Opened !412 for it.', at(11), { refs: { tickets: ['ACME-5340'], mrs: ['!412'] } });
    j.add({ ...S, id: 'zzzzzzzz-other', cwd: 'C:/code/cora/.claude/worktrees/x' }, 'wrapup', 'Calendar done.', at(12));
    expect(j.query({ ticket: 'acme-5340' }).map((e) => e.text)).toEqual(['Opened !412 for it.', 'Found the seek bug: the index is off by one.']);
    expect(j.query({ mr: '412' })).toHaveLength(1);
    expect(j.query({ repos: ['cora'] }).map((e) => e.kind)).toEqual(['wrapup']);
    expect(j.query({ tag: 'finding' })).toHaveLength(1);
    expect(j.query({ words: 'seek index' })).toHaveLength(1);
    expect(j.query({ since: at(11) })).toHaveLength(2);
    expect(j.lastAt(S.id)).toBe(at(11));
    // read back after a restart: from the index
    expect(new Journal({ dir: () => dir, dataDir: data }).query({}).length).toBe(3);
    // no index (entries written before Journal 2): read in once from the files, their refs and kind from their text
    rmSync(join(data, 'journal-entries.jsonl'));
    const again = new Journal({ dir: () => dir, dataDir: data, projects: () => ['ACME'] }).query({});
    expect(again).toHaveLength(3);
    const found = again.find((e) => e.text.startsWith('Found'))!;
    expect(found).toMatchObject({ sessionId: S.id, repo: 'aurora', tag: 'finding', at: at(10), refs: { tickets: ['ACME-5340'] } });
    expect(again.find((e) => e.text.startsWith('Opened'))!.refs.mrs).toEqual(['!412']);
  });
  it('reads its own time stamps and repo names', () => {
    expect(parseStamp('Oct 29, 7:37 PM', 2026)).toBe(new Date(2026, 9, 29, 19, 37).getTime());
    expect(parseStamp('Oct 29, 12:05 AM', 2026)).toBe(new Date(2026, 9, 29, 0, 5).getTime());
    expect(parseStamp('nonsense', 2026)).toBeNull();
    expect(repoName('C:\\code\\cora\\.claude\\worktrees\\feat-x')).toBe('cora');
    expect(repoName('C:/code/aurora')).toBe('aurora');
  });
});

const T = new Date(2026, 9, 29, 13, 45).getTime();
const iso = (h: number, m = 0) => new Date(2026, 9, 29, h, m).toISOString();
const RAW = [
  { id: 'a', summary: 'Weekly planning', start: { dateTime: iso(14) }, end: { dateTime: iso(15) }, hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://calendar.google.com/x', description: '<p>Agenda: ACME-5340 &amp; !412</p>', attendees: [{ email: 'me@x.com', self: true, responseStatus: 'accepted' }, { email: 'dana@x.com', displayName: 'Dana Ruiz' }, { email: 'room@x.com', resource: true }] },
  { id: 'b', summary: 'Daily standup', recurringEventId: 'series1', start: { dateTime: iso(9, 30) }, end: { dateTime: iso(9, 45) }, location: 'https://acme.zoom.us/j/123' },
  { id: 'c', summary: 'Declined', start: { dateTime: iso(16) }, end: { dateTime: iso(17) }, attendees: [{ email: 'me@x.com', self: true, responseStatus: 'declined' }] },
  { id: 'd', summary: 'Holiday', start: { date: '2026-10-29' }, end: { date: '2026-10-30' } },
  { id: 'e', summary: 'Gone', status: 'cancelled', start: { dateTime: iso(10) }, end: { dateTime: iso(11) } },
  { id: 'f', summary: 'Focus', eventType: 'focusTime', start: { dateTime: iso(11) }, end: { dateTime: iso(12) } },
];

describe('calendar: calls', () => {
  it("are your timed events you haven't declined, with their video link, the people on them and the invite's text", () => {
    const calls = RAW.map((r) => mapEvent(r)).filter(Boolean) as CalEvent[];
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(calls[0]).toMatchObject({ title: 'Weekly planning', link: 'https://meet.google.com/abc-defg-hij', about: 'Agenda: ACME-5340 & !412', url: 'https://calendar.google.com/x', standup: false });
    expect(calls[0].attendees.map((a) => a.email)).toEqual(['me@x.com', 'dana@x.com']);
    expect(withWhom(calls[0])).toBe('Dana Ruiz');
    // a recurring "standup": a standup; its video link from its location
    expect(calls[1]).toMatchObject({ series: 'series1', standup: true, link: 'https://acme.zoom.us/j/123' });
    // marked otherwise (by series)
    expect(mapEvent(RAW[1], { series1: false })!.standup).toBe(false);
    expect(looksLikeStandup('Daily standup', false)).toBe(false);
    expect(plainText('a<br>b&nbsp;<b>c</b>')).toBe('a\nb c');
  });
  it('are handed on once, within the lead time before they start (again if they move)', () => {
    const e = mapEvent(RAW[0])!;
    expect(dueNow([e], T, 15, {})).toEqual([e]);
    expect(dueNow([e], T, 10, {})).toEqual([]);
    expect(dueNow([e], T, 0, {})).toEqual([]);
    expect(dueNow([e], T, 15, { [`a@${e.start}`]: T })).toEqual([]);
    expect(dueNow([{ ...e, start: e.start + 60_000 }], T + 60_000, 15, { [`a@${e.start}`]: T })).toHaveLength(1);
    expect(dueNow([e], e.start + 1, 15, {})).toEqual([]);
  });
});

const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('calendar: reading it', () => {
  it('reads today and tomorrow, says what changed, and hands a call on once (kept over a restart)', async () => {
    const data = tmp('cora-cal-');
    const msgs: CalendarMsg[] = [];
    const due: Array<[string, number]> = [];
    const mk = () =>
      new Calendar({ connected: () => true, token: async () => 't', granted: () => true, lead: () => 15, file: join(data, 'calendar.json'), now: () => T, fetch: fakeFetch(200, { items: RAW }), onChange: (m) => msgs.push(m), due: (e, m) => due.push([e.id, m]) });
    const c = mk();
    await c.refresh();
    expect(c.msg().status).toMatchObject({ state: 'connected', lastCheck: T });
    expect(c.list().map((e) => e.id)).toEqual(['b', 'a']);
    expect(msgs).toHaveLength(1);
    expect(due).toEqual([['a', 15]]);
    // marked, and its prep note
    expect(c.markStandup('a', true)!.standup).toBe(true);
    c.setPrep('a', 'note-1');
    expect(c.get('a')).toMatchObject({ standup: true, prep: 'note-1' });
    const again = mk();
    await again.refresh();
    expect(due).toHaveLength(1);
    expect(again.get('a')).toMatchObject({ standup: true, prep: 'note-1' });
  });
  it("says when it's not connected, lacks the permission, or the API is off", async () => {
    const off = new Calendar({ connected: () => false, token: async () => 't', granted: () => undefined, lead: () => 15 });
    await off.refresh();
    expect(off.msg().status.state).toBe('off');
    const scope = new Calendar({ connected: () => true, token: async () => 't', granted: () => false, lead: () => 15 });
    await scope.refresh();
    expect(scope.msg().status.state).toBe('scope');
    const denied = new Calendar({ connected: () => true, token: async () => 't', granted: () => undefined, lead: () => 15, fetch: fakeFetch(403, { error: { message: 'Request had insufficient authentication scopes.' } }) });
    await denied.refresh();
    expect(denied.msg().status.state).toBe('scope');
    const apiOff = new Calendar({ connected: () => true, token: async () => 't', granted: () => true, lead: () => 15, fetch: fakeFetch(403, { error: { message: 'Google Calendar API has not been used in project 1 before or it is disabled.' } }) });
    await apiOff.refresh();
    expect(apiOff.msg().status.error).toMatch(/Turn on the Google Calendar API/);
  });
});

describe('calendar: a call starting', () => {
  it('is said once, as it starts (not again after a restart); the heads-up still comes before it', async () => {
    const data = tmp('cora-cal-start-');
    let now = T;
    const due: string[] = [];
    const starting: string[] = [];
    const mk = () => new Calendar({ connected: () => true, token: async () => 't', granted: () => true, lead: () => 15, file: join(data, 'calendar.json'), now: () => now, fetch: fakeFetch(200, { items: RAW }), due: (e) => due.push(e.id), starting: (e) => starting.push(e.id) });
    const c = mk();
    await c.refresh();
    expect(due).toEqual(['a']);
    expect(starting).toEqual([]);
    // 2:00 PM: the call starts
    now = new Date(2026, 9, 29, 14, 0, 20).getTime();
    c.check();
    c.check();
    expect(starting).toEqual(['a']);
    // Cora restarted a moment later: not again
    const again = mk();
    await again.refresh();
    expect(starting).toEqual(['a']);
    // minutes later (Cora was off at 2:00): too late to say it's starting
    expect(startingNow([mapEvent(RAW[0])!], new Date(2026, 9, 29, 14, 5).getTime(), {})).toEqual([]);
  });
});

describe('calendar: settings', () => {
  it('has its defaults and refuses what makes no sense', () => {
    const p = new Prefs(join(tmp('cora-cal-prefs-'), 'prefs.json'));
    expect(p.get().calendar).toEqual({ lead: 15, brief: 'spoken', inbox: true, notify: false, standupDraft: true, startAlert: true, slackStatus: true });
    expect(DEFAULT_SETTINGS.calendar.lead).toBe(15);
    expect(p.update({ calendar: { lead: 30, brief: 'written', notify: true } } as never).calendar).toMatchObject({ lead: 30, brief: 'written', notify: true, inbox: true });
    expect(p.update({ calendar: { lead: 0 } } as never).calendar.lead).toBe(0);
    expect(() => p.update({ calendar: { lead: 3 } } as never)).toThrow(/5 to 60/);
    expect(() => p.update({ calendar: { brief: 'loud' } } as never)).toThrow(/spoken, written or off/);
    expect(() => p.update({ calendar: { inbox: 'yes' } } as never)).toThrow(/true or false/);
  });
});

const T0 = new Date(2026, 9, 29, 8, 0).getTime();
const ses = (id: string, cwd: string): SessionInfo => ({ id, cwd, project: 'aurora', title: id, alias: id, state: 'ended', startedAt: T0, lastTs: T0 + 3600_000 }) as SessionInfo;
const ev = (sid: string, ts: number, kind: BrainEvent['kind'], o: Partial<BrainEvent> = {}): BrainEvent => ({ id: `${sid}${ts}`, seq: ts, sessionId: sid, agentId: 'main', ts, kind, icon: { name: 'x', family: 'run' }, source: 'transcript', ...o }) as BrainEvent;

describe('drafts and prep read the journal first', () => {
  it("a session's journal stands in for its raw prompts and replies; one without keeps them", async () => {
    const dir = tmp('cora-j2d-');
    const j = new Journal({ dir: () => dir, dataDir: tmp('cora-j2d-data-') });
    j.add({ ...S, id: 's1' }, 'entry', 'Fixed the seek off-by-one; !412 merged.', T0 + 600_000, { refs: { tickets: ['ACME-5340'], mrs: ['!412'] }, tag: 'done' });
    const events: Record<string, BrainEvent[]> = {
      s1: [ev('s1', T0 + 60_000, 'prompt', { text: 'raw prompt one' })],
      s2: [ev('s2', T0 + 60_000, 'prompt', { text: 'raw prompt two' })],
    };
    const d = new Drafts({ sessions: () => [ses('s1', 'C:/code/aurora'), ses('s2', 'C:/code/aurora')], events: (sid) => events[sid] ?? [], dataDir: tmp('cora-j2d-dd-'), repoOf: async () => 'aurora', journal: (w) => j.query({ since: w.since, until: w.until }) });
    const f = await d.facts({ since: T0, until: T0 + 7200_000 });
    expect(f.text).toMatch(/journal \(done\), .*Fixed the seek off-by-one/);
    expect(f.text).not.toMatch(/raw prompt one/);
    expect(f.text).toMatch(/raw prompt two/);
    expect(f.counts.tickets).toContain('ACME-5340');
    expect(f.counts.mrs).toContain('!412');
  });
  it("a call's prep: the Meeting template, with the journal trail of what its invite names, titled Prep · <title> · <date>", async () => {
    const j = new Journal({ dir: () => tmp('cora-prep-'), dataDir: tmp('cora-prep-data-'), projects: () => ['ACME'] });
    j.add({ ...S, id: 's1' }, 'entry', 'Decided to ship seek behind a flag.', T0 + 600_000, { refs: { tickets: ['ACME-5340'] }, tag: 'decision' });
    const notes = new Notes({ dir: tmp('cora-prep-notes-'), now: () => T });
    let asked = '';
    const drafts = new Drafts({ sessions: () => [ses('s1', 'C:/code/aurora')], events: () => [ev('s1', T0 + 60_000, 'prompt', { text: 'hi' })], dataDir: tmp('cora-prep-dd-'), repoOf: async () => 'aurora', now: () => T, journal: (w) => j.query({ since: w.since, until: w.until }), run: async (_c, o) => ((asked = o.input ?? ''), { code: 0, stdout: '## Context\n- Seek ships behind a flag\n', stderr: '', timedOut: false }) });
    const call = mapEvent(RAW[0])!;
    expect(journalTrail(call, j, ['ACME']).map((e) => e.text)).toEqual(['Decided to ship seek behind a flag.']);
    const r = await draftPrep(call, { notes, drafts, journal: j, projects: () => ['ACME'], now: () => T });
    expect(r.ok).toBe(true);
    const made = notes.list().find((n) => r.ok && n.id === r.id)!;
    expect(made.title).toBe('Prep · Weekly planning · Thu Oct 29');
    expect(asked).toMatch(/The call these notes are for/);
    expect(asked).toMatch(/Journal entries about what the invite names\n- .*Decided to ship seek/);
    expect(asked).toMatch(/## Context/);
  });
});
