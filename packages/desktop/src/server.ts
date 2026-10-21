import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { HELLO_PREFIX } from '@cora/shared';

/**
 * Who answers on this port: Cora (it proves it holds Cora's key, which never crosses the wire), something else, or
 * nothing. Nothing is sent with a key until it's Cora (docs/audit-2026-10-20.md S17).
 */
export async function whoIs(port: number, tokenFile?: string): Promise<'cora' | 'other' | 'none'> {
  const n = randomBytes(24).toString('hex');
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${port}/api/hello?n=${n}`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return 'none';
  }
  const key = readToken(tokenFile);
  try {
    const mac = String(((await r.json()) as { mac?: unknown }).mac ?? '');
    const want = createHmac('sha256', key).update(`${HELLO_PREFIX}${n}`).digest('hex');
    return key && r.ok && mac.length === want.length && timingSafeEqual(Buffer.from(mac), Buffer.from(want)) ? 'cora' : 'other';
  } catch {
    return 'other';
  }
}
/** Is Cora (proven) answering on this port? */
export const probe = async (port: number, tokenFile?: string) => (await whoIs(port, tokenFile)) === 'cora';
/** What to tell the user when the port isn't Cora's. */
export const NOT_CORA = (port: number) => `Something else is answering on port ${port} (or an older Cora you started yourself is still running). Close it, then start Cora again.`;

export type ServerHandle = {
  owned: boolean;
  /** stop the server; hosted terminals keep running in the terminal host unless `endTerminals` */
  stop(endTerminals?: boolean): Promise<void>;
};

const readToken = (file?: string) => {
  try {
    return file ? readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
};

/** Live hosted terminals, shells included (0 if the server can't say); `shells` of them are plain shells. */
export async function liveTerminals(port: number, tokenFile: string): Promise<{ live: number; shells?: number; persistent: boolean }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/local/terminals`, { headers: { 'x-cora-token': readToken(tokenFile) }, signal: AbortSignal.timeout(1500) });
    if (r.ok) return (await r.json()) as { live: number; shells?: number; persistent: boolean };
  } catch {
    /* unknown */
  }
  return { live: 0, persistent: true };
}

/** "2 Claude sessions and 1 shell are running in Cora." */
export function runningText(live: number, shells = 0): string {
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
  const claude = live - shells;
  const parts = [claude > 0 ? n(claude, 'Claude session') : '', shells > 0 ? n(shells, 'shell') : ''].filter(Boolean);
  return `${parts.join(' and ')} ${live === 1 ? 'is' : 'are'} running in Cora.`;
}

/**
 * Reuse a running Cora server, or start one with the system Node (not Electron's): the server
 * depends on node:sqlite and a native node-pty build for the regular Node ABI.
 */
/** A startup stage the server reports (see packages/server/src/stages.ts). */
export type StageEvent = { s: string; e: string; done?: number; total?: number; kept?: number; sessions?: number; live?: number; how?: string; key?: string };

export async function ensureServer(o: {
  port: number;
  cliPath: string;
  logFile: string;
  /** how to run it (default: the system's node); installed, Cora.exe as Node */
  run?: { file: string; env: Record<string, string | undefined> };
  /** more arguments for `cli.js start` */
  args?: string[];
  timeoutMs?: number;
  tokenFile?: string;
  /** start without the terminal host (the splash's fallback when the host won't start) */
  noHost?: boolean;
  /** follow the server's startup stages (for the splash): it appends them to this file */
  stageFile?: string;
  onStage?: (e: StageEvent) => void;
}): Promise<ServerHandle> {
  const who = await whoIs(o.port, o.tokenFile);
  if (who === 'cora') return { owned: false, async stop() {} };
  if (who === 'other') throw new Error(NOT_CORA(o.port));
  // past a few megabytes the old log becomes server.log.1 (audit B13)
  try {
    if (existsSync(o.logFile) && statSync(o.logFile).size > 5_000_000) {
      rmSync(`${o.logFile}.1`, { force: true });
      renameSync(o.logFile, `${o.logFile}.1`);
    }
  } catch {
    /* kept as it is */
  }
  const log = openSync(o.logFile, 'a');
  if (o.stageFile) writeFileSync(o.stageFile, '');
  const child = spawn(o.run?.file ?? 'node', [o.cliPath, 'start', '--no-open', '--port', String(o.port), ...(o.noHost ? ['--no-host'] : []), ...(o.args ?? [])], {
    stdio: ['ignore', log, log],
    windowsHide: true,
    // the data folder, never Electron's (where Cora opened from Start runs): a folder a process runs in can't be
    // replaced, and Electron's security patches replace it
    ...(o.tokenFile ? { cwd: dirname(o.tokenFile) } : {}),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...o.run?.env, CORA_STAGE_FILE: o.stageFile, ...(o.tokenFile ? { CORA_HOME: dirname(o.tokenFile) } : {}) },
  });
  let exited: number | null = null;
  let spawnError: Error | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  child.on('error', (e) => (spawnError = e));
  let seen = 0;
  const pump = () => {
    if (!o.stageFile || !o.onStage) return;
    try {
      const lines = readFileSync(o.stageFile, 'utf8').split('\n');
      for (; seen < lines.length - 1; seen++) {
        try {
          o.onStage(JSON.parse(lines[seen]) as StageEvent);
        } catch {
          /* a torn line: skip it */
        }
      }
    } catch {
      /* not written yet */
    }
  };
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    pump();
    // installed, Cora runs its server itself: only a source checkout needs Node on the PATH
    if (spawnError) throw new Error(o.run ? `couldn't start Cora's server (${(spawnError as Error).message}): reinstalling Cora should fix it` : `couldn't run Node (${(spawnError as Error).message}); is Node 22+ on your PATH?`);
    if (exited !== null) throw new Error(`Cora server exited (code ${exited}); see ${o.logFile}`);
    if (await probe(o.port, o.tokenFile)) {
      pump();
      // a few stages land just after it answers (Cora's agent, notes from the CLI): keep following for a moment
      const follow = setInterval(pump, 150);
      setTimeout(() => (clearInterval(follow), pump()), 4000).unref?.();
      return {
        owned: true,
        // Graceful first: the server detaches from (or ends) the terminals it hosts.
        async stop(endTerminals = false) {
          if (exited !== null) return;
          try {
            const r = await fetch(`http://127.0.0.1:${o.port}/api/shutdown`, { method: 'POST', headers: { 'x-cora-token': readToken(o.tokenFile), 'content-type': 'application/json' }, body: JSON.stringify({ endTerminals }), signal: AbortSignal.timeout(4000) });
            if (r.ok) for (let i = 0; i < 40 && exited === null; i++) await new Promise((res) => setTimeout(res, 100));
          } catch {
            /* fall through to kill */
          }
          if (exited === null) child.kill();
        },
      };
    }
    await new Promise((r) => setTimeout(r, o.onStage ? 120 : 300));
  }
  child.kill();
  throw new Error(`Cora server did not start within ${Math.round((o.timeoutMs ?? 30_000) / 1000)} s; see ${o.logFile}`);
}
