import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Where Tailscale's command line is (its Windows install, else on the PATH). */
export function tailscalePath(): string {
  if (process.platform === 'win32') for (const p of ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']) if (existsSync(p)) return p;
  return 'tailscale';
}

export type Run = (args: string[]) => Promise<{ ok: boolean; out: string; err: string }>;
const realRun: Run = (args) =>
  new Promise((done) => execFile(tailscalePath(), args, { timeout: 20_000, windowsHide: true }, (e, out, err) => done({ ok: !e, out: String(out ?? ''), err: String(err ?? e?.message ?? '') })));

/** Cora on your tailnet: whether Tailscale is here, this PC's name there, and whether Cora is served on it. */
/** Funnel's port for Go live's public links (Funnel allows 443, 8443 and 10000; 443 is Cora on your tailnet) */
export const FUNNEL_PORT = 8443;
export type PublicStatus = { can: boolean; on: boolean; url?: string; enableUrl?: string; why?: string };
export type RemoteStatus = { available: boolean; why?: string; on: boolean; url?: string; host?: string };

/**
 * Reaching Cora from your devices: Tailscale serves
 * Cora's port at this PC's tailnet address, HTTPS, your tailnet only. Tailscale is the way in; Cora's own keys (your
 * sign-in, a paired device's) are what let anyone in.
 */
export class Remote {
  private run: Run;
  constructor(private o: { port: number; run?: Run }) {
    this.run = o.run ?? realRun;
  }

  async status(): Promise<RemoteStatus> {
    const st = await this.run(['status', '--json']);
    if (!st.ok) return { available: false, on: false, why: /not found|ENOENT|not recognized/i.test(st.err) ? "Tailscale isn't installed on this PC." : "Tailscale isn't running (or isn't signed in)." };
    let host = '';
    let certs = false;
    try {
      const j = JSON.parse(st.out) as { Self?: { DNSName?: string; Online?: boolean }; CertDomains?: string[] };
      host = (j.Self?.DNSName ?? '').replace(/\.$/, '');
      certs = !!j.CertDomains?.length;
    } catch {
      return { available: false, on: false, why: "Couldn't read Tailscale's status." };
    }
    if (!host) return { available: false, on: false, why: "This PC isn't on a tailnet yet." };
    if (!certs) return { available: false, on: false, host, why: 'Turn on HTTPS certificates in your Tailscale admin (DNS › HTTPS Certificates).' };
    const sv = await this.run(['serve', 'status', '--json']);
    const on = sv.ok && this.servesUs(sv.out);
    return { available: true, on, host, url: `https://${host}` };
  }

  /** Is Tailscale serving HTTPS on 443 to Cora's port? */
  servesUs(json: string): boolean {
    try {
      const j = JSON.parse(json || '{}') as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
      return Object.entries(j.Web ?? {}).some(([k, w]) => k.endsWith(':443') && Object.values(w.Handlers ?? {}).some((h) => new RegExp(`(127\\.0\\.0\\.1|localhost):${this.o.port}/?$`).test(h.Proxy ?? '')));
    } catch {
      return false;
    }
  }

  /**
   * Go live's public link: Tailscale Funnel on 8443 to the guests' door (only while a share is public). `can`: Funnel is
   * allowed for this PC (a one-time switch in your tailnet's policy: `enableUrl` is Tailscale's page for it).
   */
  async publicStatus(doorPort: number): Promise<PublicStatus> {
    const st = await this.run(['status', '--json']);
    if (!st.ok) return { can: false, on: false, why: "Tailscale isn't running on this PC." };
    let host = '';
    let id = '';
    let can = false;
    try {
      const j = JSON.parse(st.out) as { Self?: { DNSName?: string; ID?: string; CapMap?: Record<string, unknown>; Capabilities?: string[] }; CertDomains?: string[] };
      host = (j.Self?.DNSName ?? '').replace(/\.$/, '');
      id = j.Self?.ID ?? '';
      const caps = [...Object.keys(j.Self?.CapMap ?? {}), ...(j.Self?.Capabilities ?? [])];
      can = caps.some((c) => c === 'funnel' || c === 'https://tailscale.com/cap/funnel');
      if (!j.CertDomains?.length) return { can: false, on: false, why: 'Turn on HTTPS certificates in your Tailscale admin (DNS › HTTPS Certificates).' };
    } catch {
      return { can: false, on: false, why: "Couldn't read Tailscale's status." };
    }
    if (!host) return { can: false, on: false, why: "This PC isn't on a tailnet yet." };
    const url = `https://${host}:${FUNNEL_PORT}`;
    const enableUrl = id ? `https://login.tailscale.com/f/funnel?node=${encodeURIComponent(id)}` : 'https://login.tailscale.com/admin/acls/visual/node-attributes';
    const fs = await this.run(['funnel', 'status', '--json']);
    return { can, on: fs.ok && this.funnels(fs.out, doorPort, host), url, ...(can ? {} : { enableUrl }) };
  }

  /** Is Funnel putting the guests' door on the internet? */
  funnels(json: string, doorPort: number, host: string): boolean {
    try {
      const j = JSON.parse(json || '{}') as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
      const key = `${host}:${FUNNEL_PORT}`;
      return !!j.AllowFunnel?.[key] && Object.values(j.Web?.[key]?.Handlers ?? {}).some((h) => new RegExp(`(127\\.0\\.0\\.1|localhost):${doorPort}/?$`).test(h.Proxy ?? ''));
    } catch {
      return false;
    }
  }

  /** The guests' door on the internet, or off it. A Funnel this tailnet doesn't allow yet: Tailscale's page to allow it. */
  async funnel(on: boolean, doorPort: number): Promise<PublicStatus & { error?: string }> {
    const r = on ? await this.run(['funnel', '--bg', `--https=${FUNNEL_PORT}`, `http://127.0.0.1:${doorPort}`]) : await this.run(['funnel', `--https=${FUNNEL_PORT}`, 'off']);
    const st = await this.publicStatus(doorPort);
    const said = `${r.out}\n${r.err}`;
    const ask = said.match(/https:\/\/login\.tailscale\.com\/f\/funnel\S*/)?.[0];
    if (on && !st.on) return { ...st, can: false, ...(ask ? { enableUrl: ask } : {}), error: ask ? 'Funnel needs turning on for this PC (once).' : said.trim().split('\n').slice(-2).join(' ') || 'Tailscale said no' };
    return st;
  }

  async turn(on: boolean): Promise<RemoteStatus & { error?: string }> {
    const r = on ? await this.run(['serve', '--bg', '--https=443', `http://127.0.0.1:${this.o.port}`]) : await this.run(['serve', '--https=443', 'off']);
    const st = await this.status();
    if (!r.ok && st.on !== on) return { ...st, error: (r.err || r.out).trim().split('\n').slice(-2).join(' ') || 'Tailscale said no' };
    return st;
  }
}
