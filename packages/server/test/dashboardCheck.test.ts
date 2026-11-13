import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataProblem, kitProblems } from '../src/dashboardCheck';
import { LiveExplains } from '../src/liveExplains';
import { readFileSync } from 'node:fs';

const good = {
  title: 'Release',
  status: { text: 'Rolling out', state: 'run' },
  blocks: [
    { id: 'n', type: 'stats', items: [{ label: 'passed', value: 3, state: 'ok' }] },
    { type: 'chart', kind: 'bar', labels: ['a'], series: [{ name: 'x', values: [1, 2] }] },
    { type: 'steps', items: [{ label: 'Build', state: 'done' }], actions: [{ label: 'Retry', prompt: 'retry the failed tests' }] },
    { type: 'note', text: 'fine' },
  ],
};

describe("a dashboard's data, checked as its session writes it", () => {
  it('good data: nothing to say', () => {
    expect(kitProblems(good)).toEqual([]);
    expect(dataProblem(JSON.stringify(good), { kit: true, max: 256_000 })).toBeNull();
  });
  it("JSON that doesn't parse, or is too big, is said for any live explain", () => {
    expect(dataProblem('{ "title": "x", ', { kit: false, max: 256_000 })).toMatch(/isn't valid JSON .*last good data/s);
    expect(dataProblem(JSON.stringify({ a: 'x'.repeat(3000) }), { kit: false, max: 2048 })).toMatch(/3 KB, over the 2 KB/);
    // its own page, its own shape: only that it's JSON
    expect(dataProblem(JSON.stringify({ anything: [1, 2] }), { kit: false, max: 256_000 })).toBeNull();
  });
  it("a kit dashboard's blocks the page can't draw are named, with where", () => {
    const p = kitProblems({
      blocks: [
        { type: 'gauge' },
        { id: 'c', type: 'chart', kind: 'pie', series: [{ name: 'x', values: ['1', 2] }] },
        { type: 'stats' },
        { type: 'steps', items: [{ label: 'x', state: 'exploded' }] },
        { id: 'c', type: 'note', text: 'again' },
        { type: 'actions', items: [{ label: 'no target' }] },
      ],
    });
    expect(p.join('\n')).toMatch(/blocks\[0\]: type "gauge" isn't a block/);
    expect(p.join('\n')).toMatch(/blocks\[1\] \("c"\): chart kind "pie"/);
    expect(p.join('\n')).toMatch(/series\[0\] needs "values" as a list of numbers/);
    expect(p.join('\n')).toMatch(/a stats block needs "items"/);
    expect(p.join('\n')).toMatch(/state "exploded" isn't one the page knows/);
    expect(p.length).toBeLessThanOrEqual(6);
    expect(kitProblems({ blocks: [{ id: 'a', type: 'note', text: '1' }, { id: 'a', type: 'note', text: '2' }] })).toEqual(['two blocks have the id "a": only the first shows']);
    expect(kitProblems({ title: 'x' })).toEqual(['"blocks" must be a list (the page shows nothing without it)']);
    expect(dataProblem(JSON.stringify({ blocks: [{ type: 'gauge' }] }), { kit: true, max: 256_000 })).toMatch(/^From Cora: the dashboard's page can't draw.*- blocks\[0\]/s);
  });
});

describe('which file a session wrote', () => {
  const KIT = '<html><body>kit</body></html>';
  it("its dashboard's data is checked against the kit when the page is Cora's; another page's only as JSON; other files not at all", () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-dash-'));
    const live = new LiveExplains({ root, onVersion: () => {}, onData: () => {} });
    const f = live.startKit('sess-dash-9', 'Release', KIT);
    expect(readFileSync(f.page, 'utf8')).toBe(KIT);
    writeFileSync(f.data, JSON.stringify({ blocks: [{ type: 'gauge' }] }));
    expect(live.dataProblem(f.data, KIT)).toMatch(/type "gauge" isn't a block/);
    writeFileSync(f.data, JSON.stringify(good));
    expect(live.dataProblem(f.data, KIT)).toBeNull();
    // the session's own page: its data is its own business, as long as it's JSON
    writeFileSync(f.page, '<html><body>mine</body></html>');
    writeFileSync(f.data, JSON.stringify({ blocks: [{ type: 'gauge' }] }));
    expect(live.dataProblem(f.data, KIT)).toBeNull();
    writeFileSync(f.data, '{ nope');
    expect(live.dataProblem(f.data, KIT)).toMatch(/isn't valid JSON/);
    // an earlier kit page (it says so in its head) is brought up to the new one; the session's own is not
    const OLD = '<html><head><meta name="generator" content="cora-dashboard-kit"></head><body>old kit</body></html>';
    const NEW = OLD.replace('old kit', 'new kit');
    writeFileSync(f.page, OLD);
    expect(live.startKit('sess-dash-9', 'Release', NEW).wrote).toBe(true);
    expect(readFileSync(f.page, 'utf8')).toBe(NEW);
    expect(live.startKit('sess-dash-9', 'Release', NEW).wrote).toBe(false);
    // not an explain's data file
    expect(live.dataProblem(f.page, KIT)).toBeNull();
    expect(live.dataProblem(join(root, '..', 'elsewhere', 'data.json'), KIT)).toBeNull();
    expect(live.dataProblem('', KIT)).toBeNull();
  });
});
