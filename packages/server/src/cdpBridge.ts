import { createHmac } from 'node:crypto';

/**
 * A session's Playwright, in Cora's browser: its Playwright MCP connects here over CDP (ws://…/cdp/<session>?k=…),
 * and the desktop app (the one holding the browser's tabs) plays the browser for it (desktop/src/cdpRelay.ts). This
 * passes the messages between them, each Playwright connection on the desktop's one link by an id of its own.
 */
type Sock = { send(data: string): void; close(code?: number, reason?: string): void; on(ev: 'message', f: (d: Buffer | string) => void): void; on(ev: 'close', f: () => void): void; readyState?: number };

/** desktop → server */
type FromDesktop = { t: 'msg'; c: string; d: string } | { t: 'close'; c: string; reason?: string };

/** The key a session's Playwright connects with: its own (one session's can't reach another's tabs). */
export const cdpKey = (secret: string, sessionId: string) => createHmac('sha256', secret).update(`cdp:${sessionId}`).digest('hex').slice(0, 32);

/** Where a session's Playwright connects (its MCP's --cdp-endpoint). */
export const cdpEndpoint = (port: number, secret: string, sessionId: string) => `ws://127.0.0.1:${port}/cdp/${sessionId}?k=${cdpKey(secret, sessionId)}`;

export class CdpBridge {
  private desktop: Sock | null = null;
  private clients = new Map<string, { sock: Sock; sessionId: string }>();
  private seq = 0;
  onChange?: () => void;

  get available(): boolean {
    return !!this.desktop;
  }

  /** The desktop app's link (one at a time: a new one replaces the old). */
  attachDesktop(sock: Sock): void {
    const was = this.desktop;
    this.desktop = sock;
    if (was) {
      this.dropAll('Cora\'s browser restarted');
      was.close(1000, 'replaced');
    }
    sock.on('message', (raw) => {
      let m: FromDesktop;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const c = this.clients.get(m.c);
      if (!c) return;
      if (m.t === 'msg') c.sock.send(m.d);
      else if (m.t === 'close') {
        this.clients.delete(m.c);
        c.sock.close(1011, (m.reason ?? 'closed').slice(0, 120));
      }
    });
    sock.on('close', () => {
      if (this.desktop !== sock) return;
      this.desktop = null;
      this.dropAll("Cora's desktop app went (it holds the browser)");
      this.onChange?.();
    });
    this.onChange?.();
  }

  /** A session's Playwright connected. */
  attachClient(sock: Sock, sessionId: string): void {
    const desk = this.desktop;
    if (!desk) {
      sock.close(1011, "Cora's browser needs Cora's desktop app running");
      return;
    }
    const c = `c${(++this.seq).toString(36)}`;
    this.clients.set(c, { sock, sessionId });
    desk.send(JSON.stringify({ t: 'open', c, sid: sessionId }));
    sock.on('message', (d) => this.desktop?.send(JSON.stringify({ t: 'msg', c, d: String(d) })));
    sock.on('close', () => {
      if (!this.clients.delete(c)) return;
      this.desktop?.send(JSON.stringify({ t: 'close', c }));
    });
  }

  private dropAll(reason: string) {
    for (const { sock } of this.clients.values()) sock.close(1011, reason);
    this.clients.clear();
  }
}
