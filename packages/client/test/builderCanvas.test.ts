import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { autoLayout, type Team } from '@cora/shared';
import { Canvas, spaceHeld, type CanvasProps } from '../src/components/builder/Canvas';
import { proposalMarks, withColors } from '../src/components/builder/geometry';
import { drill, drillDraft, drillProposal } from '@cora/shared/test/fixtures';

const props = (team: Team, more: Partial<CanvasProps> = {}): CanvasProps => ({
  team, look: withColors({ pos: autoLayout(team) }, team), sel: null, hov: null, flash: null, trace: null, marks: null,
  stateOf: (id) => (id === 'triage' ? 'work' : 'idle'), fitKey: 0, dot: null, busy: false, locked: false,
  onSelect() {}, onLink() {}, onMove() {}, onDrop() {}, onAddSeat() {}, onGroupThem() {}, ...more,
});
const html = (p: CanvasProps) => renderToStaticMarkup(createElement(Canvas, p));

describe('the canvas', () => {
  it('seats as Crew rows, groups as regions, routes as arrows with their chips; You and Cora at the edge', () => {
    const h = html(props(drill()));
    for (const s of ['Monitor A', 'Triage', 'Encoder analyst', 'ANALYSTS', 'ENCODER ANALYSTS', 'claim · split by issue', 'report · direct', 'issue=encoder|network', 'messages anyone']) expect(h).toContain(s);
    expect(h).toContain('data-kind="seat" data-id="triage"');
    expect(h).toContain('class="node seat s-work');
    expect(h).toContain('data-kind="fixed" data-id="user"');
  });

  it('an ask route is dashed with a hand; the legend says what each line means', () => {
    const h = html(props(drillDraft()));
    expect(h).toContain('class="route w-ask');
    expect(h).toContain('class="hand"');
    expect(h).toContain('ask (your OK)');
  });

  it("a proposal's marks: added edged, changed dotted, removed struck through", () => {
    const team = drillProposal();
    const look = withColors({ pos: { ...autoLayout(drill()), ...autoLayout(team) } }, drill());
    const h = html(props(team, { look, marks: proposalMarks(drill(), team) }));
    expect(h).toContain('m-add');
    expect(h).toContain('class="mdot"');
    expect(h).toMatch(/class="node seat s-[a-z]+ gone"[^>]*data-id="monitor-b"/);
  });

  it('Cora drafting shows over the canvas', () => {
    expect(html(props(drill(), { busy: true }))).toContain('Cora is drafting…');
  });
});

describe('Space to pan', () => {
  const o = { typing: false, locked: false };
  it('held while Space is down (not while you type, nor under a sheet), let go on keyup or when the window loses focus', () => {
    expect(spaceHeld('keydown', 'Space', o)).toBe(true);
    expect(spaceHeld('keydown', 'Space', { ...o, typing: true })).toBeNull();
    expect(spaceHeld('keydown', 'Space', { ...o, locked: true })).toBeNull();
    expect(spaceHeld('keydown', 'KeyA', o)).toBeNull();
    expect(spaceHeld('keyup', 'Space', o)).toBe(false);
    expect(spaceHeld('keyup', 'KeyA', o)).toBeNull();
    expect(spaceHeld('blur', '', o)).toBe(false);
  });
});
