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

describe('the Inbox routes', () => {
  it('Jira events land in the Inbox, folded per ticket; reading marks them read', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'cora-ib-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false });
    await srv.app.inject({ method: 'POST', url: '/api/settings', headers: UI, payload: { jira: { watch: { on: true, site: 's.atlassian.net' } } } });
    const e = (id: string, kind: string, what: string) => ({ id, kind, key: 'ACME-1', summary: 'Fix login', who: 'Dana', what, at: Date.now(), link: 'https://s.atlassian.net/browse/ACME-1' });
    await srv.app.inject({ method: 'POST', url: '/api/local/jira-events', headers: TOK, payload: { checkedAt: Date.now(), events: [e('ACME-1:a', 'assigned', 'assigned you'), e('ACME-1:c', 'commented', 'commented: hi')], status: { state: 'ok' } } });
    expect((await srv.app.inject({ method: 'GET', url: '/api/inbox' })).statusCode).toBe(401);
    const { items } = (await srv.app.inject({ method: 'GET', url: '/api/inbox', headers: UI })).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'jira', key: 'jira:ACME-1', readAt: null });
    expect(items[0].entries.map((x: any) => x.id).sort()).toEqual(['ACME-1:a', 'ACME-1:c']);
    expect((await srv.app.inject({ method: 'POST', url: '/api/inbox/read', headers: UI, payload: { all: true } })).json()).toEqual({ ok: true, n: 1 });
    expect((await srv.app.inject({ method: 'GET', url: '/api/inbox', headers: UI })).json().items[0].readAt).toBeTypeOf('number');
    expect((await srv.app.inject({ method: 'POST', url: '/api/inbox/read', headers: UI, payload: { source: 'nope' } })).statusCode).toBe(400);
    // replies: written by you; not for Jira (yet), and never empty
    expect((await srv.app.inject({ method: 'POST', url: `/api/inbox/${items[0].id}/reply`, headers: UI, payload: { text: 'on it' } })).json().error).toMatch(/no reply from the Inbox for jira/);
    expect((await srv.app.inject({ method: 'POST', url: `/api/inbox/${items[0].id}/reply`, headers: UI, payload: { text: '  ' } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'POST', url: '/api/inbox/nope/reply', headers: UI, payload: { text: 'x' } })).statusCode).toBe(404);
  });
});
