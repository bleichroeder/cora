/**
 * In words: the team read as short sentences,
 * one per route or rule, sources first; and the one-line summaries of a change Cora's turns show.
 */
import { DEFAULT_ESCALATION_AFTER, endpointName, endpointsOf, poolCap, seatsOf, type Endpoint, type Escalation, type Group, type MsgKind, type Route, type Seat, type Team } from './teams';
import { bold, cap, countOf, gap, groupById, idOf, listSegs, listWords, memberEp, numWord, plural, rich, routeName, sameValue, seatById, segs, type Rich, type Seg } from './teamHelpers';
import { layersOf } from './teamLayout';
import type { LintCtx, LintTarget } from './teamLint';

export type WordsLine = Rich & { section: 'flow' | 'sits' | 'also'; targets: LintTarget[]; quiet?: true };

const KIND_ORDER: MsgKind[] = ['handoff', 'report', 'note', 'question', 'change', 'decision'];
const NOUN: Record<string, string> = { report: 'reports', handoff: 'work', question: 'questions', note: 'notes', change: 'changes', decision: 'decisions' };
const THEN_W: Record<Escalation['then'][number], string> = { reoffer: "it's offered again", 'nudge-owner': 'its owner is nudged', 'tell-lead': 'the lead is told', 'tell-user': "you're told", 'dm-user': 'you get a DM' };
const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

/** The main clause of a route: "reports to Triage", "hands encoder issues to the Analysts", "answers Triage with notes". */
function clause(r: Route, pl: boolean, T: Seg[], reply: boolean, w: string): Seg[] {
  const v = (p: string, s: string) => (pl ? p : s);
  if (r.kinds === 'any') return segs('may message ', T, w ? ` about ${w}` : ' about anything');
  const main = KIND_ORDER.filter((k) => (r.kinds as MsgKind[]).includes(k));
  if (!main.length) return segs(`${v('message', 'messages')} `, T, ' directly');
  if (reply) return segs(`${v('answer', 'answers')} `, T, ` with ${listWords(main.map((k) => NOUN[k]))}`);
  const [p, ...rest] = main;
  let c: Seg[];
  if (p === 'handoff') c = segs(`${v('hand', 'hands')} ${w || 'work'} to `, T);
  else if (p === 'report') c = segs(`${v('report', 'reports')} ${w ? `${w} ` : ''}to `, T);
  else return segs(`${v('send', 'sends')} `, T, ` ${listWords(main.map((k) => NOUN[k]))}${w ? ` about ${w}` : ''}`);
  if (rest.length) c.push({ t: `, and ${v('send', 'sends')} it ${listWords(rest.map((k) => NOUN[k]))}` });
  return c;
}

/** The route order In words reads: sources first, an answer right after the route it answers. */
function flowOrder(t: Team, epLayer: (e: Endpoint) => number, hit: (a: Endpoint, b: Endpoint) => boolean): Route[] {
  const byFlow = t.routes
    .map((r, i) => ({ r, i, l: Math.min(...r.from.map(epLayer)) }))
    .sort((a, b) => a.l - b.l || a.i - b.i)
    .map((x) => x.r);
  const answersTo = (r: Route, d: Route) => r !== d && epLayer(r.to) < Math.min(...r.from.map(epLayer)) && r.from.some((f) => hit(f, d.to)) && d.from.some((f) => hit(f, r.to));
  const isAnswer = (r: Route) => byFlow.some((d) => answersTo(r, d));
  const sorted: Route[] = [];
  for (const r of byFlow)
    if (!isAnswer(r)) {
      sorted.push(r);
      for (const x of byFlow) if (answersTo(x, r) && !sorted.includes(x)) sorted.push(x);
    }
  for (const r of byFlow) if (!sorted.includes(r)) sorted.push(r);
  return sorted;
}

/** Each escalation rule as a clause: what it waits for, and each step with its own time. */
function escalationWords(t: Team): string[] {
  return t.escalation.map((e) => ruleWords(t, e));
}
/** One escalation rule as a sentence of its own (the Team panel's), as In words says it. */
export function escalationSentence(t: Team, e: Escalation): string {
  const w = ruleWords(t, e);
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}.`;
}
function ruleWords(t: Team, e: Escalation): string {
  const g = e.scope?.group ? groupById(t, e.scope.group) : undefined;
  const scope = `${g ? ` in the ${g.name}` : ''}${e.scope?.severity?.length ? ` (${e.scope.severity.join(' or ')} only)` : ''}`;
  const th = e.then.map((x) => THEN_W[x]);
  if (!e.then.length) return `${{ critical: 'anything critical', unclaimed: 'work nobody claims', stale: 'an owner going quiet', blocked: 'work a limit or a checkpoint holds up' }[e.when]}${scope}: nothing happens yet (the rule has no steps)`;
  if (e.when === 'critical') {
    const who = e.then.map((x) => ({ 'tell-user': 'you', 'dm-user': 'you, as a DM', 'tell-lead': 'the lead' })[x as string]).filter((x): x is string => !!x);
    return who.length === e.then.length ? `anything critical${scope} reaches ${listWords(who)} at once` : `anything critical${scope} is handled at once: ${listWords(th)}`;
  }
  // each step fires its own number of minutes later: the first after `after`, the next after twice that, and so on
  const every = e.after ?? DEFAULT_ESCALATION_AFTER;
  const lead = e.when === 'unclaimed' && e.then[0] === 'reoffer';
  const steps = th.map((w, k) => `${k === 0 && lead ? 'is offered again' : w} after ${minutes((k + 1) * every)}`);
  const stepWords = steps.length > 1 ? `${steps.slice(0, -1).join(', ')}, and ${steps[steps.length - 1]}` : steps.join('');
  if (e.when === 'unclaimed') return `work nobody claims${scope}${lead ? ' ' : ': '}${stepWords}`;
  if (e.when === 'stale') return `if an owner${scope} goes quiet, ${stepWords}`;
  return `if a limit or a checkpoint holds work up${scope}, ${stepWords}`;
}

/** The team in plain words: the flow (a sentence a route), when work sits (the escalation rules), and what else to know. */
export function describeTeam(t: Team, ctx: LintCtx = {}): WordsLine[] {
  const out: WordsLine[] = [];
  const add = (section: WordsLine['section'], r: Rich, targets: LintTarget[] = [], quiet = false) => void out.push({ section, ...r, targets, ...(quiet ? { quiet: true as const } : {}) });
  if (!t.seats.length) {
    add('flow', rich('Nobody is on the team yet. Double-click the canvas for a seat, start from a shape, or build it with Cora.'), [], true);
    return out;
  }
  const { layer } = layersOf(t);
  const epLayer = (e: Endpoint) => (e.startsWith('seat:') ? (layer[idOf(e)] ?? 0) : e.startsWith('group:') ? Math.min(99, ...seatsOf(t, idOf(e)).map((i) => layer[i] ?? 0)) : -1);
  const what = (labels?: Record<string, string[]>) =>
    Object.entries(labels ?? {})
      .filter(([, v]) => v.length)
      .map(([k, v]) => `${listWords(v)} ${plural(k)}`)
      .join(' and ');
  // the wake rule of the route being read: a pool only grows when its route wakes someone
  let curWake: Route['wake'] = 'auto';
  const poolDesc = (s: Seat, g?: Group) => {
    const max = g?.grow ? poolCap(g.grow, s) : s.count.max;
    const min = s.count.min;
    if (max <= 1 && min >= 1) return '';
    if (min >= max) return ` (${numWord(max)} of them)`;
    if (curWake === 'never') return min === 0 ? ' (none are started for it)' : ` (a pool of ${min})`;
    if (min === 0) return ` (started when work arrives, up to ${max})`;
    return ` (a pool of ${min}, growing to ${max} when busy)`;
  };
  // a member as a person would name it: a lone seat by its own name, a pool by its group's
  const memberWords = (id: string, the: boolean): Seg[] => {
    const g = groupById(t, id);
    if (!g) {
      const s = seatById(t, id);
      return s ? segs(bold(s.name), poolDesc(s)) : segs(id);
    }
    const ls = seatsOf(t, g.id).map((x) => seatById(t, x)!);
    if (ls.length === 1 && !g.grow && ls[0].count.max <= 1) return [bold(ls[0].name)];
    return segs(the ? 'the ' : '', bold(g.name), ls.length === 1 ? poolDesc(ls[0], g) : '');
  };
  const epObj = (e: Endpoint): Seg[] => (e === 'user' ? segs('you') : e === 'cora' ? segs('Cora') : memberWords(idOf(e), true));
  const subj = (from: Endpoint[]): { s: Seg[]; pl: boolean } => {
    if (from.length === 1 && from[0].startsWith('group:')) return { s: segs('The ', bold(endpointName(t, from[0]))), pl: true };
    const items = from.map((e): Seg[] => (e.startsWith('group:') ? segs('the ', bold(endpointName(t, e))) : e === 'user' ? segs('you') : e === 'cora' ? segs('Cora') : [bold(endpointName(t, e))]));
    const s = listSegs(items);
    if (s[0]) s[0] = { ...s[0], t: cap(s[0].t) };
    return { s, pl: from.length > 1 };
  };

  // the flow: one sentence per route, sources first, an answer right after the route it answers
  const hit = (a: Endpoint, b: Endpoint) => a === b || endpointsOf(t, a).includes(b) || endpointsOf(t, b).includes(a);
  const done: Route[] = [];
  for (const r of flowOrder(t, epLayer, hit)) {
    const tg: LintTarget[] = [{ kind: 'route', id: r.id }];
    const addT = (e: Endpoint) => {
      const x: LintTarget | null = e.startsWith('seat:') ? { kind: 'seat', id: idOf(e) } : e.startsWith('group:') ? { kind: 'group', id: idOf(e) } : null;
      if (x && !tg.some((y) => y.kind === x.kind && 'id' in y && 'id' in x && y.id === x.id)) tg.push(x);
    };
    r.from.forEach(addT);
    addT(r.to);
    curWake = r.wake;
    const toG = r.to.startsWith('group:') ? groupById(t, idOf(r.to)) : undefined;
    const main = r.kinds === 'any' ? [] : KIND_ORDER.filter((k) => (r.kinds as MsgKind[]).includes(k));
    if (toG && r.from.length === 1 && r.from[0] === r.to) {
      const ks = r.kinds === 'any' ? '' : ` (${listWords([...main.map((x) => NOUN[x]), ...(r.kinds.includes('direct') ? ['direct messages'] : [])])})`;
      const wake: Seg[] = r.wake === 'auto' ? segs('an idle one is woken for it') : r.wake === 'ask' ? segs('an idle one is woken ', bold('only with your OK')) : segs("an idle one doesn't see it until its next prompt");
      add('flow', rich('Everyone in the ', bold(toG.name), ` may message each other${ks}; `, wake, '.'), tg);
      done.push(r);
      continue;
    }
    const reply = done.some((d) => r.from.some((f) => hit(f, d.to)) && d.from.some((f) => hit(f, r.to)));
    const S = subj(r.from);
    const them = main.length === 1 && main[0] === 'handoff' ? 'it' : 'them';
    const body: Seg[] = [...S.s, { t: ' ' }, ...clause(r, S.pl, epObj(r.to), reply, what(r.labels))];
    if (toG?.split) {
      const split = toG.split;
      const label = t.labels.find((l) => l.id === split.label);
      const noun = plural(split.label);
      const covered = Object.keys(split.to).sort((a, b) => (label ? label.values.indexOf(a) - label.values.indexOf(b) : 0));
      const el = split.else;
      const joinAt = el ? [...covered].reverse().find((v) => split.to[v] === el) : undefined;
      // a split that names a seat rather than a group hands the work to everyone in the group
      const toEveryone = (what: string) => gap(`${what} go to everyone in the ${toG.name}, since the split names a seat rather than a group`);
      const parts: Seg[][] = covered.map((v) => {
        const lead = `${v} ones${v === joinAt ? ', and anything else,' : ''}`;
        return groupById(t, split.to[v]) ? segs(`${lead} to `, memberWords(split.to[v], false)) : toEveryone(v === joinAt ? `${v} ones and anything else` : `${v} ones`);
      });
      Object.values(split.to).forEach((m) => addT(memberEp(t, m)));
      if (el) {
        if (joinAt === undefined) parts.push(groupById(t, el) ? segs('anything else to ', memberWords(el, false)) : toEveryone('anything else'));
        addT(memberEp(t, el));
      }
      if (parts.length) body.push({ t: ': ' }, ...parts.flatMap((p, i) => (i ? [{ t: ', ' }, ...p] : p)));
      const missing = !el && label ? label.values.filter((v) => !Object.prototype.hasOwnProperty.call(split.to, v)) : [];
      if (missing.length) body.push(...gap(', but ', listSegs(missing.map((m) => [bold(m)])), ` ${noun} go to everyone in the ${toG.name}, since nothing handles them on its own`));
    }
    let tail: Seg[] = [{ t: '.' }];
    if (toG) {
      const ls = seatsOf(t, toG.id);
      const solo = ls.length === 1 && !toG.grow && (seatById(t, ls[0])?.count.max ?? 1) <= 1;
      if (!solo && ls.length) tail.push({ t: toG.dispatch === 'claim' ? ' Whoever is free first claims it.' : ' The sender picks who gets it.' });
      if (r.wake === 'ask') tail.push(...segs(' Idle members are woken ', bold('only with your OK'), '.'));
      if (r.wake === 'never') tail.push({ t: " Idle members don't see it until their next prompt." });
    } else if (r.to === 'user') tail = segs(`; you see ${them} in Needs you.`);
    else if (r.to !== 'cora') {
      const n = endpointName(t, r.to);
      if (r.wake === 'auto') tail = segs(`; ${n} is woken for ${them}.`);
      else if (r.wake === 'ask') tail = segs(`. If ${n} is idle, it's woken `, bold('only with your OK'), ctx.usuallyIdle?.(idOf(r.to)) ? gap(', and it usually is, so most of these will wait for you') : '', '.');
      else tail = segs(`; ${n} doesn't see ${them} until its next prompt.`);
    }
    if (r.template?.fields.length) tail.push({ t: ` Each must include ${listWords(r.template.fields)}.` });
    add('flow', rich(body, tail), tg);
    done.push(r);
  }

  // when work sits: the escalation rules, in one sentence
  const rules = escalationWords(t);
  if (rules.length) add('sits', rich(`${cap(rules.join('; '))}.`), [{ kind: 'team' }]);
  else add('sits', rich(gap('Nothing happens on its own when work sits: there are no escalation rules yet.')), [{ kind: 'team' }]);

  // also: what isn't connected yet, the fallback
  for (const s of t.seats) {
    const eps = endpointsOf(t, `seat:${s.id}`);
    if (!t.routes.some((r) => eps.includes(r.to) || r.from.some((f) => eps.includes(f)))) add('also', rich(bold(s.name), ' ', gap("isn't connected yet"), ': nobody messages it, and it messages nobody.'), [{ kind: 'seat', id: s.id }]);
  }
  const lead = t.lead ? seatById(t, t.lead) : undefined;
  if (lead) add('also', rich(bold(lead.name), ' leads the team: it proposes changes to the team, and opens and assigns its incidents.'), [{ kind: 'seat', id: lead.id }]);
  for (const g of t.groups) if (!g.members.length) add('also', rich('The ', bold(g.name), ' ', gap('has nobody in it yet'), '.'), [{ kind: 'group', id: g.id }]);
  if (t.fallback !== 'user' && t.fallback !== 'cora') add('also', rich("Anything a seat isn't allowed to send can go to ", epObj(t.fallback), ' instead.'), [t.fallback.startsWith('seat:') ? { kind: 'seat', id: idOf(t.fallback) } : { kind: 'group', id: idOf(t.fallback) }]);
  add('also', rich('You and Cora may message anyone, and anyone may message you.'), [], true);
  return out;
}

/** What changed between two drafts, an item each: seats, then routes, then groups, labels, rules. */
export function changeItems(prev: Team, next: Team): string[] {
  const out: string[] = [];
  for (const s of next.seats) {
    const o = seatById(prev, s.id);
    if (!o) out.push(`added ${s.name}`);
    else if (o.name !== s.name) out.push(`renamed ${o.name} to ${s.name}`);
    else if (!sameValue(o.count, s.count)) out.push(`${s.name}: pool ${countOf(o.count)} → ${countOf(s.count)}`);
    else if (!sameValue(o, s)) out.push(`changed ${s.name}`);
  }
  for (const s of prev.seats) if (!seatById(next, s.id)) out.push(`removed ${s.name}`);
  for (const r of next.routes) {
    const o = prev.routes.find((x) => x.id === r.id);
    if (!o) out.push(`route ${routeName(next, r)}`);
    else if (o.wake !== r.wake && sameValue({ ...o, wake: '' }, { ...r, wake: '' })) out.push(`route ${routeName(next, r)} wakes ${r.wake}`);
    else if (!sameValue(o, r)) out.push(`changed route ${routeName(next, r)}`);
  }
  for (const r of prev.routes) if (!next.routes.some((x) => x.id === r.id)) out.push(`removed route ${routeName(prev, r)}`);
  for (const g of next.groups) {
    const o = groupById(prev, g.id);
    if (!o) out.push(`group ${g.name}`);
    else if (!sameValue(o, g)) out.push(`changed ${g.name}`);
  }
  for (const g of prev.groups) if (!groupById(next, g.id)) out.push(`removed group ${g.name}`);
  if (!sameValue(prev.labels, next.labels)) out.push('changed the labels');
  if (prev.fallback !== next.fallback) out.push(`fallback ${endpointName(next, next.fallback)}`);
  if (prev.lead !== next.lead) out.push(next.lead ? `lead ${seatById(next, next.lead)?.name ?? next.lead}` : 'no lead');
  if (!sameValue(prev.escalation, next.escalation)) out.push('changed the escalation rules');
  for (const k of next.skills ?? []) {
    const o = prev.skills?.find((x) => x.name === k.name);
    if (!o) out.push(`added the team skill ${k.name}`);
    else if (!sameValue(o, k)) out.push(`changed the team skill ${k.name}`);
  }
  for (const k of prev.skills ?? []) if (!next.skills?.some((x) => x.name === k.name)) out.push(`removed the team skill ${k.name}`);
  return out;
}

/** A change on one line, as Cora's turns show it: "added Monitor C · route Monitor C → Triage". */
export function summarizeChange(prev: Team, next: Team): string {
  return changeItems(prev, next).join(' · ') || 'no change';
}

/** What you changed by hand, the way Cora says it back: the first two, then how many more. */
export function editPhrase(prev: Team, next: Team): string {
  const xs = changeItems(prev, next);
  return xs.length > 2 ? `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more` : listWords(xs);
}
