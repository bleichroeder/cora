import type { Family } from '@cora/shared';
import type { Item, Step } from './steps';

type ToolItem = Extract<Item, { kind: 'tool' }>;

/** Consecutive tool calls of one kind, as one row ("Read 5 files", "Ran 4 commands · 1 failed"). */
export type Group = { key: string; cls: string; family: Family; label: string; detail: string; items: ToolItem[]; failed: number };

/** What a turn did between your prompt and its answer, in order. */
export type WorkPart =
  | { kind: 'group'; g: Group }
  /** words it wrote while it worked (not its answer) */
  | { kind: 'note'; key: string; text: string; said?: { id: string; text: string } }
  /** a message you sent while it worked, where it got it */
  | { kind: 'mid'; key: string; text: string }
  /** a subagent's stretch of work (its task and steps), as one row */
  | { kind: 'agent'; step: Step }
  /** a background agent's work after the turn ended, folded */
  | { kind: 'fold'; step: Step }
  /** anything else it did (a spawn, a report, compaction) */
  | { kind: 'item'; item: Item };

export type Turn = {
  key: string;
  ts: number;
  prompt?: { text: string; ts: number };
  /** a scheduled wakeup started it (what Claude Code said) */
  wake?: string;
  /** a command you ran yourself (`!` or a `/` command Claude Code answers): a turn of its own */
  ran?: Step;
  work: WorkPart[];
  /** what Claude Code's terminal recorded during it (errors, limits, notices, links) */
  notices: Item[];
  /** the last thing it said in the turn: what you read the turn for */
  answer?: { key: string; text: string; said?: { id: string; text: string } };
  stats: { ms?: number; tools: number; byCls: Record<string, number>; editedFiles: number; failed: number; agents: number; thinkMs: number };
  /** how it ended: turn_end or interrupt */
  end?: Item;
  /** the turn that's still going (the last one, while the session works) */
  live: boolean;
  /** the steps it was made from (the timeline's playhead finds its turn by them) */
  stepKeys: string[];
};

const READ = new Set(['Read', 'NotebookRead']);
const SEARCH = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const RUN = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Monitor']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB = new Set(['WebFetch', 'WebSearch']);
const TASKS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/** What kind of step a tool call is, for grouping: read, search, run, edit, web, an MCP server's, or its family. */
export function toolClass(name: string, family: Family): string {
  if (READ.has(name)) return 'read';
  if (SEARCH.has(name)) return 'search';
  if (RUN.has(name)) return 'run';
  if (EDIT.has(name)) return 'edit';
  if (WEB.has(name)) return 'web';
  if (TASKS.has(name)) return 'tasks';
  if (name === 'Skill') return 'skill';
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp) return `mcp:${mcp[1].replace(/^plugin_[^_]+_/, '')}`;
  return family;
}

const tev = (i: ToolItem) => i.end ?? i.start;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fileOf = (i: ToolItem) => tev(i)?.tool?.resource ?? tev(i)?.tool?.summary ?? i.key;

function label(cls: string, items: ToolItem[]): string {
  const n = items.length;
  if (cls === 'read') return `Read ${plural(new Set(items.map(fileOf)).size, 'file')}`;
  if (cls === 'search') return `Searched ${plural(n, 'time')}`;
  if (cls === 'run') return `Ran ${plural(n, 'command')}`;
  if (cls === 'edit') return `Edited ${plural(new Set(items.map(fileOf)).size, 'file')}`;
  if (cls === 'web') return `Looked on the web ${plural(n, 'time')}`;
  if (cls === 'tasks') return n === 1 ? 'Updated its tasks' : `Updated its tasks ${n} times`;
  if (cls === 'skill') return n === 1 ? 'Used a skill' : `Used ${n} skills`;
  if (cls.startsWith('mcp:')) return `${cls.slice(4)} · ${plural(n, 'call')}`;
  const name = tev(items[0])?.tool?.name ?? 'step';
  return items.every((i) => tev(i)?.tool?.name === name) ? `${name} · ${plural(n, 'call')}` : plural(n, 'step');
}

/** What a group touched, in a few words: files by name, anything else by what it says it did (never a bucket's name like "shell"). */
function detail(cls: string, items: ToolItem[]): string {
  const seen: string[] = [];
  const file = cls === 'read' || cls === 'edit';
  for (const i of items) {
    const t = tev(i)?.tool;
    const raw = (file ? t?.resource ?? t?.summary : t?.summary) ?? '';
    const s = (file ? raw.split(/[\\/]/).pop() ?? '' : raw.replace(/\s+/g, ' ')).trim().slice(0, 48);
    if (s && !seen.includes(s)) seen.push(s);
    if (seen.length >= 3) break;
  }
  return seen.join(' · ');
}

const newTurn = (key: string, ts: number, fields: Partial<Turn> = {}): Turn => ({
  key, ts, work: [], notices: [], stats: { tools: 0, byCls: {}, editedFiles: 0, failed: 0, agents: 0, thinkMs: 0 }, live: false, stepKeys: [], ...fields,
});

/**
 * The transcript as turns: each prompt (or a scheduled wakeup, or a command you ran) starts one; what it did folds
 * into its work (consecutive tool calls of a kind grouped, words it wrote along the way kept as notes, subagents as a
 * row each); the last thing it said is its answer. `live`: the session is working, so the last turn is still going
 * (words followed by more work aren't its answer yet).
 */
export function buildTurns(steps: Step[], live: boolean): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const edited = new Map<Turn, Set<string>>();
  const turnFor = (s: Step): Turn => {
    if (!cur) {
      cur = newTurn(`${s.key}#turn`, s.ts);
      turns.push(cur);
    }
    return cur;
  };
  const addTool = (t: Turn, i: ToolItem) => {
    const ev = tev(i);
    const cls = toolClass(ev?.tool?.name ?? '', ev?.icon.family ?? 'mind');
    const failed = i.end?.tool?.failed ? 1 : 0;
    t.stats.tools++;
    t.stats.byCls[cls] = (t.stats.byCls[cls] ?? 0) + 1;
    t.stats.failed += failed;
    if (cls === 'edit') {
      const set = edited.get(t) ?? new Set<string>();
      set.add(fileOf(i));
      edited.set(t, set);
      t.stats.editedFiles = set.size;
    }
    const last = t.work.at(-1);
    if (last?.kind === 'group' && last.g.cls === cls) {
      last.g.items.push(i);
      last.g.failed += failed;
      return;
    }
    t.work.push({ kind: 'group', g: { key: `${i.key}#g`, cls, family: ev?.icon.family ?? 'mind', label: '', detail: '', items: [i], failed } });
  };

  for (const s of steps) {
    if (s.ran) {
      turns.push(newTurn(`${s.key}#turn`, s.ts, { ran: s, stepKeys: [s.key] }));
      cur = null;
      continue;
    }
    if (s.fold) {
      turnFor(s).stepKeys.push(s.key);
      turnFor(s).work.push({ kind: 'fold', step: s });
      continue;
    }
    if (s.agentId !== 'main') {
      turnFor(s).stepKeys.push(s.key);
      turnFor(s).work.push({ kind: 'agent', step: s });
      continue;
    }
    if (s.wake) {
      cur = newTurn(`${s.key}#turn`, s.ts, { wake: s.wake });
      turns.push(cur);
    } else if (s.prompt && !s.mid) {
      cur = newTurn(`${s.key}#turn`, s.ts, { prompt: { text: s.prompt, ts: s.ts } });
      turns.push(cur);
    }
    const t = turnFor(s);
    t.stepKeys.push(s.key);
    if (s.prompt && s.mid) t.work.push({ kind: 'mid', key: `${s.key}#mid`, text: s.prompt });
    // main went on after its turn ended (a background agent reported, a task finished): the turn isn't over
    if (t.end && (s.text || s.said) && !s.items.includes(t.end)) t.end = undefined;
    if (s.text?.trim() || s.said) t.work.push({ kind: 'note', key: s.key, text: s.text?.trim() ?? '', ...(s.said ? { said: s.said } : {}) });
    for (const i of s.items) {
      if (i.kind === 'tool') {
        if (t.end && 'e' in t.end && ((i.start ?? i.end)?.ts ?? 0) > t.end.e.ts) t.end = undefined;
        addTool(t, i);
      }
      else if (i.kind === 'think') t.stats.thinkMs += i.e.durationMs ?? 0;
      else if (i.kind === 'notice') t.notices.push(i);
      else if (i.kind === 'turn_end' || i.kind === 'interrupt') {
        t.end = i;
        if (i.kind === 'turn_end' && i.e.durationMs) t.stats.ms = (t.stats.ms ?? 0) + i.e.durationMs;
      } else {
        if (i.kind === 'spawn') t.stats.agents++;
        t.work.push({ kind: 'item', item: i });
      }
    }
  }

  turns.forEach((t, n) => {
    // over once main ended it, whatever its background agents still do
    t.live = live && n === turns.length - 1 && !t.ran && !t.end;
    for (const p of t.work) if (p.kind === 'group') ((p.g.label = label(p.g.cls, p.g.items)), (p.g.detail = detail(p.g.cls, p.g.items)));
    // its answer: the last thing it said, unless it's still working after it
    const at = t.work.map((p) => p.kind).lastIndexOf('note');
    if (at < 0) return;
    const after = t.work.slice(at + 1).some((p) => p.kind === 'group' || p.kind === 'agent' || p.kind === 'item');
    if (t.live && after) return;
    const p = t.work[at] as Extract<WorkPart, { kind: 'note' }>;
    t.answer = { key: p.key, text: p.text, ...(p.said ? { said: p.said } : {}) };
    t.work.splice(at, 1);
  });
  return turns;
}

/** A turn's work in a few words: "read 3 files · searched 4 · ran 2 · edited 1 file · 1 failed · 1 agent". */
export function workSummary(t: Turn): string {
  const c = t.stats.byCls;
  const out: string[] = [];
  if (c.read) out.push(`read ${plural(c.read, 'file')}`);
  if (c.search) out.push(`searched ${c.search}`);
  if (c.run) out.push(`ran ${c.run}`);
  if (t.stats.editedFiles) out.push(`edited ${plural(t.stats.editedFiles, 'file')}`);
  if (c.web) out.push(`web ${c.web}`);
  const known = new Set(['read', 'search', 'run', 'edit', 'web', 'tasks']);
  const rest = Object.entries(c).filter(([k]) => !known.has(k)).reduce((n, [, v]) => n + v, 0);
  if (rest) out.push(`${rest} more`);
  if (t.stats.failed) out.push(`${t.stats.failed} failed`);
  if (t.stats.agents) out.push(plural(t.stats.agents, 'agent'));
  return out.join(' · ');
}
