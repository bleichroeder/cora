import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileAtomic } from './fsx';

/**
 * Which of the user's environments this PC can reach right now (their VPNs: usually one at a time). Found from their
 * kubeconfig files (each cluster's server), checked by a plain request to the cluster's `/ping` every 30 seconds.
 * Read-only: it looks, it never changes the network. Sessions hear about it through Cora's `environment` tool and a
 * line with their next prompt when it changes.
 */

export type EnvLabel = 'dev' | 'staging' | 'prod' | 'local' | 'other';
export const ENV_LABELS: readonly EnvLabel[] = ['dev', 'staging', 'prod', 'local', 'other'];

export type Environment = {
  /** the cluster's host (stable id) */
  id: string;
  name: string;
  label: EnvLabel;
  /** what's checked: the cluster's /ping */
  url: string;
  /** a kubeconfig that reaches it (for kubectl: KUBECONFIG=<it>) */
  kubeconfig?: string;
  context?: string;
  /** checked or not */
  on: boolean;
};

export type EnvState = Environment & { reachable: boolean | null; checkedAt?: number; ms?: number };

/** what the user changed (labels, names, off), kept by id */
type Saved = Record<string, Partial<Pick<Environment, 'label' | 'name' | 'on'>>>;

export const CHECK_MS = 30_000;

/**
 * A sensible label from the cluster's names (the user can change it, and Cora keeps theirs). Prod is guessed before
 * dev, and dev only as a whole word ("prod-devices" is prod): a wrong "dev" is what lets a bump through (audit S14).
 */
export function guessLabel(...names: string[]): EnvLabel {
  const t = names.join(' ').toLowerCase();
  const words = t.split(/[^a-z0-9]+/);
  if (/staging|stage|stg/.test(t)) return 'staging';
  if (/prod|live/.test(t)) return 'prod';
  if (words.some((w) => w === 'dev' || w === 'develop' || w === 'development')) return 'dev';
  if (/localhost|127\.0\.0\.1|rancher-desktop|kind-|docker-desktop/.test(t)) return 'local';
  return 'other';
}

const unq = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
const indent = (l: string) => l.length - l.trimStart().length;

/** A kubeconfig's top-level list (clusters:, contexts:) as its items' lines (the plain YAML kubectl writes). */
function listItems(lines: string[], key: string): Array<{ lines: string[]; at: number }> {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start < 0) return [];
  const out: Array<{ lines: string[]; at: number }> = [];
  let dash = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trimStart().startsWith('#')) continue;
    if (/^\S/.test(l) && !l.startsWith('-')) break;
    const isDash = /^\s*-(\s|$)/.test(l);
    if (isDash && (dash < 0 || indent(l) === dash)) {
      dash = indent(l);
      // "- name: x" → "  name: x": the item's first key at the item's own indent
      out.push({ lines: [l.replace(/-(\s|$)/, ' $1')], at: dash + 2 });
    } else if (out.length) out[out.length - 1].lines.push(l);
  }
  return out;
}
const field = (item: { lines: string[]; at: number }, key: string, anyDepth = false) => {
  for (const l of item.lines) {
    const m = new RegExp(`^\\s*${key}:\\s*(\\S.*)$`).exec(l);
    if (m && (anyDepth || indent(l) === item.at)) return unq(m[1]);
  }
  return undefined;
};

/**
 * The clusters in a kubeconfig's text: each server with the context that uses it (the current one when it does, else
 * the first). A file can hold several clusters; each is reached through its own context, never just the file's
 * current one (which could be another cluster: audit S14).
 */
export function clustersIn(yaml: string): Array<{ server: string; context?: string }> {
  const lines = yaml.split(/\r?\n/);
  const current = /^current-context:\s*(.+)$/m.exec(yaml)?.[1];
  const cur = current ? unq(current) : undefined;
  const clusters = listItems(lines, 'clusters').map((c) => ({ name: field(c, 'name'), server: field(c, 'server', true) }));
  const contexts = listItems(lines, 'contexts').map((c) => ({ name: field(c, 'name'), cluster: field(c, 'cluster', true) }));
  const found = clusters.filter((c): c is { name: string | undefined; server: string } => !!c.server);
  if (!found.length) {
    // not the usual shape: every server, with the current context (as before)
    return [...yaml.matchAll(/^\s*server:\s*["']?([^"'\s]+)["']?/gm)].map((m) => ({ server: m[1], ...(cur ? { context: cur } : {}) }));
  }
  return found.map((c) => {
    const uses = contexts.filter((x) => x.cluster && x.cluster === c.name && x.name);
    const context = uses.find((x) => x.name === cur)?.name ?? uses[0]?.name ?? (found.length === 1 ? cur : undefined);
    return { server: c.server, ...(context ? { context } : {}) };
  });
}

/** Environments from the kubeconfig files in a folder (backups and local clusters left out; one per host). */
export function detect(kubeDir: string): Environment[] {
  if (!existsSync(kubeDir)) return [];
  const out = new Map<string, Environment>();
  const files = readdirSync(kubeDir).filter((f) => !/\.bak|~$|\.lock$/i.test(f) && f !== 'cache' && f !== 'http-cache');
  // named kubeconfigs first (orion-dev.yaml says more than config), then the most recently updated (an old file
  // for the same cluster is usually superseded)
  const mtime = (f: string) => {
    try {
      return statSync(join(kubeDir, f)).mtimeMs;
    } catch {
      return 0;
    }
  };
  for (const f of files.sort((a, b) => Number(a === 'config') - Number(b === 'config') || mtime(b) - mtime(a))) {
    let text: string;
    try {
      text = readFileSync(join(kubeDir, f), 'utf8');
    } catch {
      continue;
    }
    if (!/apiVersion|clusters:/.test(text)) continue;
    for (const c of clustersIn(text)) {
      let u: URL;
      try {
        u = new URL(c.server);
      } catch {
        continue;
      }
      if (/^(localhost|127\.|0\.0\.0\.0|host\.docker\.internal)/.test(u.hostname)) continue;
      if (out.has(u.hostname)) continue;
      const name = basename(f).replace(/\.(ya?ml|conf|config)$/i, '');
      out.set(u.hostname, { id: u.hostname, name: name === 'config' ? u.hostname.split('.')[1] ?? u.hostname : name, label: guessLabel(name, u.hostname), url: `${u.protocol}//${u.host}/ping`, kubeconfig: join(kubeDir, f), context: c.context, on: true });
    }
  }
  return [...out.values()];
}

/** One line for a session: what's reachable now. */
export function envLine(states: EnvState[]): string {
  const on = states.filter((s) => s.on).sort((a, b) => ENV_LABELS.indexOf(a.label) - ENV_LABELS.indexOf(b.label) || a.name.localeCompare(b.name));
  if (!on.length) return 'No environments are configured in Cora.';
  const up = on.filter((s) => s.reachable);
  const down = on.filter((s) => s.reachable === false);
  const name = (s: EnvState) => `${s.label}${s.label === s.name ? '' : ` (${s.name})`}`;
  if (!up.length) return `No environment is reachable right now (${down.map(name).join(', ')} all down): the VPN is probably off.`;
  return `Reachable now: ${up.map(name).join(', ')}.${down.length ? ` Not reachable: ${down.map(name).join(', ')}.` : ''}`;
}

/** What changed, for a session that last heard `before` (null: nothing yet). */
export const signature = (states: EnvState[]) =>
  states
    .filter((s) => s.on && s.reachable)
    .map((s) => s.id)
    .sort()
    .join(',');

type Probe = (url: string) => Promise<boolean>;

/** Reachable: any answer (or a TLS error, which still means we got there); not: timeouts, refused, no such host. */
export const httpProbe: Probe = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return true;
  } catch (e) {
    const c = (e as { cause?: { code?: string } }).cause?.code ?? '';
    return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/.test(c);
  }
};

export class Environments {
  private envs: Environment[] = [];
  private states = new Map<string, EnvState>();
  private timer: NodeJS.Timeout | null = null;
  private saved: Saved = {};
  private checking: Promise<void> | null = null;

  constructor(private o: { kubeDir: string; file?: string; probe?: Probe; onChange?: (states: EnvState[]) => void; now?: () => number }) {
    try {
      if (o.file && existsSync(o.file)) this.saved = JSON.parse(readFileSync(o.file, 'utf8')) as Saved;
    } catch {
      /* start afresh */
    }
    this.refresh();
  }

  private now = () => this.o.now?.() ?? Date.now();

  /** Find the environments again (kubeconfigs change), with the user's changes on top. */
  refresh(): void {
    this.envs = detect(this.o.kubeDir).map((e) => ({ ...e, ...this.saved[e.id] }));
  }

  list(): EnvState[] {
    return this.envs.map((e) => ({ ...e, reachable: null, ...this.states.get(e.id), ...e }));
  }

  /** Check every environment that's on (at most one check at a time). */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    const before = signature(this.list());
    this.checking = (async () => {
      const probe = this.o.probe ?? httpProbe;
      await Promise.all(
        this.envs
          .filter((e) => e.on)
          .map(async (e) => {
            const t0 = this.now();
            const reachable = await probe(e.url).catch(() => false);
            this.states.set(e.id, { ...e, reachable, checkedAt: this.now(), ms: this.now() - t0 });
          }),
      );
    })().finally(() => (this.checking = null));
    return this.checking.then(() => {
      if (signature(this.list()) !== before) this.o.onChange?.(this.list());
    });
  }

  /** What's reachable, checked again when the last check is older than `maxAge`. */
  async current(maxAge = 10_000): Promise<EnvState[]> {
    const oldest = Math.min(...this.list().filter((s) => s.on).map((s) => s.checkedAt ?? 0), this.now());
    if (this.now() - oldest > maxAge) await this.check();
    return this.list();
  }

  start(): void {
    this.stop();
    void this.check();
    this.timer = setInterval(() => {
      this.refresh();
      void this.check();
    }, CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Labels to keep as the user's own, where they haven't set one (an older Cora's guesses, kept once). */
  keepLabels(label: (e: Environment) => EnvLabel | null): void {
    for (const e of this.envs) {
      const l = this.saved[e.id]?.label ? null : label(e);
      if (l && l !== e.label) this.update(e.id, { label: l });
    }
  }

  /** The user's change to one (its label, name, or whether it's checked). */
  update(id: string, p: Partial<Pick<Environment, 'label' | 'name' | 'on'>>): boolean {
    if (!this.envs.some((e) => e.id === id)) return false;
    if (p.label !== undefined && !ENV_LABELS.includes(p.label)) return false;
    if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40)) return false;
    this.saved[id] = { ...this.saved[id], ...p, ...(p.name ? { name: p.name.trim() } : {}) };
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify(this.saved, null, 2));
    } catch {
      /* kept for this run */
    }
    this.refresh();
    void this.check();
    return true;
  }
}
