import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';

/**
 * Go live's public door: a second, guests-only port
 * that Tailscale Funnel puts on the internet while a share is public. It passes on only what a guest's screen uses
 * (Cora's page, the join link, the guest's reads, their stream and terminals, their acts) and never your sign-ins:
 * Cora's own cookies (yours, a paired device's) are taken off every request, so through here no one is you. Your
 * login, pairing, hooks and everything else answer 404. The server checks the guest's key as on any other request.
 */
const YOURS = /^(ab_session|ab_view|cora_device)$/;
/** headers only Tailscale may set on the tailnet (here they'd be anyone's say-so) */
const DROP = /^(tailscale-user-|tailscale-headers-info|x-cora-door$)/i;

export function doorAllows(method: string, url: string): boolean {
  const path = url.split('?')[0];
  if (/^\/(hook|auth|pair|agent-gate)(\/|$)/.test(path)) return false;
  if (path.startsWith('/api/')) {
    if (/^\/api\/(local|ide\/bridge|pair)(\/|$)/.test(path)) return false;
    if (method === 'GET' || method === 'HEAD') return true;
    return method === 'POST' && (path === '/api/live/act' || path === '/api/live/join');
  }
  // the stream and terminals come as upgrades (doorUpgrade); a plain request to them is nothing
  if (path === '/ws' || path.startsWith('/pty/')) return false;
  // Cora's page and its files, and the join link
  return method === 'GET' || method === 'HEAD';
}
const doorUpgrade = (url: string) => {
  const path = url.split('?')[0];
  return path === '/ws' || /^\/pty\/[\w-]+$/.test(path);
};

/** A request's headers as passed on: without your cookies, without Tailscale's names, marked as through the door. */
export function doorHeaders(raw: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i];
    let v = raw[i + 1];
    if (DROP.test(k) || /^x-forwarded-proto$/i.test(k)) continue;
    if (/^cookie$/i.test(k)) {
      v = v
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c && !YOURS.test(c.split('=')[0].trim()))
        .join('; ');
      if (!v) continue;
    }
    out.push([k, v]);
  }
  // Funnel is always HTTPS (the guest's key goes Secure)
  out.push(['x-cora-door', '1'], ['x-forwarded-proto', 'https']);
  return out;
}

export class Door {
  private server: Server | null = null;
  constructor(private o: { target: number; port: number }) {}

  get port(): number {
    return this.o.port;
  }
  get open(): boolean {
    return !!this.server;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const target = this.o.target;
    const s = createServer((req, res) => {
      if (!doorAllows(req.method ?? 'GET', req.url ?? '/')) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not here.');
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of doorHeaders(req.rawHeaders)) headers[k] = k in headers ? ([] as string[]).concat(headers[k], v) : v;
      const up = request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
      req.pipe(up);
    });
    s.on('upgrade', (req: IncomingMessage, sock, head) => {
      if (!doorUpgrade(req.url ?? '')) return void sock.destroy();
      const up = connect(target, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`, ...doorHeaders(req.rawHeaders).map(([k, v]) => `${k}: ${v}`)];
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head?.length) up.write(head);
        sock.pipe(up).pipe(sock);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    });
    await new Promise<void>((ok, fail) => {
      s.once('error', fail);
      s.listen(this.o.port, '127.0.0.1', () => ok());
    });
    this.server = s;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((ok) => s.close(() => ok()));
  }
}
