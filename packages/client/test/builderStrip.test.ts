import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyOverview, checkTeam, sessionEffects, teamChangeDetails, traceMessage } from '@cora/shared';
import { Strip, TryPanel, type StripProps } from '../src/components/builder/Strip';
import { ApplySheet, ConflictSheet } from '../src/components/builder/Sheets';
import { StartSheet } from '../src/components/builder/StartSheet';
import { centredCard, markTourSeen, tourSeen, TOUR } from '../src/components/builder/Tour';
import { drill, drillDraft } from '@cora/shared/test/fixtures';

afterEach(() => vi.unstubAllGlobals());
const un = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const render = (el: ReturnType<typeof createElement>) => un(renderToStaticMarkup(el));
const strip = (more: Partial<StripProps> = {}): StripProps => ({ tab: 'checks', onTab() {}, checks: checkTeam(drill()), notices: [], isSelected: () => false, onPickCheck() {}, sum: { text: '4 changes since v4', tone: '' }, applyLabel: 'Apply', applyDisabled: false, applyTitle: '', onApply() {}, tryPanel: null, ...more });

describe('the strip', () => {
  it('checks, worst first, with their counts; Apply', () => {
    const h = render(createElement(Strip, strip()));
    expect(h).toContain('<i class="w">1</i>');
    expect(h).toContain('Analysts splits by issue but has nothing for ingest, and no else.');
    expect(h).toContain('warning');
    expect(h).toContain('4 changes since v4');
    expect(h).toContain('>Apply<');
  });

  it("nothing to fix; a proposal's Approve and Reject", () => {
    const h = render(createElement(Strip, strip({ checks: [], applyLabel: 'Approve', onReject() {} })));
    expect(h).toContain('Nothing to fix. Try a message to see how it moves through the team.');
    expect(h).toContain('>Reject<');
    expect(h).toContain('>Approve<');
  });

  it('try a message: the steps so far, numbered; the caveat last', () => {
    const tr = traceMessage(drill(), { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } });
    const h = render(createElement(TryPanel, { team: drill(), form: { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } }, onForm() {}, shown: tr.steps, continuedAt: [], done: true, canThen: true, flash: false, onRun() {}, onThen() {}, onClear() {}, examples: [], onExample() {} }));
    expect(h).toContain('class="ts k-route"');
    expect(h).toContain('<i>1</i>');
    expect(h).toContain('class="ts k-reach"');
    expect(h).toContain('class="tnote"');
    expect(h).toContain('Then what?');
  });
});

describe('the sheets', () => {
  it("apply an edit: the change in numbers, what to check, only the seats that change (with what each running one does), Apply", () => {
    const h = render(createElement(ApplySheet, { title: 'Apply the draft', sub: 'Native Drill · v4 → v5', overview: applyOverview(drill(), drillDraft()), effects: sessionEffects(drill(), drillDraft()), note: '', tag: 'Apply', colorOf: () => '#60a5fa', busy: false, onCancel() {}, onApply() {} }));
    expect(h).toContain('seats changed');
    expect(h).toContain('Seats that change');
    expect(h).toContain('waits for your Restart (Team panel) to take its new permissions');
    expect(h).toContain("The team's routes and groups");
    expect(h).not.toContain('Apply and bring up');
    // a seat's lines wait for a click: the sheet is short
    expect(h).not.toContain('Triage instructions');
  });

  it('a first apply: the team in numbers, one row per seat with its facts, the routes as one row, not every line', () => {
    const t = drill();
    const h = render(createElement(ApplySheet, { title: 'Apply the draft', sub: '', overview: applyOverview(undefined, t), effects: null, note: '', tag: 'Apply', colorOf: () => '#60a5fa', busy: false, onCancel() {}, onApply() {} }));
    expect(h).toContain('sessions to start');
    for (const s of t.seats) expect(h).toContain(s.name);
    expect(h).toContain('Routes, groups and rules');
    expect(h).toContain('as on the canvas');
    expect((h.match(/class="cl[ "]/g) ?? []).length).toBeLessThan(teamChangeDetails(undefined, t).length / 2);
  });

  it("a team that isn't running: nothing restarts; Apply and bring up", () => {
    const t = drill();
    const h = render(createElement(ApplySheet, { title: 'Apply the draft', sub: '', overview: applyOverview(undefined, t), effects: null, note: '', tag: 'Apply', colorOf: () => '#60a5fa', busy: false, onCancel() {}, onApply() {} }));
    const n = t.seats.length;
    const k = t.seats.reduce((a, s) => a + s.count.min, 0);
    expect(h).toContain(`The team isn't running, so nothing restarts. Bringing it up starts ${n} seats (${k} session${k === 1 ? '' : 's'}).`);
    expect(h).toContain('Apply and bring up');
  });

  it('a refused apply: their changes, the conflicts, Rebase my draft', () => {
    const h = render(createElement(ConflictSheet, { from: 4, to: 5, theirs: ['Route changed: …'], conflicts: ['Route Analysts → Triage, wake: they set never, your draft has ask. Yours is kept.'], busy: false, onCancel() {}, onRebase() {} }));
    expect(h).toContain('The team changed while you worked');
    expect(h).toContain('1 conflict');
    expect(h).toContain('Rebase my draft');
  });

  it('the start sheet: Build with Cora, then the shapes, each saying what it asks', () => {
    const h = render(createElement(StartSheet, { name: 'Native Drill', version: 4, coraDown: false, onCora() {}, onBuild() {}, onClose() {} }));
    for (const s of ['Start the team', 'Build with Cora', 'Hub and spokes', 'asks 4 things', 'Pipeline', 'Squad', 'Blank', 'Teams you save as presets will appear here too.']) expect(h).toContain(s);
  });
});

describe('the tour', () => {
  it('four hints; whether you have seen it is kept in the browser, and a browser that refuses storage is fine', () => {
    expect(TOUR.map((x) => x.title)).toEqual(['Talk and In words', 'The canvas', 'Try a message', 'Apply']);
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
    expect(tourSeen()).toBe(false);
    markTourSeen();
    expect(tourSeen()).toBe(true);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(tourSeen()).toBe(false);
    expect(() => markTourSeen()).not.toThrow();
  });
});

describe('the sheets, a little further', () => {
  const careful = { ...applyOverview(drill(), drillDraft()), check: [{ line: '⚠️ Careful', full: '⚠️ Careful in full' }] };
  const apply = (more: Record<string, unknown> = {}) => ({ title: 'Apply the draft', sub: '', overview: careful, effects: sessionEffects(drill(), drillDraft()), note: '', tag: 'Apply' as const, colorOf: () => '#60a5fa', busy: false, onCancel() {}, onApply() {}, ...more });
  it('Apply is off while it works; an error shows; the warning sign is stripped whole', () => {
    const h = render(createElement(ApplySheet, apply({ busy: true, error: 'Could not start it' })));
    expect(h).toContain('Could not start it');
    expect(h).toMatch(/<button class="btn go" disabled="">Apply</);
    expect(h).toMatch(/<button class="btn" disabled="">Cancel</);
    expect(h).toContain('Careful');
    expect(h).not.toContain('️ Careful');
  });
  it('an approval with nothing running says nothing about bringing up', () => {
    const h = render(createElement(ApplySheet, apply({ effects: null, tag: 'Approve' })));
    expect(h).not.toContain('Bringing it up');
    expect(h).not.toContain('bring up');
  });
  it('the strip: Apply disabled', () => {
    expect(render(createElement(Strip, strip({ applyDisabled: true })))).toMatch(/class="btn go"[^>]*disabled=""/);
  });
  it('a clean rebase says so; new problems show and stop it', () => {
    const base = { from: 4, to: 5, theirs: [], conflicts: [], busy: false, onCancel() {}, onRebase() {} };
    expect(render(createElement(ConflictSheet, base))).toContain('No conflicts');
    const h = render(createElement(ConflictSheet, { ...base, problems: ['Seat X has no model.'] }));
    expect(h).toContain('Seat X has no model.');
    expect(h).toMatch(/class="btn go"[^>]*disabled=""/);
  });
});

describe('the tour never traps you', () => {
  it('a missing part puts the card in the middle', () => {
    expect(centredCard(1000, 800, 280, 130)).toEqual({ left: 360, top: 335 });
    expect(centredCard(100, 100).left).toBe(8);
  });
});

describe('class names that are the builder’s own', () => {
  it("the strip and a sheet's longer lines don't take the app's .strip (raised over sheets) or .more (pinned to the bottom)", async () => {
    const { readFileSync } = await import('node:fs');
    const strip = readFileSync(new URL('../src/components/builder/Strip.tsx', import.meta.url), 'utf8');
    const sheets = readFileSync(new URL('../src/components/builder/Sheets.tsx', import.meta.url), 'utf8');
    expect(strip).not.toMatch(/className="strip"/);
    expect(sheets).not.toMatch(/' more'/);
  });
});

describe('the sheets, a lead chosen', () => {
  it('a new lead takes effect at once (one thing: "takes"); nobody restarts', () => {
    const t = { ...drill(), lead: 'triage' };
    const h = render(createElement(ApplySheet, { title: 'Apply the draft', sub: '', overview: applyOverview(drill(), t), effects: sessionEffects(drill(), t), note: '', tag: 'Apply', colorOf: () => '#60a5fa', busy: false, onCancel() {}, onApply() {} }));
    expect(h).toContain("The team's lead takes effect at once; nobody restarts for it.");
  });
});
