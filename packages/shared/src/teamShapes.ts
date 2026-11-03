/**
 * The start sheet's shapes: each asks two
 * or three questions with sensible defaults, then builds named seats, groups, labels and routes.
 */
import type { Endpoint, MsgKind, Route, Seat, Team } from './teams';
import { bold, cap, emptyTeam, listWords, newSeat, numWord, plural, rich, slug, uniqId, type Part, type Rich } from './teamHelpers';

export type ShapeKind = 'hub' | 'pipeline' | 'squad';
export type ShapeAnswers = Record<string, string | boolean>;
export type ShapeField = { key: string; kind: 'text' | 'mono' | 'count' | 'perKind' };
export type ShapeRow = { label: string; hint?: string; fields: ShapeField[] };
export type ShapeInfo = { kind: ShapeKind | 'blank'; title: string; blurb: string; asks: string; rows: ShapeRow[] };

export const SHAPES: ShapeInfo[] = [
  {
    kind: 'hub',
    title: 'Hub and spokes',
    blurb: "Sources report to a hub, which hands work to a pool by label. The ops team's shape.",
    asks: 'asks 4 things',
    rows: [
      { label: 'What are the sources called, and how many?', hint: 'Each one reports to the hub. Several are named A, B, C…', fields: [{ key: 'source', kind: 'text' }, { key: 'count', kind: 'count' }] },
      { label: 'What is the hub called?', fields: [{ key: 'hub', kind: 'text' }] },
      { label: 'What kinds of work does it hand on?', hint: 'Comma-separated. They become a label, so each piece of work says which kind it is.', fields: [{ key: 'kinds', kind: 'mono' }] },
      { label: 'Who takes the work?', fields: [{ key: 'worker', kind: 'text' }, { key: 'perKind', kind: 'perKind' }] },
    ],
  },
  {
    kind: 'pipeline',
    title: 'Pipeline',
    blurb: 'Each seat hands to the next: writing, review, publish.',
    asks: 'asks the steps',
    rows: [{ label: 'What are the steps, in order?', hint: 'Comma-separated. Each step hands its work to the next; the next can send notes and questions back.', fields: [{ key: 'steps', kind: 'text' }] }],
  },
  {
    kind: 'squad',
    title: 'Squad',
    blurb: 'A lead and peers who may all message each other.',
    asks: 'asks 2 things',
    rows: [
      { label: 'What is the lead called?', fields: [{ key: 'lead', kind: 'text' }] },
      { label: 'How many peers?', fields: [{ key: 'peers', kind: 'count' }] },
    ],
  },
  { kind: 'blank', title: 'Blank', blurb: 'You and Cora only. Build it on the canvas.', asks: 'no questions', rows: [] },
];

export const SHAPE_DEFAULTS: Record<ShapeKind, ShapeAnswers> = {
  hub: { source: 'Monitor', count: '3', hub: 'Triage', kinds: 'encoder, network', worker: 'Analyst', perKind: true },
  pipeline: { steps: 'Draft, Review, Publish' },
  squad: { lead: 'Lead', peers: '2' },
};

const LETTERS = 'ABCDEFGHIJKL';
const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** A comma-separated answer as a list: answers that differ only in case are one (the first spelling is kept). */
const csv = (s: string) => {
  const seen = new Set<string>();
  return s
    .split(/,|\band\b/)
    .map((x) => x.trim())
    .filter((x) => x && !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase()));
};
/** The steps of a pipeline (none given: Draft, Review, Publish, as it builds them). */
const stepsOf = (a: ShapeAnswers) => {
  const st = csv(str(a.steps)).map(cap);
  return st.length ? st : ['Draft', 'Review', 'Publish'];
};
const WORKER = { model: 'sonnet', effort: 'medium', tools: ['Read', 'Bash'] };

/** The answers become a team: named seats, groups, a label and routes (positions come from the automatic layout). */
export function buildShape(kind: ShapeKind | 'blank', a: ShapeAnswers, o: { folder: string; version?: number }): Team {
  const t = emptyTeam(o.version ?? 0);
  if (kind === 'blank') return t;
  const seat = (name: string, more: Partial<Omit<Seat, 'id' | 'name'>> = {}) => {
    const id = uniqId(t, slug(name) || 'seat');
    t.seats.push(newSeat(id, name, o.folder, more));
    return id;
  };
  let n = 1;
  const route = (from: Endpoint[], to: Endpoint, kinds: MsgKind[] | 'any', more: Partial<Route> = {}) => t.routes.push({ id: `r-${n++}`, from, to, kinds, wake: 'auto', ...more });

  if (kind === 'hub') {
    const count = clamp(parseInt(str(a.count), 10) || 1, 1, 8);
    const src = cap(str(a.source) || 'Source');
    const hub = cap(str(a.hub) || 'Hub');
    const kinds = csv(str(a.kinds)).map((k) => k.toLowerCase());
    const worker = cap(str(a.worker) || 'Worker');
    const crew = plural(worker);
    const sources = Array.from({ length: count }, (_, i) =>
      seat(count > 1 ? `${src} ${LETTERS[i]}` : src, { instructions: `Watch your feed. Report each new alert to ${hub}: what you saw and since when. Don't diagnose it.`, agent: { model: 'haiku', effort: 'low', tools: ['Read', 'Bash'] } }),
    );
    const hubId = seat(hub, { instructions: `You are the hub. Read each report${kinds.length ? `, decide which kind of work it is (${listWords(kinds)})` : ''}, and hand it to the ${crew.toLowerCase()}${kinds.length ? ' with that label' : ''}. Answer their questions.`, agent: { model: 'sonnet', effort: 'high', tools: ['Read', 'Grep'] } });
    const outer = uniqId(t, slug(crew));
    if (kinds.length) t.labels = [{ id: 'issue', name: 'Issue type', values: kinds }];
    if (kinds.length > 1 && a.perKind !== false) {
      const g = { id: outer, name: crew, members: [] as string[], dispatch: 'claim' as const, split: { label: 'issue', to: {} as Record<string, string> } };
      t.groups.push(g);
      for (const k of kinds) {
        const sid = seat(`${cap(k)} ${worker.toLowerCase()}`, { instructions: `Claim ${k} work offered to you, deal with it, and say what you did. Ask ${hub} if you're stuck.`, agent: WORKER, count: { min: 1, max: 2 }, idleCloseMin: 5 });
        const gid = uniqId(t, slug(`${k} ${crew}`));
        t.groups.push({ id: gid, name: `${cap(k)} ${crew.toLowerCase()}`, members: [sid], dispatch: 'claim', grow: { seat: sid, max: 2 } });
        g.members.push(gid);
        g.split.to[k] = gid;
      }
    } else {
      const sid = seat(worker, { instructions: `Claim the work offered to you, deal with it, and say what you did. Ask ${hub} if you're stuck.`, agent: WORKER, count: { min: 1, max: 3 }, idleCloseMin: 5 });
      t.groups.push({ id: outer, name: crew, members: [sid], dispatch: 'claim', grow: { seat: sid, max: 3 } });
    }
    route(sources.map((i): Endpoint => `seat:${i}`), `seat:${hubId}`, ['report', 'direct']);
    route([`seat:${hubId}`], `group:${outer}`, ['handoff'], kinds.length ? { labels: { issue: [...kinds] } } : {});
    route([`group:${outer}`], `seat:${hubId}`, ['note', 'question']);
    t.fallback = `seat:${hubId}`;
    t.escalation.unshift({ when: 'unclaimed', after: 10, then: ['reoffer', 'tell-lead'] });
  }
  if (kind === 'pipeline') {
    const steps = stepsOf(a);
    const ids = steps.map((s, i) => seat(s, { instructions: i < steps.length - 1 ? `Do the ${s.toLowerCase()} step, then hand the work to ${steps[i + 1]}.` : `Do the ${s.toLowerCase()} step, the last one. Send notes or questions back to ${steps[i - 1] ?? 'the user'} if something is off.` }));
    for (let i = 0; i < ids.length - 1; i++) route([`seat:${ids[i]}`], `seat:${ids[i + 1]}`, ['handoff']);
    for (let i = 1; i < ids.length; i++) route([`seat:${ids[i]}`], `seat:${ids[i - 1]}`, ['note', 'question']);
    t.fallback = `seat:${ids[0]}`;
  }
  if (kind === 'squad') {
    const peers = clamp(parseInt(str(a.peers), 10) || 0, 0, 8);
    const lead = cap(str(a.lead) || 'Lead');
    const ids = [seat(lead, { instructions: 'Lead the squad: split the work, keep it moving, and decide when it is done.', agent: { model: 'opus' } })];
    for (let i = 0; i < peers; i++) ids.push(seat(`Peer ${i + 1}`, { instructions: `Take the work ${lead} gives you; ask the others when you need them.` }));
    const gid = uniqId(t, 'squad');
    t.groups.push({ id: gid, name: 'Squad', members: ids, dispatch: 'direct' });
    route([`group:${gid}`], `group:${gid}`, 'any');
    t.fallback = `seat:${ids[0]}`;
  }
  return t;
}

/** What the answers will build, said before you build it. */
export function previewShape(kind: ShapeKind, a: ShapeAnswers): Rich {
  if (kind === 'hub') {
    const count = clamp(parseInt(str(a.count), 10) || 1, 1, 8);
    const kinds = csv(str(a.kinds)).map((k) => k.toLowerCase());
    const w = (str(a.worker) || 'worker').toLowerCase();
    const src = (str(a.source) || 'source').toLowerCase();
    const pools = kinds.length > 1 && a.perKind !== false ? `${numWord(kinds.length)} pools of ${plural(w)} (${listWords(kinds)}), each growing to 2 when busy` : `one pool of ${plural(w)}, growing to 3 when busy`;
    return rich('Builds ', bold(`${numWord(count)} ${count > 1 ? plural(src) : src}`), ' that report to ', bold(cap(str(a.hub) || 'Hub')), ', which hands work to ', bold(pools), '. Whoever is free first claims it.');
  }
  if (kind === 'pipeline') {
    const st = stepsOf(a);
    const chain: Part[] = st.flatMap((x, i) => (i ? [' → ', bold(x)] : [bold(x)]));
    return rich('Builds ', bold(String(st.length)), ` step${st.length === 1 ? '' : 's'}: `, ...chain, '. Each hands its work to the next, which can send notes and questions back.');
  }
  const peers = clamp(parseInt(str(a.peers), 10) || 0, 0, 8);
  return rich('Builds ', bold(cap(str(a.lead) || 'Lead')), ' and ', bold(`${numWord(peers)} peer${peers === 1 ? '' : 's'}`), ' in one squad, where anyone may message anyone.');
}
