/**
 * The builder's checks: validateTeam's
 * problems are errors (Apply is off); lintTeam's are warnings (Apply stays on). Each names what it is about, so a click
 * selects it.
 */
import { endpointName, endpointsOf, fullPath, RISKY_MODES, SEAT_MESSAGING_TOOLS, seatsOf, validateTeam, type Endpoint, type Seat, type Team } from './teams';
import { groupById, idOf, listWords, routeName, seatById } from './teamHelpers';

export type LintTarget = { kind: 'seat' | 'group' | 'route'; id: string } | { kind: 'team' };
export type LintItem = { level: 'error' | 'warn'; text: string; target?: LintTarget };
/** What the checks can't know from the team alone: this PC's folders (there, git repositories), how its seats have been running. */
export type LintCtx = { folderExists?: (path: string) => boolean; gitRepo?: (path: string) => boolean; usuallyIdle?: (seatId: string) => boolean; /** a file (a seat's monitor reads it) is on this PC */ fileExists?: (path: string) => boolean };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const seatsAt = (t: Team, e: Endpoint): string[] => (e.startsWith('seat:') ? [idOf(e)] : e.startsWith('group:') ? seatsOf(t, idOf(e)) : []);

/** A check that couldn't run (a half-made draft, or this PC couldn't answer): said, in place of the warnings. */
const LINT_OFF = "Some checks couldn't run on this draft as it is.";

/** The warnings, in the order the team reads: seats, groups, routes. Never throws (a check that can't run: LINT_OFF). */
export function lintTeam(t: Team, ctx: LintCtx = {}): LintItem[] {
  try {
    return lint(t, ctx);
  } catch {
    return [{ level: 'warn', text: LINT_OFF, target: { kind: 'team' } }];
  }
}

function lint(t: Team, ctx: LintCtx): LintItem[] {
  const out: LintItem[] = [];
  const warn = (text: string, target: LintTarget) => out.push({ level: 'warn', text, target });
  const into = (eps: Endpoint[]) => t.routes.some((r) => eps.includes(r.to));
  const sends = (eps: Endpoint[]) => t.routes.some((r) => r.from.some((f) => eps.includes(f)));

  const alone = new Set<string>();
  for (const s of t.seats) {
    const eps = endpointsOf(t, `seat:${s.id}`);
    if (into(eps) || sends(eps)) continue;
    alone.add(s.id);
    warn(`${s.name || 'A seat'}: nobody can message it, and it messages nobody.`, { kind: 'seat', id: s.id });
  }
  for (const id of unreached(t)) if (!alone.has(id)) warn(`${seatById(t, id)?.name ?? id}: no route reaches it from you, Cora or a source, only from seats in its own loop.`, { kind: 'seat', id });
  // two seats of one name: the change lines, In words and the cards can't tell them apart
  const named = new Map<string, number>();
  for (const s of t.seats) if (s.name?.trim()) named.set(s.name.trim(), (named.get(s.name.trim()) ?? 0) + 1);
  for (const [name, n] of named) if (n > 1) warn(`${n === 2 ? 'Two' : n} seats are called ${name}: name them apart, or the team reads as one.`, { kind: 'seat', id: t.seats.find((s) => s.name?.trim() === name)!.id });
  for (const s of t.seats) {
    // its team messaging taken away: it can't reach anyone
    const cut = (s.agent?.disallowedTools ?? []).filter((x) => (SEAT_MESSAGING_TOOLS as readonly string[]).includes(x));
    if (cut.length) warn(`${s.name} may not use ${listWords(cut)}: without ${cut.length > 1 ? 'them' : 'it'} it can't message its team.`, { kind: 'seat', id: s.id });
    const mode = s.agent?.permissionMode;
    if (mode && RISKY_MODES.has(mode)) warn(`⚠ ${s.name} may act without asking (${mode}).`, { kind: 'seat', id: s.id });
    const path = s.folder?.path?.trim();
    // a folder not there yet is made when the team comes up (empty: no git repository, so no worktree of it)
    // (one that isn't a full path is an error: validateTeam says so)
    if (path && fullPath(path) && ctx.folderExists && !ctx.folderExists(path))
      warn(`${s.name}'s folder ${path} isn't on this PC: it will be created when the team comes up${s.folder.worktree ? `, and ${s.name} will work in it itself (a new folder isn't a git repository, so it has no worktree)` : ''}.`, { kind: 'seat', id: s.id });
    else if (path && s.folder.worktree && ctx.gitRepo && !ctx.gitRepo(path)) warn(`${s.name} works in a worktree, but ${path} isn't a git repository: it will work in the folder itself.`, { kind: 'seat', id: s.id });
    for (const w of startupProblems(t, s, ctx)) warn(w, { kind: 'seat', id: s.id });
  }

  for (const g of t.groups) {
    const tg: LintTarget = { kind: 'group', id: g.id };
    if (!g.members.length) warn(`${g.name} has nobody in it.`, tg);
    else if (!into(endpointsOf(t, `group:${g.id}`)) && !sends([`group:${g.id}`])) warn(`${g.name}: no route reaches it, and it sends nothing as a group.`, tg);
    const split = g.split;
    if (split && !split.else) {
      const label = t.labels.find((l) => l.id === split.label);
      const missing = label ? label.values.filter((v) => !has(split.to, v)) : [];
      if (missing.length) warn(`${g.name} splits by ${split.label} but has nothing for ${listWords(missing)}, and no else.`, tg);
    }
    const s = g.grow ? seatById(t, g.grow.seat) : undefined;
    if (g.grow && s && g.grow.max > s.count.max) warn(`${g.name} grows to ${g.grow.max}, above ${s.name}'s maximum of ${s.count.max}: it stops at ${s.count.max}.`, tg);
  }

  for (const r of t.routes) {
    const tg: LintTarget = { kind: 'route', id: r.id };
    const g = r.to.startsWith('group:') ? groupById(t, idOf(r.to)) : undefined;
    const split = g?.split;
    if (g && split && !split.else) {
      const lost = (r.labels?.[split.label] ?? []).filter((v) => !has(split.to, v));
      if (lost.length) warn(`${routeName(t, r)} carries ${split.label} ${listWords(lost)}, but ${g.name} has nothing for ${lost.length > 1 ? 'them' : 'it'} (it would go to everyone in ${g.name}).`, tg);
    }
    if (r.wake === 'ask' && r.to.startsWith('seat:') && ctx.usuallyIdle?.(idOf(r.to))) {
      const n = endpointName(t, r.to);
      warn(`${routeName(t, r)} wakes ${n} only with your OK, and ${n} is usually idle: every message on it will need your OK.`, tg);
    }
  }
  return out;
}

/** Its startup steps that can't run as written: a monitor without the Monitor tool, or on a file nothing makes. */
function startupProblems(t: Team, s: Seat, ctx: LintCtx): string[] {
  const cmd = s.startup?.monitor?.trim();
  if (!cmd) return [];
  const out: string[] = [];
  const a = s.agent ?? {};
  if ((a.disallowedTools ?? []).includes('Monitor')) out.push(`${s.name} starts a monitor, but may not use the Monitor tool: it can't start it.`);
  else if (a.tools?.length && !a.tools.includes('Monitor')) out.push(`${s.name} starts a monitor, but Monitor isn't in its tools: it can't start it.`);
  if (ctx.fileExists) {
    // what the team says about making it: a seat's instructions or startup prompt naming it (or the command writing it)
    const said = t.seats.map((x) => `${x.instructions ?? ''}\n${x.startup?.prompt ?? ''}`).join('\n').toLowerCase();
    for (const f of monitorFiles(s)) {
      if (ctx.fileExists(f.path) || said.includes(f.name.toLowerCase())) continue;
      out.push(`${s.name}'s monitor reads ${f.name}, which isn't on this PC and no seat says it makes it: as written it watches nothing. Have a seat make it, or point the monitor at something that's there.`);
    }
  }
  return out;
}

/** A file's name (its last part). */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const WRITES = /^(>>?|\d>>?|tee|tee-object|out-file|set-content|add-content|new-item|touch)$/i;

/**
 * The files a seat's monitor command reads, as full paths (a relative one is in its folder): words shaped like a file
 * name (a name and an extension), not an option, a URL or a module (`-m x.y`), and not one the command writes itself
 * (after `>`, tee, Out-File…).
 */
export function monitorFiles(s: Seat): Array<{ name: string; path: string }> {
  const cmd = s.startup?.monitor?.trim();
  if (!cmd) return [];
  const words = [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const folder = s.folder?.path?.trim() ?? '';
  const out: Array<{ name: string; path: string }> = [];
  const written = new Set<string>();
  const sep = folder.includes('/') && !folder.includes('\\') ? '/' : '\\';
  // `writing`: after >, tee, Out-File… until the command ends; `first`: the next word names a command (not a file)
  let writing = false;
  let first = true;
  for (const [i, word] of words.entries()) {
    const ends = /;$/.test(word) || /^(\||;|&&?|\|\|)$/.test(word);
    // (a word as a shell ends it: ci.log; or ci.log,)
    const w = word.replace(/[;,)]+$/, '');
    const cmdWord = first;
    first = ends;
    const prev = words[i - 1] ?? '';
    // a redirect stuck to its file (>ci.log)
    const stuck = /^\d?>>?(.+)$/.exec(w);
    if (stuck) written.add(baseName(stuck[1]).toLowerCase());
    else if (WRITES.test(w)) writing = true;
    else if (!cmdWord && !w.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w) && !w.includes('=') && prev !== '-m' && /^[^*?<>|&]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(w)) {
      if (writing) written.add(baseName(w).toLowerCase());
      else out.push({ name: baseName(w), path: fullPath(w) || !folder ? w : `${folder.replace(/[\\/]+$/, '')}${sep}${w}` });
    }
    if (ends) writing = false;
  }
  return out.filter((f) => !written.has(f.name.toLowerCase()));
}

/**
 * Seats no route reaches from you, Cora or a source (a seat no other seat routes to). A team with no source at all (a
 * squad, where everyone messages everyone) has none: you are its way in.
 */
function unreached(t: Team): string[] {
  const next = new Map<string, Set<string>>(t.seats.map((s) => [s.id, new Set<string>()]));
  const fed = new Set<string>();
  const start: string[] = [];
  for (const r of t.routes) {
    const to = seatsAt(t, r.to);
    for (const f of r.from) {
      if (f === 'user' || f === 'cora') start.push(...to);
      else for (const a of seatsAt(t, f)) for (const b of to) if (a !== b) (next.get(a)?.add(b), fed.add(b));
    }
  }
  const sources = t.seats.filter((s) => !fed.has(s.id)).map((s) => s.id);
  if (!sources.length && !start.length) return [];
  const seen = new Set<string>();
  const queue = [...start, ...sources];
  while (queue.length) {
    const a = queue.shift()!;
    if (seen.has(a)) continue;
    seen.add(a);
    queue.push(...(next.get(a) ?? []));
  }
  return t.seats.map((s) => s.id).filter((id) => !seen.has(id));
}

/** What a validateTeam problem is about, from its words (`Seat "x" …`, `Group "x" …`, `Route "x" …`, the team's rules). */
export function problemTarget(problem: string): LintTarget | undefined {
  const m = /^(Seat|Group|Route) "([^"]+)"/.exec(problem);
  if (m) return { kind: m[1].toLowerCase() as 'seat' | 'group' | 'route', id: m[2] };
  if (/^(Escalation rule|The fallback|The lead|"(labels|escalation|fallback|lead)")/.test(problem)) return { kind: 'team' };
  return undefined;
}

/** Everything the strip shows, worst first: validateTeam's errors (with what each is about), then the warnings. */
export function checkTeam(t: Team, ctx: LintCtx = {}): LintItem[] {
  const v = validateTeam(t);
  const errors: LintItem[] = v.ok
    ? []
    : v.problems.map((text) => {
        const target = problemTarget(text);
        return { level: 'error' as const, text, ...(target ? { target } : {}) };
      });
  return [...errors, ...lintTeam(t, ctx)];
}
