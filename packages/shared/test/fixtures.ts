import { clone, exampleTeam, newSeat, type Team } from '../src/index';

export const drill = (): Team => exampleTeam();
const seat = (t: Team, id: string) => t.seats.find((s) => s.id === id)!;
const group = (t: Team, id: string) => t.groups.find((g) => g.id === id)!;
const route = (t: Team, id: string) => t.routes.find((r) => r.id === id)!;

/** The draft left last time: encoder work a pool of up to 2 (its logs readable), the analysts' answers need the user's OK. */
export function drillDraft(): Team {
  const t = clone(exampleTeam());
  const e = seat(t, 'analyst-enc');
  e.count = { min: 1, max: 2 };
  e.idleCloseMin = 3;
  e.agent.permissions!.allow!.push('Read(//logs/**)');
  group(t, 'encoder-analysts').grow = { seat: 'analyst-enc', max: 2 };
  route(t, 'r-back').wake = 'ask';
  seat(t, 'triage').instructions = "You are the hub for tonight's drill. Read each report, set its severity and its issue type (encoder, network or ingest), open an incident for it, and hand it to Analysts with the issue label. Answer the analysts' questions.";
  return t;
}

/** The lead's proposal: an ingest analyst, Monitor B gone, the encoder pool to 3. */
export function drillProposal(): Team {
  const t = clone(exampleTeam());
  t.seats.push(newSeat('analyst-ing', 'Ingest analyst', 'C:\\ops\\drill', { instructions: 'Claim ingest incidents offered to you. Check the ingest queue and the recorder logs; say what you found and close it, or ask Triage.', agent: { model: 'sonnet', effort: 'medium', tools: ['Read', 'Bash'], permissions: { allow: ['Read(//logs/**)'] } }, skills: ['ingest-runbook'], count: { min: 0, max: 1 }, idleCloseMin: 5 }));
  t.groups.push({ id: 'ingest-analysts', name: 'Ingest analysts', members: ['analyst-ing'], dispatch: 'claim', grow: { seat: 'analyst-ing', max: 1 } });
  const a = group(t, 'analysts');
  a.members.push('ingest-analysts');
  a.split!.to.ingest = 'ingest-analysts';
  route(t, 'r-handoff').labels!.issue.push('ingest');
  t.seats = t.seats.filter((s) => s.id !== 'monitor-b');
  route(t, 'r-monitors').from = ['seat:monitor-a'];
  seat(t, 'analyst-enc').count = { min: 1, max: 3 };
  return t;
}

/** What Cora saved meanwhile (version 5): the network analyst capped, the analysts' answers never wake Triage. */
export function drillTheirs(): Team {
  const t = clone(exampleTeam());
  t.version = 5;
  seat(t, 'analyst-net').limits = { turnsPerHour: 20 };
  route(t, 'r-back').wake = 'never';
  return t;
}
