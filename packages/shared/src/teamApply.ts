/**
 * Apply's pieces: rebasing a draft onto a newer
 * team (and undoing one of Cora's turns, the same way backwards), what a change does to running sessions (the team
 * model's table), and how many things changed.
 */
import { diffTeam, renamedBefore, seatedChangeDetails, seatRenames, type Route, type Team } from './teams';
import { clone, countOf, emptyTeam, listWords, routeName, sameValue, seatById } from './teamHelpers';

type Keyed = { id: string } & Record<string, unknown>;
const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? JSON.stringify(v).replace(/[{}"]/g, '').replace(/,/g, ', ') : String(v ?? 'none'));

/** Your draft on top of their newer version: theirs where you didn't touch it, yours (listed) where you both did. */
export function rebaseTeam(oldBase: Team, theirs: Team, mine: Team): { team: Team; conflicts: string[] } {
  const out = clone(mine);
  const conflicts: string[] = [];
  const list = (key: 'seats' | 'groups' | 'routes', label: string, nameOf: (t: Team, x: Keyed) => string) => {
    const B = oldBase[key] as unknown as Keyed[];
    const T = theirs[key] as unknown as Keyed[];
    const O = out[key] as unknown as Keyed[];
    for (const th of T) {
      const ob = B.find((x) => x.id === th.id);
      const mi = O.find((x) => x.id === th.id);
      if (!ob) {
        if (!mi) O.push(clone(th));
        else if (!sameValue(mi, th)) conflicts.push(`${label} ${nameOf(out, mi)}: you both added it, differently. Yours is kept.`);
        continue;
      }
      if (sameValue(ob, th)) continue;
      if (!mi) {
        conflicts.push(`${label} ${nameOf(oldBase, ob)}: they changed it, your draft removes it. Removed.`);
        continue;
      }
      for (const f of new Set([...Object.keys(th), ...Object.keys(ob)])) {
        if (sameValue(ob[f], th[f])) continue;
        if (sameValue(mi[f], ob[f])) {
          if (th[f] === undefined) delete mi[f];
          else mi[f] = clone(th[f]);
        } else if (!sameValue(mi[f], th[f])) conflicts.push(`${label} ${nameOf(out, mi)}, ${f}: they set ${show(th[f])}, your draft has ${show(mi[f])}. Yours is kept.`);
      }
    }
    for (const ob of B) {
      if (T.some((x) => x.id === ob.id)) continue;
      const i = O.findIndex((x) => x.id === ob.id);
      if (i >= 0 && sameValue(O[i], ob)) O.splice(i, 1);
      else if (i >= 0) conflicts.push(`${label} ${nameOf(oldBase, ob)}: they removed it, your draft changes it. Kept.`);
    }
  };
  list('seats', 'Seat', (_t, s) => String(s.name));
  list('groups', 'Group', (_t, g) => String(g.name));
  list('routes', 'Route', (t, r) => routeName(t, r as unknown as Route));
  const rest = out as unknown as Record<string, unknown>;
  for (const k of ['labels', 'fallback', 'escalation', 'skills', 'lead'] as const) {
    if (sameValue(oldBase[k], theirs[k])) continue;
    if (sameValue(out[k], oldBase[k])) {
      if (theirs[k] === undefined) delete rest[k];
      else rest[k] = clone(theirs[k]);
    } else if (!sameValue(out[k], theirs[k])) conflicts.push(`The team's ${k}: you both changed it. Yours is kept.`);
  }
  out.version = theirs.version;
  return { team: out, conflicts };
}

export type SessionEffect = { seat: string; name: string; kind: 'start' | 'restart' | 'tell' | 'now' | 'stop' | 'keep'; text: string };

const RESTART_WORDS: Record<string, string> = { tools: 'tools', disallowedTools: 'tools', model: 'model', effort: 'model', permissionMode: 'permission mode' };

/** What a change does to a running team, seat by seat (the team model's table), and what takes effect at once. It reads diffTeam's change list, the one the runtime acts on. */
/**
 * What Apply does to running sessions, a row per seat, and what changes at once. A seat only renamed (seatRenames: the
 * same name or instructions under a new id) keeps its sessions, adopted into the new id: its row says so, and what else
 * changed in it reads as for any seat. `ending`: seats it stands down, said plainly (their sessions end, and what they
 * run and know goes with them).
 */
export function sessionEffects(prev: Team | undefined, next: Team): { rows: SessionEffect[]; atOnce: string[]; ending?: string } {
  const renames = seatRenames(prev, next);
  const before = prev ? renamedBefore(prev, renames) : emptyTeam(0);
  const rows: SessionEffect[] = renames.map((r) => ({ seat: r.to.id, name: r.to.name, kind: 'keep' as const, text: `renamed from ${r.from.id}: its sessions keep running as ${r.to.name} (and what they run and know), each told its new seat` }));
  const atOnce: string[] = [];
  for (const c of diffTeam(prev ? before : undefined, next)) {
    if (c.kind === 'routes-changed') {
      atOnce.push(...(c.detail ?? '').replace(/ changed$/, '').split(', ').filter(Boolean));
      continue;
    }
    const s = seatById(next, c.seat ?? '') ?? seatById(before, c.seat ?? '');
    const o = seatById(before, c.seat ?? '');
    if (!s) continue;
    const row = (kind: SessionEffect['kind'], text: string) => rows.push({ seat: s.id, name: s.name, kind, text });
    if (c.kind === 'seat-added') row('start', s.count.min > 0 ? `starts: ${s.count.min} session${s.count.min > 1 ? 's' : ''}, and its routes take effect` : 'starts when work first arrives (its minimum is 0)');
    else if (c.kind === 'seat-removed') row('stop', 'stands down: its sessions end (now, or once idle)');
    else if (c.kind === 'seat-retasked') row('tell', 'is told its new instructions now; its full prompt updates at its next restart');
    else if (c.kind === 'seat-restart-needed') {
      const what = [...new Set((c.detail ?? '').replace(/ changed$/, '').split(', ').map((w) => RESTART_WORDS[w] ?? w))];
      row('restart', `waits for your Restart (Team panel) to take its new ${listWords(what)} (Claude Code reads them at start)`);
    } else if (c.kind === 'pool-resized' && o) row('now', `pool ${countOf(o.count)} → ${countOf(s.count)}, at once${s.count.max < o.count.max ? ' (extras close once idle)' : ''}`);
    else if (c.kind === 'watches-changed') row('now', 'its watches are set again, at once');
  }
  const ending = endingWords(before, next);
  return { rows, atOnce, ...(ending ? { ending } : {}) };
}

/** What ends when seats stand down (a seat only renamed doesn't: its sessions are kept); none: null. */
export function endingWords(before: Team, next: Team): string | null {
  const renamed = new Set(seatRenames(before, next).map((r) => r.from.id));
  const gone = before.seats.filter((s) => !seatById(next, s.id) && !renamed.has(s.id));
  if (!gone.length) return null;
  return `${listWords(gone.map((s) => s.name))} ${gone.length > 1 ? 'stand' : 'stands'} down: ${gone.length > 1 ? 'their' : 'its'} sessions end, and with them anything they run (a /loop, a cron, a Monitor) and what they know.`;
}

/** How many things changed (a new seat is one change, however many lines describe it). */
export function changeCount(prev: Team | undefined, next: Team): number {
  const before = prev ?? emptyTeam(0);
  let n = 0;
  const count = (A: Keyed[], B: Keyed[]) => {
    for (const x of B) {
      const o = A.find((y) => y.id === x.id);
      if (!o || !sameValue(o, x)) n++;
    }
    for (const x of A) if (!B.some((y) => y.id === x.id)) n++;
  };
  count(before.seats as unknown as Keyed[], next.seats as unknown as Keyed[]);
  count(before.groups as unknown as Keyed[], next.groups as unknown as Keyed[]);
  count(before.routes as unknown as Keyed[], next.routes as unknown as Keyed[]);
  for (const k of ['labels', 'fallback', 'escalation', 'skills', 'lead'] as const) if (!sameValue(before[k], next[k])) n++;
  return n;
}


export type ApplyLine = { line: string; full?: string };
/** A seat in Apply's sheet: its one line of facts, what's new about it, and its change lines (opened on a click). */
export type ApplySeat = { id: string; name: string; status: 'new' | 'changed' | 'removed' | 'same'; facts: string[]; warn: boolean; lines: ApplyLine[] };
/**
 * What Apply's sheet shows (instead of every change line in one long list): the team in numbers, the few things worth
 * checking (⚠: folders, permissions, risky modes; a folder many new seats share said once), one row per seat, and the
 * rest (routes, groups, labels, rules, team skills) as one group.
 */
export type ApplyOverview = {
  first: boolean;
  counts: { seats: number; routes: number; groups: number; rules: number; sessions: number };
  delta: { added: number; changed: number; removed: number; other: number };
  check: ApplyLine[];
  seats: ApplySeat[];
  rest: ApplyLine[];
};
const WARN_RE = /^⚠️?\s*/;
export function applyOverview(prev: Team | undefined, next: Team): ApplyOverview {
  // each line with the seat it is about (by id: two seats of one name keep their own)
  const seated = seatedChangeDetails(prev, next);
  const details: ApplyLine[] = seated.map(({ seat: _s, ...d }) => d);
  const prevSeats = prev?.seats ?? [];
  const bySeat = new Map<string, ApplyLine[]>();
  const rest: ApplyLine[] = [];
  for (const { seat: id, ...d } of seated) {
    // ("New seat: X (1)" is the row itself)
    if (id && /^New seat: /.test(d.line)) continue;
    if (id) bySeat.set(id, [...(bySeat.get(id) ?? []), d]);
    else rest.push(d);
  }
  const factsOf = (s: Team['seats'][number]) => {
    const a = s.agent ?? {};
    return [
      [a.model || 'default model', a.effort ? `${a.effort} effort` : ''].filter(Boolean).join(' · '),
      a.tools?.length ? `${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}` : 'all tools',
      ...(a.permissionMode && a.permissionMode !== 'default' ? [a.permissionMode] : []),
      ...(s.count.max > 1 || s.count.min !== 1 ? [`×${countOf(s.count)}`] : []),
    ];
  };
  const seats: ApplySeat[] = [
    ...next.seats.map((s): ApplySeat => {
      const lines = bySeat.get(s.id) ?? [];
      const status = !prevSeats.some((o) => o.id === s.id) ? 'new' : lines.length ? 'changed' : 'same';
      // its own risks (a folder is said once, for every seat in it, in check)
      return { id: s.id, name: s.name, status, facts: factsOf(s), warn: lines.some((l) => WARN_RE.test(l.line) && !/ works in /.test(l.line)), lines };
    }),
    ...prevSeats.filter((s) => !seatById(next, s.id)).map((s): ApplySeat => ({ id: s.id, name: s.name, status: 'removed', facts: [], warn: false, lines: bySeat.get(s.id) ?? [] })),
  ];
  // the things worth checking: every ⚠, with "X works in F" for many new seats in one folder said once
  const warns = details.filter((d) => WARN_RE.test(d.line));
  const inFolder = new Map<string, string[]>();
  const check: ApplyLine[] = [];
  for (const w of warns) {
    const m = /^(.+) works in (.+)$/.exec(w.line.replace(WARN_RE, ''));
    if (m && !w.full) inFolder.set(m[2], [...(inFolder.get(m[2]) ?? []), m[1]]);
    else check.push({ line: w.line.replace(WARN_RE, ''), ...(w.full ? { full: w.full.replace(WARN_RE, '') } : {}) });
  }
  const folders = [...inFolder.entries()].map(([f, who]) => ({ line: who.length === next.seats.length && who.length > 1 ? `Every seat works in ${f}` : `${listWords(who)} work${who.length === 1 ? 's' : ''} in ${f}` }));
  return {
    first: !prev,
    counts: { seats: next.seats.length, routes: next.routes.length, groups: next.groups.length, rules: next.escalation.length, sessions: next.seats.reduce((a, s) => a + s.count.min, 0) },
    delta: { added: seats.filter((s) => s.status === 'new').length, changed: seats.filter((s) => s.status === 'changed').length, removed: seats.filter((s) => s.status === 'removed').length, other: rest.length },
    check: [...folders, ...check],
    seats,
    rest,
  };
}
