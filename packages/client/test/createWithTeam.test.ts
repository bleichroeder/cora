import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@cora/shared';

// (a new project as the server would make it; none when it refuses)
const made = vi.hoisted(() => ({ project: null as Project | null, calls: [] as Array<[string, string | undefined]> }));
vi.mock('../src/state/projects', async (orig) => ({
  ...(await orig<typeof import('../src/state/projects')>()),
  createProject: async (name: string, sessionId?: string) => (made.calls.push([name, sessionId]), made.project),
}));

import { createWithTeam, useBuilder } from '../src/state/builder';
import { useBrain } from '../src/state/store';
import { NewProject } from '../src/components/Projects';
import { NoMembers } from '../src/components/board/ProjectPanels';

const P = { id: 'p9', name: 'Night shift' } as Project;
afterEach(() => {
  made.project = null;
  made.calls = [];
  useBuilder.setState({ open: {} });
});

describe('a new project with a team', () => {
  it('makes the project, then opens its builder (the start sheet: no team yet)', async () => {
    made.project = P;
    expect(await createWithTeam('Night shift')).toBe(P);
    expect(made.calls).toEqual([['Night shift', undefined]]);
    expect(useBuilder.getState().open).toEqual({ p9: {} });
    expect(useBrain.getState().projectOpen).toBe('p9');
  });
  it('nothing opens when it could not be made', async () => {
    expect(await createWithTeam('Night shift')).toBeNull();
    expect(useBuilder.getState().open).toEqual({});
  });
});

describe('the ways in', () => {
  it("the nav's name field offers Create with a team as a button that always answers (no name yet: it asks for one)", () => {
    const h = renderToStaticMarkup(createElement(NewProject, { onDone: () => undefined }));
    expect(h).toContain('Create with a team →');
    expect(h).toMatch(/<button class="pj-withteam"/);
    expect(h).not.toMatch(/<button class="pj-withteam"[^>]*disabled/);
  });
  it("not when a session's menu makes a project for it", () => {
    expect(renderToStaticMarkup(createElement(NewProject, { onDone: () => undefined, sessionId: 's1' }))).not.toContain('Create with a team');
  });
  it("a new project's empty Crew says there's no team yet, with Build a team", () => {
    const h = renderToStaticMarkup(createElement(NoMembers, { team: 'p9' }));
    expect(h).toContain('No team yet');
    expect(h).toContain('Build a team');
    expect(renderToStaticMarkup(createElement(NoMembers, {}))).not.toContain('No team yet');
  });
});

describe('a team draft in progress on the empty Crew', () => {
  it('says so, with Continue, instead of No team yet', () => {
    const h = renderToStaticMarkup(createElement(NoMembers, { team: 'p9', drafting: true }));
    expect(h).toContain('A team draft is in progress');
    expect(h).toContain('Continue');
    expect(h).not.toContain('No team yet');
  });
});
