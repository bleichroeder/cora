import { describe, expect, it } from 'vitest';
import { buildShape, emptyTeam, previewShape, SHAPE_DEFAULTS, SHAPES, validateTeam, type ShapeKind } from '../src/index';

const o = { folder: 'C:/work', version: 4 };

describe('the shapes: a few questions, then a team', () => {
  it('four shapes, in order, each saying what it asks', () => {
    expect(SHAPES.map((s) => [s.kind, s.asks])).toEqual([['hub', 'asks 4 things'], ['pipeline', 'asks the steps'], ['squad', 'asks 2 things'], ['blank', 'no questions']]);
  });

  it.each(['hub', 'pipeline', 'squad'] as ShapeKind[])('%s from its defaults is a valid team', (k) => {
    expect(validateTeam(buildShape(k, SHAPE_DEFAULTS[k], o))).toMatchObject({ ok: true });
  });

  it('hub and spokes: named sources, a hub, a pool per kind split by a label', () => {
    const t = buildShape('hub', SHAPE_DEFAULTS.hub, o);
    expect(t.seats.map((s) => s.name)).toEqual(['Monitor A', 'Monitor B', 'Monitor C', 'Triage', 'Encoder analyst', 'Network analyst']);
    expect(t.groups.map((g) => g.name)).toEqual(['Analysts', 'Encoder analysts', 'Network analysts']);
    expect(t.labels).toEqual([{ id: 'issue', name: 'Issue type', values: ['encoder', 'network'] }]);
    expect(t.groups[0].split).toEqual({ label: 'issue', to: { encoder: 'encoder-analysts', network: 'network-analysts' } });
    expect(t.routes.map((r) => [r.from, r.to, r.kinds, r.wake])).toEqual([
      [['seat:monitor-a', 'seat:monitor-b', 'seat:monitor-c'], 'seat:triage', ['report', 'direct'], 'auto'],
      [['seat:triage'], 'group:analysts', ['handoff'], 'auto'],
      [['group:analysts'], 'seat:triage', ['note', 'question'], 'auto'],
    ]);
    expect(t.fallback).toBe('seat:triage');
    expect(t.version).toBe(4);
    expect(t.seats.every((s) => s.folder.path === 'C:/work')).toBe(true);
  });

  it('other answers: one source, one kind, one pool', () => {
    const t = buildShape('hub', { source: 'Watcher', count: '1', hub: 'Desk', kinds: 'audio', worker: 'Fixer', perKind: false }, o);
    expect(validateTeam(t)).toMatchObject({ ok: true });
    expect(t.seats.map((s) => s.name)).toEqual(['Watcher', 'Desk', 'Fixer']);
    expect(t.groups).toEqual([{ id: 'fixers', name: 'Fixers', members: ['fixer'], dispatch: 'claim', grow: { seat: 'fixer', max: 3 } }]);
    const p = buildShape('pipeline', { steps: 'Write, Edit' }, o);
    expect(validateTeam(p)).toMatchObject({ ok: true });
    expect(p.routes.map((r) => `${r.from[0]}>${r.to}`)).toEqual(['seat:write>seat:edit', 'seat:edit>seat:write']);
    const s = buildShape('squad', { lead: 'Boss', peers: '0' }, o);
    expect(validateTeam(s)).toMatchObject({ ok: true });
    expect(s.seats.map((x) => x.name)).toEqual(['Boss']);
  });

  it('answers that differ only in case are one (the first spelling kept); kinds are lowercase in the build and its preview alike', () => {
    const t = buildShape('hub', { ...SHAPE_DEFAULTS.hub, kinds: 'Encoder, encoder, Network' }, o);
    expect(validateTeam(t)).toMatchObject({ ok: true });
    expect(t.labels[0].values).toEqual(['encoder', 'network']);
    expect(previewShape('hub', { ...SHAPE_DEFAULTS.hub, kinds: 'Encoder, encoder, Network' }).text).toContain('two pools of analysts (encoder and network)');
    const p = buildShape('pipeline', { steps: 'QA, Write, qa' }, o);
    expect(p.seats.map((x) => x.name)).toEqual(['QA', 'Write']);
  });

  it('no steps given: the preview says what the build will make (Draft, Review, Publish)', () => {
    expect(buildShape('pipeline', { steps: ' , ' }, o).seats.map((x) => x.name)).toEqual(['Draft', 'Review', 'Publish']);
    expect(previewShape('pipeline', { steps: ' , ' }).text).toBe('Builds 3 steps: Draft → Review → Publish. Each hands its work to the next, which can send notes and questions back.');
  });

  it('blank: you and Cora only', () => {
    expect(buildShape('blank', {}, o)).toEqual(emptyTeam(4));
  });

  it('a preview line says what the answers will build', () => {
    expect(previewShape('hub', SHAPE_DEFAULTS.hub).text).toBe('Builds three monitors that report to Triage, which hands work to two pools of analysts (encoder and network), each growing to 2 when busy. Whoever is free first claims it.');
    expect(previewShape('pipeline', SHAPE_DEFAULTS.pipeline).text).toBe('Builds 3 steps: Draft → Review → Publish. Each hands its work to the next, which can send notes and questions back.');
    expect(previewShape('squad', SHAPE_DEFAULTS.squad).text).toBe('Builds Lead and two peers in one squad, where anyone may message anyone.');
  });
});
