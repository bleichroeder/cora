import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LibraryEntry } from '@cora/shared';
import { NO_FILTER, groupLibrary, libraryUrl } from '../src/state/library';
import { LibraryList, cappedLine, libraryWhen, rowKey } from '../src/components/Library';

/** The Library tool (Tools › Cora): everything sessions made, grouped by project and session, starred ones on top. */

const local = (h: number, mi = 0, d = 4) => new Date(2026, 10, d, h, mi).getTime();
const NOW = local(18);
const entry = (o: Partial<LibraryEntry> & Pick<LibraryEntry, 'id' | 'at'>): LibraryEntry => ({
  kind: 'explain',
  title: o.id,
  sessionId: 's1',
  session: 'Login fix',
  project: null,
  snippet: 'a line of it',
  open: { how: 'explain', sessionId: 's1', toolUseId: 't' },
  ...o,
});

describe('the Library tool', () => {
  it('asks the server with only the filters set', () => {
    expect(libraryUrl(NO_FILTER)).toBe('/api/library');
    expect(libraryUrl({ q: '  cpu chart ', kind: 'live', when: 'week', starred: true })).toBe('/api/library?q=cpu+chart&kind=live&when=week&starred=1');
  });

  it('groups by project (those in none last), then session, newest first; starred ones pinned on their own', () => {
    const dash = { id: 'p1', name: 'Dashboards' };
    const ops = { id: 'p2', name: 'Ops' };
    const g = groupLibrary([
      entry({ id: 'a', at: local(9), sessionId: 's1', session: 'Login fix' }),
      entry({ id: 'b', at: local(17), sessionId: 's2', session: 'Charts', project: dash }),
      entry({ id: 'c', at: local(12), sessionId: 's3', session: 'Alerts', project: ops }),
      entry({ id: 'd', at: local(10), sessionId: 's4', session: 'Memory chart', project: dash }),
      entry({ id: 'e', at: local(8), sessionId: 's2', session: 'Charts', project: dash, starred: true }),
      entry({ id: 'f', at: local(16), sessionId: 's2', session: 'Charts', project: dash }),
    ]);
    expect(g.starred.map((e) => e.id)).toEqual(['e']);
    expect(g.projects.map((p) => p.name)).toEqual(['Dashboards', 'Ops', null]);
    expect(g.projects[0].sessions.map((s) => [s.name, s.entries.map((e) => e.id)])).toEqual([
      ['Charts', ['b', 'f']],
      ['Memory chart', ['d']],
    ]);
    expect(g.projects[2].sessions[0].entries.map((e) => e.id)).toEqual(['a']);
  });

  it('says when as a row does: the time today, else the day', () => {
    expect(libraryWhen(local(9, 5), NOW)).toBe('9:05');
    expect(libraryWhen(local(9, 5, 2), NOW)).toBe('Mon 2 Nov');
    expect(libraryWhen(new Date(2025, 10, 2).getTime(), NOW)).toBe('Sun 2 Nov 2025');
  });

  it('shows the starred first, then each project and its sessions, each row its kind, title, when and a star', () => {
    const groups = groupLibrary([
      entry({ id: 'x', title: 'CPU by host', kind: 'live', at: local(17), sessionId: 's2', session: 'Charts', project: { id: 'p1', name: 'Dashboards' } }),
      entry({ id: 'y', title: 'How the login was fixed', kind: 'debrief', at: local(9), versions: 2 }),
      entry({ id: 'z', title: 'Latency report', kind: 'artifact', at: local(8, 0, 1), starred: true }),
    ]);
    const html = renderToStaticMarkup(createElement(LibraryList, { groups, onOpen() {}, onStar() {}, onSession() {}, now: NOW }));
    const order = ['Starred', 'Latency report', 'Dashboards', 'Charts', 'CPU by host', 'No project', 'How the login was fixed'].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('class="lib-r k-artifact starred"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('live explain');
    expect(html).toContain('debrief · 2 versions');
    expect(html).toContain('>17:00<');
    // the starred row says whose it is (it's out of its session's group)
    expect(html).toMatch(/k-artifact starred[\s\S]*?class="lib-ses">Login fix</);
  });

  it("is one of Cora's tools: a row and a button in Tools, its pane in the tool drawer", () => {
    const tools = readFileSync(join(__dirname, '../src/components/Tools.tsx'), 'utf8');
    expect(tools).toMatch(/<LibraryRow on=\{open === LIBRARY_ID\} \/>/);
    expect(tools).toMatch(/<LibraryButton on=\{open === LIBRARY_ID\} \/>/);
    expect(tools).toMatch(/<LibraryPane visible=\{library\} \/>/);
  });

  it("Enter on a row opens it; on its star, it stars it and doesn't open the entry", () => {
    const row = {};
    const star = {};
    let opened = 0;
    rowKey({ key: 'Enter', target: row, currentTarget: row }, () => opened++);
    expect(opened).toBe(1);
    // (the star's Enter bubbling up to the row: not the row's)
    rowKey({ key: 'Enter', target: star, currentTarget: row }, () => opened++);
    rowKey({ key: 'a', target: row, currentTarget: row }, () => opened++);
    expect(opened).toBe(1);
  });

  it('a capped list says how many there are', () => {
    expect(cappedLine({ entries: new Array(500), total: 1234 })).toBe('Showing 500 of 1234: search or filter to narrow it.');
    expect(cappedLine({ entries: new Array(12), total: 12 })).toBeNull();
    expect(cappedLine(null)).toBeNull();
  });
});
