import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_VPN, type VpnPhase, type VpnProfile, type VpnReach, type VpnRequest, type VpnState } from '@cora/shared';
import { envLine, guessLabel, type EnvState } from './environments';
import { writeFileAtomic } from './fsx';

/**
 * The user's VPN, through OpenVPN Connect on this PC. Cora reads which profile is connected from the app's own saved
 * state (config.json) and its log, and switches only when the USER asks, from Cora's VPN control: a switch cuts off
 * whatever other sessions are doing on the VPN that's up. A session can only ask (`vpn_request`): its request waits
 * on a card for the user's Switch or Not now, and its Bash/PowerShell can't drive OpenVPN (drivesVpn, the gate).
 *
 * OpenVPN Connect has no API for this: Cora uses the switches its own desktop shortcuts use (`--connect-shortcut=<id>`,
 * `--disconnect-shortcut`), which a running app takes from a second launch. If an update changes them, a switch
 * times out and says so; nothing else breaks.
 */

/** What Cora reads from OpenVPN Connect's saved state. */
export type OvpnRead = { profiles: Array<Omit<VpnProfile, 'reaches'>>; connected: string | null; connectedAt?: number; authPending: boolean };

const parse = (v: unknown): any => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** OpenVPN Connect's config.json: its profiles (names and servers only) and the connected one. Null: not readable. */
export function readOvpnConfig(text: string): OvpnRead | null {
  const root = parse(parse(text)?.['persist:root']);
  const status = parse(root?.status);
  if (!status || typeof status !== 'object') return null;
  const profiles = Object.values((status.profiles ?? {}) as Record<string, any>)
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => ({
      id: String(p.id),
      name: String(p.profileDisplayName || p.profileName || p.id),
      host: String(p.hostname ?? ''),
      password: !!p.profileConfig?.userlockedUsername,
      ...(typeof p.lastConnected === 'number' ? { lastConnected: p.lastConnected } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const c = status.connectedProfile;
  const connected = c && typeof c.id === 'string' && profiles.some((p) => p.id === c.id) ? c.id : null;
  return { profiles, connected, ...(connected && typeof status.connectedAt === 'number' ? { connectedAt: status.connectedAt } : {}), authPending: !!status.embeddedBrowser?.authPendingUrl };
}

/** The latest event in OpenVPN Connect's log, as a phase (null: none worth saying). */
export function lastPhase(log: string): VpnPhase | null {
  const events = [...log.matchAll(/EVENT: ([A-Z_]+)/g)].map((m) => m[1]);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === 'CONNECTED') return 'connected';
    if (e === 'DISCONNECTED' || e === 'PAUSE') return 'disconnected';
    if (e === 'AUTH_PENDING') return 'waiting';
    if (/FAIL|ERROR|TIMEOUT|DENIED/.test(e)) return 'failed';
    if (/RESOLVE|WAIT|CONNECTING|GET_CONFIG|ASSIGN_IP|RECONNECTING|RESUME|ADD_ROUTES/.test(e)) return 'connecting';
    // INFO and the like say nothing about the connection: look further back
  }
  return null;
}

/** Where OpenVPN Connect is (null: not installed, or not Windows). */
export function findOpenVpnConnect(env: NodeJS.ProcessEnv = process.env, exists = existsSync): { exe: string; config: string; log: string } | null {
  if (process.platform !== 'win32' && !env.CORA_FAKE_OVPN) return null;
  const dirs = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')].filter((d): d is string => !!d);
  const exe = dirs.map((d) => join(d, 'OpenVPN Connect', 'OpenVPNConnect.exe')).find((p) => exists(p));
  if (!exe || !env.APPDATA) return null;
  const data = join(env.APPDATA, 'OpenVPN Connect');
  return { exe, config: join(data, 'config.json'), log: join(data, 'log', 'ovpn.log') };
}

/**
 * A command that drives the VPN or takes the network down: OpenVPN Connect (its program, service, helper, links),
 * other VPN clients' command lines, a network adapter switched off. Reading OpenVPN Connect's folder is fine.
 */
export function drivesVpn(command: string): boolean {
  return /OpenVPNConnect|ovpnconnector|ovpncli|ovpnhelper|agent_ovpnconnect|openvpn-gui|openvpn(\.exe)?\s+--|connect-shortcut|openvpn(-connect)?:\/\/|\brasdial\b|Disable-NetAdapter|netsh\s+interface\s+set\s+interface|vpncli|wg(-quick)?\s+(up|down)|wireguard(\.exe)?\s+\//i.test(command);
}

export const VPN_REFUSAL =
  'From Cora: only the user switches the VPN or changes the network: a switch cuts off what other sessions are doing on the VPN that is up. Ask them with the vpn_request tool (it waits for their answer), and carry on once they have switched it. Never start, stop or script OpenVPN Connect yourself.';

/** Which profile a session means: a profile's name, an environment it reaches, or what its name says (prod, dev…). */
export function matchProfile(asked: string, profiles: VpnProfile[], envs: EnvState[] = []): string | null {
  const a = asked.trim().toLowerCase();
  if (!a) return null;
  const one = (xs: VpnProfile[]) => (xs.length === 1 ? xs[0].id : null);
  const exact = profiles.filter((p) => p.name.toLowerCase() === a || p.id === a);
  if (exact.length) return one(exact);
  // an environment it reached (its label, name or cluster)
  const env = envs.filter((e) => e.label === a || e.name.toLowerCase() === a || e.id.toLowerCase().includes(a));
  const label = guessLabel(a);
  const byEnv = profiles.filter((p) => p.reaches.some((r) => env.some((e) => e.id === r.id) || (label !== 'other' && r.label === label)));
  if (byEnv.length) return one(byEnv);
  // what its name says (Insight Production: prod)
  if (label !== 'other') {
    const byName = profiles.filter((p) => guessLabel(p.name) === label);
    if (byName.length) return one(byName);
  }
  return one(profiles.filter((p) => p.name.toLowerCase().includes(a) || a.includes(p.name.toLowerCase())));
}

export type VpnOutcome = { kind: 'already' | 'switched' | 'declined' | 'waiting' | 'unavailable'; text: string };

type Saved = { on?: boolean; reaches?: Record<string, string[]>; /** reachable with no VPN connected */ baseline?: string[] };
type Held = { req: VpnRequest; waiter: ((o: VpnOutcome) => void) | null };

export type VpnDeps = {
  /** OpenVPN Connect here (null: not installed) */
  ovpn: { exe: string; config: string; log: string } | null;
  /** start it with these arguments (it hands them to the running app) */
  run?: (exe: string, args: string[]) => void;
  envs(): EnvState[];
  /** check the environments again, now */
  recheck(): Promise<EnvState[]>;
  /** Cora's own: whether the control is on, and what each profile reached */
  file?: string;
  onChange(s: VpnState): void;
  /** a session's request was answered after its call stopped waiting: tell it */
  tell?(sessionId: string, text: string): void;
  /** a session asks: let the user know */
  onRequest?(r: VpnRequest, profile: string | null): void;
  /** OpenVPN Connect's window (it shows itself for a shortcut): put away again after a switch from Cora */
  window?: OvpnWindow;
  now?: () => number;
  /** how often its files are looked at; how long a request's call waits; how long a switch may take */
  pollMs?: number;
  waitMs?: number;
  switchMs?: number;
};

/** Start OpenVPN Connect with arguments, detached, without Electron's or Node's settings (it is an Electron app). */
export function runDetached(exe: string, args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(k)));
  spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
}

/**
 * OpenVPN Connect's window. A shortcut (how Cora switches) makes it show itself, minimizing only after (its "Shortcut
 * Minimize" setting): a window popping up on every switch. Closing it only puts it in the tray (its close handler
 * hides it and never quits, so the VPN stays up), and starting it with no arguments shows it again.
 */
export type OvpnWindow = {
  /** whether it's on screen now */
  visible(): Promise<boolean>;
  /** close it to the tray whenever it shows, for a while (0: once, now) */
  putAway(seconds: number): { stop(): void };
  /** bring it back (it needs you: a sign-in) */
  show(): void;
};

const ps = (script: string) => ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const PS_EXE = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** its process's main window, only while it's on screen (.NET's MainWindowHandle is 0 for a hidden window) */
const PS_SHOWN = "Get-Process OpenVPNConnect -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }";

/** Windows: PowerShell looks for its window and sends it WM_CLOSE (what its own close button does). */
export function ovpnWindow(exe: string): OvpnWindow {
  return {
    visible: () =>
      new Promise((res) => {
        execFile(PS_EXE(), ps(`if (${PS_SHOWN}) { 'yes' } else { 'no' }`), { windowsHide: true, timeout: 8000 }, (err, out) => res(!err && String(out).trim() === 'yes'));
      }),
    putAway: (seconds) => {
      const script = [
        "Add-Type -Name W -Namespace CoraOvpn -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'",
        `$end = (Get-Date).AddSeconds(${Math.max(0, Math.round(seconds))})`,
        `do { ${PS_SHOWN} | ForEach-Object { [void][CoraOvpn.W]::PostMessage($_.MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $end)`,
      ].join('\n');
      const p = spawn(PS_EXE(), ps(script), { windowsHide: true, stdio: 'ignore' });
      p.on('error', () => {});
      return { stop: () => void p.kill() };
    },
    show: () => runDetached(exe, []),
  };
}

export const REQUEST_WAIT_MS = 10 * 60_000;
const SWITCH_MS = 90_000;
const DISCONNECT_MS = 20_000;
const LOG_TAIL = 16_384;

export class Vpn {
  private read: OvpnRead = { profiles: [], connected: null, authPending: false };
  private phase: VpnPhase = 'disconnected';
  private saved: Saved = {};
  private held = new Map<string, Held>();
  private switching: VpnState['switching'];
  private error: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private seen = '';
  private last = '';
  /** when no profile was connected since (what's reachable then is the baseline) */
  private offSince = 0;

  constructor(private d: VpnDeps) {
    try {
      if (d.file && existsSync(d.file)) this.saved = JSON.parse(readFileSync(d.file, 'utf8')) as Saved;
    } catch {
      /* start afresh */
    }
    this.refresh();
  }

  private now = () => this.d.now?.() ?? Date.now();
  get available(): boolean {
    return !!this.d.ovpn;
  }
  get on(): boolean {
    return this.available && this.saved.on !== false;
  }

  /** Read OpenVPN Connect's state again (and learn what the connected profile reaches). */
  refresh(): void {
    const o = this.d.ovpn;
    if (!o) return;
    try {
      const r = readOvpnConfig(readFileSync(o.config, 'utf8'));
      if (r && !r.connected && (this.read.connected || !this.offSince)) this.offSince = this.now();
      if (r) this.read = r;
    } catch {
      /* keep the last */
    }
    const logged = tail(o.log, LOG_TAIL);
    const p = logged ? lastPhase(logged) : null;
    this.phase = this.read.authPending ? 'waiting' : this.read.connected ? (p && p !== 'disconnected' ? p : 'connected') : p === 'connected' ? 'connecting' : (p ?? 'disconnected');
    this.learn();
    this.settle();
  }

  /**
   * The environments were checked: what the connected profile reaches now, less what's reachable with no VPN at all
   * (another way in, like Tailscale: it isn't the profile's).
   */
  learn(states = this.d.envs()): void {
    const id = this.read.connected;
    if (this.switching || (id ? this.phase !== 'connected' : this.phase === 'connecting' || this.phase === 'waiting')) return;
    // only checks made after it connected or disconnected (a check from before says what the last VPN reached)
    const since = (id ? (this.read.connectedAt ?? this.now()) : this.offSince) + 3000;
    const on = states.filter((s) => s.on);
    if (!on.length || on.some((s) => (s.checkedAt ?? 0) < since)) return;
    const up = on.filter((s) => s.reachable).map((s) => s.id).sort();
    if (!id) {
      if ((this.saved.baseline ?? []).join() === up.join()) return;
      this.saved = { ...this.saved, baseline: up };
      return this.save();
    }
    const mine = up.filter((e) => !(this.saved.baseline ?? []).includes(e));
    if (!mine.length || (this.saved.reaches?.[id] ?? []).join() === mine.join()) return;
    this.saved = { ...this.saved, reaches: { ...this.saved.reaches, [id]: mine } };
    this.save();
  }

  state(): VpnState {
    if (!this.d.ovpn) return EMPTY_VPN;
    const envs = this.d.envs();
    const reach = (id: string): VpnReach[] =>
      (this.saved.reaches?.[id] ?? []).map((e) => envs.find((x) => x.id === e)).filter((e): e is EnvState => !!e).map((e) => ({ id: e.id, name: e.name, label: e.label }));
    return {
      available: true,
      on: this.on,
      profiles: this.read.profiles.map((p) => ({ ...p, reaches: reach(p.id) })),
      connected: this.read.connected,
      ...(this.read.connectedAt ? { connectedAt: this.read.connectedAt } : {}),
      phase: this.phase,
      ...(this.switching ? { switching: this.switching } : {}),
      ...(this.error ? { error: this.error } : {}),
      requests: [...this.held.values()].map((h) => h.req),
    };
  }

  private changed(): void {
    const s = this.state();
    const j = JSON.stringify(s);
    if (j === this.last) return;
    this.last = j;
    this.d.onChange(s);
  }

  /** Look at OpenVPN Connect's files every couple of seconds; read them again when they changed. */
  start(): void {
    this.stop();
    if (!this.d.ovpn) return;
    this.timer = setInterval(() => this.poll(), this.d.pollMs ?? 2000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  poll(): void {
    const o = this.d.ovpn;
    if (!o) return;
    const sig = [o.config, o.log].map((f) => stamp(f)).join('|');
    if (sig !== this.seen) {
      this.seen = sig;
      this.refresh();
    }
    this.changed();
  }

  setOn(on: boolean): void {
    this.saved = { ...this.saved, on };
    this.save();
    if (!on) for (const id of [...this.held.keys()]) this.finish(id, { kind: 'unavailable', text: "The user turned Cora's VPN control off. Ask them in your reply if you still need another VPN." });
    this.changed();
  }

  /**
   * The USER switches (from Cora's VPN control or a request's card): to a profile, or off (null). Returns at once;
   * the switch goes on, seen in the state. Never called for a session.
   */
  switchTo(to: string | null): { ok: true } | { ok: false; error: string } {
    const o = this.d.ovpn;
    if (!o) return { ok: false, error: "OpenVPN Connect isn't installed here" };
    if (!this.on) return { ok: false, error: "Cora's VPN control is off" };
    if (this.switching) return { ok: false, error: 'a switch is already under way' };
    if (to !== null && !this.read.profiles.some((p) => p.id === to)) return { ok: false, error: 'no such profile' };
    this.switching = { to, at: this.now() };
    this.error = undefined;
    this.changed();
    void this.doSwitch(o.exe, to)
      .catch((e: Error) => (this.error = e.message))
      .finally(() => {
        this.switching = undefined;
        this.refresh();
        this.changed();
      });
    return { ok: true };
  }

  private async doSwitch(exe: string, to: string | null): Promise<void> {
    const run = this.d.run ?? runDetached;
    const name = (id: string | null) => this.read.profiles.find((p) => p.id === id)?.name ?? 'it';
    // its window shows itself for a shortcut: when it wasn't open before, it goes back to the tray. At once when
    // nothing will be asked of you (a disconnect, a profile that signs in by itself); a profile that asks for its
    // password, once it's connected; one waiting for you (a sign-in page) is brought back and left open
    const win = this.d.window;
    const wasOpen = win ? await win.visible().catch(() => true) : true;
    // the watcher putting it away (held in an object: closures set it)
    const away: { now: { stop(): void } | null } = { now: null };
    let needsYou = false;
    const putAway = (seconds: number) => {
      if (!win || wasOpen || needsYou) return;
      away.now?.stop();
      away.now = win.putAway(seconds);
    };
    const asked = () => {
      if (this.phase !== 'waiting' || needsYou) return;
      needsYou = true;
      away.now?.stop();
      away.now = null;
      win?.show();
    };
    // (a switch that doesn't happen leaves the window as it is: it may be saying why)
    this.refresh();
    if (this.read.connected && this.read.connected !== to) {
      putAway(15);
      run(exe, ['--disconnect-shortcut']);
      if (!(await this.until(() => !this.read.connected, DISCONNECT_MS))) throw new Error(`OpenVPN Connect didn't disconnect ${name(this.read.connected)} (is it asking you something?)`);
    }
    if (to && !(this.read.connected === to && this.phase === 'connected')) {
      const asksPassword = !!this.read.profiles.find((p) => p.id === to)?.password;
      if (asksPassword) {
        away.now?.stop();
        away.now = null;
      } else putAway(20);
      run(exe, [`--connect-shortcut=${to}`]);
      const ms = this.d.switchMs ?? SWITCH_MS;
      if (!(await this.until(() => this.read.connected === to && this.phase === 'connected', ms, asked)))
        throw new Error(this.phase === 'waiting' ? `${name(to)} is waiting for you in OpenVPN Connect` : this.phase === 'failed' ? `${name(to)} didn't connect: see OpenVPN Connect` : `${name(to)} hadn't connected after ${Math.round(ms / 1000)}s`);
    }
    // done: back in the tray (once, now: its last showing, a password profile's included)
    putAway(0);
    await this.d.recheck().catch(() => this.d.envs());
    this.learn();
  }

  private async until(ok: () => boolean, ms: number, each?: () => void): Promise<boolean> {
    // real time (a switch's own wait), whatever clock stamps the state
    const end = Date.now() + ms;
    for (;;) {
      this.refresh();
      this.changed();
      each?.();
      if (ok()) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, Math.min(1000, this.d.pollMs ?? 1000)));
    }
  }

  // ---------------------------------------------------------------- sessions' requests
  /**
   * A session asks for another VPN. It waits (a while) for the user's answer: switched, or not now. Cora never
   * switches for it: the card's Switch is the user's.
   */
  request(r: { sessionId: string; session: string; asked: string; why: string }): Promise<VpnOutcome> {
    if (!this.available) return Promise.resolve({ kind: 'unavailable', text: "OpenVPN Connect isn't on this PC, so Cora can't show the user a switch. Ask them in your reply." });
    if (!this.on) return Promise.resolve({ kind: 'unavailable', text: "Cora's VPN control is off. Ask the user in your reply to switch the VPN, and wait for them." });
    this.refresh();
    const st = this.state();
    const profileId = matchProfile(r.asked, st.profiles, this.d.envs());
    if (profileId && profileId === st.connected && st.phase === 'connected') return Promise.resolve({ kind: 'already', text: `${this.nameOf(profileId)} is connected already. ${envLine(this.d.envs())}` });
    // a session asks once: its newer request replaces the one before
    for (const [id, h] of this.held) if (h.req.sessionId === r.sessionId) this.finish(id, { kind: 'declined', text: 'Replaced by your newer request.' });
    const req: VpnRequest = { id: randomUUID(), sessionId: r.sessionId, session: r.session, asked: r.asked.slice(0, 80), profileId, why: r.why.slice(0, 400), at: this.now() };
    return new Promise((resolve) => {
      const h: Held = { req, waiter: resolve };
      this.held.set(req.id, h);
      setTimeout(() => {
        if (h.waiter !== resolve) return;
        h.waiter = null;
        resolve({ kind: 'waiting', text: `Still waiting for the user to switch to ${profileId ? this.nameOf(profileId) : r.asked}. Cora will type a message into this session when they answer. Don't switch it yourself; carry on with what doesn't need it, or wait.` });
      }, this.d.waitMs ?? REQUEST_WAIT_MS).unref?.();
      this.changed();
      this.d.onRequest?.(req, profileId ? this.nameOf(profileId) : null);
    });
  }

  /** The user's answer on a request's card: switch (to its profile, or the one they picked), or not now. */
  answer(id: string, a: { switch: boolean; profileId?: string }): { ok: true } | { ok: false; error: string } {
    const h = this.held.get(id);
    if (!h) return { ok: false, error: 'already answered' };
    if (!a.switch) {
      this.finish(id, { kind: 'declined', text: "The user said not now: they won't switch the VPN for this. Carry on without it, or ask them in your reply. Don't switch it yourself." });
      this.changed();
      return { ok: true };
    }
    const to = a.profileId ?? h.req.profileId;
    if (!to) return { ok: false, error: 'pick a profile' };
    h.req = { ...h.req, profileId: to };
    if (this.read.connected === to && this.phase === 'connected') {
      this.settle();
      this.changed();
      return { ok: true };
    }
    return this.switchTo(to);
  }

  /** Requests for the profile that's connected now are answered: it's switched. */
  private settle(): void {
    const id = this.read.connected;
    if (!id || this.phase !== 'connected' || this.switching) return;
    for (const [rid, h] of this.held) if (h.req.profileId === id) this.finish(rid, { kind: 'switched', text: `The user switched the VPN to ${this.nameOf(id)}. ${envLine(this.d.envs())} (Cora checks every 30 s; the environment tool checks again.)` });
  }

  private finish(id: string, o: VpnOutcome): void {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    if (h.waiter) h.waiter(o);
    else this.d.tell?.(h.req.sessionId, `(Cora, about your VPN request:) ${o.text}`);
  }

  /** A session ended: its request goes. */
  forget(sessionId: string): void {
    for (const [id, h] of this.held) if (h.req.sessionId === sessionId) this.held.delete(id);
    this.changed();
  }

  private nameOf(id: string): string {
    return this.read.profiles.find((p) => p.id === id)?.name ?? id;
  }

  private save(): void {
    try {
      if (this.d.file) writeFileAtomic(this.d.file, JSON.stringify(this.saved, null, 2));
    } catch {
      /* kept for this run */
    }
  }
}

const stamp = (f: string) => {
  try {
    const s = statSync(f);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
};

/** The end of a file (the log is half a megabyte; its latest events are at the end). */
function tail(file: string, bytes: number): string {
  try {
    const size = statSync(file).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}
