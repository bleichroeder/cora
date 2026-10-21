import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  compareTags,
  mostCommon,
  servicesTouched,
  sortTags,
  type BumpTarget,
  type CiHealth,
  type CiStatus,
  type DeployBuild,
  type DeployBump,
  type DeployEnv,
  type DeployEvent,
  type DeploySuggestion,
  type DeploysMsg,
  type DeploysState,
  type EnvHas,
  type Journey,
  type JourneyMr,
  type Workload,
  type WorkloadKind,
} from '@cora/shared';
import { classify, findGlab, json, type Exec } from './ci';
import type { EnvState } from './environments';
import { gitlabHost, registryPrefix } from './gitlabHost';
import { writeFileAtomic } from './fsx';

/**
 * Deploys: what each reachable environment runs, read with
 * `kubectl get` through the environment check's kubeconfig; the projects' newest tags and their pipelines; how far a
 * live session's ticket has got (its MRs, the tags containing them, the environments running those); and the one
 * write: a dev bump the user clicks (`kubectl set image`), refused for anything but a reachable environment labelled
 * dev, then followed until it has rolled out. Nothing is read while no dashboard is open (a rollout being followed
 * aside). An unreachable environment keeps its last listing, saved with the rest in ~/.cora/deploys.json.
 */

export const READ_MS = 3 * 60_000;
export const ROLL_MS = 5_000;
const BUILDS_MS = 10 * 60_000;
const JOURNEY_MS = 2 * 60_000;
const JOURNEY_DONE_MS = 10 * 60_000;
const ROLL_LIMIT_MS = 10 * 60_000;
const PODS_MS = 15_000;
const MAX_GLAB = 3;
const MAX_EVENTS = 50;
const BAD_WAIT = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|InvalidImageName/;

const nodeExec: Exec = (file, args, o) =>
  new Promise((res, rej) => {
    execFile(file, args, { ...o, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) rej(Object.assign(err, { stdout, stderr }));
      else res({ stdout, stderr });
    });
  });

/** kubectl: the user's own (~/bin) first; Rancher Desktop's kuberlr shim on PATH 404s fetching versions. */
export function findKubectl(): string {
  const own = join(homedir(), 'bin', process.platform === 'win32' ? 'kubectl.exe' : 'kubectl');
  return existsSync(own) ? own : 'kubectl';
}

const ts = (s: unknown) => (typeof s === 'string' && s ? Date.parse(s) || undefined : undefined);
const enc = encodeURIComponent;
const wkey = (w: Pick<Workload, 'env' | 'kind' | 'namespace' | 'name' | 'container'>) => `${w.env}|${w.kind}|${w.namespace}|${w.name}|${w.container}`;

/** A cluster's `kubectl get deployments,statefulsets,cronjobs -A -o json` as workloads (GitLab-registry images only). */
export function parseWorkloads(env: string, out: string): Workload[] {
  const items: any[] = json(out)?.items ?? [];
  const list: Workload[] = [];
  for (const it of items) {
    const kind = String(it?.kind ?? '').toLowerCase() as WorkloadKind;
    if (!['deployment', 'statefulset', 'cronjob'].includes(kind)) continue;
    const spec = it.spec ?? {};
    const pod = kind === 'cronjob' ? spec.jobTemplate?.spec?.template?.spec : spec.template?.spec;
    const st = it.status ?? {};
    const desired = kind === 'cronjob' ? undefined : Number(spec.replicas ?? 1);
    const updated = kind === 'cronjob' ? undefined : Number(st.updatedReplicas ?? 0);
    const ready = kind === 'cronjob' ? undefined : Number(st.readyReplicas ?? 0);
    const stale = Number(st.observedGeneration ?? 0) < Number(it.metadata?.generation ?? 0);
    const rolling =
      kind === 'cronjob' || !desired
        ? false
        : stale || updated! < desired || ready! < desired || Number(st.replicas ?? 0) > desired || (kind === 'statefulset' && !!st.updateRevision && st.currentRevision !== st.updateRevision && ready! < desired);
    const since = kind === 'deployment' ? ts((st.conditions ?? []).find((c: any) => c?.type === 'Progressing')?.lastUpdateTime) : undefined;
    for (const c of pod?.containers ?? []) {
      const image = String(c?.image ?? '');
      if (!image.startsWith(registryPrefix())) continue;
      const at = image.lastIndexOf(':');
      if (at < image.lastIndexOf('/')) continue;
      const path = image.slice(0, at);
      const tag = image.slice(at + 1).replace(/@sha256:.*$/, '');
      list.push({ env, kind, namespace: String(it.metadata?.namespace ?? ''), name: String(it.metadata?.name ?? ''), container: String(c.name ?? ''), image: path, tag, project: null, service: path.split('/').pop() ?? path, ...(desired != null ? { desired, ready, updated } : {}), rolling, ...(since ? { since } : {}) });
    }
  }
  return list;
}

/** The project an image path is built from, given the projects known (the longest that prefixes it). */
export function projectFor(path: string, known: Iterable<string>): string | null {
  let best: string | null = null;
  for (const p of known) if ((path === p || path.startsWith(`${p}/`)) && (!best || p.length > best.length)) best = p;
  return best;
}

export type DeploySession = { id: string; ticket?: string | null; repo: { project: string; branch: string; defaultBranch?: string } | null };

export type DeploysDeps = {
  envs(): EnvState[];
  /** live sessions, their ticket and their GitLab repo */
  sessions(): DeploySession[];
  publish(m: DeploysMsg): void;
  hasClients(): boolean;
  /** a bump finished (or failed): one line for Cora */
  onBump?(b: DeployBump, line: string): void;
  exec?: Exec;
  glab?: string;
  kubectl?: string;
  file?: string;
  now?: () => number;
  log?: (m: string) => void;
};

type Saved = {
  listings?: Record<string, { readAt: number; workloads: Workload[] }>;
  projects?: Record<string, string | null>;
  events?: DeployEvent[];
  dismissed?: string[];
  bumps?: DeployBump[];
};

type EnvRun = { due: number; busy?: boolean; error?: string; podsAt?: number };
type JRun = { due: number; busy?: boolean; key: string; project: string; branch: string | null; data?: Journey };

/** kubectl's way to one environment: its kubeconfig and its own context (never just the file's current one: audit S14). */
const kubeArgs = (e: { kubeconfig?: string; context?: string }) => ['--kubeconfig', e.kubeconfig!, ...(e.context ? ['--context', e.context] : [])];

export class Deploys {
  private exec: Exec;
  private now: () => number;
  private kubectl: string;
  private glabPath: string;
  private onPath = true;
  private listings = new Map<string, { readAt: number; workloads: Workload[] }>();
  private runs = new Map<string, EnvRun>();
  private projects = new Map<string, string | null>();
  private resolving = new Set<string>();
  private builds = new Map<string, { due: number; busy?: boolean; list: DeployBuild[] }>();
  private journeys = new Map<string, JRun>();
  private mrCache = new Map<string, JourneyMr>();
  private refsCache = new Map<string, { newest: string; tags: string[] }>();
  private pipeCache = new Map<string, { status: CiStatus | null; url?: string; at: number }>();
  private registry = new Map<string, { at: number; repos: Map<string, number> }>();
  private regTags = new Map<string, { ok: boolean; at: number }>();
  private events: DeployEvent[] = [];
  private bumps: DeployBump[] = [];
  private dismissed = new Set<string>();
  private health: CiHealth = { state: 'ok' };
  private running = 0;
  private timer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private sent = '';

  constructor(private d: DeploysDeps) {
    this.exec = d.exec ?? nodeExec;
    this.now = d.now ?? Date.now;
    this.kubectl = d.kubectl ?? findKubectl();
    this.glabPath = d.glab ?? 'glab';
    try {
      if (d.file && existsSync(d.file)) {
        const s = JSON.parse(readFileSync(d.file, 'utf8')) as Saved;
        for (const [id, l] of Object.entries(s.listings ?? {})) this.listings.set(id, l);
        for (const [p, v] of Object.entries(s.projects ?? {})) this.projects.set(p, v);
        this.events = s.events ?? [];
        this.dismissed = new Set(s.dismissed ?? []);
        // a rollout followed when Cora stopped: its end wasn't seen
        this.bumps = (s.bumps ?? []).map((b) => (b.state === 'rolling' ? { ...b, state: 'failed' as const, error: 'Cora restarted while it was rolling out', doneAt: this.now() } : b));
      }
    } catch {
      /* start afresh */
    }
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.flushTimer);
    if (this.saveTimer) (clearTimeout(this.saveTimer), this.save());
  }

  // ---------------------------------------------------------------------------------------------------------------
  // what the UI and the tool see

  state(): DeploysState {
    const envs: DeployEnv[] = this.d
      .envs()
      .filter((e) => e.on && e.kubeconfig)
      .map((e) => ({ id: e.id, name: e.name, label: e.label, reachable: e.reachable, ...(this.listings.get(e.id) ? { readAt: this.listings.get(e.id)!.readAt } : {}), ...(this.runs.get(e.id)?.error ? { error: this.runs.get(e.id)!.error } : {}) }));
    const ids = new Set(envs.map((e) => e.id));
    const workloads = [...this.listings].filter(([id]) => ids.has(id)).flatMap(([, l]) => l.workloads.map((w) => this.place(w)));
    const live = new Set(this.d.sessions().map((s) => s.id));
    const journeys = [...this.journeys.entries()].filter(([sid, j]) => live.has(sid) && j.data).map(([, j]) => this.scoped(j.data!));
    const st: DeploysState = { envs, workloads, builds: [...this.builds.values()].flatMap((b) => b.list), journeys, suggestions: [], bumps: this.bumps.filter((b) => !this.dismissed.has(b.id)), events: this.events, health: this.health };
    st.suggestions = this.suggestions(st);
    return st;
  }

  /** A live session's GitLab project. */
  projectOf(sid: string): string | undefined {
    return this.d.sessions().find((s) => s.id === sid)?.repo?.project;
  }

  snapshot(): DeploysMsg {
    return { t: 'deploys', ...this.state() };
  }

  /** Forget a card: a suggestion (that ticket and tag) or a finished bump. */
  dismiss(id: string): boolean {
    if (!id || id.length > 300) return false;
    this.dismissed.add(id);
    if (this.dismissed.size > 300) this.dismissed.delete(this.dismissed.values().next().value!);
    this.changed(true);
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the one write

  /**
   * Bump workloads in a dev environment to a tag: only a reachable environment labelled dev, only workloads it just
   * listed there, only a tag the registry has for each image. Followed until rolled out.
   */
  async bump(req: { env: string; tag: string; key?: string; targets: Array<Pick<BumpTarget, 'kind' | 'namespace' | 'name' | 'container'>> }): Promise<{ ok: true; bump: DeployBump } | { ok: false; error: string }> {
    const e = this.d.envs().find((x) => x.id === req.env);
    if (!e) return { ok: false, error: 'no such environment' };
    if (e.label !== 'dev') return { ok: false, error: `Cora only bumps dev; ${e.name} is ${e.label}` };
    if (!e.reachable || !e.kubeconfig) return { ok: false, error: `${e.name} isn't reachable right now (VPN?)` };
    if (!/^[\w][\w.-]{0,127}$/.test(req.tag)) return { ok: false, error: 'not a tag' };
    if (!req.targets?.length || req.targets.length > 40) return { ok: false, error: 'nothing to bump' };
    if (this.bumps.some((b) => b.env === e.id && b.state === 'rolling')) return { ok: false, error: 'a bump is still rolling out there' };
    // the kubeconfig (and context) really reach this environment's cluster, and nothing else (audit S14)
    const reaches = await this.reaches(e);
    if (reaches !== true) return { ok: false, error: reaches };
    const listed = this.listings.get(e.id)?.workloads ?? [];
    const targets: BumpTarget[] = [];
    for (const t of req.targets) {
      const w = listed.find((x) => x.kind === t.kind && x.namespace === t.namespace && x.name === t.name && x.container === t.container);
      if (!w) return { ok: false, error: `${t.namespace}/${t.name} isn't in ${e.name} (as last read)` };
      if (!(await this.tagExists(this.place(w).project, w.image, req.tag))) return { ok: false, error: `${w.service}:${req.tag} isn't in the registry` };
      targets.push({ kind: w.kind, namespace: w.namespace, name: w.name, container: w.container, image: w.image, from: w.tag, on: true });
    }
    const project = this.place(listed.find((x) => x.image === targets[0].image)!).project ?? targets[0].image;
    const b: DeployBump = { id: `bump-${this.now().toString(36)}`, env: e.id, project, tag: req.tag, ...(req.key ? { key: req.key } : {}), targets, state: 'rolling', at: this.now() };
    for (const t of targets) {
      try {
        await this.exec(this.kubectl, [...kubeArgs(e), '-n', t.namespace, 'set', 'image', `${t.kind}/${t.name}`, `${t.container}=${t.image}:${req.tag}`], { timeout: 30_000 });
        this.d.log?.(`deploys: ${e.name} ${t.namespace}/${t.name} ${t.container} ${t.from} → ${req.tag}`);
      } catch (err: any) {
        const msg = String(err?.stderr || err?.message || 'kubectl failed').split(/\r?\n/).find((l: string) => l.trim()) ?? 'kubectl failed';
        b.state = 'failed';
        b.error = `${t.name}: ${msg.slice(0, 200)}`;
        b.doneAt = this.now();
        break;
      }
    }
    this.bumps = [b, ...this.bumps].slice(0, 20);
    const run = this.run(e.id);
    run.due = this.now();
    run.podsAt = this.now() + PODS_MS;
    if (b.state === 'failed') this.d.onBump?.(b, this.bumpLine(b));
    this.changed(true);
    return { ok: true, bump: b };
  }

  // ---------------------------------------------------------------------------------------------------------------

  async tick(): Promise<void> {
    const now = this.now();
    const clients = this.d.hasClients();
    const rolling = new Set(this.bumps.filter((b) => b.state === 'rolling').map((b) => b.env));
    if (!clients && !rolling.size) return;
    for (const e of this.d.envs()) {
      if (!e.on || !e.kubeconfig || e.reachable !== true) continue;
      if (!clients && !rolling.has(e.id)) continue;
      const r = this.run(e.id);
      if (!r.busy && r.due <= now) void this.read(e, rolling.has(e.id));
    }
    if (!clients) return;
    // the sessions' tickets
    const sessions = this.d.sessions();
    const want = new Set<string>();
    for (const s of sessions) {
      if (!s.ticket || !s.repo) continue;
      want.add(s.id);
      const j = this.journeys.get(s.id);
      if (!j || j.key !== s.ticket || j.project !== s.repo.project) this.journeys.set(s.id, { due: now, key: s.ticket, project: s.repo.project, branch: s.repo.branch === s.repo.defaultBranch ? null : s.repo.branch });
      else j.branch = s.repo.branch === s.repo.defaultBranch ? null : s.repo.branch;
    }
    for (const sid of this.journeys.keys()) if (!want.has(sid)) this.journeys.delete(sid);
    // projects worth reading builds for: the ones running somewhere, and the sessions'
    const projects = new Set<string>();
    for (const l of this.listings.values()) for (const w of l.workloads) {
      const p = this.place(w).project;
      if (p) projects.add(p);
    }
    for (const s of sessions) if (s.repo) projects.add(s.repo.project);
    for (const p of projects) if (!this.builds.has(p)) this.builds.set(p, { due: now, list: [] });
    for (const p of this.builds.keys()) if (!projects.has(p)) this.builds.delete(p);
    const due: Array<{ at: number; run: () => Promise<void> }> = [];
    for (const [p, b] of this.builds) if (!b.busy && b.due <= now) due.push({ at: b.due, run: () => this.readBuilds(p) });
    for (const [sid, j] of this.journeys) if (!j.busy && j.due <= now) due.push({ at: j.due, run: () => this.readJourney(sid) });
    due.sort((a, b) => a.at - b.at);
    for (const x of due) {
      if (this.running >= MAX_GLAB) break;
      void x.run();
    }
  }

  private run(id: string): EnvRun {
    let r = this.runs.get(id);
    if (!r) this.runs.set(id, (r = { due: this.now() }));
    return r;
  }

  /** An environment's workloads (and, while a bump rolls out there, whether its pods start). */
  private async read(e: EnvState, rolling: boolean): Promise<void> {
    const r = this.run(e.id);
    r.busy = true;
    try {
      const out = await this.exec(this.kubectl, [...kubeArgs(e), 'get', 'deployments,statefulsets,cronjobs', '-A', '-o', 'json', '--request-timeout=20s'], { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
      const workloads = parseWorkloads(e.id, out.stdout);
      const before = this.listings.get(e.id);
      if (before) this.diff(before.workloads, workloads);
      this.listings.set(e.id, { readAt: this.now(), workloads });
      r.error = undefined;
      this.resolveProjects(workloads);
      if (rolling) await this.follow(e, workloads);
      this.changed(true);
    } catch (err: any) {
      const msg = String(err?.stderr || err?.message || 'kubectl failed').split(/\r?\n/).find((l: string) => l.trim()) ?? 'kubectl failed';
      if (r.error !== msg) (r.error = msg.slice(0, 200)), this.d.log?.(`deploys: ${e.name}: ${r.error}`), this.changed();
    } finally {
      r.busy = false;
      r.due = this.now() + (this.bumps.some((b) => b.env === e.id && b.state === 'rolling') ? ROLL_MS : READ_MS);
    }
  }

  /** Tag changes since the last listing, newest first. */
  private diff(before: Workload[], after: Workload[]): void {
    const was = new Map(before.map((w) => [wkey(w), w]));
    const fresh: DeployEvent[] = [];
    for (const w of after) {
      const o = was.get(wkey(w));
      if (!o || o.tag === w.tag) continue;
      const by = this.bumps.some((b) => b.env === w.env && b.tag === w.tag && this.now() - b.at < ROLL_LIMIT_MS && b.targets.some((t) => t.namespace === w.namespace && t.name === w.name));
      const p = this.place(w);
      fresh.push({ at: this.now(), env: w.env, project: p.project, service: p.service, namespace: w.namespace, name: w.name, from: o.tag, to: w.tag, ...(by ? { by: 'cora' as const } : {}) });
    }
    if (fresh.length) this.events = [...fresh, ...this.events].slice(0, MAX_EVENTS);
  }

  /** Bumps rolling out here: done when every target runs the tag with all replicas updated and ready. */
  private async follow(e: EnvState, workloads: Workload[]): Promise<void> {
    const r = this.run(e.id);
    for (const b of this.bumps.filter((x) => x.env === e.id && x.state === 'rolling')) {
      const ws = b.targets.map((t) => workloads.find((w) => w.kind === t.kind && w.namespace === t.namespace && w.name === t.name && w.container === t.container));
      if (ws.some((w) => w && w.tag !== b.tag && this.now() - b.at > 30_000)) this.finish(b, 'failed', 'its image was changed again since');
      else if (ws.every((w) => w && w.tag === b.tag && !w.rolling)) this.finish(b, 'done');
      else if (this.now() - b.at > ROLL_LIMIT_MS) this.finish(b, 'failed', 'not rolled out after 10 minutes');
      else if (this.now() >= (r.podsAt ?? 0)) {
        r.podsAt = this.now() + PODS_MS;
        const bad = await this.badPods(e, b).catch(() => null);
        if (bad) this.finish(b, 'failed', bad);
      }
    }
  }

  /** A pod of the new image that can't start: why (CrashLoopBackOff, ImagePullBackOff…). */
  private async badPods(e: EnvState, b: DeployBump): Promise<string | null> {
    for (const ns of new Set(b.targets.map((t) => t.namespace))) {
      const out = await this.exec(this.kubectl, [...kubeArgs(e), '-n', ns, 'get', 'pods', '-o', 'json', '--request-timeout=20s'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
      const images = new Set(b.targets.filter((t) => t.namespace === ns).map((t) => `${t.image}:${b.tag}`));
      for (const p of json(out.stdout)?.items ?? []) {
        for (const c of p?.status?.containerStatuses ?? []) {
          const reason = c?.state?.waiting?.reason;
          if (images.has(String(c?.image ?? '')) && reason && BAD_WAIT.test(reason)) return `${p.metadata?.name}: ${reason}`;
        }
      }
    }
    return null;
  }

  private finish(b: DeployBump, state: 'done' | 'failed', error?: string): void {
    b.state = state;
    b.doneAt = this.now();
    if (error) b.error = error;
    this.d.onBump?.(b, this.bumpLine(b));
    this.changed(true);
  }

  private bumpLine(b: DeployBump): string {
    const env = this.d.envs().find((e) => e.id === b.env);
    const what = `${b.project.split('/').pop()} ${b.tag}${b.key ? ` (${b.key})` : ''} on ${env?.label ?? b.env}`;
    const took = b.doneAt ? `${Math.round((b.doneAt - b.at) / 1000)}s` : '';
    return b.state === 'done' ? `[Deploys] ${what} rolled out in ${took}: ${b.targets.map((t) => t.name).join(', ')}.` : `[Deploys] ${what} didn't roll out: ${b.error ?? 'failed'}.`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // projects, builds, journeys (glab, GET only)

  /** A workload with its project and service worked out. */
  private place(w: Workload): Workload {
    const path = w.image.slice(registryPrefix().length);
    const project = projectFor(path, this.known()) ?? (this.projects.has(path) ? this.projects.get(path)! : null);
    if (!project) return { ...w, project: null, service: path.split('/').pop() ?? path };
    return { ...w, project, service: path === project ? (project.split('/').pop() ?? project) : path.slice(project.length + 1) };
  }

  private knownAt = -Infinity;
  private knownSet = new Set<string>();
  /** The projects known: the sessions' repos and the ones GitLab named (worked out again every couple of seconds). */
  private known(): Set<string> {
    if (this.now() - this.knownAt < 2000) return this.knownSet;
    this.knownAt = this.now();
    this.knownSet = new Set<string>([...this.d.sessions().flatMap((s) => (s.repo ? [s.repo.project] : [])), ...[...this.projects.values()].filter((v): v is string => !!v)]);
    return this.knownSet;
  }

  /** Image paths no known project prefixes: ask GitLab which project they're under (the path itself, then up). */
  private resolveProjects(workloads: Workload[]): void {
    for (const w of workloads) {
      const path = w.image.slice(registryPrefix().length);
      if (this.place(w).project || this.projects.has(path) || this.resolving.has(path)) continue;
      this.resolving.add(path);
      void (async () => {
        let found: string | null = null;
        const parts = path.split('/');
        for (let n = parts.length; n >= Math.max(2, parts.length - 2) && !found; n--) {
          const p = parts.slice(0, n).join('/');
          try {
            const r = json(await this.glab(['api', `projects/${enc(p)}`]));
            if (r?.path_with_namespace) found = String(r.path_with_namespace);
          } catch (e) {
            if (classify(e).kind !== 'missing') {
              this.resolving.delete(path);
              return;
            }
          }
        }
        this.projects.set(path, found);
        this.resolving.delete(path);
        this.knownAt = -Infinity;
        this.changed(true);
      })();
    }
  }

  private async readBuilds(project: string): Promise<void> {
    const b = this.builds.get(project);
    if (!b) return;
    b.busy = true;
    try {
      const tags = json(await this.glab(['api', `projects/${enc(project)}/repository/tags?per_page=5&order_by=updated&sort=desc`]));
      const list: DeployBuild[] = [];
      for (const t of Array.isArray(tags) ? tags : []) {
        const tag = String(t?.name ?? '');
        if (!tag) continue;
        const p = await this.tagPipeline(project, tag);
        list.push({ project, tag, at: ts(t?.commit?.created_at) ?? 0, status: p.status, ...(p.url ? { url: p.url } : {}) });
      }
      b.list = list;
      b.due = this.now() + (list.some((x) => x.status && !['success', 'failed', 'canceled', 'skipped'].includes(x.status)) ? 60_000 : BUILDS_MS);
      this.changed();
    } catch (e) {
      this.note(e);
      b.due = this.now() + BUILDS_MS;
    } finally {
      b.busy = false;
    }
  }

  /** A tag's pipeline (a finished one is kept). */
  private async tagPipeline(project: string, tag: string): Promise<{ status: CiStatus | null; url?: string }> {
    const k = `${project}@${tag}`;
    const c = this.pipeCache.get(k);
    const finished = c?.status && ['success', 'failed', 'canceled', 'skipped'].includes(c.status);
    if (c && (finished || this.now() - c.at < 30_000)) return c;
    const list = json(await this.glab(['api', `projects/${enc(project)}/pipelines?ref=${enc(tag)}&per_page=1`]));
    const top = Array.isArray(list) ? list[0] : null;
    const v = { status: (top?.status as CiStatus) ?? null, ...(top?.web_url ? { url: String(top.web_url) } : {}), at: this.now() };
    this.pipeCache.set(k, v);
    if (this.pipeCache.size > 500) this.pipeCache.delete(this.pipeCache.keys().next().value!);
    return v;
  }

  private async readJourney(sid: string): Promise<void> {
    const j = this.journeys.get(sid);
    if (!j) return;
    j.busy = true;
    const { key, project } = j;
    try {
      const p = enc(project);
      const named = new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[^\w-]/g, '')}([^0-9]|$)`, 'i');
      const found = json(await this.glab(['api', `projects/${p}/merge_requests?state=all&search=${enc(key)}&in=title&per_page=20`]));
      const list: any[] = (Array.isArray(found) ? found : []).filter((m) => named.test(String(m?.title ?? '')) || named.test(String(m?.source_branch ?? '')));
      if (j.branch) {
        const own = json(await this.glab(['api', `projects/${p}/merge_requests?state=all&source_branch=${enc(j.branch)}&per_page=5`]));
        for (const m of Array.isArray(own) ? own : []) if (!list.some((x) => x.iid === m.iid)) list.push(m);
      }
      const mrs: JourneyMr[] = [];
      for (const m of list.filter((x) => x?.state !== 'closed').slice(0, 8)) mrs.push(await this.mr(project, m));
      mrs.sort((a, b) => b.iid - a.iid);
      const merged = mrs.filter((m) => m.state === 'merged' && m.sha);
      // the tags containing every merged change
      let tags: string[] = [];
      if (merged.length) {
        const newest = this.builds.get(project)?.list[0]?.tag ?? '';
        const sets: string[][] = [];
        for (const m of merged) sets.push(await this.tagsWith(project, m.sha!, newest));
        tags = sets.reduce((a, s) => a.filter((t) => s.includes(t)));
        tags = sortTags(tags).reverse();
      }
      let built: Journey['built'] = null;
      let ready: string | null = null;
      if (tags.length) {
        const first = await this.tagPipeline(project, tags[0]);
        built = { tag: tags[0], status: first.status, ...(first.url ? { url: first.url } : {}) };
        for (const t of [...tags].reverse().slice(0, 3)) {
          if ((await this.tagPipeline(project, t)).status === 'success') {
            ready = t;
            break;
          }
        }
      }
      j.data = this.scoped({ sessionId: sid, key, project, mrs, tags, built, ready, services: [], shared: [], envs: {}, readAt: this.now() });
      const envs = j.data.envs;
      const prod = this.d.envs().find((e) => e.label === 'prod' && envs[e.id]);
      j.due = this.now() + (prod && envs[prod.id].has === 'yes' ? JOURNEY_DONE_MS : JOURNEY_MS);
      this.changed();
    } catch (e) {
      this.note(e);
      j.due = this.now() + JOURNEY_MS;
    } finally {
      j.busy = false;
    }
  }

  /** An MR with its pipeline and the commit its change landed as (a merged one is kept). */
  private async mr(project: string, m: any): Promise<JourneyMr> {
    const k = `${project}!${m.iid}`;
    const c = this.mrCache.get(k);
    if (c && c.state === 'merged') return c;
    const d = json(await this.glab(['api', `projects/${enc(project)}/merge_requests/${m.iid}`]));
    const hp = d?.head_pipeline;
    const v: JourneyMr = {
      iid: Number(d.iid),
      title: String(d.title ?? ''),
      state: d.state,
      url: String(d.web_url ?? ''),
      ...(d.draft || d.work_in_progress ? { draft: true } : {}),
      mergedAt: ts(d.merged_at) ?? null,
      sha: d.state === 'merged' ? String(d.merge_commit_sha || d.squash_commit_sha || d.sha || '') || null : null,
      pipeline: hp?.status ? { status: hp.status as CiStatus, url: String(hp.web_url ?? '') } : null,
      dirs: await this.changedDirs(project, Number(d.iid)),
    };
    this.mrCache.set(k, v);
    if (this.mrCache.size > 300) this.mrCache.delete(this.mrCache.keys().next().value!);
    return v;
  }

  /** The folders an MR's changed files are in (none when GitLab won't say). */
  private async changedDirs(project: string, iid: number): Promise<string[]> {
    const dirsOf = (paths: string[]) => [...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))].slice(0, 200);
    try {
      const diffs = json(await this.glab(['api', `projects/${enc(project)}/merge_requests/${iid}/diffs?per_page=100`]));
      return dirsOf((Array.isArray(diffs) ? diffs : []).flatMap((x) => [String(x?.new_path ?? ''), String(x?.old_path ?? '')]));
    } catch (e) {
      if (classify(e).kind !== 'missing') return [];
    }
    try {
      const ch = json(await this.glab(['api', `projects/${enc(project)}/merge_requests/${iid}/changes`]));
      return dirsOf((ch?.changes ?? []).flatMap((x: any) => [String(x?.new_path ?? ''), String(x?.old_path ?? '')]));
    } catch {
      return [];
    }
  }

  /** A journey with the services its MRs change (of the ones the project runs) and, per environment, theirs only. */
  private scoped(j: Journey): Journey {
    const all = new Set<string>();
    for (const l of this.listings.values()) for (const w of l.workloads) {
      const p = this.place(w);
      if (p.project === j.project) all.add(p.service);
    }
    const t = servicesTouched(j.mrs.flatMap((m) => m.dirs ?? []), [...all]);
    return { ...j, services: t.services, shared: t.shared, envs: this.envHas(j.project, j.tags, t.services) };
  }

  /** Does kubectl, as Deploys calls it for this environment, reach its cluster? true, or why not. */
  private async reaches(e: { id: string; name: string; kubeconfig?: string; context?: string }): Promise<true | string> {
    try {
      const out = await this.exec(this.kubectl, [...kubeArgs(e), 'config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'], { timeout: 15_000 });
      const host = (() => {
        try {
          return new URL(String(out.stdout).trim()).hostname;
        } catch {
          return '';
        }
      })();
      return host === e.id ? true : `${e.name}'s kubeconfig points at ${host || 'another cluster'}, not ${e.id}: nothing was changed`;
    } catch {
      return `couldn't check where ${e.name}'s kubeconfig points: nothing was changed`;
    }
  }

  /** Tags containing a commit (asked again once the project has a newer tag). */
  private async tagsWith(project: string, sha: string, newest: string): Promise<string[]> {
    const k = `${project}@${sha}`;
    const c = this.refsCache.get(k);
    if (c && c.newest === newest && newest) return c.tags;
    const refs = json(await this.glab(['api', `projects/${enc(project)}/repository/commits/${sha}/refs?type=tag&per_page=100`]));
    const tags = (Array.isArray(refs) ? refs : []).map((r) => String(r?.name ?? '')).filter(Boolean);
    this.refsCache.set(k, { newest, tags });
    return tags;
  }

  /** Per environment the project runs in (only `services`, when given): what it mostly runs and whether that has the change. */
  private envHas(project: string, tags: string[], services: string[] = []): Record<string, EnvHas> {
    const out: Record<string, EnvHas> = {};
    const has = new Set(tags);
    for (const [env, l] of this.listings) {
      const ws = l.workloads.map((w) => this.place(w)).filter((w) => w.project === project && (!services.length || services.includes(w.service)));
      if (!ws.length) continue;
      const runs = mostCommon(ws.map((w) => w.tag));
      const n = ws.filter((w) => has.has(w.tag)).length;
      out[env] = { has: has.has(runs) ? 'yes' : n ? 'part' : 'no', runs, of: ws.length, with: n };
    }
    return out;
  }

  /** Whether the registry has image:tag (a yes is kept; a no is asked again in a couple of minutes). */
  private async tagExists(project: string | null, image: string, tag: string): Promise<boolean> {
    if (!project) return false;
    const k = `${image}:${tag}`;
    const c = this.regTags.get(k);
    if (c && (c.ok || this.now() - c.at < 120_000)) return c.ok;
    let reg = this.registry.get(project);
    if (!reg || this.now() - reg.at > 30 * 60_000) {
      const repos = json(await this.glab(['api', `projects/${enc(project)}/registry/repositories?per_page=100`]));
      reg = { at: this.now(), repos: new Map((Array.isArray(repos) ? repos : []).map((r) => [String(r?.location ?? ''), Number(r?.id)])) };
      this.registry.set(project, reg);
    }
    const rid = reg.repos.get(image);
    let ok = false;
    if (rid) {
      try {
        const t = json(await this.glab(['api', `projects/${enc(project)}/registry/repositories/${rid}/tags/${enc(tag)}`]));
        ok = t?.name === tag;
      } catch (e) {
        if (classify(e).kind !== 'missing') throw e;
      }
    }
    this.regTags.set(k, { ok, at: this.now() });
    return ok;
  }

  /** Cora's next steps: a ticket's change built in a passed tag that dev doesn't run yet. */
  private suggestions(st: DeploysState): DeploySuggestion[] {
    const out: DeploySuggestion[] = [];
    const dev = st.envs.find((e) => e.label === 'dev' && e.reachable);
    if (!dev) return out;
    for (const j of st.journeys) {
      if (!j.ready) continue;
      const id = `${j.key}@${j.ready}`;
      if (this.dismissed.has(id) || out.some((s) => s.id === id)) continue;
      if (j.envs[dev.id]?.has === 'yes') continue;
      if (this.bumps.some((b) => b.env === dev.id && b.tag === j.ready && b.project === j.project && (b.state === 'rolling' || b.state === 'done'))) continue;
      const has = new Set(j.tags);
      const targets: BumpTarget[] = st.workloads
        .filter((w) => w.env === dev.id && w.project === j.project && !has.has(w.tag) && w.kind !== 'cronjob' && (!j.services.length || j.services.includes(w.service)))
        // only the services its MRs change, ticked when older; couldn't tell which: all of the project's, none ticked
        .map((w) => ({ kind: w.kind, namespace: w.namespace, name: w.name, container: w.container, image: w.image, from: w.tag, on: !!j.services.length && (compareTags(w.tag, j.ready!) ?? 1) < 0 }));
      if (!targets.length || (j.services.length && !targets.some((t) => t.on))) continue;
      out.push({ id, key: j.key, sessionId: j.sessionId, project: j.project, tag: j.ready, env: dev.id, targets });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private note(e: unknown): void {
    const g = classify(e);
    if (g.kind === 'missing') return;
    const h: CiHealth = { state: g.kind === 'no-glab' ? 'no-glab' : (g.kind as CiHealth['state']), message: g.message };
    if (h.state !== this.health.state || h.message !== this.health.message) (this.health = h), this.d.log?.(`deploys: ${g.message}`), this.changed();
  }

  private async glab(args: string[]): Promise<string> {
    this.running++;
    try {
      const env = { ...process.env, GLAB_CHECK_UPDATE: 'false', NO_COLOR: '1', GLAB_NO_PROMPT: 'true' };
      const go = (file: string) => this.exec(file, [...args.slice(0, 1), '--hostname', gitlabHost(), ...args.slice(1)], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env, cwd: homedir() });
      let r: { stdout: string };
      try {
        r = await go(this.onPath ? 'glab' : this.glabPath);
      } catch (e: any) {
        if (e?.code !== 'ENOENT' || !this.onPath) throw e;
        this.onPath = false;
        if (this.glabPath === 'glab') this.glabPath = findGlab();
        r = await go(this.glabPath);
      }
      if (this.health.state !== 'ok') (this.health = { state: 'ok' }), this.changed();
      return r.stdout;
    } finally {
      this.running--;
    }
  }

  /** Something changed: tell the dashboards (once, shortly), and save what's worth keeping. */
  private changed(save = false): void {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const m = this.snapshot();
      const text = JSON.stringify(m);
      if (text === this.sent) return;
      this.sent = text;
      this.d.publish(m);
    }, 80);
    if (save) this.saveTimer ??= setTimeout(() => this.save(), 2000);
  }

  private save(): void {
    this.saveTimer = undefined;
    if (!this.d.file) return;
    const s: Saved = { listings: Object.fromEntries(this.listings), projects: Object.fromEntries(this.projects), events: this.events, dismissed: [...this.dismissed], bumps: this.bumps };
    try {
      writeFileAtomic(this.d.file, JSON.stringify(s));
    } catch {
      /* kept for this run */
    }
  }
}
