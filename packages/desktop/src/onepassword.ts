import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { opAppPaths, type OpLogin, type OpStatus } from '@cora/shared';

/**
 * 1Password, through its command line (`op`) connected to the 1Password app (which unlocks with Windows Hello). Here,
 * in the desktop app's main process, is the only place a password or a code ever is in Cora: between `op` and the page
 * it's filled into.
 */

/** `op` with these arguments: its output, or it throws (with what it said). */
export type OpRun = (args: string[]) => Promise<string>;

const runOp: OpRun = (args) =>
  new Promise((resolve, reject) =>
    execFile('op', args, { windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).split(/\r?\n/).find((l) => l.trim()) ?? 'op failed')) : resolve(String(stdout)),
    ),
  );

/** 1Password's app, where it installs for one user. */
/** The 1Password app, wherever it's installed (shared: opAppPaths); none: its usual place, for the message. */
export const appPath = (env: NodeJS.ProcessEnv = process.env) => opAppPaths(env).find(isThere) ?? opAppPaths(env)[0];
/** There, links included: Windows' app aliases (WindowsApps) can't be followed (existsSync says no), only seen. */
export function isThere(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `op item list --categories Login --format json`: the logins, without a secret among them. */
export function parseItemList(json: string): OpLogin[] {
  const items = JSON.parse(json) as Array<Record<string, any>>;
  return (Array.isArray(items) ? items : [])
    .filter((i) => typeof i?.id === 'string')
    .map((i) => ({
      id: i.id,
      title: String(i.title ?? ''),
      username: String(i.additional_information ?? ''),
      vault: String(i.vault?.name ?? ''),
      urls: (Array.isArray(i.urls) ? i.urls : []).map((u: any) => String(u?.href ?? '')).filter(Boolean),
    }));
}

/** `op item get <id> --format json --reveal`: the username and password (by their purpose) and the current code. */
export function parseItem(json: string): { username?: string; password?: string; totp?: string } {
  const fields = (JSON.parse(json)?.fields ?? []) as Array<Record<string, any>>;
  const by = (f: (x: Record<string, any>) => boolean) => fields.find(f);
  const username = by((x) => x.purpose === 'USERNAME')?.value;
  const password = by((x) => x.purpose === 'PASSWORD')?.value;
  const totp = by((x) => x.type === 'OTP')?.totp;
  return { ...(typeof username === 'string' && username ? { username } : {}), ...(typeof password === 'string' && password ? { password } : {}), ...(typeof totp === 'string' && totp ? { totp } : {}) };
}

/** The list of logins (titles, usernames, sites: never a secret) is fresh this long; after it, the kept one answers at
 * once while a fresh one is asked for behind it, up to STALE_MS (then it waits for the fresh one). */
const LIST_MS = 60_000;
const STALE_MS = 30 * 60_000;

/** 1Password's command line stays unlocked this long after it was last used (its own default): no Windows Hello then. */
const UNLOCKED_MS = 10 * 60_000;

export class OnePassword {
  private list: { at: number; logins: OpLogin[] } | null = null;
  /** when 1Password last answered with your items (it was unlocked then) */
  private okAt = 0;
  private listing: Promise<OpLogin[]> | null = null;

  constructor(private o: { run?: OpRun; now?: () => number; appPath?: string } = {}) {}

  private run = (args: string[]) =>
    (this.o.run ?? runOp)(args).then((out) => {
      if (args[0] === 'item') this.okAt = this.now();
      return out;
    });
  /** Unlocked a moment ago: asking again won't bring up Windows Hello (so logins may be suggested at a field). */
  unlocked(): boolean {
    return this.okAt > 0 && this.now() - this.okAt < UNLOCKED_MS;
  }
  private now = () => this.o.now?.() ?? Date.now();

  /** The app installed, its command line there, and the two connected (names only are asked for). */
  async status(): Promise<OpStatus> {
    const app = isThere(this.o.appPath ?? appPath());
    const cli = await this.run(['--version']).then(
      () => true,
      () => false,
    );
    if (!cli) return { app, cli, connected: false };
    try {
      const accounts = JSON.parse(await this.run(['account', 'list', '--format', 'json']));
      return { app, cli, connected: Array.isArray(accounts) && accounts.length > 0 };
    } catch (e) {
      return { app, cli, connected: false, error: (e as Error).message };
    }
  }

  /**
   * Your logins (no secrets). Fresh for a minute; then the kept list answers at once while a fresh one is asked for
   * behind it (1Password's command line takes a second or two), up to half an hour.
   */
  async logins(): Promise<OpLogin[]> {
    const age = this.list ? this.now() - this.list.at : Infinity;
    if (age < LIST_MS) return this.list!.logins;
    const fresh = (this.listing ??= this.run(['item', 'list', '--categories', 'Login', '--format', 'json'])
      .then((out) => {
        const logins = parseItemList(out);
        this.list = { at: this.now(), logins };
        return logins;
      })
      .finally(() => (this.listing = null)));
    if (this.list && age < STALE_MS) {
      fresh.catch(() => {});
      return this.list.logins;
    }
    return fresh;
  }

  /** Forget the kept list (Cora locked): the next ask goes to 1Password again. */
  forget(): void {
    this.list = null;
  }

  /** One login's username, password and current code: asked for only when you pick it, never kept. */
  async secrets(id: string): Promise<{ username?: string; password?: string; totp?: string }> {
    if (!/^[a-z0-9]{10,40}$/i.test(id)) throw new Error('not a 1Password item');
    return parseItem(await this.run(['item', 'get', id, '--format', 'json', '--reveal']));
  }
}
