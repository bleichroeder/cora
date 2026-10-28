/**
 * The live board's Spotlight: what Claude decided you should see (Cora's spotlight tool), kept until Claude asks for
 * something else; an approval waiting on you cuts in, then it goes back. Before Claude has asked for anything it
 * follows the session on its own (tests failing or running, a deploy, the pipeline, a live explain, edits),
 * holding each for a while and never repeating a panel already on the page. A pin keeps what it shows. The rest of the
 * board stays as you arranged it. Never the session's browser: that stays where it is, beside the session (and the
 * board's Browser panel is yours alone). Pure: the panel (components/board/Spotlight.tsx) gathers the signals.
 */

export type SpotKind = 'needs' | 'tests' | 'pipeline' | 'deploys' | 'explain' | 'changes' | 'background' | 'ticket' | 'git' | 'terminal' | 'context' | 'agents' | 'touching' | 'tasks' | 'recap' | 'videos';
export type Spot = { k: SpotKind; title?: string; why: string; prio: number };

/** What Claude can ask the Spotlight to show (the spotlight tool's `panel`). */
export const ASKABLE: SpotKind[] = ['pipeline', 'deploys', 'tests', 'changes', 'background', 'ticket', 'git', 'terminal', 'context', 'explain', 'recap'];

export type SpotSignals = {
  now: number;
  /** approvals and questions waiting */
  needs: number;
  /** Claude's latest ask (the spotlight tool) */
  asked?: { k: SpotKind; title?: string; why?: string; at: number };
  testsRunning: boolean;
  testsFailedAt?: number;
  pipeline?: { active: boolean; failedAt?: number };
  deployRolling: boolean;
  /** the live explain written to last */
  live?: { title: string; at: number };
  /** the last file it changed */
  editAt?: number;
  /** Claude Code's latest recap of it (written as you came back) */
  recapAt?: number;
  background: number;
  /** its newest debrief video: being made, or when it was ready */
  video?: { making: boolean; readyAt?: number };
};

/** How long the Spotlight keeps what it shows before something less pressing can take over. */
export const HOLD_MS = 20_000;
/** From this priority up it cuts in at once (you're needed; Claude asked). */
const URGENT = 90;

export const spotKey = (s: Pick<Spot, 'k' | 'title'>) => (s.k === 'explain' ? `explain:${s.title ?? ''}` : s.k);
export function parseKey(key: string): Pick<Spot, 'k' | 'title'> | null {
  if (key.startsWith('explain:')) return { k: 'explain', title: key.slice(8) };
  return ASKABLE.includes(key as SpotKind) || ['needs', 'agents', 'touching', 'tasks', 'videos'].includes(key) ? { k: key as SpotKind } : null;
}

const NAMES: Record<SpotKind, string> = {
  needs: 'Needs you',
  videos: 'Video',
  tests: 'Tests',
  pipeline: 'Pipeline',
  deploys: 'Deploys',
  explain: 'Explain',
  changes: 'Changes',
  background: 'Background',
  ticket: 'Ticket',
  git: 'Git',
  terminal: 'Terminal',
  context: 'Context',
  agents: 'Agents',
  touching: 'Touching',
  tasks: 'Tasks',
  recap: 'Recap',
};
export const spotName = (s: Pick<Spot, 'k' | 'title'>) => (s.k === 'explain' && s.title ? s.title : NAMES[s.k]);

/** Everything worth showing now, most pressing first. */
export function candidates(s: SpotSignals): Spot[] {
  const out: Spot[] = [];
  const within = (at: number | undefined, ms: number) => at != null && s.now - at < ms;
  if (s.needs) out.push({ k: 'needs', why: s.needs === 1 ? 'Waiting on you' : `${s.needs} waiting on you`, prio: 100 });
  if (s.asked) out.push({ k: s.asked.k, ...(s.asked.title ? { title: s.asked.title } : {}), why: s.asked.why || 'Claude asked to show this', prio: 90 });
  if (within(s.testsFailedAt, 3 * 60_000)) out.push({ k: 'tests', why: 'Tests failed', prio: 72 });
  if (s.deployRolling) out.push({ k: 'deploys', why: 'Rolling out', prio: 70 });
  if (s.testsRunning) out.push({ k: 'tests', why: 'Tests running', prio: 68 });
  if (within(s.pipeline?.failedAt, 10 * 60_000)) out.push({ k: 'pipeline', why: 'Pipeline failed', prio: 66 });
  if (s.pipeline?.active) out.push({ k: 'pipeline', why: 'Pipeline running', prio: 60 });
  if (s.live && within(s.live.at, 3 * 60_000)) out.push({ k: 'explain', title: s.live.title, why: 'Live explain', prio: 50 });
  if (s.video?.making) out.push({ k: 'videos', why: 'Making a video', prio: 47 });
  else if (within(s.video?.readyAt, 5 * 60_000)) out.push({ k: 'videos', why: 'Its video is ready', prio: 52 });
  if (within(s.recapAt, 3 * 60_000)) out.push({ k: 'recap', why: 'Where you left off', prio: 45 });
  if (within(s.editAt, 2 * 60_000)) out.push({ k: 'changes', why: 'Editing files', prio: 30 });
  if (s.background) out.push({ k: 'background', why: s.background === 1 ? 'Running in the background' : `${s.background} running in the background`, prio: 20 });
  return out.sort((a, b) => b.prio - a.prio);
}

/** With nothing going on: the first of these not already on the page. */
const QUIET: SpotKind[] = ['agents', 'changes', 'context'];

/**
 * What the Spotlight shows now. `cur`: what it shows and since when; `onPage`: the other panels on the page (never
 * shown twice); `pin`: what you pinned (shown regardless).
 */
export function choose(s: SpotSignals, cur: { spot: Spot; since: number } | null, onPage: Set<string>, pin?: string): Spot {
  if (pin) {
    const p = parseKey(pin);
    if (p) return { ...p, why: 'Pinned', prio: 0 };
  }
  // (what Claude asked for shows even if it's on the page too: Claude decided)
  const list = candidates(s).filter((c) => c.prio >= URGENT || !onPage.has(c.k));
  const top = list[0] ?? { k: QUIET.find((k) => !onPage.has(k)) ?? 'agents', why: 'Nothing in particular', prio: 0 };
  if (!cur || spotKey(top) === spotKey(cur.spot)) return top;
  // still worth showing, and shown only a moment: it stays (unless this is urgent); no longer worth it: it goes
  const still = list.find((c) => spotKey(c) === spotKey(cur.spot));
  return still && top.prio < URGENT && s.now - cur.since < HOLD_MS ? still : top;
}
