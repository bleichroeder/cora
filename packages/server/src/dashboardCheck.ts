/**
 * What's wrong with a dashboard's data.json, said to the session that wrote it (a wrong file fails silently otherwise:
 * the page keeps the last good data). Any live explain: it isn't JSON, or it's too big. A kit dashboard (Cora's own
 * page:) as well: blocks the page can't draw as written.
 */

const TYPES = ['stats', 'steps', 'table', 'chart', 'timeline', 'note', 'meters', 'kv', 'log', 'actions'];
const STATES = ['run', 'running', 'doing', 'active', 'ok', 'done', 'pass', 'passed', 'success', 'warn', 'warning', 'bad', 'fail', 'failed', 'error', 'todo', 'pending', 'skip', 'skipped', 'idle'];
/** the lists each block type draws from (a block without its list shows empty) */
const LISTS: Record<string, string> = { stats: 'items', steps: 'items', timeline: 'items', meters: 'items', kv: 'items', table: 'rows', chart: 'series', actions: 'items' };
const MOST = 6;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The problems with a kit dashboard's data (already parsed), the first few; none: []. */
export function kitProblems(data: unknown): string[] {
  const out: string[] = [];
  if (!isObj(data)) return ['the file must be one JSON object: { "title", "status", "blocks": [ … ] }'];
  if (!Array.isArray(data.blocks)) return ['"blocks" must be a list (the page shows nothing without it)'];
  const state = (where: string, v: unknown) => {
    if (v != null && !(typeof v === 'string' && STATES.includes(v.toLowerCase()))) out.push(`${where}: state ${JSON.stringify(v)} isn't one the page knows (run, ok, warn, bad, todo, skip)`);
  };
  if (isObj(data.status)) state('status', data.status.state ?? data.status.text);
  data.blocks.forEach((b, i) => {
    const at = `blocks[${i}]${isObj(b) && typeof b.id === 'string' ? ` ("${b.id}")` : ''}`;
    if (!isObj(b)) return void out.push(`${at} must be an object with a "type"`);
    if (typeof b.type !== 'string' || !TYPES.includes(b.type)) return void out.push(`${at}: type ${JSON.stringify(b.type)} isn't a block (${TYPES.join(', ')})`);
    const list = LISTS[b.type];
    if (list && !Array.isArray(b[list])) out.push(`${at}: a ${b.type} block needs "${list}" (a list)`);
    if (b.type === 'chart') {
      if (b.kind != null && !['line', 'area', 'bar'].includes(String(b.kind))) out.push(`${at}: chart kind ${JSON.stringify(b.kind)} isn't line, area or bar`);
      (Array.isArray(b.series) ? b.series : []).forEach((s, k) => {
        if (!isObj(s) || !Array.isArray(s.values) || s.values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) out.push(`${at}: series[${k}] needs "values" as a list of numbers`);
      });
    }
    if (b.type === 'table' && !Array.isArray(b.columns)) out.push(`${at}: a table needs "columns" (a list)`);
    if (b.type === 'note' && typeof b.text !== 'string') out.push(`${at}: a note needs "text"`);
    if (b.type === 'log' && !Array.isArray(b.lines) && typeof b.text !== 'string') out.push(`${at}: a log needs "lines" (a list of strings)`);
    if (b.span != null && !(typeof b.span === 'number' && b.span >= 1 && b.span <= 4)) out.push(`${at}: span must be 1 to 4`);
    state(at, b.state);
    for (const it of list && Array.isArray(b[list]) ? (b[list] as unknown[]) : []) if (isObj(it) && it.state != null) state(`${at} ${list}`, it.state);
    for (const a of Array.isArray(b.actions) ? b.actions : b.type === 'actions' && Array.isArray(b.items) ? b.items : []) {
      if (!isObj(a) || typeof a.label !== 'string' || (typeof a.prompt !== 'string' && typeof a.url !== 'string')) out.push(`${at}: a button needs "label" and a "prompt" or a "url"`);
    }
  });
  const ids = data.blocks.filter(isObj).map((b) => b.id).filter((x): x is string => typeof x === 'string');
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) out.push(`two blocks have the id "${twice}": only the first shows`);
  return [...new Set(out)].slice(0, MOST);
}

/**
 * What to tell the session about the data it just wrote, or null when it's fine. `kit`: its page is Cora's own (the
 * blocks are checked too).
 */
export function dataProblem(text: string, o: { kit: boolean; max: number }): string | null {
  if (text.length > o.max) return `From Cora: that data.json is ${Math.round(text.length / 1024)} KB, over the ${Math.round(o.max / 1024)} KB a live explain's data may be: the page keeps showing the last good data. Make it smaller (fewer rows, shorter logs).`;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return `From Cora: that data.json isn't valid JSON (${(e as Error).message.slice(0, 160)}): the page keeps showing the last good data. Write the whole file again.`;
  }
  if (!o.kit) return null;
  const problems = kitProblems(data);
  return problems.length ? `From Cora: the dashboard's page can't draw some of that data.json as written:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix those and write the file again.` : null;
}
