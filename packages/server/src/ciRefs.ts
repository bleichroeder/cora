// What a session's git setup and commands say about GitLab pipelines. Pure parsing, no I/O (ci.ts does the asking).

import type { CiWhy } from '@cora/shared';
import { gitlabHost } from './gitlabHost';

/** Is this the GitLab pipelines are read from (Settings › Environments › GitLab; glab is signed in to it)? */
const ciHost = (h: string) => h.toLowerCase() === gitlabHost();

/** A git remote URL's host and project path: https (with or without credentials), ssh://, or scp-like git@host:path. */
export function parseRemote(url: string): { host: string; project: string } | null {
  const u = url.trim();
  const m =
    u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i) ??
    u.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const project = m[2].replace(/^\/+/, '');
  if (!project.includes('/')) return null;
  return { host: m[1].toLowerCase(), project };
}

/**
 * The remote a branch's pipelines run on: the one its upstream tracks, else origin, else the first GitLab one.
 * `remotes` maps name → URL. Returns the project on a CI host, or null.
 */
export function pickProject(remotes: Record<string, string>, upstreamRemote?: string | null): string | null {
  const onCi = (name: string) => {
    const r = remotes[name] ? parseRemote(remotes[name]) : null;
    return r && ciHost(r.host) ? r.project : null;
  };
  if (upstreamRemote && remotes[upstreamRemote]) return onCi(upstreamRemote);
  if (remotes.origin) {
    const p = onCi('origin');
    if (p) return p;
  }
  for (const name of Object.keys(remotes)) {
    const p = onCi(name);
    if (p) return p;
  }
  return null;
}

/** `git remote -v` output → name → fetch URL. */
export function parseRemotes(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (m) r[m[1]] = m[2];
  }
  return r;
}

/** An upstream like "origin/feature/x" split into its remote (a known name: names may contain slashes) and branch. */
export function splitUpstream(upstream: string, remoteNames: string[]): { remote: string; branch: string } | null {
  const name = [...remoteNames].sort((a, b) => b.length - a.length).find((n) => upstream.startsWith(`${n}/`));
  return name ? { remote: name, branch: upstream.slice(name.length + 1) } : null;
}

export type UrlRef = { project: string; kind: 'pipeline' | 'job' | 'mr'; id: number };

/** GitLab pipeline, job and merge request links in some text (a new-MR link is not one). */
export function gitlabUrls(text: string): UrlRef[] {
  const out: UrlRef[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/([a-z0-9.-]+)\/([\w.~-]+(?:\/[\w.~-]+)+?)\/-\/(pipelines|jobs|merge_requests)\/(\d+)/gi;
  for (const m of text.matchAll(re)) {
    if (!ciHost(m[1])) continue;
    const kind = m[3] === 'pipelines' ? 'pipeline' : m[3] === 'jobs' ? 'job' : 'mr';
    const k = `${m[2]}|${kind}|${m[4]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ project: m[2], kind, id: Number(m[4]) });
  }
  return out;
}

/** What one command (and its output) says to watch. `project` null: the session's own repo. */
export type CmdRefs = {
  /** the session's current branch may have a new pipeline soon (a push, an MR, `glab ci run`) */
  kick: CiWhy | null;
  /** other branches (or tags) it pushed to or asked about */
  branches: Array<{ project: string | null; ref: string; why: CiWhy }>;
  pipelines: Array<{ project: string | null; id: number; why: CiWhy }>;
  jobs: Array<{ project: string | null; id: number; why: CiWhy }>;
  mrs: Array<{ project: string | null; id: number; why: CiWhy }>;
};

/** Shell words, quotes removed (good enough for the commands Claude runs). */
export function words(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** A command line split into its simple commands (&&, ||, ;, | and new lines). */
const pieces = (cmd: string) => cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);

/** A `-R group/project` (or a project URL) given to glab. */
function repoArg(v: string | undefined): string | null {
  if (!v) return null;
  const url = parseRemote(v);
  if (url) return ciHost(url.host) ? url.project : null;
  return /^[\w.-]+(\/[\w.-]+)+$/.test(v) ? v : null;
}

/** The value after a flag (`-b x`, `--branch x`, `--branch=x`). */
function flag(ws: string[], names: string[]): string | undefined {
  for (let i = 0; i < ws.length; i++) {
    for (const n of names) {
      if (ws[i] === n) return ws[i + 1];
      if (n.startsWith('--') && ws[i].startsWith(`${n}=`)) return ws[i].slice(n.length + 1);
    }
  }
  return undefined;
}

/** git push's flags that take a value. */
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** The refs a `git push` updates (empty: the current branch), or null when it deletes. */
export function pushedRefs(args: string[]): string[] | null {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--delete' || a === '-d' || a === '--mirror') return null;
    if (PUSH_VALUED.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  // `:branch` deletes it (only deletes: nothing to build)
  const specs = pos.slice(1);
  if (specs.length && specs.every((r) => r.startsWith(':'))) return null;
  return specs.filter((r) => !r.startsWith(':')).map((r) => {
    const dst = r.replace(/^\+/, '').split(':').pop() ?? r;
    return dst.replace(/^refs\/(heads|tags)\//, '');
  });
}

/**
 * The branches a command shows the session working on, so their pipelines are its own: one it committed to (git's
 * `[branch abc1234] message` line), pushed (named, or in git's `a..b  x -> y` lines), created (`checkout -b`,
 * `switch -c`, `worktree add -b`), opened an MR from, or ran a pipeline on. `current`: it did one of those on
 * whatever was checked out, which neither the command nor its output names.
 */
export function ownedRefs(command: string, output = ''): { branches: string[]; current: boolean } {
  const r = { branches: [] as string[], current: false };
  for (const piece of pieces(command)) {
    const ws = words(piece);
    const g = ws.indexOf('git');
    if (g >= 0) {
      let i = g + 1;
      while (i < ws.length && ws[i].startsWith('-')) i += ws[i] === '-C' || ws[i] === '-c' ? 2 : 1;
      const [verb, rest] = [ws[i], ws.slice(i + 1)];
      if (verb === 'commit' && !rest.includes('--dry-run')) {
        const m = /^\[(\S+?)(?: \([^)]*\))? [0-9a-f]{7,40}\]/m.exec(output);
        if (m && m[1] !== 'detached') r.branches.push(m[1]);
        else r.current = true;
      } else if (verb === 'push') {
        const refs = pushedRefs(rest);
        if (!refs) continue;
        const named = refs.filter((x) => x && x !== 'HEAD');
        r.branches.push(...named);
        if (named.length < refs.length || !refs.length) {
          const seen = [...output.matchAll(/^\s*[*+!= -]?\s*(?:\[new branch\]|[0-9a-f]{7,}\.{2,3}[0-9a-f]{7,})\s+\S+\s+->\s+(\S+)/gm)].map((m) => m[1]);
          if (seen.length) r.branches.push(...seen);
          else r.current = true;
        }
      } else if (verb === 'checkout' || verb === 'switch') {
        const b = flag(rest, verb === 'checkout' ? ['-b', '-B'] : ['-c', '-C', '--create', '--force-create']);
        if (b) r.branches.push(b);
      } else if (verb === 'worktree' && rest[0] === 'add') {
        const b = flag(rest, ['-b', '-B']);
        if (b) r.branches.push(b);
      }
    }
    const gl = ws.findIndex((w) => /(^|[\\/])glab(\.exe)?$/i.test(w));
    if (gl < 0) continue;
    const [area, verb] = [ws[gl + 1], ws[gl + 2]];
    const rest = ws.slice(gl + 3);
    // someone else's repo (-R) isn't this folder's branch
    if (flag(ws, ['-R', '--repo'])) continue;
    if (area === 'mr' && verb === 'create') {
      const source = flag(rest, ['-s', '--source-branch']);
      if (source) r.branches.push(source);
      else r.current = true;
    } else if ((area === 'ci' || area === 'pipeline') && verb === 'run') {
      const b = flag(rest, ['-b', '--branch']);
      if (b) r.branches.push(b);
      else r.current = true;
    }
  }
  return r;
}

/** `glab mr` verbs that look at (or act on) an MR whose pipeline is then worth following. */
const MR_VERBS = new Set(['view', 'show', 'merge', 'checks', 'approve', 'update', 'rebase', 'diff']);

export function commandRefs(command: string, output = ''): CmdRefs {
  const r: CmdRefs = { kick: null, branches: [], pipelines: [], jobs: [], mrs: [] };
  const kick = (why: CiWhy) => {
    if (!r.kick || why === 'push') r.kick = why;
  };
  for (const piece of pieces(command)) {
    const ws = words(piece);
    // `git -C dir push …` and `git push …`
    const g = ws.indexOf('git');
    if (g >= 0) {
      let i = g + 1;
      while (i < ws.length && ws[i].startsWith('-')) i += ws[i] === '-C' || ws[i] === '-c' ? 2 : 1;
      if (ws[i] === 'push') {
        const refs = pushedRefs(ws.slice(i + 1));
        if (refs) {
          const named = refs.filter((x) => x && x !== 'HEAD');
          if (named.length < refs.length || !refs.length) kick('push');
          for (const ref of named) r.branches.push({ project: null, ref, why: 'push' });
        }
      }
    }
    const gl = ws.findIndex((w) => /(^|[\\/])glab(\.exe)?$/i.test(w));
    if (gl < 0) continue;
    const [area, verb] = [ws[gl + 1], ws[gl + 2]];
    const rest = ws.slice(gl + 3);
    const project = repoArg(flag(ws, ['-R', '--repo']));
    const branch = flag(rest, ['-b', '--branch']);
    const num = rest.find((w) => /^\d+$/.test(w));
    const onBranch = (why: CiWhy) => (branch ? r.branches.push({ project, ref: branch, why }) : project ? undefined : kick(why));
    if (area === 'mr' && verb === 'create') {
      // its -b is the target branch: the source is -s (else the current branch)
      const source = flag(rest, ['-s', '--source-branch']);
      if (source) r.branches.push({ project, ref: source, why: 'push' });
      else if (!project) kick('push');
    } else if (area === 'mr' && verb && MR_VERBS.has(verb)) {
      // looking at, merging or checking an MR: its pipeline (no number: the current branch's MR)
      if (num) r.mrs.push({ project, id: Number(num), why: 'command' });
      else kick('command');
    }
    if (area === 'ci' || area === 'pipeline') {
      const pid = flag(rest, ['-p', '--pipeline-id']);
      if (verb === 'run') onBranch('push');
      else if (verb === 'status' || verb === 'list' || verb === 'ls') onBranch('command');
      else if (verb === 'view') {
        // `glab ci view [branch]`
        const pos = rest.find((w) => !w.startsWith('-'));
        if (pos && !branch) r.branches.push({ project, ref: pos, why: 'command' });
        else onBranch('command');
      } else if (verb === 'get') {
        if (pid && /^\d+$/.test(pid)) r.pipelines.push({ project, id: Number(pid), why: 'command' });
        else onBranch('command');
      } else if (verb === 'trace' || verb === 'retry' || verb === 'cancel') {
        if (num) r.jobs.push({ project, id: Number(num), why: 'command' });
        else onBranch('command');
      }
    }
    if (area === 'api') {
      for (const m of piece.matchAll(/projects\/([^/\s'"?]+)\/(pipelines|jobs|merge_requests)\/(\d+)/g)) {
        const p = decodeURIComponent(m[1]);
        const proj = /^\d+$/.test(p) ? null : p;
        if (!proj || !proj.includes('/')) continue;
        (m[2] === 'pipelines' ? r.pipelines : m[2] === 'jobs' ? r.jobs : r.mrs).push({ project: proj, id: Number(m[3]), why: 'command' });
      }
      // a ref's pipelines: `…/pipelines?ref=<branch or tag>`
      for (const m of piece.matchAll(/projects\/([^/\s'"?]+)\/pipelines\?[^\s'"]*\bref=([^&\s'"]+)/g)) {
        const proj = decodeURIComponent(m[1]);
        if (proj.includes('/')) r.branches.push({ project: proj, ref: decodeURIComponent(m[2]), why: 'command' });
      }
    }
  }
  // links in the command or what it printed (a push prints the MR, `glab ci run` the pipeline)
  for (const u of gitlabUrls(`${command}\n${output}`)) {
    const why: CiWhy = r.kick === 'push' ? 'push' : 'url';
    (u.kind === 'pipeline' ? r.pipelines : u.kind === 'job' ? r.jobs : r.mrs).push({ project: u.project, id: u.id, why });
  }
  return r;
}

/** Tools whose output may name pipelines worth following (a file that merely mentions an old link is not one). */
export const CI_TOOLS = /^(Bash|PowerShell)$|gitlab|^WebFetch$|open_tab|browser_navigate/i;

/** A job's log made readable: GitLab's section markers, the runner's timestamps and colour codes removed. */
export function cleanTrace(text: string): string[] {
  return text
    .replace(/section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?\r?/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\r+$/, '').split('\r').pop()!)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z [0-9a-f]{2}[OE]\+? ?/, '').trimEnd());
}

/** The last `n` non-empty lines of a log. */
export const traceTail = (text: string, n = 60) => cleanTrace(text).filter((l) => l.trim()).slice(-n);
