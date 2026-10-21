import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScratch, formatScratch, toggleTask } from '@cora/shared';
import { Notes } from '../src/notes';

const dir = () => join(mkdtempSync(join(tmpdir(), 'cora-notes-')), 'notes');

describe('notes', () => {
  it('Scratch keeps jots newest first, in a file you can read', () => {
    let now = Date.parse('2026-10-17T22:00:00Z');
    const d = dir();
    const n = new Notes({ dir: d, now: () => now });
    n.jot('clip service staging has no ingress');
    now += 60_000;
    n.jot('ask QA about report-scheduler\nbefore the Stripe change');
    const s = n.read('scratch');
    expect(s.jots!.map((j) => j.text)).toEqual(['ask QA about report-scheduler\nbefore the Stripe change', 'clip service staging has no ingress']);
    expect(readFileSync(join(d, 'scratch.md'), 'utf8')).toMatch(/^<!-- jot \w+ 2026-10-17T22:01:00.000Z -->\nask QA/);
    expect(parseScratch(formatScratch(s.jots!))).toEqual(s.jots);
    n.deleteJot(s.jots![1].id);
    expect(n.list()[0]).toMatchObject({ id: 'scratch', count: 1, preview: 'ask QA about report-scheduler\nbefore the Stripe change' });
  });

  it('named notes: made, pinned first, renamed, a jot moved into one, deleted', () => {
    let now = 1_000;
    const n = new Notes({ dir: dir(), now: () => (now += 1000) });
    const a = n.create('Deploy notes', '# Dev bumps\n- only the services the ticket touches\n');
    const b = n.create('Deploy notes');
    expect([a, b]).toEqual(['deploy-notes', 'deploy-notes-2']);
    n.pin(b, true);
    expect(n.list().filter((x) => x.kind !== 'template').map((x) => x.id)).toEqual(['scratch', b, a]);
    n.rename(b, 'Questions for Monday');
    const j = n.jot('is staging on rc1?');
    n.moveJot(j.id, { id: b });
    expect(n.read(b).text).toBe('is staging on rc1?\n');
    expect(n.read('scratch').jots).toEqual([]);
    n.remove(b);
    expect(() => n.read(b)).toThrow(/no such note/);
    expect(() => n.read('../secrets')).toThrow(/no such note/);
  });

  it('sessions add (a jot, or a quote at the end), marked and unseen until you open it; a stale save keeps it', () => {
    const n = new Notes({ dir: dir() });
    const id = n.create('Deploy notes', 'Dev: acme-dev\n');
    const opened = n.read(id);
    // a session adds while you're typing
    expect(n.addFromSession('deploy', 'Bumped dev to 2.10.0-dev26: acme-api only.', 'orion-services (ACME-5301)')).toEqual({ id, title: 'Deploy notes', created: false });
    expect(n.list().find((x) => x.id === id)?.unseen).toBe(true);
    const r = n.save(id, 'Dev: acme-dev, kubeconfig orion-dev\n', opened.version);
    expect(r.text).toMatch(/^Dev: acme-dev, kubeconfig orion-dev\n\n> \*\*Added by orion-services \(ACME-5301\)\*\* · .+\n> Bumped dev to 2\.10\.0-dev26: acme-api only\.\n$/);
    // a save that had seen it doesn't add it twice; deleting it yourself is yours to do
    expect(n.save(id, r.text, r.version).text).toBe(r.text);
    expect(n.save(id, 'just mine\n', r.version + 1).text).toBe('just mine\n');
    // opening it sees it
    n.read(id, { seen: true });
    expect(n.list().find((x) => x.id === id)?.unseen).toBe(false);
    // no note named: a jot from the session; a name that isn't there: a new note
    n.addFromSession(undefined, 'KDKA CC gap again', 'canvas');
    expect(n.read('scratch').jots![0]).toMatchObject({ text: 'KDKA CC gap again', by: 'canvas' });
    expect(n.list()[0].unseen).toBe(true);
    expect(n.addFromSession('Reconciler quirks', 'times out past ~4k companies', 'canvas')).toMatchObject({ title: 'Reconciler quirks', created: true });
  });

  it('search finds every word, in titles, notes and jots', () => {
    const n = new Notes({ dir: dir() });
    n.create('Stripe reconciler quirks', 'The account reconciler times out past ~4k companies.\nBatch by 50.\n');
    n.create('Other', 'nothing here');
    n.jot('reconciler timeout again on prod');
    const hits = n.search('reconciler time');
    expect(hits.map((h) => h.title)).toEqual(['Stripe reconciler quirks', 'Scratch']);
    expect(hits[0].lines).toEqual(['The account reconciler times out past ~4k companies.']);
    expect(n.search('zebra')).toEqual([]);
  });
});

describe('notes: more', () => {
  it('tasks tick and untick by line; a jot keeps where it was taken from; a deleted jot comes back in place', () => {
    expect(toggleTask('# Monday\n- [ ] ask QA\n  - [x] nested\n- plain', 2)).toBe('# Monday\n- [x] ask QA\n  - [x] nested\n- plain');
    expect(toggleTask('- [x] done', 1)).toBe('- [ ] done');
    expect(toggleTask('- plain', 1)).toBe('- plain');
    let now = 1_000_000;
    const n = new Notes({ dir: dir(), now: () => (now += 1000) });
    const a = n.jot('first');
    const b = n.jot('from a transcript', undefined, 'orion-services (ACME-5301)');
    n.jot('third');
    expect(parseScratch(readFileSync(join(n['o'].dir, 'scratch.md'), 'utf8')).find((j) => j.id === b.id)).toMatchObject({ src: 'orion-services (ACME-5301)' });
    n.deleteJot(b.id);
    n.restoreJot(b);
    expect(n.read('scratch').jots!.map((j) => j.text)).toEqual(['third', 'from a transcript', 'first']);
    expect(() => n.restoreJot({ ...a, id: '../x' })).toThrow(/not a jot/);
  });

  it('what the notes say about a ticket: its key as a whole word', () => {
    const n = new Notes({ dir: dir() });
    n.create('Deploy notes', 'ACME-5301: webapi only on dev\nACME-53011 is something else\n');
    n.jot('ask QA about ACME-5301 before staging');
    n.create('Other', 'nothing');
    const about = n.aboutTicket('ACME-5301')!;
    expect(about).toMatch(/^## Deploy notes\n- ACME-5301: webapi only on dev\n## Scratch\n- \[.+\] ask QA about ACME-5301 before staging$/);
    expect(about).not.toMatch(/53011/);
    expect(n.aboutTicket('ACME-9999')).toBeNull();
  });

  it("a session's first prompt on a ticket hears what the notes say about it, once", { timeout: 30_000 }, async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-notesprompt-'));
    const srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, kubeDir: join(dataDir, 'no-kube') });
    try {
      const UI = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
      await srv.app.inject({ method: 'POST', url: '/api/notes', headers: UI, payload: { title: 'Deploy notes', text: 'ACME-5301: bump webapi only\n' } });
      const prompt = (n: number, text: string) => srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: 'sess-np-1', cwd: 'C:/work/x', prompt: text, prompt_id: `np-${n}` } });
      expect((await prompt(1, '/jira ACME-5301')).json().hookSpecificOutput.additionalContext).toMatch(/From Cora: the user's notes mention ACME-5301:\n## Deploy notes\n- ACME-5301: bump webapi only/);
      expect((await prompt(2, 'carry on with ACME-5301')).statusCode).toBe(204);
    } finally {
      await srv.close();
    }
  });
});

describe('notes over HTTP', () => {
  it('lists, jots, edits and deletes; the hub hears the list', { timeout: 30_000 }, async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    const srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'cora-notesrv-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false });
    try {
      const UI = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
      const call = (method: string, url: string, payload?: object) => srv.app.inject({ method: method as any, url, headers: UI, ...(payload ? { payload } : {}) });
      expect((await call('POST', '/api/notes/jots', { text: 'first jot' })).json().jot.text).toBe('first jot');
      const { id } = (await call('POST', '/api/notes', { title: 'Deploy notes' })).json();
      expect((await call('POST', '/api/notes/jots', { text: 'to a note', to: { id } })).json()).toEqual({ id });
      const doc = (await call('GET', `/api/notes/${id}`)).json();
      expect(doc).toMatchObject({ title: 'Deploy notes', text: 'to a note\n' });
      expect((await call('PUT', `/api/notes/${id}`, { text: 'edited', base: doc.version })).json().text).toBe('edited');
      await call('POST', `/api/notes/${id}/meta`, { pinned: true, title: 'Deploys' });
      const list = (await call('GET', '/api/notes')).json().list.filter((x: any) => x.kind !== 'template');
      expect(list.map((x: any) => [x.title, x.pinned])).toEqual([['Scratch', true], ['Deploys', true]]);
      expect((await call('GET', '/api/notes/nope')).statusCode).toBe(404);
      expect((await call('DELETE', `/api/notes/${id}`)).json()).toEqual({ ok: true });
      // no origin: refused
      expect((await srv.app.inject({ method: 'POST', url: '/api/notes/jots', headers: { cookie: 'ab_session=uitok' }, payload: { text: 'x' } })).statusCode).toBe(403);
    } finally {
      await srv.close();
    }
  });
});
