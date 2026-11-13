import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvState } from '../src/environments';
import { Vpn, drivesVpn, lastPhase, matchProfile, readOvpnConfig, type VpnOutcome } from '../src/vpn';

const PROFILES = {
  '1': { id: '1', profileName: 'MGMT', profileDisplayName: 'MGMT', hostname: 'vpn01.mgmt.example.com', profileConfig: { userlockedUsername: 'dh' }, lastConnected: 5 },
  '2': { id: '2', profileName: 'Insight Production', profileDisplayName: 'Insight Production', hostname: 'cvpn-prod.example.com', profileConfig: { userlockedUsername: '' } },
  '3': { id: '3', profileName: 'Insight Development', profileDisplayName: 'Insight Development', hostname: 'dev.cvpn.example.com', profileConfig: {} },
};
/** OpenVPN Connect's config.json: redux-persist's JSON strings in JSON strings */
const cfg = (connected: string | null, at = 1000, authPendingUrl = '') =>
  JSON.stringify({ 'persist:root': JSON.stringify({ status: JSON.stringify({ profiles: PROFILES, connectedProfile: connected ? { id: connected, profileName: 'x' } : null, connectedAt: at, embeddedBrowser: { authPendingUrl } }) }) });

const env = (id: string, label: EnvState['label'], reachable: boolean, checkedAt: number): EnvState => ({ id, name: id, label, url: `https://${id}/ping`, on: true, reachable, checkedAt });

describe('VPN: reading OpenVPN Connect', () => {
  it('reads its profiles (names, servers, whether they ask a password) and the connected one', () => {
    const r = readOvpnConfig(cfg('1', 42))!;
    expect(r.profiles.map((p) => [p.id, p.name, p.password])).toEqual([
      ['3', 'Insight Development', false],
      ['2', 'Insight Production', false],
      ['1', 'MGMT', true],
    ]);
    expect(r.connected).toBe('1');
    expect(r.connectedAt).toBe(42);
    expect(readOvpnConfig(cfg(null))!.connected).toBeNull();
    expect(readOvpnConfig('not json')).toBeNull();
  });

  it("its log's latest event says the phase (INFO lines say nothing)", () => {
    expect(lastPhase('EVENT: CONNECTING x EVENT: CONNECTED y EVENT: INFO z')).toBe('connected');
    expect(lastPhase('EVENT: CONNECTED EVENT: DISCONNECTED')).toBe('disconnected');
    expect(lastPhase('EVENT: RECONNECTING')).toBe('connecting');
    expect(lastPhase('EVENT: AUTH_PENDING')).toBe('waiting');
    expect(lastPhase('EVENT: AUTH_FAILED')).toBe('failed');
    expect(lastPhase('nothing')).toBeNull();
  });
});

describe('VPN: only the user switches it', () => {
  it("a session's command that drives OpenVPN or takes the network down is refused; reading its folder is not", () => {
    for (const c of [
      '"C:\\Program Files\\OpenVPN Connect\\OpenVPNConnect.exe" --connect-shortcut=1665147783306',
      'Stop-Process -Name OpenVPNConnect',
      'Restart-Service agent_ovpnconnect',
      'start openvpn://import-profile/x',
      'rasdial "Work VPN"',
      'Disable-NetAdapter -Name Ethernet',
      'netsh interface set interface "Local Area Connection" disable',
      'openvpn --config client.ovpn',
    ])
      expect(drivesVpn(c), c).toBe(true);
    for (const c of ['kubectl get pods', 'Get-Content "$env:APPDATA\\OpenVPN Connect\\log\\ovpn.log" -Tail 20', 'git status', 'cat ~/.kube/config'])
      expect(drivesVpn(c), c).toBe(false);
  });

  it('a request names a profile, an environment it reached, or what its name says', () => {
    const profiles = readOvpnConfig(cfg(null))!.profiles.map((p) => ({ ...p, reaches: p.id === '1' ? [{ id: 'mgmtflex', name: 'mgmtflex', label: 'other' }] : [] }));
    expect(matchProfile('prod', profiles)).toBe('2');
    expect(matchProfile('production', profiles)).toBe('2');
    expect(matchProfile('dev', profiles)).toBe('3');
    expect(matchProfile('mgmt', profiles)).toBe('1');
    expect(matchProfile('mgmtflex', profiles, [env('mgmtflex', 'other', false, 0)])).toBe('1');
    expect(matchProfile('insight', profiles)).toBeNull(); // two match: the user picks
    expect(matchProfile('staging', profiles)).toBeNull();
  });
});

/** A fake OpenVPN Connect: its files, and what the shortcut switches do to them. */
function fake(o: { connected?: string | null; connects?: boolean; waitMs?: number; windowOpen?: boolean; waits?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cora-vpn-'));
  mkdirSync(join(dir, 'log'));
  const config = join(dir, 'config.json');
  const log = join(dir, 'log', 'ovpn.log');
  let now = 10_000;
  writeFileSync(config, cfg(o.connected ?? null, now));
  writeFileSync(log, o.connected ? 'EVENT: CONNECTED' : 'EVENT: DISCONNECTED');
  const ran: string[][] = [];
  let envs: EnvState[] = [];
  const told: Array<[string, string]> = [];
  const win: string[] = [];
  const vpn = new Vpn({
    ovpn: { exe: 'ovpn.exe', config, log },
    run: (_exe, args) => {
      ran.push(args);
      now += 1000;
      if (args[0] === '--disconnect-shortcut') {
        writeFileSync(config, cfg(null, now));
        appendFileSync(log, '\nEVENT: DISCONNECTED');
      } else if (o.waits) {
        // a sign-in page: it waits for the user
        writeFileSync(config, cfg(null, now, 'https://sso.example.com/login'));
        appendFileSync(log, '\nEVENT: AUTH_PENDING');
      } else if (o.connects !== false) {
        const id = args[0].split('=')[1];
        writeFileSync(config, cfg(id, now));
        appendFileSync(log, '\nEVENT: CONNECTED');
      }
    },
    envs: () => envs,
    recheck: async () => envs,
    onChange: () => {},
    tell: (sid, text) => told.push([sid, text]),
    window: {
      visible: async () => !!o.windowOpen,
      putAway: (s) => (win.push(`away ${s}`), { stop: () => void win.push('stop') }),
      show: () => void win.push('show'),
    },
    now: () => now,
    pollMs: 5,
    waitMs: o.waitMs ?? 60,
    switchMs: 50,
  });
  return { vpn, ran, told, win, setEnvs: (e: EnvState[]) => (envs = e), tick: (ms: number) => (now += ms), file: { config, log } };
}

const settled = async (vpn: Vpn) => {
  for (let i = 0; i < 200 && vpn.state().switching; i++) await new Promise((r) => setTimeout(r, 5));
};

describe('VPN: a session asks, the user answers', () => {
  it('asking for what is connected already: said at once, no card', async () => {
    const f = fake({ connected: '2' });
    const o = await f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'prod', why: 'read the pods' });
    expect(o.kind).toBe('already');
    expect(f.vpn.state().requests).toEqual([]);
    expect(f.ran).toEqual([]);
  });

  it('a request waits on a card; Switch disconnects, connects that profile, and answers the session', async () => {
    const f = fake({ connected: '1' });
    const asked = f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'prod', why: 'read the pods' });
    const [r] = f.vpn.state().requests;
    expect(r).toMatchObject({ sessionId: 's1', session: 'svc', profileId: '2', why: 'read the pods' });
    // nothing switched until the user says so
    expect(f.ran).toEqual([]);
    expect(f.vpn.answer(r.id, { switch: true })).toEqual({ ok: true });
    await settled(f.vpn);
    const o: VpnOutcome = await asked;
    expect(f.ran).toEqual([['--disconnect-shortcut'], ['--connect-shortcut=2']]);
    expect(o.kind).toBe('switched');
    expect(o.text).toContain('Insight Production');
    expect(f.vpn.state()).toMatchObject({ connected: '2', phase: 'connected', requests: [] });
  });

  it('Not now answers the session and switches nothing', async () => {
    const f = fake({ connected: '1' });
    const asked = f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'dev', why: 'x' });
    f.vpn.answer(f.vpn.state().requests[0].id, { switch: false });
    expect((await asked).kind).toBe('declined');
    expect(f.ran).toEqual([]);
  });

  it("a request the user hasn't answered stops the call waiting; their later answer is typed into the session", async () => {
    const f = fake({ connected: '1' });
    const o = await f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'dev', why: 'x' });
    expect(o.kind).toBe('waiting');
    const [r] = f.vpn.state().requests;
    f.vpn.answer(r.id, { switch: true });
    await settled(f.vpn);
    expect(f.told).toHaveLength(1);
    expect(f.told[0][0]).toBe('s1');
    expect(f.told[0][1]).toMatch(/switched the VPN to Insight Development/);
  });

  it("the user switching by themselves answers the requests for that profile; a switch that doesn't happen says why and keeps the card", async () => {
    const f = fake({ connected: '1', connects: false, waitMs: 5000 });
    const asked = f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'dev', why: 'x' });
    const [r] = f.vpn.state().requests;
    f.vpn.answer(r.id, { switch: true });
    await settled(f.vpn);
    expect(f.vpn.state().error).toMatch(/Insight Development hadn't connected/);
    expect(f.vpn.state().requests).toHaveLength(1);
    // they connect it in OpenVPN Connect themselves
    writeFileSync(f.file.config, cfg('3', 20_000));
    appendFileSync(f.file.log, '\nEVENT: CONNECTED');
    f.vpn.poll();
    expect((await asked).kind).toBe('switched');
  });

  it('an unknown ask waits for the user to pick a profile', async () => {
    const f = fake({ connected: '1' });
    void f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'insight', why: 'x' });
    const [r] = f.vpn.state().requests;
    expect(r.profileId).toBeNull();
    expect(f.vpn.answer(r.id, { switch: true })).toEqual({ ok: false, error: 'pick a profile' });
    expect(f.vpn.answer(r.id, { switch: true, profileId: '3' })).toEqual({ ok: true });
    await settled(f.vpn);
    expect(f.ran.at(-1)).toEqual(['--connect-shortcut=3']);
  });

  it('turned off: sessions are told to ask in their reply, and nothing switches', async () => {
    const f = fake({ connected: '1' });
    f.vpn.setOn(false);
    expect((await f.vpn.request({ sessionId: 's1', session: 'svc', asked: 'dev', why: 'x' })).kind).toBe('unavailable');
    expect(f.vpn.switchTo('3')).toEqual({ ok: false, error: "Cora's VPN control is off" });
  });

  it("OpenVPN Connect's window, which shows itself for a shortcut, goes back to the tray: at once when nothing is asked of you", async () => {
    // from MGMT to Insight Development (signs in by itself): put away through the disconnect, the connect, and once at the end
    const f = fake({ connected: '1' });
    f.vpn.switchTo('3');
    await settled(f.vpn);
    expect(f.vpn.state().connected).toBe('3');
    expect(f.win).toEqual(['away 15', 'stop', 'away 20', 'stop', 'away 0']);
  });

  it('a profile that asks for its password keeps the window while it connects, then puts it away', async () => {
    const f = fake({ connected: '3' });
    f.vpn.switchTo('1');
    await settled(f.vpn);
    expect(f.vpn.state().connected).toBe('1');
    // the disconnect's watcher stops before MGMT's connect, so its password prompt stays
    expect(f.win).toEqual(['away 15', 'stop', 'away 0']);
  });

  it("a window you had open stays open; one waiting for you (a sign-in) is brought back, and left", async () => {
    const open = fake({ connected: '1', windowOpen: true });
    open.vpn.switchTo('3');
    await settled(open.vpn);
    expect(open.win).toEqual([]);
    const waits = fake({ connected: null, waits: true, waitMs: 5000 });
    waits.vpn.switchTo('3');
    await settled(waits.vpn);
    expect(waits.vpn.state().error).toMatch(/waiting for you/);
    expect(waits.win).toEqual(['away 20', 'stop', 'show']);
  });

  it("learns what a profile reaches, only from checks made after it connected", () => {
    const f = fake({ connected: '1' });
    // a check from before it connected: what the last VPN reached
    f.setEnvs([env('mgmtflex', 'other', true, 10_000), env('acme-prod', 'prod', false, 10_000)]);
    f.vpn.learn();
    expect(f.vpn.state().profiles.find((p) => p.id === '1')!.reaches).toEqual([]);
    f.setEnvs([env('mgmtflex', 'other', true, 20_000), env('acme-prod', 'prod', false, 20_000)]);
    f.vpn.learn();
    expect(f.vpn.state().profiles.find((p) => p.id === '1')!.reaches).toEqual([{ id: 'mgmtflex', name: 'mgmtflex', label: 'other' }]);
  });
  it("what's reachable with no VPN connected (another way in) isn't what a profile reaches", () => {
    const f = fake({ connected: null });
    f.setEnvs([env('acme-prod', 'prod', true, 20_000), env('mgmtflex', 'other', false, 20_000)]);
    f.vpn.learn();
    writeFileSync(f.file.config, cfg('1', 30_000));
    appendFileSync(f.file.log, '\nEVENT: CONNECTED');
    f.vpn.refresh();
    f.setEnvs([env('acme-prod', 'prod', true, 40_000), env('mgmtflex', 'other', true, 40_000)]);
    f.vpn.learn();
    expect(f.vpn.state().profiles.find((p) => p.id === '1')!.reaches.map((r) => r.id)).toEqual(['mgmtflex']);
  });
});
