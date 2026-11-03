import { describe, expect, it } from 'vitest';
import type { BuilderDraftView } from '@cora/shared';
import { drill } from '@cora/shared/test/fixtures';
import { draftInProgress } from '../src/state/builder';

/** A team draft in progress shows on its project, so leaving the builder never looks like losing the work (David, live test). */
describe('draftInProgress', () => {
  const NOW = 1_000_000_000;
  const view = (o: Partial<BuilderDraftView> = {}): BuilderDraftView => ({ team: drill(), rev: 3, base: 0, by: 'you', at: NOW - 3 * 60_000, turns: [], ...o });
  it('a draft for a project with no team: its seats and when it last changed, and by whom', () => {
    const n = drill().seats.length;
    expect(draftInProgress(view(), undefined, NOW)).toEqual({ label: 'Continue team draft', line: `A team draft is in progress: ${n} seats, changed 3m ago by you.` });
    expect(draftInProgress(view({ by: 'cora', at: NOW - 30_000 }), undefined, NOW)?.line).toContain('changed 30s ago by Cora');
  });
  it('none (or not known yet): nothing to say', () => {
    expect(draftInProgress(null, undefined, NOW)).toBeNull();
    expect(draftInProgress(undefined, undefined, NOW)).toBeNull();
  });
  it("a draft the same as the team isn't work in progress", () => {
    expect(draftInProgress(view(), drill(), NOW)).toBeNull();
  });
  it('one seat reads as one seat', () => {
    const t = drill();
    expect(draftInProgress(view({ team: { ...t, seats: t.seats.slice(0, 1) } }), undefined, NOW)?.line).toContain('1 seat,');
  });
});
