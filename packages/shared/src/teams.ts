/**
 * Teams: a project can carry a team definition. Seats are roles,
 * groups gather seats, labels are small vocabularies, routes say who may message whom. Pure logic only, shared by the
 * server runtime, the plugin's route gate and the builder.
 */
export type Endpoint = `seat:${string}` | `group:${string}` | 'user' | 'cora';
export type MsgKind = 'direct' | 'report' | 'handoff' | 'question' | 'change' | 'note' | 'decision';
export type Watch = { kind: 'gmail'; from: string; query?: string; about: string; then: string } | { kind: 'slack'; channel: string; about: string; then: string };

export type Seat = {
  id: string; name: string; instructions: string;
  agent: { model?: string; effort?: string; tools?: string[]; disallowedTools?: string[]; permissionMode?: string; permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } };
  skills: string[]; folder: { path: string; worktree?: boolean }; count: { min: number; max: number };
  startup: { prompt?: string; watches?: Watch[]; monitor?: string };
  limits?: { turnsPerHour?: number; costPerDay?: number; quiet?: { from: string; to: string } };
  idleCloseMin?: number;
};
/** `members`: seat ids or group ids; `split`: the label that picks one member group; `grow`: the seat it may add copies of */
export type Group = {
  id: string; name: string; members: string[]; dispatch: 'claim' | 'direct';
  split?: { label: string; to: Record<string, string>; else?: string }; grow?: { seat: string; max: number };
};
export type LabelSet = { id: string; name: string; values: string[] };
export type Route = {
  id: string; from: Endpoint[]; to: Endpoint; kinds: MsgKind[] | 'any';
  labels?: Record<string, string[]>; wake: 'auto' | 'ask' | 'never'; template?: { fields: string[] };
};
export type Escalation = {
  when: 'unclaimed' | 'critical' | 'stale' | 'blocked'; after?: number;
  scope?: { group?: string; route?: string; severity?: string[] };
  then: Array<'reoffer' | 'nudge-owner' | 'tell-lead' | 'tell-user' | 'dm-user'>;
};
export type TeamSkill = { name: string; description: string; body: string };
/** `lead`: the seat whose first live member leads the project (proposes team changes, opens and assigns incidents) */
export type Team = {
  version: number; seats: Seat[]; groups: Group[]; labels: LabelSet[]; routes: Route[];
  fallback: Endpoint; escalation: Escalation[]; skills?: TeamSkill[]; lead?: string;
};
export type RouteCheck = { ok: true; route: Route } | { ok: false; why: string; may: Endpoint[] };

export const MSG_KINDS: MsgKind[] = ['direct', 'report', 'handoff', 'question', 'change', 'note', 'decision'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Every seat id under a group, through nested groups (a cycle is ignored, not followed twice). */
export function seatsOf(t: Team, groupId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (gid: string) => {
    if (seen.has(gid)) return;
    seen.add(gid);
    const g = t.groups.find((x) => x.id === gid);
    if (!g) return;
    for (const m of g.members) {
      if (t.groups.some((x) => x.id === m)) walk(m);
      else if (t.seats.some((s) => s.id === m) && !out.includes(m)) out.push(m);
    }
  };
  walk(groupId);
  return out;
}

/** True when `outer` is `inner` or holds it by membership, through nested groups (a cycle is not followed twice). */
export function groupContains(t: Team, outer: string, inner: string): boolean {
  const seen = new Set<string>();
  const within = (gid: string): boolean => {
    if (gid === inner) return true;
    if (seen.has(gid)) return false;
    seen.add(gid);
    return (t.groups.find((g) => g.id === gid)?.members ?? []).some(within);
  };
  return within(outer);
}

/** How many members a group's pool grows to: its `grow.max`, never above its seat's `count.max`. */
export function poolCap(grow: { max: number }, seat: { count: { max: number } }): number {
  return Math.min(grow.max, seat.count.max);
}

/** Minutes between an escalation rule's steps when it names none. */
export const DEFAULT_ESCALATION_AFTER = 15;

/**
 * The tools a seat talks to its team with: Claude Code's own messaging, and Cora's project tools. A seat given a list
 * of tools (its agent's `tools`) keeps these too, unless the team takes one away (`disallowedTools`): without them a
 * seat can't message anyone (found live: a team whose seats listed only file and web tools couldn't hand off at all).
 */
export const SEAT_MESSAGING_TOOLS = [
  'SendMessage',
  'ListAgents',
  ...['project_read', 'project_post', 'project_edit', 'project_items', 'project_item', 'project_claim', 'project_annotate', 'project_close', 'project_team_propose'].map((t) => `mcp__cora__${t}`),
] as const;

/** The group a message to `groupId` lands in, following `split` by label, and the seats under it. */
export function resolveGroup(t: Team, groupId: string, labels?: Record<string, string>): { group: Group; seats: string[] } {
  const first = t.groups.find((g) => g.id === groupId);
  if (!first) throw new Error(`This team has no group "${groupId}".`);
  let group: Group = first;
  const seen = new Set<string>();
  while (group.split && !seen.has(group.id)) {
    seen.add(group.id);
    const value = labels?.[group.split.label];
    const next = (value !== undefined && Object.prototype.hasOwnProperty.call(group.split.to, value) ? group.split.to[value] : undefined) ?? group.split.else;
    const found = next ? t.groups.find((g) => g.id === next) : undefined;
    if (!found) break;
    group = found;
  }
  return { group, seats: seatsOf(t, group.id) };
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A team's own Claude Code plugin (its seats' agents and its skills): `cora-team-<project>`. */
export function teamPluginName(projectId: string): string {
  return `cora-team-${clean(projectId)}`;
}

/** A seat's agent as Claude Code addresses it: `cora-team-<project>:<seat>` (an agent name can't hold a ':'). */
export function seatAgentName(projectId: string, seatId: string): string {
  return `${teamPluginName(projectId)}:${clean(seatId)}`;
}

/**
 * The name a seat's session is started with (--name), so other sessions message it by it: its seat, its number in a
 * pool, and its project's id's first characters (two teams with a `triage` seat answer to different names).
 */
export function seatHandle(projectId: string, seatId: string, instance?: number): string {
  return `${clean(seatId)}${instance !== undefined ? `-${instance}` : ''}-${clean(projectId).replace(/-/g, '').slice(0, 4)}`;
}

/** The permission modes a seat may start in (Claude Code's --permission-mode). */
export const SEAT_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'manual', 'bypassPermissions'] as const;

/** The endpoint itself plus every group that holds it, however deep. */
export function endpointsOf(t: Team, e: Endpoint): Endpoint[] {
  const out: Endpoint[] = [e];
  const id = e.startsWith('seat:') ? e.slice(5) : e.startsWith('group:') ? e.slice(6) : '';
  if (!id) return out;
  const grow = (member: string) => {
    for (const g of t.groups) {
      const ep: Endpoint = `group:${g.id}`;
      if (g.members.includes(member) && !out.includes(ep)) { out.push(ep); grow(g.id); }
    }
  };
  grow(id);
  return out;
}

export function endpointName(t: Team, e: Endpoint): string {
  if (e === 'user') return 'You';
  if (e === 'cora') return 'Cora';
  const id = e.slice(e.indexOf(':') + 1);
  return (e.startsWith('seat:') ? t.seats.find((s) => s.id === id)?.name : t.groups.find((g) => g.id === id)?.name) ?? id;
}

/**
 * May `from` send a `kind` message to `to`? `user` and `cora` may message anyone, and anyone may message `user`. A
 * refusal names the team's fallback when the sender may send it there instead (and it isn't where it was going).
 */
export function routeAllows(t: Team, from: Endpoint, to: Endpoint, kind: MsgKind, labels?: Record<string, string>, fallback = true): RouteCheck {
  if (from === 'user' || from === 'cora' || to === 'user') return { ok: true, route: { id: 'implicit', from: [from], to, kinds: 'any', wake: 'auto' } };
  const fromSet = endpointsOf(t, from);
  const toSet = endpointsOf(t, to);
  const mine = t.routes.filter((r) => r.from.some((f) => fromSet.includes(f)));
  const hit = mine.find((r) =>
    toSet.includes(r.to) &&
    (r.kinds === 'any' || r.kinds.includes(kind)) &&
    Object.entries(r.labels ?? {}).every(([k, vals]) => labels?.[k] !== undefined && vals.includes(labels[k])));
  if (hit) return { ok: true, route: hit };
  const may = [...new Set(mine.map((r) => r.to))];
  const names = may.map((e) => endpointName(t, e));
  const fb = t.fallback;
  const instead = fallback && fb && !toSet.includes(fb) && routeAllows(t, from, fb, kind, labels, false).ok ? ` Send it to ${cardName(t, fb)} instead.` : '';
  const why = `${endpointName(t, from)} may not message ${endpointName(t, to)}${mine.some((r) => toSet.includes(r.to)) ? ' this way (kind or labels do not match a route)' : ''}.` +
    (names.length ? ` It may message ${names.join(', ')}.` : ' It has no routes.') + instead;
  return { ok: false, why, may };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
/** A full path, on Windows or elsewhere (C:\..., /..., \\server\...): never one relative to wherever Cora runs. */
export const fullPath = (p: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(p.trim());
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && !!x.trim();
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');
const WHENS: Escalation['when'][] = ['unclaimed', 'critical', 'stale', 'blocked'];
const THENS: Escalation['then'][number][] = ['reoffer', 'nudge-owner', 'tell-lead', 'tell-user', 'dm-user'];
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** A seat's shape (everything the runtime reads from it), each problem in plain words. */
function checkSeat(s: Record<string, unknown>, at: string, problems: string[]): void {
  if (!nonEmpty(s.name)) problems.push(`${at} needs a name.`);
  if (typeof s.instructions !== 'string') problems.push(`${at} needs instructions (text).`);
  const a = s.agent;
  if (!isObj(a)) problems.push(`${at} needs an "agent" object (it may be empty).`);
  else {
    for (const k of ['model', 'effort'] as const) if (a[k] !== undefined && typeof a[k] !== 'string') problems.push(`${at}: agent.${k} must be text.`);
    for (const k of ['tools', 'disallowedTools'] as const) if (a[k] !== undefined && !strings(a[k])) problems.push(`${at}: agent.${k} must be a list of tool names.`);
    if (a.permissionMode !== undefined && !SEAT_PERMISSION_MODES.includes(a.permissionMode as never)) problems.push(`${at}: agent.permissionMode must be one of ${SEAT_PERMISSION_MODES.join(', ')}.`);
    if (a.permissions !== undefined) {
      if (!isObj(a.permissions)) problems.push(`${at}: agent.permissions must be an object (allow, ask, deny).`);
      else for (const k of ['allow', 'ask', 'deny'] as const) if (a.permissions[k] !== undefined && !strings(a.permissions[k])) problems.push(`${at}: agent.permissions.${k} must be a list of rules.`);
    }
  }
  if (!strings(s.skills)) problems.push(`${at}: "skills" must be a list of skill names.`);
  if (!isObj(s.folder) || !nonEmpty(s.folder.path)) problems.push(`${at} needs folder.path (the folder it works in).`);
  else if (!fullPath(s.folder.path)) problems.push(`${at}: folder.path must be a full path (like C:\\work\\ops), not "${s.folder.path}".`);
  else if (s.folder.worktree !== undefined && typeof s.folder.worktree !== 'boolean') problems.push(`${at}: folder.worktree must be true or false.`);
  const c = s.count;
  if (!isObj(c) || !Number.isInteger(c.min) || !Number.isInteger(c.max)) problems.push(`${at} needs count.min and count.max whole numbers.`);
  else if ((c.min as number) > (c.max as number)) problems.push(`${at} has count.min ${c.min} above count.max ${c.max}.`);
  else if ((c.min as number) < 0 || (c.max as number) < 1) problems.push(`${at} count must be min 0 or more and max 1 or more.`);
  const st = s.startup;
  if (!isObj(st)) problems.push(`${at} needs a "startup" object (it may be empty).`);
  else {
    for (const k of ['prompt', 'monitor'] as const) if (st[k] !== undefined && typeof st[k] !== 'string') problems.push(`${at}: startup.${k} must be text.`);
    if (st.watches !== undefined) {
      if (!Array.isArray(st.watches)) problems.push(`${at}: startup.watches must be a list.`);
      else
        st.watches.forEach((w, i) => {
          const wat = `${at}'s watch ${i + 1}`;
          if (!isObj(w)) return void problems.push(`${wat} is not an object.`);
          for (const k of ['about', 'then'] as const) if (w[k] !== undefined && typeof w[k] !== 'string') problems.push(`${wat}: ${k} must be text.`);
          if (w.kind === 'gmail') {
            if (!nonEmpty(w.from)) problems.push(`${wat} needs "from" (the sender it waits for).`);
            if (w.query !== undefined && typeof w.query !== 'string') problems.push(`${wat}: query must be text.`);
          } else if (w.kind === 'slack') {
            if (!nonEmpty(w.channel)) problems.push(`${wat} needs a "channel".`);
          } else problems.push(`${wat}: kind must be gmail or slack.`);
        });
    }
  }
  const l = s.limits;
  if (l !== undefined) {
    if (!isObj(l)) problems.push(`${at}: "limits" must be an object.`);
    else {
      for (const k of ['turnsPerHour', 'costPerDay'] as const) if (l[k] !== undefined && !(typeof l[k] === 'number' && Number.isFinite(l[k]) && (l[k] as number) >= 0)) problems.push(`${at}: limits.${k} must be a number.`);
      if (l.quiet !== undefined && (!isObj(l.quiet) || typeof l.quiet.from !== 'string' || typeof l.quiet.to !== 'string' || !HHMM.test(l.quiet.from) || !HHMM.test(l.quiet.to))) problems.push(`${at}: limits.quiet needs from and to as HH:MM.`);
    }
  }
  if (s.idleCloseMin !== undefined && !(typeof s.idleCloseMin === 'number' && Number.isFinite(s.idleCloseMin))) problems.push(`${at}: idleCloseMin must be a number of minutes.`);
}

/** Check a team definition from anywhere (a file, the builder). Never throws; lists every problem it finds. */
export function validateTeam(input: unknown): { ok: true; team: Team } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  try {
    if (!isObj(input)) return { ok: false, problems: ['The team is not an object.'] };
    const arr = (k: string): unknown[] => {
      const v = input[k];
      if (!Array.isArray(v)) { problems.push(`"${k}" must be a list.`); return []; }
      return v;
    };
    const seats = arr('seats'), groups = arr('groups'), labels = arr('labels'), routes = arr('routes');
    if (typeof input.version !== 'number') problems.push('"version" must be a number.');
    const seatIds = new Set<string>(), groupIds = new Set<string>(), labelMap = new Map<string, Set<string>>();
    const checkId = (what: string, id: unknown, seen: Set<string>): string | undefined => {
      if (typeof id !== 'string') { problems.push(`A ${what} has no id.`); return undefined; }
      if (!ID_RE.test(id)) problems.push(`The ${what} id "${id}" may use only lowercase letters, digits and dashes.`);
      if (seen.has(id)) problems.push(`Duplicate ${what} id "${id}".`);
      seen.add(id);
      return id;
    };

    for (const s of seats) {
      if (!isObj(s)) { problems.push('A seat is not an object.'); continue; }
      const id = checkId('seat', s.id, seatIds);
      checkSeat(s, `Seat "${String(id ?? '?')}"`, problems);
    }
    for (const g of groups) {
      if (!isObj(g)) { problems.push('A group is not an object.'); continue; }
      const id = checkId('group', g.id, groupIds);
      if (!nonEmpty(g.name)) problems.push(`Group "${String(id ?? '?')}" needs a name.`);
    }
    for (const l of labels) {
      if (!isObj(l)) { problems.push('A label set is not an object.'); continue; }
      const seen = new Set<string>();
      const id = checkId('label', l.id, seen);
      if (id !== undefined && labelMap.has(id)) problems.push(`Duplicate label id "${id}".`);
      const vals = Array.isArray(l.values) ? l.values.filter((v): v is string => typeof v === 'string') : [];
      if (!Array.isArray(l.values)) problems.push(`Label "${id}" needs a list of values.`);
      if (id !== undefined) labelMap.set(id, new Set(vals));
    }
    for (const id of seatIds) if (groupIds.has(id)) problems.push(`The id "${id}" is both a seat and a group.`);
    // a pool's members are <seat>-<n>: no other seat may be called that (their sessions' names would be the same)
    for (const id of seatIds) {
      const m = /^(.+)-\d+$/.exec(id);
      if (m && seatIds.has(m[1])) problems.push(`The seat id "${id}" could be mistaken for a copy of seat "${m[1]}": name it differently.`);
    }

    const members = new Map<string, string[]>();
    for (const g of groups) {
      if (!isObj(g) || typeof g.id !== 'string') continue;
      const ms = Array.isArray(g.members) ? g.members.filter((m): m is string => typeof m === 'string') : [];
      if (!Array.isArray(g.members)) problems.push(`Group "${g.id}" needs a list of members.`);
      members.set(g.id, ms);
      for (const m of ms) if (!seatIds.has(m) && !groupIds.has(m)) problems.push(`Group "${g.id}" has an unknown member "${m}".`);
      if (g.dispatch !== 'claim' && g.dispatch !== 'direct') problems.push(`Group "${g.id}" dispatch must be claim or direct.`);
      if (isObj(g.split)) {
        const sp = g.split;
        const set = typeof sp.label === 'string' ? labelMap.get(sp.label) : undefined;
        if (!set) problems.push(`Group "${g.id}" splits on an unknown label "${String(sp.label)}".`);
        const targets: Array<[string, unknown]> = isObj(sp.to) ? Object.entries(sp.to) : [];
        if (!isObj(sp.to)) problems.push(`Group "${g.id}" split needs a "to" map.`);
        for (const [v, target] of targets) {
          if (set && !set.has(v)) problems.push(`Group "${g.id}" splits on "${v}", which is not a value of label "${String(sp.label)}".`);
          if (typeof target !== 'string' || !ms.includes(target)) problems.push(`Group "${g.id}" splits to "${String(target)}", which is not a member.`);
        }
        if (sp.else !== undefined && (typeof sp.else !== 'string' || !ms.includes(sp.else))) problems.push(`Group "${g.id}" split else "${String(sp.else)}" is not a member.`);
      }
      if (isObj(g.grow)) {
        if (typeof g.grow.seat !== 'string' || !ms.includes(g.grow.seat) || !seatIds.has(g.grow.seat)) problems.push(`Group "${g.id}" grows "${String(g.grow.seat)}", which is not a seat in it.`);
        if (typeof g.grow.max !== 'number' || g.grow.max < 1) problems.push(`Group "${g.id}" grow.max must be 1 or more.`);
      }
    }

    // a group may not hold itself, however deep
    const state = new Map<string, 1 | 2>();
    const cyc = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) { const loop = path.slice(path.indexOf(id)).concat(id).join(' > '); if (!cyc.has(loop)) { cyc.add(loop); problems.push(`Groups form a cycle: ${loop}.`); } return; }
      state.set(id, 1);
      for (const m of members.get(id) ?? []) if (groupIds.has(m)) visit(m, [...path, id]);
      state.set(id, 2);
    };
    for (const id of members.keys()) visit(id, []);

    const endpointOk = (e: unknown): boolean => {
      if (e === 'user' || e === 'cora') return true;
      if (typeof e !== 'string') return false;
      if (e.startsWith('seat:')) return seatIds.has(e.slice(5));
      if (e.startsWith('group:')) return groupIds.has(e.slice(6));
      return false;
    };
    const routeIds = new Set<string>();
    for (const r of routes) {
      if (!isObj(r)) { problems.push('A route is not an object.'); continue; }
      const id = checkId('route', r.id, routeIds);
      const from = Array.isArray(r.from) ? r.from : [];
      if (!Array.isArray(r.from) || from.length === 0) problems.push(`Route "${id}" needs at least one "from".`);
      for (const f of from) if (!endpointOk(f)) problems.push(`Route "${id}" is from an unknown endpoint "${String(f)}".`);
      if (!endpointOk(r.to)) problems.push(`Route "${id}" goes to an unknown endpoint "${String(r.to)}".`);
      if (r.kinds !== 'any') {
        if (!Array.isArray(r.kinds) || r.kinds.length === 0) problems.push(`Route "${id}" kinds must be "any" or a list.`);
        else for (const k of r.kinds) if (!MSG_KINDS.includes(k as MsgKind)) problems.push(`Route "${id}" has an unknown kind "${String(k)}".`);
      }
      if (r.wake !== 'auto' && r.wake !== 'ask' && r.wake !== 'never') problems.push(`Route "${id}" wake must be auto, ask or never.`);
      if (r.labels !== undefined) {
        if (!isObj(r.labels)) problems.push(`Route "${id}" labels must be a map.`);
        else for (const [k, vals] of Object.entries(r.labels)) {
          const set = labelMap.get(k);
          if (!set) { problems.push(`Route "${id}" filters on an unknown label "${k}".`); continue; }
          if (!strings(vals) || !vals.length) problems.push(`Route "${id}" filter "${k}" needs a list of values.`);
          for (const v of Array.isArray(vals) ? vals : []) if (!set.has(v as string)) problems.push(`Route "${id}" filters "${k}" on "${String(v)}", which is not one of its values.`);
        }
      }
      if (r.template !== undefined && (!isObj(r.template) || !strings(r.template.fields))) problems.push(`Route "${id}" template needs a list of fields.`);
    }
    if (!endpointOk(input.fallback)) problems.push(`The fallback "${String(input.fallback)}" is not a known endpoint.`);
    if (input.lead !== undefined) {
      if (typeof input.lead !== 'string') problems.push('"lead" must be a seat id.');
      else if (!seatIds.has(input.lead)) problems.push(`The lead "${input.lead}" is not a seat in the team.`);
    }
    if (!Array.isArray(input.escalation)) problems.push('"escalation" must be a list.');
    else
      input.escalation.forEach((e, i) => {
        const at = `Escalation rule ${i + 1}`;
        if (!isObj(e)) return void problems.push(`${at} is not an object.`);
        if (!WHENS.includes(e.when as never)) problems.push(`${at}: "when" must be one of ${WHENS.join(', ')}.`);
        if (!Array.isArray(e.then) || !e.then.length) problems.push(`${at}: "then" must be a list of steps.`);
        else for (const t of e.then) if (!THENS.includes(t as never)) problems.push(`${at} has an unknown step "${String(t)}" (one of ${THENS.join(', ')}).`);
        if (e.after !== undefined && !(typeof e.after === 'number' && Number.isFinite(e.after) && e.after > 0)) problems.push(`${at}: "after" must be a number of minutes above 0.`);
        if (e.scope !== undefined) {
          if (!isObj(e.scope)) problems.push(`${at}: "scope" must be an object.`);
          else {
            if (e.scope.group !== undefined && (typeof e.scope.group !== 'string' || !groupIds.has(e.scope.group))) problems.push(`${at} is scoped to an unknown group "${String(e.scope.group)}".`);
            if (e.scope.route !== undefined && (typeof e.scope.route !== 'string' || !routeIds.has(e.scope.route))) problems.push(`${at} is scoped to an unknown route "${String(e.scope.route)}".`);
            if (e.scope.severity !== undefined && !strings(e.scope.severity)) problems.push(`${at}: scope.severity must be a list.`);
          }
        }
      });
    if (input.skills !== undefined) {
      if (!Array.isArray(input.skills)) problems.push('"skills" must be a list.');
      else
        input.skills.forEach((k, i) => {
          if (!isObj(k) || !nonEmpty(k.name) || typeof k.description !== 'string' || typeof k.body !== 'string') problems.push(`Team skill ${i + 1} needs a name, a description and a body.`);
        });
    }
  } catch (e) {
    problems.push(`The team could not be checked: ${(e as Error).message}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, team: input as Team };
}

const KIND_WORDS: Record<MsgKind, string> = { direct: 'direct messages', report: 'reports', handoff: 'handoffs', question: 'questions', change: 'changes', note: 'notes', decision: 'decisions' };
const kindsWords = (k: MsgKind[] | 'any'): string => (k === 'any' ? 'anything' : k.map((x) => KIND_WORDS[x]).join(', '));

function cardName(t: Team, e: Endpoint): string {
  if (e === 'user') return 'the user';
  if (e === 'cora') return 'Cora';
  const id = e.slice(e.indexOf(':') + 1);
  return (e.startsWith('seat:') ? t.seats.find((s) => s.id === id)?.name : t.groups.find((g) => g.id === id)?.name) ?? id;
}

/** A seat's place in the team in plain words: who it may message and how, who reaches it, and the labels it uses. Names, never ids (but the label syntax). */
export function seatCard(t: Team, seatId: string): string {
  const me = endpointsOf(t, `seat:${seatId}`);
  const seat = t.seats.find((s) => s.id === seatId);
  const out = t.routes.filter((r) => r.from.some((f) => me.includes(f)) && r.to !== 'user');
  const into = t.routes.filter((r) => me.includes(r.to));
  const setName = (id: string) => t.labels.find((l) => l.id === id)?.name ?? id;
  const outgoing = out.map((r) => {
    const parts = [kindsWords(r.kinds)];
    for (const [k, vals] of Object.entries(r.labels ?? {})) parts.push(`only when ${setName(k)} is ${vals.join(' or ')}`);
    if (r.template?.fields.length) parts.push(`must include ${r.template.fields.join(', ')}`);
    return `${cardName(t, r.to)} (${parts.join('; ')})`;
  });
  // (a sender on two routes alike, say one of them only for some labels, is said once)
  const senders = [...new Set(into.flatMap((r) => r.from.filter((f) => f !== 'user').map((f) => `${cardName(t, f)} (${kindsWords(r.kinds)})`)))];
  const labelIds = [...new Set(out.flatMap((r) => Object.keys(r.labels ?? {})))];
  const groupsOut = [...new Set(out.filter((r) => r.to.startsWith('group:')).map((r) => cardName(t, r.to)))];
  const lines = [
    // (who leads is said by the project card: only the project's lead, not every copy of the lead seat)
    `Your seat: ${seat?.name ?? seatId}.`,
    `You may message: ${outgoing.length ? `${outgoing.join('; ')}, and ` : ''}the user (anything).`,
    // work for a group goes to the group, by its name: its free members are offered it
    ...(groupsOut.length ? [`A group takes work by its name (to: [${groupsOut.map((g) => JSON.stringify(g)).join(', ')}]): its free members are offered it, and the first to claim it owns it.`] : []),
    ...(senders.length ? [`Reaches you: ${senders.join('; ')}.`] : []),
    ...labelIds.flatMap((id) => {
      const set = t.labels.find((l) => l.id === id);
      return set ? [`Label with a first line like [labels: ${id}=${set.values[0] ?? ''}]: ${id} is one of ${set.values.join(', ')}.`] : [];
    }),
    'Messages outside these are refused, saying who you may message instead.',
  ];
  return lines.join('\n');
}

/** What an edit to a team changes for its running seats (diffTeam). */
export type TeamChange = {
  kind: 'seat-added' | 'seat-removed' | 'seat-retasked' | 'seat-restart-needed' | 'pool-resized' | 'routes-changed' | 'watches-changed';
  seat?: string; detail?: string;
};

/**
 * A value without what means nothing (undefined, null, empty text, empty lists and maps, a permission mode of
 * 'default': Claude Code's own), its keys sorted: two that mean the same compare equal. The one meaning of "the same"
 * for the change lines, what restarts, and the builder's count and rebase.
 */
function canon(x: unknown, key?: string): unknown {
  if (Array.isArray(x)) return x.map((v) => canon(v));
  if (!isObj(x)) return x === null || x === '' || (key === 'permissionMode' && x === 'default') ? undefined : x;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x).sort()) {
    const v = canon(x[k], k);
    if (v === undefined || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length)) continue;
    out[k] = v;
  }
  return out;
}
/** Two values that say the same (key order and what means nothing don't matter). */
export const sameMeaning = (a: unknown, b: unknown, key?: string) => JSON.stringify(canon({ [key ?? 'v']: a })) === JSON.stringify(canon({ [key ?? 'v']: b }));
const same = sameMeaning;

/** Two definitions of a team that say the same (whatever their versions): an edit that changes nothing. */
export function sameTeam(a: Team | undefined, b: Team | undefined): boolean {
  return same(a ? { ...a, version: 0 } : undefined, b ? { ...b, version: 0 } : undefined);
}

const AGENT_FIELDS = ['tools', 'disallowedTools', 'model', 'effort', 'permissionMode', 'permissions'] as const;

/**
 * What changed between two versions of a team, for its running seats: seats removed, added, then each remaining seat
 * (in the team's order: retasked, restart needed, pool resized, watches changed), then its routes. No change: [].
 */
export function diffTeam(old: Team | undefined, next: Team): TeamChange[] {
  const prev: Team = old ?? { version: 0, seats: [], groups: [], labels: [], routes: [], fallback: next.fallback, escalation: [] };
  const out: TeamChange[] = [];
  const nextIds = new Set(next.seats.map((s) => s.id));
  const prevById = new Map(prev.seats.map((s) => [s.id, s]));
  for (const s of prev.seats) if (!nextIds.has(s.id)) out.push({ kind: 'seat-removed', seat: s.id });
  for (const s of next.seats) if (!prevById.has(s.id)) out.push({ kind: 'seat-added', seat: s.id });
  for (const s of next.seats) {
    const o = prevById.get(s.id);
    if (!o) continue;
    if (o.instructions !== s.instructions) out.push({ kind: 'seat-retasked', seat: s.id, detail: 'instructions changed' });
    const what = [
      ...AGENT_FIELDS.filter((k) => !same(o.agent?.[k], s.agent?.[k], k)),
      ...(same(o.skills, s.skills) ? [] : ['skills']),
      ...(same(o.folder, s.folder) ? [] : ['folder']),
      // taken only when a member starts (a blank prompt is none)
      ...(same(o.startup?.prompt?.trim() || undefined, s.startup?.prompt?.trim() || undefined) ? [] : ['startup prompt']),
      ...(same(o.startup?.monitor, s.startup?.monitor) ? [] : ['startup monitor']),
    ];
    if (what.length) out.push({ kind: 'seat-restart-needed', seat: s.id, detail: `${what.join(', ')} changed` });
    const size = [
      ...(o.count.min !== s.count.min ? [`min ${o.count.min}→${s.count.min}`] : []),
      ...(o.count.max !== s.count.max ? [`max ${o.count.max}→${s.count.max}`] : []),
    ];
    if (size.length) out.push({ kind: 'pool-resized', seat: s.id, detail: size.join(', ') });
    if (!same(o.startup?.watches, s.startup?.watches)) out.push({ kind: 'watches-changed', seat: s.id });
  }
  const rest: Array<[string, (t: Team) => unknown]> = [['routes', (t) => t.routes], ['groups', (t) => t.groups], ['labels', (t) => t.labels], ['fallback', (t) => t.fallback], ['escalation', (t) => t.escalation], ['team skills', (t) => t.skills], ['lead', (t) => t.lead]];
  const changed = rest.filter(([, f]) => !same(f(prev), f(next))).map(([k]) => k);
  if (changed.length) out.push({ kind: 'routes-changed', detail: `${changed.join(', ')} changed` });
  return out;
}

const WARN = '⚠ ';
/** a text on one line, cut to `n` characters (Infinity: the whole of it, as written) */
const oneLine = (s: string | undefined, n = 80) => {
  if (n === Infinity) return (s ?? '').trim();
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const quoted = (s: string | undefined, n = 80) => (s?.trim() ? `"${oneLine(s, n)}"` : 'none');

/**
 * A text's change as `before → after`. Cut to `n` characters, a long text would read the same on both sides when the
 * change is past its start: then only the part that differs is said, its common start and end trimmed to whole words
 * and marked "…" (`… added "…"`, `… removed "…"`, or `… "old" → "new" …`). Short texts, a text added or cleared, and
 * the full view (n = Infinity) read as before; the same words spaced otherwise say only that. `ctx`: that many words
 * on each side of the part that differs, so a few changed words can be found even if they appear twice: a change reads
 * `… "ctx old ctx" → "ctx new ctx" …`, an addition `added "…" after "ctx"` (before, at the start), a removal the same.
 */
export function textChange(x: string | undefined, y: string | undefined, n = 80, ctx = 0): string {
  const a = (x ?? '').replace(/\s+/g, ' ').trim();
  const b = (y ?? '').replace(/\s+/g, ' ').trim();
  // the same words, spaced or broken into lines otherwise (a trailing newline, a re-wrapped paragraph)
  if (n !== Infinity && a && a === b) return 'only its spacing or line breaks changed';
  if (n === Infinity || !a || !b || (a.length <= n && b.length <= n)) return `${quoted(x, n)} → ${quoted(y, n)}`;
  // the common start, then the common end (never overlapping it)
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // whole words: a change that starts or ends inside a word takes in the whole of it
  const word = (c: string | undefined) => c !== undefined && c !== ' ';
  if (p > 0 && word(a[p - 1]) && (word(a[p]) || word(b[p]))) p = a.lastIndexOf(' ', p - 1) + 1;
  let ea = a.length - s;
  let eb = b.length - s;
  if (s > 0 && word(a[ea]) && (word(a[ea - 1]) || word(b[eb - 1]))) {
    const to = a.indexOf(' ', ea);
    const k = (to < 0 ? a.length : to) - ea;
    ea += k;
    eb += k;
  }
  const was = a.slice(p, ea).trim();
  const now = b.slice(p, eb).trim();
  if (ctx > 0) {
    const before = a.slice(0, p).trim().split(' ').filter(Boolean);
    const after = a.slice(ea).trim().split(' ').filter(Boolean);
    const l = before.slice(-ctx).join(' ');
    const r = after.slice(0, ctx).join(' ');
    if (!was || !now) {
      const where = l ? ` after ${quoted(l, n)}` : r ? ` before ${quoted(r, n)}` : '';
      return `${was ? 'removed' : 'added'} ${quoted(was || now, n)}${where}`;
    }
    const wrap = (t: string) => [l, t, r].filter(Boolean).join(' ');
    return `${before.length > ctx ? '… ' : ''}${quoted(wrap(was), n)} → ${quoted(wrap(now), n)}${after.length > ctx ? ' …' : ''}`;
  }
  const head = p > 0 ? '… ' : '';
  const tail = ea < a.length ? ' …' : '';
  if (!was) return `${head}added ${quoted(now, n)}${tail}`;
  if (!now) return `${head}removed ${quoted(was, n)}${tail}`;
  return `${head}${quoted(was, n)} → ${quoted(now, n)}${tail}`;
}
const listOf = (xs?: string[]) => (xs?.length ? xs.join(', ') : 'none');
const permsOf = (p?: Seat['agent']['permissions']) => {
  const parts = (['allow', 'ask', 'deny'] as const).filter((k) => p?.[k]?.length).map((k) => `${k} ${p![k]!.join(', ')}`);
  return parts.length ? parts.join('; ') : 'none';
};
const folderOf = (f: Seat['folder']) => `${f.path}${f.worktree ? ' (in its own worktree)' : ''}`;
const countOf = (c: Seat['count']) => (c.min === c.max ? `${c.max}` : `${c.min} to ${c.max}`);
const watchOf = (w: Watch, cut = 120) => (w.kind === 'gmail' ? `email from ${w.from}${w.query?.trim() ? ` matching ${w.query.trim()}` : ''}` : `Slack ${w.channel}`) + (w.then?.trim() ? `, then: ${quoted(w.then, cut)}` : '');
const watchesOf = (ws?: Watch[], cut = 120) => (ws?.length ? ws.map((w) => watchOf(w, cut)).join('; ') : 'none');
const limitsOf = (l?: Seat['limits']) => {
  const parts = [l?.turnsPerHour ? `${l.turnsPerHour} turns an hour` : '', l?.costPerDay ? `$${l.costPerDay} a day` : '', l?.quiet ? `quiet ${l.quiet.from} to ${l.quiet.to}` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'none';
};
// no mode of its own: it starts in the mode the user's sessions start in (their Claude Code default)
const modeOf = (m?: string) => (m && m !== 'default' ? m : "yours (the mode your sessions start in)");
/** Modes that let a seat act without asking first: worth a ⚠ */
export const RISKY_MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const riskyMode = (m?: string) => !!m && RISKY_MODES.has(m);

/**
 * What a new definition of a team changes, line by line in words the user can judge before approving it (a lead's
 * proposal, Cora's edit): each new seat with where it works, its permissions, tools, model, watches and skills; each
 * changed field of a seat as `before → after`; seats removed; team skills added or changed (their first line); routes,
 * groups, labels, fallback and escalation summarised. Lines about a seat's folder or permissions start with "⚠ ", and
 * about its permission mode only when the mode (before or after) lets it act without asking (RISKY_MODES). No change: [].
 */
export function teamChangeLines(prev: Team | undefined, next: Team): string[] {
  return changeLines(prev, next, 80).map((x) => x.line);
}

/**
 * teamChangeLines with the whole of what they cut: each line, and when it was cut (instructions, startup prompts,
 * monitors, watches' instructions, team skills' bodies) the same line with the full text (`full`), for the user to
 * read before approving.
 */
export function teamChangeDetails(prev: Team | undefined, next: Team): Array<{ line: string; full?: string }> {
  return seatedChangeDetails(prev, next).map(({ seat: _s, ...d }) => d);
}

/** teamChangeDetails, each line with the seat it is about (its id), when it is about one: Apply's sheet groups them by it. */
export function seatedChangeDetails(prev: Team | undefined, next: Team): Array<{ line: string; full?: string; seat?: string }> {
  const short = changeLines(prev, next, 80);
  const whole = changeLines(prev, next, Infinity);
  return short.map(({ line, seat }, i) => ({ line, ...(whole[i] !== undefined && whole[i].line !== line ? { full: whole[i].line } : {}), ...(seat ? { seat } : {}) }));
}

/** The change lines (each with the seat it is about), risky texts cut to `cut` characters (Infinity: in full). */
function changeLines(prev: Team | undefined, next: Team, cut: number): Array<{ line: string; seat?: string }> {
  const lines: Array<{ line: string; seat?: string }> = [];
  // the seat the lines being said are about
  let about: string | undefined;
  const out = { push: (line: string) => lines.push(about ? { line, seat: about } : { line }) };
  const before: Team = prev ?? { version: 0, seats: [], groups: [], labels: [], routes: [], fallback: next.fallback, escalation: [] };
  const prevSeats = new Map(before.seats.map((s) => [s.id, s]));
  const nextIds = new Set(next.seats.map((s) => s.id));
  for (const s of next.seats) {
    const o = prevSeats.get(s.id);
    const a = s.agent ?? {};
    about = s.id;
    if (!o) {
      out.push(`New seat: ${s.name} (${countOf(s.count)})`);
      out.push(`${s.name} instructions: ${quoted(s.instructions, cut)}`);
      out.push(`${WARN}${s.name} works in ${folderOf(s.folder)}`);
      out.push(`${riskyMode(a.permissionMode) ? WARN : ''}${s.name} permission mode: ${modeOf(a.permissionMode)}`);
      if (permsOf(a.permissions) !== 'none') out.push(`${WARN}${s.name} permissions: ${permsOf(a.permissions)}`);
      if (a.tools?.length) out.push(`${s.name} tools: ${listOf(a.tools)}`);
      if (a.disallowedTools?.length) out.push(`${s.name} may not use: ${listOf(a.disallowedTools)}`);
      if (a.model || a.effort) out.push(`${s.name} model: ${[a.model, a.effort ? `${a.effort} effort` : ''].filter(Boolean).join(', ')}`);
      for (const w of s.startup?.watches ?? []) out.push(`${s.name} watches ${watchOf(w, cut === Infinity ? cut : 120)}`);
      if (s.skills?.length) out.push(`${s.name} skills: ${listOf(s.skills)}`);
      if (s.startup?.prompt?.trim()) out.push(`${s.name} starts with: ${quoted(s.startup.prompt, cut)}`);
      if (s.startup?.monitor?.trim()) out.push(`${s.name} monitors: ${quoted(s.startup.monitor, cut)}`);
      if (limitsOf(s.limits) !== 'none') out.push(`${s.name} limits: ${limitsOf(s.limits)}`);
      continue;
    }
    const b = o.agent ?? {};
    const ch = <T>(label: string, x: T, y: T, words: (v: T) => string, warn = false) => {
      if (!same(x, y)) out.push(`${warn ? WARN : ''}${s.name} ${label}: ${words(x)} → ${words(y)}`);
    };
    // a text changed: the part that differs, when it's long (textChange)
    const chText = (label: string, x: string | undefined, y: string | undefined) => {
      if (!same(x, y)) out.push(`${s.name} ${label}: ${textChange(x, y, cut)}`);
    };
    if (o.name !== s.name) out.push(`Seat ${o.name} is now named ${s.name}`);
    chText('instructions', o.instructions, s.instructions);
    ch('folder', o.folder, s.folder, folderOf, true);
    // 'default' is no mode of its own (Claude Code's default)
    const mode = (m?: string) => (m && m !== 'default' ? m : undefined);
    ch('permission mode', mode(b.permissionMode), mode(a.permissionMode), modeOf, riskyMode(a.permissionMode) || riskyMode(b.permissionMode));
    ch('permissions', b.permissions, a.permissions, permsOf, true);
    ch('tools', b.tools, a.tools, listOf);
    ch('may not use', b.disallowedTools, a.disallowedTools, listOf);
    ch('model', b.model, a.model, (v) => v || 'default');
    ch('effort', b.effort, a.effort, (v) => v || 'default');
    ch('skills', o.skills, s.skills, listOf);
    ch('count', o.count, s.count, countOf);
    ch('watches', o.startup?.watches, s.startup?.watches, (v) => watchesOf(v, cut === Infinity ? cut : 120));
    chText('startup prompt', o.startup?.prompt?.trim() || undefined, s.startup?.prompt?.trim() || undefined);
    chText('monitor', o.startup?.monitor?.trim() || undefined, s.startup?.monitor?.trim() || undefined);
    ch('limits', o.limits, s.limits, limitsOf);
    ch('idle close', o.idleCloseMin, s.idleCloseMin, (v) => (typeof v === 'number' && v > 0 ? `after ${v} min idle` : 'never'));
  }
  for (const s of before.seats) {
    if (nextIds.has(s.id)) continue;
    about = s.id;
    out.push(`Seat removed: ${s.name}`);
  }
  about = undefined;

  // a skill by its first line (in full: its whole body)
  const firstLine = (k: TeamSkill) => (cut === Infinity ? k.body.trim() || k.description : oneLine(k.body.split(/\r?\n/).find((l) => l.trim()) ?? k.description, 100));
  const prevSkills = new Map((before.skills ?? []).map((k) => [k.name, k]));
  const nextSkills = new Set((next.skills ?? []).map((k) => k.name));
  for (const k of next.skills ?? []) {
    const o = prevSkills.get(k.name);
    if (!o) out.push(`Team skill added: ${k.name}: ${firstLine(k)}`);
    else if (!same(o, k)) out.push(`Team skill changed: ${k.name}: ${firstLine(k)}`);
  }
  for (const k of before.skills ?? []) if (!nextSkills.has(k.name)) out.push(`Team skill removed: ${k.name}`);

  // routes and groups, by the names in the version they belong to
  const routeOf = (t: Team, r: Route) => {
    const parts = [kindsWords(r.kinds), `wake ${r.wake}`, ...Object.entries(r.labels ?? {}).map(([k, v]) => `only ${k} ${v.join(' or ')}`), ...(r.template?.fields.length ? [`must include ${r.template.fields.join(', ')}`] : [])];
    return `${r.from.map((f) => cardName(t, f)).join(', ')} → ${cardName(t, r.to)} (${parts.join('; ')})`;
  };
  const groupOf = (t: Team, g: Group) =>
    `${g.name}: ${g.members.map((m) => cardName(t, t.groups.some((x) => x.id === m) ? `group:${m}` : `seat:${m}`)).join(', ') || 'nobody'}${g.dispatch === 'claim' ? ', first free claims it' : ', sender picks'}${g.grow ? `, grows to ${g.grow.max}` : ''}`;
  const byId = <T extends { id: string }>(label: string, a: T[], b: T[], words: (t: Team, x: T) => string) => {
    const old = new Map(a.map((x) => [x.id, x]));
    const now = new Set(b.map((x) => x.id));
    for (const x of b) {
      const o = old.get(x.id);
      if (!o) out.push(`${label} added: ${words(next, x)}`);
      else if (!same(o, x)) out.push(`${label} changed: ${words(before, o)} → ${words(next, x)}`);
    }
    for (const x of a) if (!now.has(x.id)) out.push(`${label} removed: ${words(before, x)}`);
  };
  byId('Route', before.routes, next.routes, routeOf);
  byId('Group', before.groups, next.groups, groupOf);
  const labelsOf = (ls: LabelSet[]) => ls.map((l) => `${l.name} (${l.values.join(', ')})`).join('; ') || 'none';
  if (!same(before.labels, next.labels)) out.push(`Labels: ${labelsOf(before.labels)} → ${labelsOf(next.labels)}`);
  if (!same(before.fallback, next.fallback)) out.push(`Fallback: ${cardName(before, before.fallback)} → ${cardName(next, next.fallback)}`);
  const leadOf = (t: Team) => (t.lead ? cardName(t, `seat:${t.lead}`) : 'none');
  if (!same(before.lead, next.lead)) out.push(`Lead: ${leadOf(before)} → ${leadOf(next)}`);
  const escOf = (e: Escalation) => `${e.when}${e.after ? ` after ${e.after} min` : ''}${e.scope?.group ? ` in ${e.scope.group}` : ''}: ${e.then.join(', ')}`;
  if (!same(before.escalation, next.escalation)) out.push(`Escalation: ${before.escalation.map(escOf).join('; ') || 'none'} → ${next.escalation.map(escOf).join('; ') || 'none'}`);
  return lines;
}

/** A lead's proposal that would start a seat skipping permission prompts (a new seat, or one moved to that mode). */
export function proposalSkipsPrompts(prev: Team | undefined, next: Team): boolean {
  const before = new Map((prev?.seats ?? []).map((s) => [s.id, s]));
  return next.seats.some((s) => s.agent?.permissionMode === 'bypassPermissions' && before.get(s.id)?.agent?.permissionMode !== 'bypassPermissions');
}
