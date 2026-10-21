/**
 * Cora's security check: is what it runs on still getting security fixes? Electron (the desktop app and its built-in
 * browser), Node.js (the server), and the npm packages in its repo. Patches to Electron are installed on their own
 * when Cora next starts; anything bigger is shown with a way to have Claude fix it.
 */

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export type ElectronStatus = {
  installed: string;
  /** the newest release of the installed major */
  latestPatch?: string;
  /** the newest release overall */
  latest: string;
  /** Electron patches its newest three majors */
  supportedMajors: number[];
  supported: boolean;
  /** a newer patch, downloaded and waiting to be installed when Cora next starts */
  pending?: string;
  /** a newer patch that wouldn't install (tried at three starts): update.log says why */
  failed?: string;
  error?: string;
};

export type NodeStatus = {
  version: string;
  /** the newest release of this major */
  latestInLine?: string;
  /** a security release of this major came out since this one */
  securityBehind: boolean;
  /** when this major stops getting fixes (YYYY-MM-DD), and whether that's passed */
  endOfLife?: string;
  ended: boolean;
  error?: string;
};

export type NpmFinding = {
  name: string;
  severity: Severity;
  title: string;
  url?: string;
  fix: 'auto' | 'breaking' | 'none';
  direct: boolean;
  /** only in development tools (tests, the build), not in what Cora runs */
  dev?: boolean;
};
export type NpmStatus = { counts: Record<Severity, number>; findings: NpmFinding[]; error?: string };

export type SecurityReport = {
  checkedAt: number;
  /** the Cora checkout the checks are about (where "ask Claude to fix it" starts a session) */
  repo: string;
  electron?: ElectronStatus;
  node?: NodeStatus;
  npm?: NpmStatus;
  checking?: boolean;
};

export type SecurityMsg = { t: 'security'; report: SecurityReport | null };

/** Compare dotted versions ("v22.1.0", "44.7.2"): negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const major = (v: string) => Number.parseInt(v.replace(/^v/, ''), 10);

/** Electron's state from its npm dist-tags (`latest`, `44-x-y`…). */
export function electronStatus(installed: string, tags: Record<string, string>): ElectronStatus {
  const latest = tags.latest ?? installed;
  const L = major(latest);
  const supportedMajors = [L, L - 1, L - 2];
  const m = major(installed);
  const latestPatch = tags[`${m}-x-y`];
  return { installed, latest, supportedMajors, supported: supportedMajors.includes(m), ...(latestPatch ? { latestPatch } : {}) };
}

/** Node's state from nodejs.org's release list and its release schedule. */
export function nodeStatus(version: string, releases: Array<{ version: string; security?: boolean }>, schedule: Record<string, { end?: string }>, now: number): NodeStatus {
  const m = major(version);
  const line = releases.filter((r) => major(r.version) === m).sort((a, b) => compareVersions(b.version, a.version));
  const newer = line.filter((r) => compareVersions(r.version, version) > 0);
  const end = schedule[`v${m}`]?.end;
  return {
    version,
    ...(line[0] ? { latestInLine: line[0].version } : {}),
    securityBehind: newer.some((r) => r.security),
    ...(end ? { endOfLife: end } : {}),
    ended: !!end && Date.parse(end) < now,
  };
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

/** `npm audit --json` (npm 7+) as findings, worst first; with `prod` (the same, --omit=dev), findings only in dev tools are marked. */
export function parseAudit(json: any, prod?: any): NpmStatus {
  const inProd = prod ? new Set(Object.keys(prod?.vulnerabilities ?? {})) : null;
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  const findings: NpmFinding[] = [];
  for (const [name, v] of Object.entries<any>(json?.vulnerabilities ?? {})) {
    const severity = (v.severity ?? 'low') as Severity;
    counts[severity] = (counts[severity] ?? 0) + 1;
    const advisory = (v.via ?? []).find((x: unknown) => typeof x === 'object' && x) as { title?: string; url?: string } | undefined;
    const via = (v.via ?? []).filter((x: unknown) => typeof x === 'string') as string[];
    const fix = v.fixAvailable === true ? 'auto' : v.fixAvailable && typeof v.fixAvailable === 'object' ? (v.fixAvailable.isSemVerMajor ? 'breaking' : 'auto') : 'none';
    findings.push({ name, severity, title: advisory?.title ?? (via.length ? `through ${via.join(', ')}` : 'vulnerable'), ...(advisory?.url ? { url: advisory.url } : {}), fix, direct: !!v.isDirect, ...(inProd && !inProd.has(name) ? { dev: true } : {}) });
  }
  findings.sort((a, b) => Number(!!a.dev) - Number(!!b.dev) || RANK[b.severity] - RANK[a.severity] || Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { counts, findings };
}

/** Findings that matter most: high or critical, in what Cora runs (not only in its dev tools). */
export const urgentFindings = (r: SecurityReport | null) => (r?.npm?.findings ?? []).filter((f) => !f.dev && (f.severity === 'critical' || f.severity === 'high'));

/** How much the report should worry you: 'high' (unsupported, missing security fixes, high/critical packages Cora runs), 'some', or null. */
export function securityLevel(r: SecurityReport | null): 'high' | 'some' | null {
  if (!r) return null;
  const e = r.electron;
  const n = r.node;
  if ((e && !e.supported) || n?.ended || n?.securityBehind || urgentFindings(r).length) return 'high';
  if ((e?.latestPatch && compareVersions(e.latestPatch, e.installed) > 0) || r.npm?.findings.length) return 'some';
  return null;
}
