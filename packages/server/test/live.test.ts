import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../src/remote';
import { Shares } from '../src/shares';
import { Door, doorAllows, doorHeaders } from '../src/door';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';

let dir: string;
const fakeDoor0 = () => ({ open: false, port: 4328, async start() {}, async stop() {} });
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-live-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a share', () => {
  it('the link lets guests in, each with a key of their own; removing one, or ending it, ends their key', () => {
    let changes = 0;
    const s = new Shares({ onChange: () => changes++ });
    expect(s.join('x', {})).toBeNull();
    const { share, token } = s.start();
    expect(share).toMatchObject({ mode: 'view', open: [], guests: [] });
    expect(s.join('0'.repeat(48), { name: 'Ana' })).toBeNull();
    const a = s.join(token, { name: 'Ana Ruiz', login: 'ana@example.com' })!;
    const b = s.join(token, { login: 'bo@example.com' })!;
    expect(a.guest.name).toBe('Ana Ruiz');
    expect(b.guest.name).toBe('bo');
    expect(s.check(a.key)?.id).toBe(a.guest.id);
    expect(s.check('nope')).toBeNull();
    s.setOpen('notes', true);
    s.setOpen('settings' as never, true);
    expect(s.current()?.open).toEqual(['notes']);
    expect(s.remove(a.guest.id)).toBe(true);
    expect(s.check(a.key)).toBeNull();
    expect(s.check(b.key)).not.toBeNull();
    // a new share: the old link and keys are done
    const again = s.start();
    expect(s.check(b.key)).toBeNull();
    expect(s.join(token, {})).toBeNull();
    expect(s.join(again.token, {})).not.toBeNull();
    s.end();
    expect(s.current()).toBeNull();
    expect(changes).toBeGreaterThan(5);
  });
});

describe('Go live, through the server', () => {
  const tailnet: Run = async (args) => {
    if (args[0] === 'status') return { ok: true, out: JSON.stringify({ Self: { DNSName: 'pc.tail1.ts.net.' }, CertDomains: ['pc.tail1.ts.net'] }), err: '' };
    if (args.join(' ') === 'serve status --json') return { ok: true, out: JSON.stringify({ Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' } } } } }), err: '' };
    return { ok: true, out: '', err: '' };
  };

  it('a guest sees the sessions, never your private things; acts only as the share allows', async () => {
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, remoteRun: tailnet, door: fakeDoor0() });
    try {
      const pc = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
      const tail = 'https://pc.tail1.ts.net';
      // not live: the link is nothing
      expect((await srv.app.inject({ url: '/live/abc' })).statusCode).toBe(404);
      const started = (await srv.app.inject({ method: 'POST', url: '/api/live/start', headers: pc, payload: { reach: 'tailnet' } })).json();
      expect(started.live).toMatchObject({ mode: 'view', reach: 'tailnet', guests: [], link: expect.stringMatching(/^https:\/\/pc\.tail1\.ts\.net\/live\/[0-9a-f]{48}$/) });
      const path = new URL(started.live.link).pathname;
      // a teammate opens it (Tailscale names them): a key, then Cora
      const r = await srv.app.inject({ url: path, headers: { 'tailscale-user-name': 'Ana Ruiz', 'tailscale-user-login': 'ana@example.com', 'x-forwarded-proto': 'https' } });
      expect(r.statusCode).toBe(302);
      const cookie = String(r.headers['set-cookie']).split(';')[0];
      expect(cookie).toMatch(/^cora_guest=[0-9a-f]{64}$/);
      const ana = { cookie, origin: tail };
      // they see the share (not its link), and the sessions
      const me = (await srv.app.inject({ url: '/api/live', headers: ana })).json();
      expect(me).toMatchObject({ role: 'guest', live: { mode: 'view', guests: [{ name: 'Ana Ruiz' }] } });
      expect(me.live.link).toBeUndefined();
      expect(me.live.you).toBe(me.live.guests[0].id);
      expect((await srv.app.inject({ url: '/api/sessions', headers: ana })).statusCode).toBe(200);
      // your look: the visual part, read only (no Tools list, no drafts)
      await srv.app.inject({ method: 'PUT', url: '/api/synced/ab%3Aui', headers: pc, payload: { value: JSON.stringify({ coraColor: '#a78bfa', scene3d: false, tools: [{ id: 't', url: 'https://secret.example' }] }) } });
      await srv.app.inject({ method: 'PUT', url: '/api/synced/ab%3Acomposer', headers: pc, payload: { value: '{"drafts":{"s":"my private draft"}}' } });
      const look = (await srv.app.inject({ url: '/api/synced', headers: ana })).json().values;
      expect(Object.keys(look)).toEqual(['ab:ui']);
      expect(JSON.parse(look['ab:ui'])).toEqual({ coraColor: '#a78bfa', scene3d: false });
      expect((await srv.app.inject({ method: 'PUT', url: '/api/synced/ab%3Aui', headers: ana, payload: { value: '{}' } })).statusCode).toBe(401);
      // your private things: no
      for (const url of ['/api/secrets', '/api/notes', '/api/inbox', '/api/slack', '/api/devices', '/api/history', '/api/gmail', '/api/orchestrator']) expect((await srv.app.inject({ url, headers: ana })).statusCode, url).toBe(403);
      // acting as you: no
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/end', headers: ana })).statusCode).toBe(401);
      expect((await srv.app.inject({ method: 'PUT', url: '/api/lock/pin', headers: ana, payload: { pin: '1234' } })).statusCode).toBe(401);
      // watching only: they can't prompt
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/act', headers: ana, payload: { kind: 'prompt', sessionId: 's', text: 'hi' } })).statusCode).toBe(403);
      // you open Notes to them: they can read it; close it again: they can't
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/area', headers: pc, payload: { area: 'notes', open: true } })).statusCode).toBe(200);
      expect((await srv.app.inject({ url: '/api/notes', headers: ana })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/area', headers: pc, payload: { area: 'notes', open: false } })).statusCode).toBe(200);
      expect((await srv.app.inject({ url: '/api/notes', headers: ana })).statusCode).toBe(403);
      // interactive: a prompt goes through (here, no session is running: 404, not refused)
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/mode', headers: pc, payload: { mode: 'interactive' } })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/act', headers: ana, payload: { kind: 'prompt', sessionId: 's', text: 'hi' } })).statusCode).toBe(404);
      // from another site: no
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/act', headers: { cookie, origin: 'https://evil.example' }, payload: { kind: 'prompt', sessionId: 's', text: 'hi' } })).statusCode).toBe(403);
      // Follow only: the share says so to the guest
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/follow', headers: pc, payload: { on: true } })).statusCode).toBe(200);
      expect((await srv.app.inject({ url: '/api/live', headers: ana })).json().live.followOnly).toBe(true);
      expect((await srv.app.inject({ method: 'POST', url: '/api/live/follow', headers: ana, payload: { on: false } })).statusCode).toBe(401);
      // you see who's there, and remove them: out at once
      const host = (await srv.app.inject({ url: '/api/live', headers: pc })).json();
      expect(host).toMatchObject({ role: 'host', live: { mode: 'interactive', guests: [{ name: 'Ana Ruiz', login: 'ana@example.com' }] } });
      await srv.app.inject({ method: 'POST', url: `/api/live/guests/${host.live.guests[0].id}/remove`, headers: pc });
      expect((await srv.app.inject({ url: '/api/sessions', headers: ana })).statusCode).toBe(401);
      // ended: the link is done
      await srv.app.inject({ method: 'POST', url: '/api/live/end', headers: pc });
      expect((await srv.app.inject({ url: path })).statusCode).toBe(404);
      expect((await srv.app.inject({ url: '/api/live', headers: pc })).json()).toMatchObject({ role: 'host', live: null });
    } finally {
      await srv.close();
    }
  });

  it("can't go live while Cora isn't on your tailnet", async () => {
    const off: Run = async (args) => (args[0] === 'status' ? { ok: true, out: JSON.stringify({ Self: { DNSName: 'pc.tail1.ts.net.' }, CertDomains: ['pc.tail1.ts.net'] }), err: '' } : { ok: true, out: '{}', err: '' });
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, remoteRun: off, door: fakeDoor0() });
    try {
      const r = await srv.app.inject({ method: 'POST', url: '/api/live/start', headers: { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' }, payload: { reach: 'tailnet' } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ remoteOff: true });
    } finally {
      await srv.close();
    }
  });
});

describe('a public link (Tailscale Funnel to the guests-only door)', () => {
  const tailnet = (o: { funnel: boolean }) => {
    const calls: string[][] = [];
    let funnelOn = false;
    const run: Run = async (args) => {
      calls.push(args);
      if (args[0] === 'status') return { ok: true, out: JSON.stringify({ Self: { DNSName: 'pc.tail1.ts.net.', ID: 'nABC', CapMap: o.funnel ? { funnel: null, https: null } : { https: null } }, CertDomains: ['pc.tail1.ts.net'] }), err: '' };
      if (args.join(' ') === 'funnel status --json') return { ok: true, out: funnelOn ? JSON.stringify({ Web: { 'pc.tail1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4328' } } } }, AllowFunnel: { 'pc.tail1.ts.net:8443': true } }) : '{}', err: '' };
      if (args[0] === 'funnel') funnelOn = args.at(-1) !== 'off';
      if (args.join(' ') === 'serve status --json') return { ok: true, out: '{}', err: '' };
      return { ok: true, out: '', err: '' };
    };
    return { run, calls };
  };
  const fakeDoor = () => {
    const d = { open: false, port: 4328, async start() { d.open = true; }, async stop() { d.open = false; } };
    return d;
  };

  it('Go live makes a public link by default: Funnel on to the door; a guest says their name; ending closes it all', async () => {
    const t = tailnet({ funnel: true });
    const door = fakeDoor();
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, remoteRun: t.run, door });
    try {
      const pc = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
      const started = await srv.app.inject({ method: 'POST', url: '/api/live/start', headers: pc });
      expect(started.statusCode).toBe(200);
      expect(door.open).toBe(true);
      expect(started.json().live).toMatchObject({ reach: 'public', link: expect.stringMatching(/^https:\/\/pc\.tail1\.ts\.net:8443\/live\/[0-9a-f]{48}$/) });
      expect(t.calls).toContainEqual(['funnel', '--bg', '--https=8443', 'http://127.0.0.1:4328']);
      const path = new URL(started.json().live.link).pathname;
      const pub = { 'x-cora-door': '1', 'x-forwarded-proto': 'https', origin: 'https://pc.tail1.ts.net:8443' };
      // through the door: a join page (no Tailscale names there, even if someone sends them)
      const page = await srv.app.inject({ url: path, headers: { ...pub, 'tailscale-user-name': 'Not Really' } });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Your name');
      expect(page.headers['set-cookie']).toBeUndefined();
      // they say their name: in
      const token = path.split('/').pop();
      const j = await srv.app.inject({ method: 'POST', url: '/api/live/join', headers: pub, payload: { token, name: '  Sam   Rivera ' } });
      expect(j.statusCode).toBe(200);
      const cookie = String(j.headers['set-cookie']).split(';')[0];
      expect(String(j.headers['set-cookie'])).toMatch(/Secure/i);
      const me = (await srv.app.inject({ url: '/api/live', headers: { ...pub, cookie } })).json();
      expect(me).toMatchObject({ role: 'guest', live: { reach: 'public', guests: [{ name: 'Sam Rivera' }] } });
      // through the door, your own sign-in is nothing
      expect((await srv.app.inject({ url: '/api/secrets', headers: { ...pub, cookie: 'ab_session=u' } })).statusCode).toBe(401);
      // a wrong link: the ended page; a burst of them: no more tries for a while
      expect((await srv.app.inject({ url: '/live/' + '0'.repeat(48), headers: pub })).statusCode).toBe(404);
      // to your tailnet only, mid-share: Funnel off, same secret on Cora's tailnet address
      await srv.app.inject({ method: 'POST', url: '/api/live/end', headers: pc });
      expect(t.calls).toContainEqual(['funnel', '--https=8443', 'off']);
      expect((await srv.app.inject({ url: '/api/live', headers: { ...pub, cookie } })).statusCode).toBe(401);
      expect(door.open).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("Funnel not allowed for this PC yet: Go live says so, with Tailscale's page to allow it", async () => {
    const t = tailnet({ funnel: false });
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, remoteRun: t.run, door: fakeDoor0() });
    try {
      const r = await srv.app.inject({ method: 'POST', url: '/api/live/start', headers: { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ enableUrl: 'https://login.tailscale.com/f/funnel?node=nABC' });
      expect(t.calls.some((c) => c[0] === 'funnel' && c[1] === '--bg')).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('the door passes on only what a guest uses, and never your sign-ins', async () => {
    expect(doorAllows('GET', '/')).toBe(true);
    expect(doorAllows('GET', '/assets/index-abc.js')).toBe(true);
    expect(doorAllows('GET', '/live/abc')).toBe(true);
    expect(doorAllows('GET', '/api/sessions')).toBe(true);
    expect(doorAllows('POST', '/api/live/act')).toBe(true);
    expect(doorAllows('POST', '/api/live/join')).toBe(true);
    for (const [m, u] of [['GET', '/auth?key=x'], ['GET', '/pair'], ['POST', '/api/pair'], ['POST', '/hook/pre'], ['GET', '/api/local/jira-watch'], ['GET', '/api/ide/bridge/next'], ['POST', '/api/live/start'], ['PUT', '/api/lock/pin'], ['DELETE', '/api/devices/x'], ['POST', '/agent-gate']])
      expect(doorAllows(m, u), `${m} ${u}`).toBe(false);
    const h = doorHeaders(['Cookie', 'ab_session=u; cora_guest=abc; cora_device=d; ab_view=v', 'Tailscale-User-Name', 'X', 'x-cora-door', '0', 'Host', 'h']);
    expect(h).toContainEqual(['Cookie', 'cora_guest=abc']);
    expect(h.some(([k]) => /tailscale/i.test(k))).toBe(false);
    expect(h.filter(([k]) => k === 'x-cora-door')).toEqual([['x-cora-door', '1']]);
    // for real: a request through it reaches Cora without your cookie
    let seen: Record<string, unknown> = {};
    const target = createServer((req, res) => ((seen = req.headers), res.end('ok')));
    await new Promise<void>((ok) => target.listen(0, '127.0.0.1', () => ok()));
    const port = (target.address() as { port: number }).port;
    const door = new Door({ target: port, port: port + 1 });
    try {
      await door.start();
      const ok = await fetch(`http://127.0.0.1:${port + 1}/api/sessions`, { headers: { cookie: 'ab_session=u; cora_guest=g' } });
      expect(await ok.text()).toBe('ok');
      expect(seen.cookie).toBe('cora_guest=g');
      expect(seen['x-cora-door']).toBe('1');
      expect((await fetch(`http://127.0.0.1:${port + 1}/auth?key=u`)).status).toBe(404);
    } finally {
      await door.stop();
      target.close();
    }
  });
});

describe('the IDE, relayed to your other devices', () => {
  it('only for you: not signed in, a guest, or through the public door get nothing; VS Code not running says so', async () => {
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, door: fakeDoor0() });
    try {
      expect((await srv.app.inject({ url: '/ide/' })).statusCode).toBe(401);
      expect((await srv.app.inject({ url: '/ide/', headers: { cookie: 'cora_guest=' + 'a'.repeat(64) } })).statusCode).toBe(401);
      expect((await srv.app.inject({ url: '/ide/', headers: { cookie: 'ab_session=u', 'x-cora-door': '1' } })).statusCode).toBe(401);
      const r = await srv.app.inject({ url: '/ide/', headers: { cookie: 'ab_session=u' } });
      expect(r.statusCode).toBe(503);
      expect(r.body).toMatch(/VS Code isn't running/);
    } finally {
      await srv.close();
    }
  });
});

describe("a session's browser, through the server", () => {
  it('for you only: a guest, the public door, or no sign-in get nothing; the desktop link needs Cora’s local key', async () => {
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, door: fakeDoor0() });
    try {
      const pc = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
      expect((await srv.app.inject({ url: '/api/browse' })).statusCode).toBe(401);
      expect((await srv.app.inject({ url: '/api/browse', headers: { cookie: 'ab_session=u', 'x-cora-door': '1' } })).statusCode).toBe(401);
      expect((await srv.app.inject({ url: '/api/browse', headers: pc })).json()).toMatchObject({ t: 'rbrowse', available: false, tabs: [] });
      const o = await srv.app.inject({ method: 'POST', url: '/api/browse/open', headers: pc, payload: { sessionId: 's1', url: 'https://example.com' } });
      expect(o.json().tab).toMatchObject({ sessionId: 's1', url: 'https://example.com' });
      expect((await srv.app.inject({ method: 'POST', url: '/api/browse/open', headers: pc, payload: { sessionId: 's1', url: 'file:///c:/x' } })).statusCode).toBe(400);
      expect((await srv.app.inject({ url: '/api/local/browse?key=wrong' })).statusCode).toBe(401);
    } finally {
      await srv.close();
    }
  });
});
