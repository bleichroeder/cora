/**
 * The dry run: what the rules say happens to
 * a message, step by step, without starting anything. A group is resolved as the runtime resolves it (resolveGroup).
 */
import { DEFAULT_ESCALATION_AFTER, endpointName, endpointsOf, groupContains, poolCap, resolveGroup, routeAllows, type Endpoint, type Escalation, type Group, type MsgKind, type Team } from './teams';
import { bold, groupById, idOf, kindsChip, labelsChip, listWords, memberName, mono, rich, routeName, seatById, type Rich } from './teamHelpers';

export type TraceMsg = { from: Endpoint; to: Endpoint; kind: MsgKind; labels?: Record<string, string>; critical?: boolean };
export type TraceStep = Rich & {
  kind: 'route' | 'blocked' | 'template' | 'split' | 'claim' | 'direct' | 'wake' | 'grow' | 'escalate' | 'reach' | 'caveat';
  /** the route it matched, and which of its senders it left from */
  route?: string;
  from?: number;
  /** what to light on the canvas */
  mark?: { kind: 'seat' | 'group'; id: string };
  /** a message no route allows: from where to where */
  blocked?: { from: Endpoint; to: Endpoint };
  /** an escalation's minutes */
  after?: number;
};
/** `reached`: a seat's id, 'user', 'cora', or null (blocked, or a direct group). */
export type Trace = { steps: TraceStep[]; reached: string | null };

export const TRACE_CAVEAT = "A dry run: it doesn't simulate busy or idle members, limits or quiet hours, and a team that isn't running, or a seat stood down, won't grow.";
const THEN_WORDS: Record<Escalation['then'][number], string> = { reoffer: "it's offered again", 'nudge-owner': 'its owner is nudged', 'tell-lead': 'the lead is told', 'tell-user': "you're told", 'dm-user': 'you get a DM' };
const thenWords = (e: Escalation) => listWords(e.then.map((x) => THEN_WORDS[x]));
const severityNote = (e: Escalation) => (e.scope?.severity?.length ? ` (if its severity is ${e.scope.severity.join(' or ')})` : '');

export function traceMessage(t: Team, m: TraceMsg): Trace {
  const steps: TraceStep[] = [];
  const name = (e: Endpoint) => endpointName(t, e);
  const step = (kind: TraceStep['kind'], r: Rich, more: Partial<TraceStep> = {}) => void steps.push({ kind, ...r, ...more });
  const done = (reached: string | null): Trace => {
    step('caveat', rich(TRACE_CAVEAT));
    return { steps, reached };
  };

  // a rule's scope, as the runtime reads it: the group it was offered to, or one that holds it
  // (scoped to a route: the one it matched)
  const inScope = (e: Escalation) => (!e.scope?.group || (!!landed && groupContains(t, e.scope.group, landed))) && (!e.scope?.route || (chk.ok && chk.route.id === e.scope.route));
  const chk = routeAllows(t, m.from, m.to, m.kind, m.labels);
  if (!chk.ok) {
    step('blocked', rich(chk.why), { blocked: { from: m.from, to: m.to } });
    return done(null);
  }
  const r = chk.route;
  if (r.id === 'implicit') step('route', rich(m.to === 'user' ? 'Anyone may message you: no route needed.' : `${name(m.from)} may message anyone: no route needed.`));
  else {
    const mine = endpointsOf(t, m.from);
    const chip = [kindsChip(r), labelsChip(r)].filter(Boolean).join(' · ');
    step('route', rich('Matches ', bold(routeName(t, r)), ' · ', mono(chip), ` · wake ${r.wake}`), { route: r.id, from: Math.max(0, r.from.findIndex((f) => mine.includes(f))) });
    if (r.template?.fields.length) step('template', rich(`It must include ${listWords(r.template.fields)}, or it bounces back to ${name(m.from)}.`));
  }

  let reached: string | null = null;
  let claim: Group | null = null;
  let wake = r.wake;
  let landed = '';
  if (m.to.startsWith('group:')) {
    // down the splits, as resolveGroup goes: a value with nowhere to go (and no else) stays with the group it reached
    let g = groupById(t, idOf(m.to));
    const seen = new Set<string>();
    while (g && !seen.has(g.id)) {
      seen.add(g.id);
      const split = g.split;
      if (!split) break;
      const v = m.labels?.[split.label];
      const hit = v !== undefined && Object.prototype.hasOwnProperty.call(split.to, v) ? split.to[v] : undefined;
      const nextId = hit ?? split.else;
      const nextGroup = nextId ? groupById(t, nextId) : undefined;
      if (!nextId) {
        step('split', rich(`${g.name} splits by ${split.label}, but has nothing for ${v ?? 'a message without it'} and no else: it goes to everyone in ${g.name}.`), { mark: { kind: 'group', id: g.id } });
        break;
      }
      if (!nextGroup) {
        step('split', rich(`${g.name} splits by ${split.label}: ${v ?? 'none'} → `, bold(memberName(t, nextId)), `, a seat rather than a group, so it goes to everyone in ${g.name}.`), { mark: { kind: 'group', id: g.id } });
        break;
      }
      step('split', rich(`${g.name} splits by ${split.label}: `, hit ? mono(v!) : `${v ?? 'none'} isn't listed, so else`, ' → ', bold(nextGroup.name), '.'), { mark: { kind: 'group', id: nextGroup.id } });
      g = nextGroup;
    }
    const land = resolveGroup(t, idOf(m.to), m.labels);
    const names = land.seats.map((id) => seatById(t, id)?.name ?? id);
    if (land.group.dispatch === 'direct') {
      step('direct', rich(`Direct: a message to ${land.group.name} must name one of its members (${names.join(' or ') || 'none'}).`), { mark: { kind: 'group', id: land.group.id } });
      return done(null);
    }
    claim = land.group;
    landed = land.group.id;
    // the runtime checks the route again against the group it lands in, and wakes as that route says
    const again = routeAllows(t, m.from, `group:${land.group.id}`, m.kind, m.labels);
    if (again.ok) wake = again.route.wake;
    step('claim', rich('Claim: an incident is opened for it and offered to the free members of ', bold(land.group.name), ` (${listWords(names) || 'none'}). The first to claim it owns it.`), { mark: { kind: 'group', id: land.group.id } });
    reached = land.seats[0] ?? null;
  } else reached = m.to.startsWith('seat:') ? idOf(m.to) : m.to;

  const who = reached ? (seatById(t, reached)?.name ?? '') : '';
  if (reached === 'user') step('wake', rich('It lands in your Needs you.'));
  else if (reached === 'cora') step('wake', rich('Cora reads it at once.'));
  else if (claim) step('wake', rich(wake === 'auto' ? 'Idle free members are woken at once to see the offer (wake auto).' : wake === 'ask' ? 'Idle free members wait for your OK to be woken: a card in Needs you (wake ask).' : 'Idle members see the offer at their next prompt (wake never).'));
  else if (reached) step('wake', rich(wake === 'auto' ? `If ${who} is idle, it's woken at once (wake auto).` : wake === 'ask' ? `If ${who} is idle, a card in Needs you asks you to wake it (wake ask); without your OK it reads this at its next prompt.` : `${who} isn't woken for it (wake never): it reads this at its next prompt.`));

  if (claim) {
    const grow = claim.grow;
    const gs = grow ? seatById(t, grow.seat) : undefined;
    if (wake === 'never') step('grow', rich("If none is free, it waits: its route never wakes anyone, so nobody new is started for it."));
    else if (grow && gs) {
      const now = Math.max(gs.count.min, 1);
      const cap = poolCap(grow, gs);
      step('grow', rich(cap > now ? `If none is free, Cora starts another ${gs.name} with the work in its first prompt: the pool grows to ${now + 1} of ${cap}.` : `If none is free, it waits: ${gs.name}'s pool is at its most (${cap}).`));
    } else step('grow', rich(`If none is free, it waits for one (${claim.name} doesn't grow).`));
    for (const e of t.escalation) {
      if (!inScope(e) || (e.when !== 'unclaimed' && e.when !== 'stale')) continue;
      const every = e.after ?? DEFAULT_ESCALATION_AFTER;
      // one step at a time, `after` minutes apart
      e.then.forEach((x, k) => {
        const after = (k + 1) * every;
        const first = k === 0;
        const why = e.when === 'unclaimed' ? (first ? 'nobody has claimed it' : 'still nobody has') : first ? 'after a claim with no word from its owner' : 'still no word from its owner';
        step('escalate', rich(mono(`+${after} min`), ` ${why}${first ? severityNote(e) : ''}: ${THEN_WORDS[x]}.`), { after });
      });
    }
  }
  if (m.critical) for (const e of t.escalation) if (e.when === 'critical' && inScope(e)) step('escalate', rich(`It's critical${severityNote(e)}: ${thenWords(e)}, at once.`));
  if (reached) step('reach', rich('Reaches ', bold(reached === 'user' ? 'you' : reached === 'cora' ? 'Cora' : who), '.'), seatById(t, reached) ? { mark: { kind: 'seat', id: reached } } : {});
  return done(reached);
}
