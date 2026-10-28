import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { jwtExpiry, mask, secretNameProblem, type SecretInfo, type SecretScope } from '@cora/shared';
import { readSecret, writeSecret } from './secrets';
import { cleanEnv } from './pty';

type Stored = SecretInfo & { value: string };

/**
 * Cora Secrets' store: one sealed file (Windows' own encryption, as Cora's keys), values never leaving the server
 * except when you reveal one. Which sessions you let use which secret is kept while Cora runs (a session asks again
 * after a restart).
 */
export class Vault {
  private grants = new Set<string>();
  constructor(private o: { file: string; onChange?: (list: SecretInfo[]) => void; now?: () => number }) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
  private load(): Stored[] {
    if (!existsSync(this.o.file)) return [];
    try {
      const j = JSON.parse(readSecret(this.o.file)) as { secrets?: Stored[] };
      return Array.isArray(j.secrets) ? j.secrets : [];
    } catch {
      return [];
    }
  }
  private save(list: Stored[]): void {
    writeSecret(this.o.file, JSON.stringify({ secrets: list }));
    this.o.onChange?.(this.list());
  }

  list(): SecretInfo[] {
    return this.load()
      .map(({ value: _v, ...info }) => info)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /** A value: for running a command, or for you to reveal. */
  value(name: string): string | null {
    return this.load().find((s) => s.name === name)?.value ?? null;
  }

  /** Add one, or change one (its value replaced only when a new one is given). */
  set(o: { name: string; value?: string; note?: string; scope?: SecretScope }): SecretInfo {
    const bad = secretNameProblem(o.name);
    if (bad) throw new Error(bad);
    const list = this.load();
    const was = list.find((s) => s.name === o.name);
    const value = o.value?.trim();
    if (!was && !value) throw new Error('a value');
    if (value !== undefined && !value) throw new Error('a value');
    const t = this.now();
    const next: Stored = {
      name: o.name,
      note: (o.note ?? was?.note ?? '').trim().slice(0, 300),
      scope: o.scope ?? was?.scope ?? { all: true },
      createdAt: was?.createdAt ?? t,
      updatedAt: t,
      value: value ?? was!.value,
      expiresAt: value ? jwtExpiry(value) : (was?.expiresAt ?? null),
      lastUsed: was?.lastUsed ?? null,
    };
    // a new value: sessions ask again before they use it
    if (value && was) for (const g of [...this.grants]) if (g.endsWith(`|${o.name}`)) this.grants.delete(g);
    this.save([...list.filter((s) => s.name !== o.name), next]);
    const { value: _v, ...info } = next;
    return info;
  }

  remove(name: string): boolean {
    const list = this.load();
    if (!list.some((s) => s.name === name)) return false;
    this.save(list.filter((s) => s.name !== name));
    return true;
  }

  granted(sessionId: string, name: string): boolean {
    return this.grants.has(`${sessionId}|${name}`);
  }
  grant(sessionId: string, name: string): void {
    this.grants.add(`${sessionId}|${name}`);
  }

  /** It was used (shown in Settings: when, and by which session). */
  used(names: string[], sessionId: string, session: string): void {
    const list = this.load();
    const at = this.now();
    for (const s of list) if (names.includes(s.name)) s.lastUsed = { at, sessionId, session };
    this.save(list);
  }
}

/** Where bash is (Git's, on Windows), for running a session's command the way its own shell would. */
export function bashPath(): string {
  if (process.platform !== 'win32') return '/bin/bash';
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
  return 'bash';
}

const OUT_MAX = 30_000;

/**
 * Run a session's command in its folder with secrets in its environment: its output (stdout and stderr as they came)
 * with every secret masked, capped; ended when it runs too long.
 */
export function runWithSecrets(o: { command: string; cwd: string; secrets: Record<string, string>; timeoutMs: number; bash?: string }): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((done) => {
    const values = Object.values(o.secrets);
    let out = '';
    let cut = false;
    const take = (b: Buffer) => {
      if (out.length >= OUT_MAX) return void (cut = true);
      out += b.toString('utf8');
    };
    // Cora's own key stays out, and no colour codes in what the session reads
    const { CORA_TOKEN: _t, FORCE_COLOR: _c, ...env } = cleanEnv(process.env);
    const p = spawn(o.bash ?? bashPath(), ['-c', o.command], { cwd: o.cwd, env: { ...env, NO_COLOR: '1', ...o.secrets }, windowsHide: true });
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, o.timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(t);
      let text = out.length > OUT_MAX ? out.slice(0, OUT_MAX) : out;
      if (cut || out.length > OUT_MAX) text += `\n… (output cut at ${OUT_MAX / 1000} KB)`;
      done({ code, out: mask(text, values), timedOut });
    };
    p.on('error', (e) => ((out += `\n${e.message}`), finish(null)));
    p.on('close', (code) => finish(code));
  });
}
