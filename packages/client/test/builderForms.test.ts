import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { autoLayout, clone, describeTeam } from '@cora/shared';
import { Inspector, formKey, formTokens, type InspectorProps } from '../src/components/builder/Inspector';
import { Words, pickTarget } from '../src/components/builder/Words';
import { drill, drillDraft } from '@cora/shared/test/fixtures';

const props = (more: Partial<InspectorProps> = {}): InspectorProps => ({
  team: drill(), base: drill(), sel: null, look: { pos: autoLayout(drill()) }, projectName: 'Native Drill', version: 4,
  stateOf: () => 'idle', focusName: 0, onEdit() {}, onTeam() {}, onRename() {}, onDelete() {}, onGroupThem() {}, ...more,
});
const un = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const html = (p: InspectorProps) => un(renderToStaticMarkup(createElement(Inspector, p)));

describe('the inspector', () => {
  it("nothing selected: the team's labels, fallback and escalation rules", () => {
    const h = html(props());
    for (const s of ['Native Drill', 'team · v4 · 5 seats · 3 groups · 3 routes', 'Issue type', 'Fallback', 'Escalation', '+ Rule', 'tell lead']) expect(h).toContain(s);
  });

  it("nothing selected: the team's lead, none or any seat, picked like the fallback", () => {
    const h = html(props({ team: { ...drill(), lead: 'triage' } }));
    expect(h).toContain('>Lead<');
    expect(h).toContain('<option value="">No lead</option>');
    expect(h).toContain('<option value="triage" selected="">Triage</option>');
    expect(h).toContain('Once the team is up, its first member leads: it proposes changes to the team, and opens and assigns incidents.');
    expect(html(props())).toContain('<option value="" selected="">No lead</option>');
  });

  it('a seat: its id follows its name until applied; a risky mode is marked ⚠', () => {
    const t = clone(drill());
    t.seats[2].agent.permissionMode = 'bypassPermissions';
    const h = html(props({ team: t, sel: { kind: 'seat', ids: ['triage'] } }));
    expect(h).toContain('Its id stays <code>triage</code> (it has been applied).');
    expect(h).toContain('⚠ Skips every permission prompt.');
    expect(h).toContain('class="fh warn"');
    for (const s of ['Instructions', 'Permission mode', 'A fresh worktree', 'Idle close', 'First prompt', 'Watches', 'Quiet hours', 'Delete seat']) expect(h).toContain(s);
    const fresh = html(props({ base: undefined, sel: { kind: 'seat', ids: ['triage'] } }));
    expect(fresh).toContain("Its id follows the name until it's applied: <code>triage</code>.");
  });

  it("watches: email only (Slack isn't offered until Cora can keep it); a Slack watch the seat has already is shown, not edited, and says so", () => {
    const t = clone(drill());
    t.seats[2].startup.watches = [
      { kind: 'gmail', from: 'alerts@x.com', about: 'alerts', then: 'triage it' },
      { kind: 'slack', channel: '#ops', about: 'ops chatter', then: 'read it' },
    ];
    const h = html(props({ team: t, sel: { kind: 'seat', ids: ['triage'] } }));
    expect(h).not.toContain('<option value="slack"');
    expect(h).toContain('value="alerts@x.com"');
    expect(h).not.toContain('value="#ops"');
    expect(h).toContain('Slack #ops: ops chatter');
    expect(h).toContain("Slack watches aren't supported yet: Cora doesn't set this one.");
  });

  it('a group: a row per value of its label, and an else', () => {
    const h = html(props({ sel: { kind: 'group', ids: ['analysts'] } }));
    expect(h).toContain('>encoder<');
    expect(h).toContain('>ingest<');
    expect(h).toContain('>else<');
    expect(h).toContain('Delete group (its members stay)');
  });

  it("a route: its wake as a three-way choice, and what it means", () => {
    const h = html(props({ team: drillDraft(), sel: { kind: 'route', ids: ['r-back'] } }));
    expect(h).toContain('<button class="on">Ask</button>');
    expect(h).toContain('An idle member is woken only with your OK (a card in Needs you).');
  });

  it('several seats: group them, or delete them', () => {
    const h = html(props({ sel: { kind: 'seat', ids: ['monitor-a', 'monitor-b'] } }));
    expect(h).toContain('2 seats');
    expect(h).toContain('Group them');
  });
});

describe('In words', () => {
  it('sections, bold names, a gap in its colour, the quiet last line', () => {
    const h = un(renderToStaticMarkup(createElement(Words, { lines: describeTeam(drill()), sel: null, onHover() {}, onPick() {} })));
    expect(h).toContain('How work moves');
    expect(h).toContain('When work sits');
    expect(h).toContain('<b>Triage</b>');
    expect(h).toContain('<span class="gap"><b>ingest</b></span>');
    expect(h).toContain('class="ws q"');
  });
});

describe('form keys and picks', () => {
  const counter = () => {
    let n = 0;
    return () => `f${++n}`;
  };
  it("a seat's form key survives its id changing with its name", () => {
    const fresh = counter();
    const t = clone(drill());
    const sel = { kind: 'seat' as const, ids: ['triage'] };
    const a = formTokens(null, t, sel, fresh);
    const before = formKey(a, sel);
    const renamed = clone(t);
    renamed.seats[2].id = 'triager';
    const b = formTokens(a, renamed, { kind: 'seat', ids: ['triager'] }, fresh);
    expect(formKey(b, { kind: 'seat', ids: ['triager'] })).toBe(before);
    expect(formKey(b, { kind: 'seat', ids: ['monitor-a'] })).not.toBe(before);
  });

  it("Cora removing an earlier seat, or the seats moving, never hands one seat's form to another", () => {
    const fresh = counter();
    const t = clone(drill());
    const sel = { kind: 'seat' as const, ids: ['triage'] };
    const a = formTokens(null, t, sel, fresh);
    const fewer = clone(t);
    fewer.seats = fewer.seats.filter((x) => x.id !== 'monitor-a');
    const b = formTokens(a, fewer, sel, fresh);
    expect(formKey(b, sel)).toBe(formKey(a, sel));
    expect(formKey(b, { kind: 'seat', ids: ['monitor-b'] })).toBe(formKey(a, { kind: 'seat', ids: ['monitor-b'] }));
    const moved = clone(fewer);
    moved.seats.reverse();
    const c = formTokens(b, moved, sel, fresh);
    expect(formKey(c, sel)).toBe(formKey(a, sel));
    // a new seat gets its own
    const more = clone(moved);
    more.seats.push({ ...clone(more.seats[0]), id: 'new-seat' });
    const d = formTokens(c, more, { kind: 'seat', ids: ['new-seat'] }, fresh);
    expect(new Set(Object.values(d.tokens)).size).toBe(Object.keys(d.tokens).length);
    // selecting another seat that is still there is never a rename
    const e = formTokens(d, more, { kind: 'seat', ids: ['monitor-b'] }, fresh);
    expect(formKey(e, { kind: 'seat', ids: ['monitor-b'] })).toBe(formKey(a, { kind: 'seat', ids: ['monitor-b'] }));
  });

  it('a line selects its route, else its first seat', () => {
    const l = { section: 'flow', segs: [], text: '', targets: [{ kind: 'seat', id: 'a' }, { kind: 'route', id: 'r' }] } as never;
    expect(pickTarget(l)).toEqual({ kind: 'route', id: 'r' });
    expect(pickTarget({ ...(l as object), targets: [{ kind: 'group', id: 'g' }, { kind: 'seat', id: 's' }] } as never)).toEqual({ kind: 'seat', id: 's' });
  });

  it('an unnamed seat in a multi-selection shows ?', () => {
    const t = clone(drill());
    t.seats[0].name = '';
    expect(html(props({ team: t, sel: { kind: 'seat', ids: [t.seats[0].id, t.seats[1].id] } }))).toContain('>?</span>');
  });
});
