import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { TerminalMode } from '@cora/shared';

/**
 * The terminal host: a small process that owns the hosted `claude` terminals so they outlive the server.
 * The server talks to it over a local socket (a named pipe on Windows) with newline-delimited JSON.
 *
 * Keep this protocol small and stable: changing the host means restarting it, which ends every hosted session.
 */
export const PROTOCOL_VERSION = 1;

/** What the server needs to rebuild its record of a terminal after reconnecting; the host stores it opaquely. */
export type TermMeta = { sessionId: string; cwd: string; mode: TerminalMode; startedAt: number; /** a shell's kind (its name) */ shell?: string; /** a shell of the Board's */ place?: 'board' };
export type HostTerm = { id: string; meta: TermMeta; alive: boolean; exitCode?: number; buf: string };

export type ClientMsg =
  | { t: 'hello'; token: string; v: number }
  | { t: 'spawn'; id: string; file: string; args: string[]; cwd: string; cols: number; rows: number; env: Record<string, string | undefined>; meta: TermMeta }
  | { t: 'write'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  /** end every terminal and exit (the user quit and chose to end their sessions) */
  | { t: 'shutdown' };

export type HostMsg =
  | { t: 'hello'; v: number; pid: number; terms: HostTerm[] }
  | { t: 'data'; id: string; d: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'error'; msg: string };

/** Where the host listens: a per-user named pipe on Windows, a socket in the data dir elsewhere. */
export function socketPath(dataDir: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\cora-pty-${createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16)}`;
  return join(dataDir, 'pty.sock');
}

/** Where a host started before the rename (agent-brain) listens, for reattaching to its terminals. */
export function legacySocketPath(dataDir: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\agent-brain-pty-${createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16)}`;
  return join(dataDir, 'pty.sock');
}

/** Read newline-delimited JSON from a socket. */
export function onLines(sock: Socket, cb: (msg: any) => void): void {
  let pending = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        cb(JSON.parse(line));
      } catch {
        /* ignore a malformed line */
      }
    }
  });
}

export const sendLine = (sock: Socket, msg: ClientMsg | HostMsg) => {
  if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
};
