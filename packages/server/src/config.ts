import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './fsx';

/** The hook token from a request: the header's current name, or its name before the rename (older hooks, sessions). */
export const hookToken = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const v = req.headers['x-cora-token'] ?? req.headers['x-agent-brain-token'];
  return Array.isArray(v) ? v[0] : v;
};

/** Where the app kept its data before it was called Cora. */
export const LEGACY_HOME = join(homedir(), '.agent-brain');

/**
 * Cora's data folder: $CORA_HOME (or the old $AGENT_BRAIN_HOME), else ~/.cora. The first time, ~/.agent-brain is
 * copied over (same tokens, database, settings and voice key) and left in place; if the copy fails the old folder
 * is used as is.
 */
export function dataHome(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CORA_HOME ?? env.AGENT_BRAIN_HOME;
  if (set) return set;
  const dir = join(home, '.cora');
  const old = join(home, '.agent-brain');
  if (existsSync(dir) || !existsSync(old)) return dir;
  try {
    cpSync(old, dir, { recursive: true });
    if (existsSync(join(dir, 'agent-brain.ico')) && !existsSync(join(dir, 'cora.ico'))) copyFileSync(join(dir, 'agent-brain.ico'), join(dir, 'cora.ico'));
    writeFileSync(join(dir, 'MIGRATED.txt'), `Copied from ${old} on ${new Date().toISOString()} when agent-brain became Cora. The old folder can be deleted once nothing runs from it.\n`);
    return dir;
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leave it */
    }
    return old;
  }
}

/** Data folders a terminal host may still be running from (started before the rename). */
export const legacyDataDirs = (dataDir: string, old = LEGACY_HOME) => (dataDir.toLowerCase() !== old.toLowerCase() && existsSync(old) ? [old] : []);

export type Config = {
  port: number;
  host: '127.0.0.1';
  dataDir: string;
  dbPath: string;
  hookToken: string;
  uiToken: string;
  retentionDays: number;
  /** How long a PermissionRequest/Elicitation is held waiting for the dashboard. */
  holdMs: number;
  projectsDir: string;
  clientDir: string;
  /** The Cora checkout this server runs from (its security check runs `npm audit` there). */
  repoDir: string;
  /** Answer AskUserQuestion via PermissionRequest updatedInput.answers (spike S2, confirmed 2026-10-15). */
  /** a key that shows the dashboard and can't act (Cora's agent's screenshots: docs/audit-2026-10-20.md S2) */
  viewToken: string;
  /** only Cora's own agent has it (in its own MCP config): what unlocks Cora's tools, so no session can pass for it */
  agentToken: string;
  /** the terminal host's key: never written where Claude Code or a session can read it */
  hostToken: string;
  askAnswering: boolean;
  /** Extra allowed Origin for action endpoints (vite dev server). */
  devOrigin?: string;
  /** Transcript history window read at startup. */
  backfillMs: number;
};

/** Is `given` the secret? In constant time (no telling how much of it matched from how long it took: audit S17). */
export function sameSecret(given: unknown, secret: string): boolean {
  if (typeof given !== 'string' || !secret) return false;
  const h = (x: string) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(given), h(secret));
}

function token(file: string): string {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  const t = randomBytes(32).toString('hex');
  writeFileAtomic(file, t + '\n', { mode: 0o600 });
  return t;
}

/**
 * An older Cora printed the dashboard's sign-in link (its key) into server.log, which people open and share: the log
 * loses it, and that key is retired for a new one (once: a log without the current key is left alone). Returns the
 * new key, or null when there was nothing to do. docs/audit-2026-10-20.md S11
 */
export function retireLoggedKey(dataDir: string, key: string): string | null {
  const log = join(dataDir, 'server.log');
  const keyFile = join(dataDir, 'ui-token');
  try {
    if (!key || !existsSync(log) || !existsSync(keyFile) || readFileSync(keyFile, 'utf8').trim() !== key) return null;
    const text = readFileSync(log, 'utf8');
    if (!text.includes(key)) return null;
    writeFileSync(log, text.split(key).join('<a retired key>'));
    const next = randomBytes(32).toString('hex');
    writeFileAtomic(keyFile, next + '\n', { mode: 0o600 });
    return next;
  } catch {
    return null;
  }
}

function defaultClientDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js → ../../client/dist ; src/config.ts → ../../client/dist
  return resolve(here, '..', '..', 'client', 'dist');
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? dataHome();
  mkdirSync(dataDir, { recursive: true });
  const fileCfg = (() => {
    try {
      return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Partial<Config>;
    } catch {
      return {};
    }
  })();
  const merged = { ...fileCfg, ...overrides };
  return {
    port: merged.port ?? 4317,
    host: '127.0.0.1',
    dataDir,
    dbPath: merged.dbPath ?? join(dataDir, 'brain.db'),
    hookToken: merged.hookToken ?? token(join(dataDir, 'token')),
    uiToken: merged.uiToken ?? token(join(dataDir, 'ui-token')),
    viewToken: merged.viewToken ?? token(join(dataDir, 'view-token')),
    agentToken: merged.agentToken ?? token(join(dataDir, 'agent-token')),
    hostToken: merged.hostToken ?? token(join(dataDir, 'host-token')),
    retentionDays: merged.retentionDays ?? 7,
    holdMs: merged.holdMs ?? 120_000,
    projectsDir: merged.projectsDir ?? join(homedir(), '.claude', 'projects'),
    clientDir: merged.clientDir ?? defaultClientDir(),
    repoDir: merged.repoDir ?? resolve(defaultClientDir(), '..', '..', '..'),
    askAnswering: merged.askAnswering ?? true,
    devOrigin: merged.devOrigin,
    backfillMs: merged.backfillMs ?? 24 * 3600_000,
  };
}
