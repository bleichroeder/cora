/**
 * Edits to a builder draft:
 * each returns a new team (the draft it was given is never changed), and says what it did when that matters.
 */
import { clone, groupById, listWords, MSG_KINDS, newSeat, parentsOf, seatById, slug, uniqId, type Endpoint, type MsgKind, type Route, type Team, type TeamLayout } from '@cora/shared';

export type Sel = { kind: 'seat' | 'group' | 'route'; ids: string[] } | null;

const UNSAFE_KEY = /^(__proto__|constructor|prototype)$/;
const unsafe = (path: string): boolean => path.split('.').some((k) => UNSAFE_KEY.test(k));

export const getPath = (o: unknown, path: string): unknown => (unsafe(path) ? undefined : path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Record<string, unknown>)[k]), o));
function setPath(o: Record<string, unknown>, path: string, v: unknown): void {
  if (unsafe(path)) return;
  const ks = path.split('.');
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    a = a[ks[i]] as Record<string, unknown>;
  }
  const last = ks[ks.length - 1];
  if (v === undefined) delete a[last];
  else a[last] = v;
}
/** Fields a definition may leave out: emptied, they go (required ones, like instructions, skills or members, stay as empty). */
const OPTIONAL_LIST = /^(agent\.(tools|disallowedTools|permissions\.(allow|ask|deny))|labels\.[^.]+|template\.fields)$/;
const OPTIONAL_TEXT = /^(lead|agent\.(model|effort|permissionMode)|startup\.(prompt|monitor)|limits\.quiet\.(from|to))$/;

/** Routes that are gone: a rule scoped to one loses that scope (and has none left if it had only that). */
function forgetRoutes(team: Team, ids: string[]): void {
  if (!ids.length) return;
  for (const e of team.escalation) {
    if (e.scope?.route && ids.includes(e.scope.route)) {
      delete e.scope.route;
      if (!Object.keys(e.scope).length) delete e.scope;
    }
  }
}
/** Drop the routes `keep` refuses; the ids of those dropped are forgotten by the escalation rules. */
function pruneRoutes(team: Team, keep: (r: Route) => boolean): number {
  const before = team.routes;
  team.routes = before.filter(keep);
  forgetRoutes(team, before.filter((r) => !team.routes.includes(r)).map((r) => r.id));
  return before.length - team.routes.length;
}

/** A group's growth and split only name its members: when one leaves, what pointed at it goes. */
const leaves = (g: Team['groups'][number], id: string): void => {
  g.members = g.members.filter((m) => m !== id);
  if (g.grow?.seat === id) delete g.grow;
  if (g.split) {
    for (const k of Object.keys(g.split.to)) if (g.split.to[k] === id) delete g.split.to[k];
    if (g.split.else === id) delete g.split.else;
  }
};

export function addSeat(t: Team, folder: string): { team: Team; id: string } {
  const team = clone(t);
  let name = 'New seat';
  for (let n = 2; team.seats.some((s) => s.name === name); n++) name = `New seat ${n}`;
  const id = uniqId(team, 'new-seat');
  team.seats.push(newSeat(id, name, folder));
  return { team, id };
}

/** A route drawn on the canvas: it carries anything, and asks you before waking (the safe default). */
export function createRoute(t: Team, from: Endpoint, to: Endpoint): { team: Team; id: string } {
  const team = clone(t);
  let n = 1;
  while (team.routes.some((r) => r.id === `r-${n}`)) n++;
  const id = `r-${n}`;
  team.routes.push({ id, from: [from], to, kinds: 'any', wake: 'ask' });
  return { team, id };
}

/** Delete what's selected; routes to a deleted seat (or only from it) go too, and the notice says so. */
export function deleteSel(t: Team, sel: NonNullable<Sel>): { team: Team; notice: string } {
  const team = clone(t);
  if (sel.kind === 'route') {
    pruneRoutes(team, (r) => !sel.ids.includes(r.id));
    return { team, notice: '' };
  }
  if (sel.kind === 'seat') {
    const gone: string[] = [];
    for (const id of sel.ids) {
      const s = seatById(team, id);
      if (!s) continue;
      gone.push(s.name);
      team.seats = team.seats.filter((x) => x.id !== id);
      for (const g of team.groups) {
        g.members = g.members.filter((m) => m !== id);
        if (g.split) {
          for (const k of Object.keys(g.split.to)) if (g.split.to[k] === id) delete g.split.to[k];
          if (g.split.else === id) delete g.split.else;
        }
        if (g.grow?.seat === id) delete g.grow;
      }
    }
    const eps = sel.ids.map((i) => `seat:${i}`);
    for (const r of team.routes) r.from = r.from.filter((f) => !eps.includes(f));
    const lost = pruneRoutes(team, (r) => r.from.length > 0 && !eps.includes(r.to));
    if (eps.includes(team.fallback)) team.fallback = 'user';
    if (team.lead && sel.ids.includes(team.lead)) delete team.lead;
    return { team, notice: `Removed ${listWords(gone)}${lost ? `, and ${lost} route${lost > 1 ? 's' : ''} that went to or only from ${gone.length > 1 ? 'them' : 'it'}` : ''}.` };
  }
  const names: string[] = [];
  let lost = 0;
  for (const id of sel.ids) {
    const g = groupById(team, id);
    if (!g) continue;
    names.push(g.name);
    const ep = `group:${g.id}`;
    for (const p of parentsOf(team, g.id)) {
      p.members = p.members.flatMap((m) => (m === g.id ? g.members.filter((x) => !p.members.includes(x)) : [m]));
      if (p.split) {
        for (const k of Object.keys(p.split.to)) if (p.split.to[k] === g.id) delete p.split.to[k];
        if (p.split.else === g.id) delete p.split.else;
      }
    }
    team.groups = team.groups.filter((x) => x.id !== g.id);
    for (const r of team.routes) r.from = r.from.filter((f) => f !== ep);
    lost += pruneRoutes(team, (r) => r.from.length > 0 && r.to !== ep);
    if (team.fallback === ep) team.fallback = 'user';
    for (const e of team.escalation) {
      if (e.scope?.group === g.id) {
        delete e.scope.group;
        if (!Object.keys(e.scope).length) delete e.scope;
      }
    }
  }
  if (!names.length) return { team, notice: '' };
  const what = names.length > 1 ? `the groups ${listWords(names)}` : `the group ${names[0]}`;
  return { team, notice: `Removed ${what} (${names.length > 1 ? 'their' : 'its'} members stay)${lost ? `, and ${lost} route${lost > 1 ? 's' : ''} to or from ${names.length > 1 ? 'them' : 'it'}` : ''}.` };
}

/** Seats grouped: out of any group they all shared, into the new one (which goes where they were). */
export function groupThem(t: Team, ids: string[]): { team: Team; id: string } {
  const team = clone(t);
  if (!ids.length) return { team, id: '' };
  const common = parentsOf(team, ids[0]).filter((p) => ids.every((i) => p.members.includes(i)));
  let name = 'New group';
  for (let n = 2; team.groups.some((g) => g.name === name); n++) name = `New group ${n}`;
  const id = uniqId(team, 'new-group');
  team.groups.push({ id, name, members: [...ids], dispatch: 'claim' });
  for (const p of common) {
    for (const i of ids) leaves(p, i);
    p.members.push(id);
  }
  return { team, id };
}

/** A seat dropped in another group's region joins it; dropped outside its own, it leaves it. */
export function moveMembership(t: Team, id: string, drop: { into: string } | { out: true }): { team: Team; notice: string } {
  const team = clone(t);
  const s = seatById(team, id);
  const parents = parentsOf(team, id);
  if (!s) return { team, notice: '' };
  if ('into' in drop) {
    const g = groupById(team, drop.into);
    if (!g || g.members.includes(id)) return { team, notice: '' };
    for (const p of parents) leaves(p, id);
    g.members.push(id);
    return { team, notice: `${s.name} moved into ${g.name}.` };
  }
  if (!parents.length) return { team, notice: '' };
  for (const g of parents) leaves(g, id);
  return { team, notice: `${s.name} left ${listWords(parents.map((g) => g.name))}.` };
}

/** A new name; the id follows it until the seat or group has been applied once (`keepId`), and every reference with it. */
export function renameEntity(t: Team, kind: 'seat' | 'group', id: string, name: string, keepId: boolean): { team: Team; id: string } {
  const team = clone(t);
  const x = kind === 'seat' ? seatById(team, id) : groupById(team, id);
  if (!x) return { team, id };
  x.name = name;
  if (keepId) return { team, id };
  const nu = uniqId(team, slug(name) || kind, id);
  if (nu === id) return { team, id };
  const fix = (e: Endpoint): Endpoint => (e === `seat:${id}` ? `seat:${nu}` : e === `group:${id}` ? `group:${nu}` : e);
  for (const s of team.seats) if (s.id === id) s.id = nu;
  for (const g of team.groups) {
    if (g.id === id) g.id = nu;
    g.members = g.members.map((m) => (m === id ? nu : m));
    if (g.split) {
      for (const k of Object.keys(g.split.to)) if (g.split.to[k] === id) g.split.to[k] = nu;
      if (g.split.else === id) g.split.else = nu;
    }
    if (g.grow?.seat === id) g.grow.seat = nu;
  }
  for (const r of team.routes) {
    r.from = r.from.map(fix);
    r.to = fix(r.to);
  }
  team.fallback = fix(team.fallback);
  if (kind === 'seat' && team.lead === id) team.lead = nu;
  for (const e of team.escalation) if (e.scope?.group === id) e.scope.group = nu;
  return { team, id: nu };
}
/** Its place and colour follow a renamed id. */
export function renameInLook(look: TeamLayout, from: string, to: string): TeamLayout {
  if (from === to) return look;
  const pos = { ...look.pos };
  if (pos[from]) (pos[to] = pos[from]), delete pos[from];
  const color = look.color ? { ...look.color } : undefined;
  if (color?.[from]) (color[to] = color[from]), delete color[from];
  return { pos, ...(color ? { color } : {}) };
}

/** The object an edit is to: the selected seat, group or route, else the team. */
function target(team: Team, sel: Sel): Record<string, unknown> | undefined {
  if (!sel) return team as unknown as Record<string, unknown>;
  const id = sel.ids[0];
  const o = sel.kind === 'seat' ? seatById(team, id) : sel.kind === 'group' ? groupById(team, id) : team.routes.find((r) => r.id === id);
  return o as unknown as Record<string, unknown> | undefined;
}

/** The inspector's edits (as you type), with what some of them also mean (a split's label, growth, quiet hours…). */
export function editField(t: Team, sel: Sel, path: string, value: unknown): Team {
  const team = clone(t);
  const o = target(team, sel);
  if (!o || unsafe(path)) return team;
  const esc = /^escalation\.(\d+)\./.exec(path);
  if (esc && (sel || !team.escalation[Number(esc[1])])) return team;
  if (path === 'split.label') {
    const cur = o.split as { label: string } | undefined;
    if (!value) delete o.split;
    else o.split = cur?.label === value ? cur : { label: value, to: {} };
  } else if (path === 'grow.seat') {
    const cur = o.grow as { max: number } | undefined;
    if (!value) delete o.grow;
    else o.grow = { seat: value, max: cur?.max ?? Math.max(2, seatById(team, String(value))?.count.max ?? 2) };
  } else if (/^escalation\.\d+\.scope\.group$/.test(path)) {
    // the group only: the rest of its scope (its severities, its route) stays
    const e = team.escalation[Number(path.split('.')[1])];
    if (value) e.scope = { ...e.scope, group: String(value) };
    else if (e.scope) {
      delete e.scope.group;
      if (!Object.keys(e.scope).length) delete e.scope;
    }
  } else {
    const gone = (Array.isArray(value) && !value.length && OPTIONAL_LIST.test(path)) || (value === '' && OPTIONAL_TEXT.test(path));
    setPath(o, path, gone ? undefined : value);
    if (/^escalation\.\d+\.when$/.test(path) && value === 'critical') delete team.escalation[Number(path.split('.')[1])].after;
    const agent = o.agent as { permissions?: Record<string, unknown> } | undefined;
    if (agent?.permissions && !Object.keys(agent.permissions).length) delete agent.permissions;
    const lim = o.limits as Record<string, unknown> | undefined;
    if (lim) {
      const q = lim.quiet as Record<string, unknown> | undefined;
      if (q && !q.from && !q.to) delete lim.quiet;
      if (!Object.keys(lim).length) delete o.limits;
    }
    const tpl = o.template as { fields?: string[] } | undefined;
    if (tpl && !tpl.fields?.length) delete o.template;
    const labels = o.labels as Record<string, unknown> | undefined;
    if (sel?.kind === 'route' && labels && !Object.keys(labels).length) delete o.labels;
  }
  return team;
}

/** A route's kinds: 'any', or the ones picked in the usual order (none left: any). */
export function toggleKind(kinds: Route['kinds'], k: MsgKind | 'any'): Route['kinds'] {
  if (k === 'any') return 'any';
  const cur = kinds === 'any' ? [] : [...kinds];
  const i = cur.indexOf(k);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(k);
  const out = MSG_KINDS.filter((x) => cur.includes(x));
  return out.length ? out : 'any';
}
export function toggleIn(list: string[] | undefined, v: string): string[] {
  const xs = [...(list ?? [])];
  const i = xs.indexOf(v);
  if (i >= 0) xs.splice(i, 1);
  else xs.push(v);
  return xs;
}
/** You're typing: in an input, a text area, a select, or editable text (the builder's keys leave it alone). */
export const isTyping = (el: Element | null | undefined) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!(el as HTMLElement).isContentEditable);
