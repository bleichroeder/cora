/**
 * Small pieces the team builder's words, checks and canvas share:
 * sentences as runs of words, the names of what a team holds, and comparing two definitions.
 */
import { endpointName, sameMeaning, type Endpoint, type Group, type Route, type Seat, type Team } from './teams';

/** A run of words: plain, a name in bold, words the checks warn about, or mono. */
export type Seg = { t: string; b?: true; gap?: true; code?: true };
/** A sentence as plain text (for Cora, proposal cards, tests) and as runs (for the screen). */
export type Rich = { text: string; segs: Seg[] };
export type Part = string | Seg | Seg[];

const flat = (parts: Part[]): Seg[] => parts.flatMap((p) => (typeof p === 'string' ? (p ? [{ t: p }] : []) : Array.isArray(p) ? p : [p]));
export const bold = (t: string): Seg => ({ t, b: true });
export const mono = (t: string): Seg => ({ t, code: true });
/** Words the checks warn about (names in them stay bold). */
export const gap = (...parts: Part[]): Seg[] => flat(parts).map((s) => ({ ...s, gap: true as const }));
export const segs = (...parts: Part[]): Seg[] => flat(parts);
export function rich(...parts: Part[]): Rich {
  const s = flat(parts);
  return { text: s.map((x) => x.t).join(''), segs: s };
}

/** "a", "a and b", "a, b and c" */
export function listWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
/** The same, keeping each item's runs (a bold name stays bold). */
export function listSegs(xs: Seg[][]): Seg[] {
  return xs.flatMap((x, i) => [...(i === 0 ? [] : [{ t: i === xs.length - 1 ? ' and ' : ', ' }]), ...x]);
}
export const cap = (s: string) => (s && /[a-z]/.test(s[0]) ? s[0].toUpperCase() + s.slice(1) : s);
export const plural = (w: string) => (/(s|x|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const numWord = (n: number) => NUM[n] ?? String(n);
/** A seat's count in words: "1", "1 to 3". */
export const countOf = (c: Seat['count']) => (c.min === c.max ? `${c.max}` : `${c.min} to ${c.max}`);

export const idOf = (e: string) => e.slice(e.indexOf(':') + 1);
export const seatById = (t: Team, id: string): Seat | undefined => t.seats.find((s) => s.id === id);
export const groupById = (t: Team, id: string): Group | undefined => t.groups.find((g) => g.id === id);
/** A group's member as an endpoint (members are seat or group ids). */
export const memberEp = (t: Team, id: string): Endpoint => (groupById(t, id) ? `group:${id}` : `seat:${id}`);
export const memberName = (t: Team, id: string) => endpointName(t, memberEp(t, id));
export const parentsOf = (t: Team, id: string): Group[] => t.groups.filter((g) => g.members.includes(id));
/** How deep a group sits (0: no group holds it). */
export function depthOf(t: Team, gid: string, path = new Set<string>()): number {
  if (path.has(gid)) return 0;
  path.add(gid);
  const ps = parentsOf(t, gid);
  const d = ps.length ? 1 + Math.max(...ps.map((p) => depthOf(t, p.id, path))) : 0;
  path.delete(gid);
  return d;
}
export const routeName = (t: Team, r: Route) => `${r.from.map((f) => endpointName(t, f)).join(', ')} → ${endpointName(t, r.to)}`;
/** A route's chip on the canvas: its kinds, then its labels. */
export const kindsChip = (r: Route) => (r.kinds === 'any' ? 'any' : r.kinds.join(' · '));
export const labelsChip = (r: Route) =>
  Object.entries(r.labels ?? {})
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k}=${v.join('|')}`)
    .join(' ');
export const dispatchText = (g: Group) => [g.dispatch, g.split ? `split by ${g.split.label}` : '', g.grow ? `grows to ${g.grow.max}` : ''].filter(Boolean).join(' · ');
/** You, Cora, each seat and (unless left out) each group, with the names a picker shows. */
export function endpointOptions(t: Team, o: { groups?: boolean } = {}): Array<[Endpoint, string]> {
  return [
    ['user', 'You'],
    ['cora', 'Cora'],
    ...t.seats.map((s): [Endpoint, string] => [`seat:${s.id}`, s.name || s.id]),
    ...(o.groups === false ? [] : t.groups.map((g): [Endpoint, string] => [`group:${g.id}`, `${g.name} (group)`])),
  ];
}
export const slug = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/**
 * An id no seat or group has yet (`except`: the one being renamed keeps its own). Taken ones get a letter (`triage-b`),
 * never a number: validateTeam refuses `x-2` beside `x` (a pool's copies are named that way).
 */
export function uniqId(t: Team, want: string, except?: string): string {
  const used = new Set([...t.seats.map((s) => s.id), ...t.groups.map((g) => g.id)].filter((x) => x !== except));
  const seatIds = new Set(t.seats.map((s) => s.id).filter((x) => x !== except));
  // validateTeam refuses `x-2` beside seat `x` (it looks like one of x's copies)
  const copyOfSeat = (id: string) => {
    const m = /^(.+)-\d+$/.exec(id);
    return !!m && seatIds.has(m[1]);
  };
  const first = want || 'seat';
  if (!used.has(first) && !copyOfSeat(first)) return first;
  const stem = first.replace(/-\d+$/, '');
  for (let n = 1; ; n++) {
    const id = `${stem}-${String.fromCharCode(97 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ''}`;
    if (!used.has(id) && !copyOfSeat(id)) return id;
  }
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** Two values that say the same (key order and what means nothing don't matter): the team's one meaning of it (sameMeaning). */
export const sameValue = (a: unknown, b: unknown) => sameMeaning(a, b);

/** Shaped like a team (its lists and its fallback there), however wrong what's in them: what a draft must be. */
export function teamShaped(x: unknown): x is Team {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const t = x as Record<string, unknown>;
  return ['seats', 'groups', 'labels', 'routes', 'escalation'].every((k) => Array.isArray(t[k])) && typeof t.fallback === 'string';
}
/** A team with nobody on it: you and Cora, and anything critical reaching you. */
export function emptyTeam(version = 0): Team {
  return { version, seats: [], groups: [], labels: [], routes: [], fallback: 'user', escalation: [{ when: 'critical', then: ['tell-user'] }] };
}
/** A new seat: one session in `folder`, nothing else set. */
export function newSeat(id: string, name: string, folder: string, o: Partial<Omit<Seat, 'id' | 'name'>> = {}): Seat {
  return {
    id,
    name,
    instructions: o.instructions ?? '',
    agent: o.agent ?? {},
    skills: o.skills ?? [],
    folder: o.folder ?? { path: folder },
    count: o.count ?? { min: 1, max: 1 },
    startup: o.startup ?? {},
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.idleCloseMin ? { idleCloseMin: o.idleCloseMin } : {}),
  };
}
