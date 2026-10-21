import type { CiHealth, CiStatus } from './types';

/**
 * Deploys: what each environment runs (read from its cluster through the environment check's kubeconfig), the
 * projects' newest builds, how far a ticket's change has got, and the one write Cora makes: a dev bump you click.
 *
 */

export type DeployEnvLabel = 'dev' | 'staging' | 'prod' | 'local' | 'other';
export type WorkloadKind = 'deployment' | 'statefulset' | 'cronjob';

/** One container of a workload whose image comes from GitLab's registry. */
export type Workload = {
  /** the environment's id (its cluster's host) */
  env: string;
  kind: WorkloadKind;
  namespace: string;
  name: string;
  container: string;
  /** the image without its tag, e.g. registry.gitlab.com/acme/internal/orion/orion-services/orion-indexer */
  image: string;
  tag: string;
  /** the GitLab project it's built from (null: not worked out yet) */
  project: string | null;
  /** what follows the project in the image's path (the project's own name for an image at its root) */
  service: string;
  desired?: number;
  ready?: number;
  updated?: number;
  rolling: boolean;
  /** when its last rollout finished, as the cluster says (deployments) */
  since?: number;
};

export type DeployEnv = {
  id: string;
  name: string;
  label: DeployEnvLabel;
  /** reachable now (the environment check) */
  reachable: boolean | null;
  /** its last good listing (an unreachable one shows that) */
  readAt?: number;
  error?: string;
};

/** A tag of a project and its pipeline. */
export type DeployBuild = { project: string; tag: string; at: number; status: CiStatus | null; url?: string };

export type JourneyMr = {
  iid: number;
  title: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  url: string;
  draft?: boolean;
  mergedAt?: number | null;
  /** its change on the target branch (merge, squash or head commit) */
  sha?: string | null;
  pipeline?: { status: CiStatus; url: string } | null;
  /** the folders its changed files are in */
  dirs?: string[];
};

export type EnvHas = { has: 'yes' | 'part' | 'no'; runs: string; of: number; with: number };

/** How far a session's ticket has got: its MRs, the tags that contain all of it, and what each environment runs. */
export type Journey = {
  sessionId: string;
  key: string;
  project: string;
  mrs: JourneyMr[];
  /** tags containing every merged MR's change, oldest first */
  tags: string[];
  /** the first of those tags and its pipeline */
  built: { tag: string; status: CiStatus | null; url?: string } | null;
  /** the newest of those tags whose pipeline passed */
  ready: string | null;
  /** the project's services its changes are in (from the MRs' folders); empty: couldn't tell */
  services: string[];
  /** changed folders no service is named after (shared code), tests and docs aside */
  shared: string[];
  /** per environment id where its services run (all the project's when `services` is empty) */
  envs: Record<string, EnvHas>;
  readAt: number;
};

export type BumpTarget = { kind: WorkloadKind; namespace: string; name: string; container: string; image: string; from: string; /** on by default: it's older than the new tag */ on: boolean };

/** Cora offers a dev bump: the ticket's change built in `tag`, dev doesn't run it. */
export type DeploySuggestion = { id: string; key: string; sessionId: string; project: string; tag: string; env: string; targets: BumpTarget[] };

export type DeployBump = {
  id: string;
  env: string;
  project: string;
  tag: string;
  key?: string;
  targets: BumpTarget[];
  state: 'rolling' | 'done' | 'failed';
  at: number;
  doneAt?: number;
  error?: string;
};

/** A tag change seen in an environment (`by`: a bump from Cora). */
export type DeployEvent = { at: number; env: string; project: string | null; service: string; namespace: string; name: string; from: string; to: string; by?: 'cora' };

export type DeploysState = {
  envs: DeployEnv[];
  workloads: Workload[];
  builds: DeployBuild[];
  journeys: Journey[];
  suggestions: DeploySuggestion[];
  bumps: DeployBump[];
  events: DeployEvent[];
  /** GitLab reads (glab) */
  health: CiHealth;
};

export type DeploysMsg = { t: 'deploys' } & DeploysState;

export const EMPTY_DEPLOYS: DeploysState = { envs: [], workloads: [], builds: [], journeys: [], suggestions: [], bumps: [], events: [], health: { state: 'ok' } };

// ---------------------------------------------------------------------------------------------------------------
// versions

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const tokens = (s: string) => s.match(/\d+|[A-Za-z]+/g) ?? [];

/**
 * Two tags as versions: `2.10.0-dev26` > `2.10.0-dev25` > `2.9.1`, a release beats its prereleases (`2.10.0` >
 * `2.10.0-rc3`). Null when either isn't a version (the caller falls back on when they were made).
 */
export function compareTags(a: string, b: string): number | null {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] - +y[i];
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = tokens(x[4]);
  const q = tokens(y[4]);
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d/.test(p[i]);
    const m = /^\d/.test(q[i]);
    if (n && m && +p[i] !== +q[i]) return +p[i] - +q[i];
    if (n !== m) return n ? -1 : 1;
    if (!n && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** Newest first, by version (else by when, else by name). */
export function sortTags(tags: string[], at?: (t: string) => number | undefined): string[] {
  return [...tags].sort((a, b) => {
    const c = compareTags(a, b);
    if (c != null && c !== 0) return -c;
    const d = (at?.(b) ?? 0) - (at?.(a) ?? 0);
    return d || (a < b ? 1 : a > b ? -1 : 0);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// the grid

const LABEL_ORDER: DeployEnvLabel[] = ['dev', 'staging', 'prod', 'other', 'local'];
export const envOrder = (envs: DeployEnv[]) => [...envs].sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label) || a.name.localeCompare(b.name));

export type DeployCell = { tag: string; tags: string[]; workloads: Workload[]; ready: number; desired: number; rolling: boolean; since?: number; behind: boolean };
export type ServiceRow = { key: string; project: string | null; service: string; cells: Record<string, DeployCell>; newest: DeployBuild | null; newestOk: DeployBuild | null; devBehind: boolean };

/** The most common of a list (ties: the newest version). */
export function mostCommon(tags: string[]): string {
  const n = new Map<string, number>();
  for (const t of tags) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || -(compareTags(a[0], b[0]) ?? 0))[0]?.[0] ?? '';
}

/** One row per service (project + image), a cell per environment it runs in; amber where it's behind the one before. */
export function serviceRows(s: Pick<DeploysState, 'envs' | 'workloads' | 'builds'>): ServiceRow[] {
  const envs = envOrder(s.envs);
  const rows = new Map<string, ServiceRow>();
  for (const w of s.workloads) {
    const key = `${w.project ?? w.image}|${w.service}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { key, project: w.project, service: w.service, cells: {}, newest: null, newestOk: null, devBehind: false }));
    const c = (r.cells[w.env] ??= { tag: '', tags: [], workloads: [], ready: 0, desired: 0, rolling: false, behind: false });
    c.workloads.push(w);
  }
  const builds = new Map<string, DeployBuild[]>();
  for (const b of s.builds) builds.set(b.project, [...(builds.get(b.project) ?? []), b]);
  for (const r of rows.values()) {
    let prev: DeployCell | null = null;
    for (const e of envs) {
      const c = r.cells[e.id];
      if (!c) continue;
      c.tags = [...new Set(c.workloads.map((w) => w.tag))];
      c.tag = mostCommon(c.workloads.map((w) => w.tag));
      c.ready = c.workloads.reduce((n, w) => n + (w.ready ?? 0), 0);
      c.desired = c.workloads.reduce((n, w) => n + (w.desired ?? 0), 0);
      c.rolling = c.workloads.some((w) => w.rolling);
      c.since = Math.max(0, ...c.workloads.map((w) => w.since ?? 0)) || undefined;
      c.behind = !!prev && (compareTags(c.tag, prev.tag) ?? 0) < 0;
      prev = c;
    }
    const bs = r.project ? sortTags((builds.get(r.project) ?? []).map((b) => b.tag), (t) => builds.get(r.project!)!.find((b) => b.tag === t)?.at).map((t) => builds.get(r.project!)!.find((b) => b.tag === t)!) : [];
    r.newest = bs[0] ?? null;
    r.newestOk = bs.find((b) => b.status === 'success') ?? null;
    const dev = envs.find((e) => e.label === 'dev' && r.cells[e.id]);
    r.devBehind = !!dev && !!r.newestOk && (compareTags(r.cells[dev.id].tag, r.newestOk.tag) ?? 0) < 0;
  }
  return [...rows.values()].sort((a, b) => (a.project ?? '~').localeCompare(b.project ?? '~') || a.service.localeCompare(b.service));
}

/** The short name of a project path (its last part). */
export const projectName = (p: string | null) => (p ? (p.split('/').pop() ?? p) : 'other');

// ---------------------------------------------------------------------------------------------------------------
// which services a change is in

const NOT_CODE = /^(\.|docs?$|scripts?$|tools?$|nuget|samples?$)|tests?$|\.sample$/i;
const words = (s: string) => (s.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
/** a folder's or image's name, squashed, its prefix off (`Acme.Import.MMS.Web` and `acmeimportmmsweb` → `importmmsweb`) */
const squash = (s: string, prefixes: string[]) => prefixes.reduce((q, p) => q.replace(new RegExp(`^${p.toLowerCase()}`), ''), s.toLowerCase().replace(/[^a-z0-9]/g, ''));

/**
 * The word a project's names start with (`acme` in acme-indexer and Acme.Search.Broadcast): one that leads both an
 * image's name and a changed top folder's. Found per change, never set: matching ignores it, so
 * `Acme.Search.Broadcast` can find `broadcast-search`. (A word only images start with, like `broadcast` in
 * broadcast-search and broadcast-emitter, is part of their names, not a prefix.)
 */
export function sharedPrefixes(services: string[], dirs: string[]): string[] {
  const lead = (s: string) => /^([A-Za-z][A-Za-z0-9]{2,})[-_.]./.exec(s)?.[1]?.toLowerCase();
  const images = new Set(services.map(lead).filter(Boolean));
  const folders = new Set(dirs.map((d) => lead(d.split('/').filter(Boolean)[0] ?? '')).filter(Boolean));
  return [...folders].filter((w): w is string => !!w && images.has(w));
}

/**
 * The services (image names) a change's folders are named after: an exact match first (`AcmeWebAPIProject` →
 * `acmewebapiproject`, `Acme.Indexer` → `acme-indexer`), else the one image whose words include all the folder's
 * (`Acme.Search.Broadcast` → `broadcast-search`). Folders that match none are shared code (tests, docs and the like
 * left out). `prefixes`: the project's common name prefix, ignored (found from the names unless given).
 */
export function servicesTouched(dirs: string[], services: string[], prefixes: string[] = sharedPrefixes(services, dirs)): { services: string[]; shared: string[] } {
  const found = new Set<string>();
  const shared = new Set<string>();
  const sq = services.map((s) => [s, squash(s, prefixes), new Set(words(s.replace(/[-_.]/g, ' ')).flatMap((w) => w.split(/\s+/)))] as const);
  const match = (seg: string): string | null => {
    const q = squash(seg, prefixes);
    if (!q) return null;
    const exact = sq.find(([, x]) => x === q);
    if (exact) return exact[0];
    const lead = prefixes.find((p) => seg.toLowerCase().startsWith(p.toLowerCase()));
    const ws = words(lead ? seg.slice(lead.length).replace(/^(Web)?\.?/, '') : seg).filter((w) => !prefixes.includes(w));
    if (ws.length < 2) return null;
    const subset = sq.filter(([, , set]) => ws.every((w) => set.has(w))).sort((a, b) => a[2].size - b[2].size);
    return subset.length && (subset.length === 1 || subset[0][2].size < subset[1][2].size) ? subset[0][0] : null;
  };
  for (const d of dirs) {
    const segs = d.split('/').filter(Boolean);
    const hit = segs.map(match).find(Boolean);
    if (hit) found.add(hit);
    else if (segs[0] && !segs.some((s) => NOT_CODE.test(s))) shared.add(segs[0]);
  }
  return { services: [...found].sort(), shared: [...shared].sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// a ticket's journey

export type JourneyStepState = 'ok' | 'run' | 'fail' | 'none';
export type JourneyStep = { id: 'mr' | 'pipeline' | 'tag' | DeployEnvLabel; label: string; state: JourneyStepState; detail: string };

const PIPE_STATE = (s: CiStatus | null | undefined): JourneyStepState =>
  !s ? 'none' : s === 'success' ? 'ok' : s === 'failed' || s === 'canceled' ? 'fail' : s === 'skipped' ? 'none' : 'run';

/** The journey's steps, in order: MR, Pipeline, Tag, then each environment the project runs in. */
export function journeySteps(j: Journey, envs: DeployEnv[], now = Date.now()): JourneyStep[] {
  const merged = j.mrs.filter((m) => m.state === 'merged');
  const open = j.mrs.filter((m) => m.state === 'opened');
  const steps: JourneyStep[] = [];
  steps.push({
    id: 'mr',
    label: 'MR',
    state: merged.length && !open.length ? 'ok' : open.length ? 'run' : 'none',
    detail: !j.mrs.length ? 'none yet' : open.length ? `${open.length > 1 ? `${open.length} ` : `!${open[0].iid} `}${open.some((m) => m.draft) ? 'draft' : 'open'}` : `${merged.length > 1 ? `${merged.length} ` : `!${merged[0]?.iid ?? '?'} `}merged${merged[0]?.mergedAt ? ` ${ago(merged[0].mergedAt, now)}` : ''}`,
  });
  // before the merge: the MR's pipeline; after it: the tag's
  const p = open[0]?.pipeline ?? merged[0]?.pipeline;
  steps.push({ id: 'pipeline', label: 'Pipeline', state: PIPE_STATE(p?.status), detail: p ? p.status : 'none' });
  steps.push({
    id: 'tag',
    label: 'Tag',
    state: j.ready ? 'ok' : j.built ? PIPE_STATE(j.built.status) : 'none',
    detail: j.ready ?? j.built?.tag ?? (merged.length ? 'not tagged yet' : 'after the merge'),
  });
  for (const e of envOrder(envs)) {
    const h = j.envs[e.id];
    if (!h || e.label === 'local') continue;
    steps.push({ id: e.label, label: e.label === 'other' ? e.name : cap(e.label), state: h.has === 'yes' ? 'ok' : h.has === 'part' ? 'run' : 'none', detail: h.has === 'yes' ? h.runs : h.has === 'part' ? `${h.with} of ${h.of} · ${h.runs}` : `runs ${h.runs}` });
  }
  return steps;
}

/** The furthest environment that has it (for the chip), else the step it's at. */
export function journeyWhere(j: Journey, envs: DeployEnv[]): string {
  const steps = journeySteps(j, envs);
  const env = [...steps].reverse().find((s) => !['mr', 'pipeline', 'tag'].includes(s.id) && s.state === 'ok');
  if (env) return env.label.toLowerCase();
  const at = steps.find((s) => s.state !== 'ok');
  return at ? at.label.toLowerCase() : 'done';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ---------------------------------------------------------------------------------------------------------------
// the tool's text

/** What's deployed where for a project or a service (all projects when neither), with a ticket's journey. */
export function deploysText(s: DeploysState, o: { project?: string; service?: string; sessionId?: string }, now = Date.now()): string {
  const envs = envOrder(s.envs).filter((e) => e.label !== 'local');
  if (!envs.length) return 'Cora has no environments (it finds clusters in ~/.kube kubeconfig files).';
  const q = (o.service ?? '').toLowerCase();
  const rows = serviceRows(s).filter((r) => (o.project ? r.project === o.project || projectName(r.project) === o.project : true) && (q ? r.service.toLowerCase().includes(q) : true) && r.project);
  const lines: string[] = [];
  lines.push(`Environments: ${envs.map((e) => `${e.label}${e.label === e.name ? '' : ` (${e.name})`} ${e.reachable ? 'reachable now' : e.readAt ? `not reachable, last read ${ago(e.readAt, now)} ago` : 'never read'}`).join('; ')}.`);
  if (!rows.length) lines.push(o.project || q ? `Nothing from ${o.service ?? o.project} runs in these environments (as last read).` : 'No GitLab-built workloads found.');
  for (const [project, rs] of group(rows)) {
    const b = rs[0].newest;
    const ok = rs[0].newestOk;
    lines.push(`\n${project}${b ? ` (newest tag ${b.tag}${b.status ? ` ${b.status}` : ''}${ok && ok.tag !== b.tag ? `; newest passed ${ok.tag}` : ''})` : ''}:`);
    for (const r of rs.slice(0, 60)) {
      const cells = envs.flatMap((e) => {
        const c = r.cells[e.id];
        if (!c) return [];
        const names = c.workloads.map((w) => `${w.kind === 'deployment' ? '' : `${w.kind} `}${w.namespace}/${w.name}${c.tags.length > 1 ? `=${w.tag}` : ''}`);
        return [`${e.label} ${c.tag}${c.rolling ? ' (rolling out)' : ''}${c.desired ? ` ${c.ready}/${c.desired} ready` : ''} [${names.join(', ')}]`];
      });
      lines.push(`- ${r.service}: ${cells.join(' · ')}`);
    }
  }
  const j = o.sessionId ? s.journeys.find((x) => x.sessionId === o.sessionId) : null;
  if (j) lines.push(`\nThis session's ticket ${j.key}${j.services.length ? ` (changes ${j.services.join(', ')}${j.shared.length ? `; shared code: ${j.shared.join(', ')}` : ''})` : ''}: ${journeySteps(j, s.envs, now).map((st) => `${st.label} ${st.detail}${st.state === 'ok' ? ' ✓' : ''}`).join(' → ')}.`);
  const live = s.bumps.filter((b) => b.state === 'rolling');
  for (const b of live) lines.push(`Rolling out now: ${b.project} ${b.tag} on ${s.envs.find((e) => e.id === b.env)?.label ?? b.env}.`);
  return lines.join('\n');
}

function group(rows: ServiceRow[]): Array<[string, ServiceRow[]]> {
  const m = new Map<string, ServiceRow[]>();
  for (const r of rows) m.set(r.project ?? 'other', [...(m.get(r.project ?? 'other') ?? []), r]);
  return [...m];
}
