import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Devices, deviceName } from '../src/devices';
import { Remote, type Run } from '../src/remote';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-devices-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pairing a device', () => {
  it('the code (or the QR secret) pairs once, within 5 minutes; five wrong tries end it; the key signs it in', () => {
    let now = 1_000_000;
    const d = new Devices({ file: join(dir, 'devices.json'), now: () => now });
    expect(d.pair({ code: '123456', name: 'iPad' })).toMatchObject({ ok: false, why: expect.stringMatching(/No pairing is open/) });
    const p = d.startPairing();
    expect(p.code).toMatch(/^\d{6}$/);
    const r = d.pair({ code: p.code, name: 'iPad' });
    expect(r).toMatchObject({ ok: true, device: { name: 'iPad' } });
    const key = (r as { key: string }).key;
    expect(d.check(key)).toMatchObject({ name: 'iPad' });
    expect(d.check('0'.repeat(64))).toBeNull();
    // used once
    expect(d.pair({ code: p.code, name: 'x' }).ok).toBe(false);
    // the QR's secret works too; an expired one doesn't
    const q = d.startPairing();
    expect(d.pair({ secret: q.secret, name: 'Mac' }).ok).toBe(true);
    const late = d.startPairing();
    now += 6 * 60_000;
    expect(d.pair({ code: late.code, name: 'x' }).ok).toBe(false);
    // five wrong tries close it
    const w = d.startPairing();
    for (let i = 0; i < 5; i++) d.pair({ code: '000000' === w.code ? '111111' : '000000', name: 'x' });
    expect(d.pair({ code: w.code, name: 'x' }).ok).toBe(false);
    // kept (sealed) across a restart; removed, it's out at once
    const again = new Devices({ file: join(dir, 'devices.json'), now: () => now });
    expect(again.list().map((x) => x.name)).toEqual(['iPad', 'Mac']);
    expect(again.remove(again.list()[0].id)).toBe(true);
    expect(again.check(key)).toBeNull();
  });

  it('names a device from its browser', () => {
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPad');
    expect(deviceName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC');
  });
});

describe('Cora on your tailnet', () => {
  const fake = (o: { serving?: boolean; certs?: boolean; down?: boolean }): { run: Run; calls: string[][] } => {
    const calls: string[][] = [];
    let serving = !!o.serving;
    const run: Run = async (args) => {
      calls.push(args);
      if (o.down) return { ok: false, out: '', err: 'failed to connect to local tailscaled' };
      if (args[0] === 'status') return { ok: true, out: JSON.stringify({ Self: { DNSName: 'pc.tail1.ts.net.' }, CertDomains: o.certs === false ? [] : ['pc.tail1.ts.net'] }), err: '' };
      if (args.join(' ') === 'serve status --json') return { ok: true, out: serving ? JSON.stringify({ Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' } } } } }) : '{}', err: '' };
      if (args[0] === 'serve') serving = args.at(-1) !== 'off';
      return { ok: true, out: '', err: '' };
    };
    return { run, calls };
  };

  it('says whether it can, and whether it is; turns on and off with tailscale serve', async () => {
    const f = fake({});
    const r = new Remote({ port: 4317, run: f.run });
    expect(await r.status()).toEqual({ available: true, on: false, host: 'pc.tail1.ts.net', url: 'https://pc.tail1.ts.net' });
    expect(await r.turn(true)).toMatchObject({ on: true, url: 'https://pc.tail1.ts.net' });
    expect(f.calls).toContainEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:4317']);
    expect(await r.turn(false)).toMatchObject({ on: false });
    expect(f.calls).toContainEqual(['serve', '--https=443', 'off']);
    expect(await new Remote({ port: 4317, run: fake({ certs: false }).run }).status()).toMatchObject({ available: false, why: expect.stringMatching(/HTTPS certificates/) });
    expect(await new Remote({ port: 4317, run: fake({ down: true }).run }).status()).toMatchObject({ available: false, why: expect.stringMatching(/isn't running/) });
  });

  it('pairs through the server: the PC opens it, the page takes the code, the key then signs the device in', async () => {
    const f = fake({ serving: true });
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false, remoteRun: f.run });
    try {
      const pc = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
      const ipad = { origin: 'https://pc.tail1.ts.net', 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' };
      expect((await srv.app.inject({ url: '/pair' })).body).toContain('Pair with Cora');
      // not paired: nothing
      expect((await srv.app.inject({ url: '/api/me' })).statusCode).toBe(401);
      expect((await srv.app.inject({ method: 'POST', url: '/api/pair', headers: ipad, payload: { code: '123456' } })).statusCode).toBe(403);
      // the PC opens a pairing (the tailnet address now counts as Cora's own)
      const open = (await srv.app.inject({ method: 'POST', url: '/api/devices/pair', headers: pc })).json();
      expect(open).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), url: 'https://pc.tail1.ts.net/pair' });
      expect(open.link).toMatch(/^https:\/\/pc\.tail1\.ts\.net\/pair\?c=[0-9a-f]{48}$/);
      // the iPad gives the code back: its key, as a cookie
      const r = await srv.app.inject({ method: 'POST', url: '/api/pair', headers: ipad, payload: { code: open.code } });
      expect(r.statusCode).toBe(200);
      const cookie = String(r.headers['set-cookie']).split(';')[0];
      expect(cookie).toMatch(/^cora_device=[0-9a-f]{64}$/);
      expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/i);
      expect(String(r.headers['set-cookie'])).toMatch(/Secure/i);
      expect((await srv.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
      const list = (await srv.app.inject({ url: '/api/devices', headers: { cookie: pc.cookie } })).json().devices;
      expect(list).toMatchObject([{ name: 'iPad' }]);
      // one device at a time: the PC has it, so the iPad gets nothing but where it is
      const iCookie = { ...ipad, cookie };
      const pcCookie = pc;
      expect((await srv.app.inject({ url: '/api/sessions', headers: { cookie } })).json()).toEqual({ error: 'elsewhere', elsewhere: 'your PC' });
      expect((await srv.app.inject({ url: '/api/seat', headers: { cookie } })).json()).toMatchObject({ here: false, name: 'your PC', pc: false });
      // no PIN set: the iPad can't take Cora over at all
      expect((await srv.app.inject({ url: '/api/seat', headers: { cookie } })).json()).toMatchObject({ noPin: true });
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/take', headers: iCookie, payload: {} })).json()).toMatchObject({ noPin: true });
      // a PIN set on the PC (to take Cora back later)
      expect((await srv.app.inject({ method: 'PUT', url: '/api/lock/pin', headers: pcCookie, payload: { pin: '4821' } })).statusCode).toBe(200);
      // the iPad takes it over with your PIN: it has it now, and the PC is covered
      expect((await srv.app.inject({ url: '/api/seat', headers: { cookie } })).json()).toMatchObject({ needsPin: true });
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/take', headers: iCookie, payload: {} })).json()).toMatchObject({ needsPin: true });
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/take', headers: iCookie, payload: { pin: '4821' } })).statusCode).toBe(200);
      expect((await srv.app.inject({ url: '/api/sessions', headers: { cookie } })).statusCode).toBe(200);
      expect((await srv.app.inject({ url: '/api/sessions', headers: { cookie: pc.cookie } })).json()).toEqual({ error: 'elsewhere', elsewhere: 'iPad' });
      // with a PIN set, the PC needs it to take Cora back (a wrong one doesn't)
      expect((await srv.app.inject({ url: '/api/seat', headers: { cookie: pc.cookie } })).json()).toMatchObject({ here: false, needsPin: true, name: 'iPad' });
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/take', headers: pcCookie, payload: {} })).json()).toMatchObject({ needsPin: true });
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/take', headers: pcCookie, payload: { pin: '0000' } })).statusCode).toBe(403);
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/disconnect', headers: pcCookie, payload: { pin: '4821' } })).statusCode).toBe(200);
      expect((await srv.app.inject({ url: '/api/sessions', headers: { cookie: pc.cookie } })).statusCode).toBe(200);
      // only the PC disconnects remote devices
      expect((await srv.app.inject({ method: 'POST', url: '/api/seat/disconnect', headers: iCookie })).statusCode).toBe(403);
      // removed: signed out at once
      await srv.app.inject({ method: 'DELETE', url: `/api/devices/${list[0].id}`, headers: pc });
      expect((await srv.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await srv.close();
    }
  });
});
