import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => srv?.close());
const UI = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
const TOK = { 'x-cora-token': 'hooktok' };

describe('the Jira watch routes', () => {
  it('the desktop app reads what to watch and reports what it found; the dashboard reads the status and inbox', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'cora-jr-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false });
    expect((await srv.app.inject({ method: 'GET', url: '/api/local/jira-watch' })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'GET', url: '/api/local/jira-watch', headers: TOK })).json()).toMatchObject({ on: false, since: null });
    await srv.app.inject({ method: 'POST', url: '/api/settings', headers: UI, payload: { jira: { watch: { on: true, site: 's.atlassian.net' } } } });
    expect((await srv.app.inject({ method: 'GET', url: '/api/local/jira-watch', headers: TOK })).json()).toMatchObject({ on: true, site: 's.atlassian.net' });
    const e = { id: 'ACME-1:h1', kind: 'assigned', key: 'ACME-1', summary: 'S', who: 'Dana', what: 'assigned you', at: Date.now(), link: 'https://s.atlassian.net/browse/ACME-1' };
    expect((await srv.app.inject({ method: 'POST', url: '/api/local/jira-events', headers: TOK, payload: { checkedAt: Date.now(), events: [e], status: { state: 'ok' } } })).json()).toEqual({ ok: true, fresh: 1 });
    // one odd event is left out, not the batch: the rest still come in (audit B11)
    const e2 = { ...e, id: 'ACME-2:h1', key: 'ACME-2', link: 'https://s.atlassian.net/browse/ACME-2', summary: 'x'.repeat(900) };
    expect((await srv.app.inject({ method: 'POST', url: '/api/local/jira-events', headers: TOK, payload: { events: [{ ...e, id: 'bad', kind: 'nope' }, null, { ...e, id: 'bad2', link: 'javascript:x' }, e2], status: { state: 'ok' } } })).json()).toEqual({ ok: true, fresh: 1 });
    // a backlog bigger than 500: the newest 500, not a refusal
    const many = Array.from({ length: 520 }, (_, i) => ({ ...e, id: `ACME-1:m${i}`, at: Date.now() - 520 + i }));
    expect((await srv.app.inject({ method: 'POST', url: '/api/local/jira-events', headers: TOK, payload: { events: many, status: { state: 'ok' } } })).statusCode).toBe(200);
    // a batch without its status is still refused
    expect((await srv.app.inject({ method: 'POST', url: '/api/local/jira-events', headers: TOK, payload: { events: [e] } })).statusCode).toBe(400);
    const w = (await srv.app.inject({ method: 'GET', url: '/api/jira/watch', headers: UI })).json();
    expect(w.status.state).toBe('ok');
    expect(w.recent.map((x: any) => x.id)).toContain('ACME-1:h1');
    expect(w.recent.find((x: any) => x.id === 'ACME-2:h1').summary).toHaveLength(500);
  });
});
