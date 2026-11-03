// The team flow, end to end, against a throwaway Cora (serve.mts): a draft with a missing folder and a worktree seat,
// Apply and bring up, each seat's agent file, the mods' hello, and a message from you to the lead, the lead to the worker
// and back. Seats run on haiku. Usage: node scripts/e2e/team-flow.mjs <root> [port]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const work = join(root, 'work').replace(/\//g, '\\');
const missing = join(root, 'work', 'helper-desk').replace(/\//g, '\\');
const BASE = `http://127.0.0.1:${process.argv[3] ?? 4399}`;
const H = { cookie: 'ab_session=e2e', origin: BASE, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  return { status: r.status, ...j };
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const project = async (pid) => (await call('GET', '/api/projects')).projects.find((p) => p.id === pid);

const allow = ['Read', 'Write', 'SendMessage', 'ListAgents', 'mcp__cora__project_read', 'mcp__cora__project_post'];
const seat = (id, name, folder, o = {}) => ({
  id, name, instructions: o.instructions ?? `You are the ${name} in a small test team. Keep every reply to one short sentence.`,
  agent: { model: 'haiku', effort: 'low', tools: ['Read', 'Write'], permissions: { allow } }, skills: [], folder: { path: folder, ...(o.worktree ? { worktree: true } : {}) },
  count: { min: 1, max: 1 }, startup: {},
});
const team = {
  version: 0,
  seats: [
    seat('lead', 'Lead', work),
    seat('worker', 'Worker', work, { worktree: true, instructions: 'You are the Worker in a small test team. When the Lead messages you, reply to the Lead with project_post (kind note, to the Lead) saying exactly: pong <the number they sent>. Nothing else.' }),
    seat('helper', 'Helper', missing),
  ],
  groups: [], labels: [],
  routes: [
    { id: 'r1', from: ['seat:lead'], to: 'seat:worker', kinds: ['handoff', 'direct', 'question'], wake: 'auto' },
    { id: 'r2', from: ['seat:worker'], to: 'seat:lead', kinds: ['note', 'report', 'question'], wake: 'auto' },
    { id: 'r3', from: ['seat:lead'], to: 'seat:helper', kinds: ['direct'], wake: 'auto' },
    { id: 'r4', from: ['seat:helper'], to: 'seat:lead', kinds: ['note'], wake: 'auto' },
  ],
  fallback: 'user', escalation: [], lead: 'lead',
};

const t0 = Date.now();
const p = (await call('POST', '/api/projects', { name: 'E2E team' })).project;
check('project made', !!p?.id);
await call('PATCH', `/api/projects/${p.id}`, { coordination: true, autoWake: true });

// the draft, then what the builder's folder check says about it
const put = await call('PUT', `/api/projects/${p.id}/builder`, { team, rev: 0 });
check('draft saved', put.ok === true || !!put.draft, JSON.stringify(put).slice(0, 160));
const folders = await call('POST', `/api/projects/${p.id}/builder/folders`, { paths: [work, missing], worktrees: [work] });
check('folder check: the missing folder is reported', JSON.stringify(folders).includes('helper-desk'), JSON.stringify(folders).slice(0, 200));
check('folder check: the worktree folder is reported as not a git repository', (folders.notRepo ?? []).length === 1, JSON.stringify(folders).slice(0, 200));
check('helper folder does not exist before bring-up', !existsSync(missing));

// apply and bring up
const draft = await call('GET', `/api/projects/${p.id}/builder`);
const ap = await call('POST', `/api/projects/${p.id}/builder/apply`, { rev: draft.draft?.rev, bringUp: true });
check('apply and bring up accepted', ap.ok === true, JSON.stringify(ap).slice(0, 300));

// seats come up
let pr;
for (let i = 0; i < 60; i++) {
  pr = await project(p.id);
  const seated = Object.values(pr.members ?? {}).filter((m) => m.seat).length;
  if (seated >= 3) break;
  await sleep(2000);
}
const seats = Object.entries(pr.members ?? {}).filter(([, m]) => m.seat).map(([sid, m]) => ({ sid, seat: m.seat }));
check('all three seats started', seats.length === 3, seats.map((s) => s.seat).join(', '));
check('the helper folder was created', existsSync(missing));
const lead = seats.find((s) => s.seat === 'lead');
check('the lead is the lead seat (from the design)', !!lead && pr.lead === lead.sid, `lead=${pr.lead?.slice(0, 8)} leadSeat=${lead?.sid.slice(0, 8)}`);

// each seat's agent file keeps its messaging tools
const agents = join(root, 'home', 'team-plugins', p.id, 'agents');
for (const id of ['lead', 'worker', 'helper']) {
  const f = join(agents, `${id}.md`);
  const txt = existsSync(f) ? readFileSync(f, 'utf8') : '';
  check(`${id}: agent file keeps SendMessage and project_post`, /SendMessage/.test(txt) && /mcp__cora__project_post/.test(txt));
}

// mods said hello (the seats are live)
await sleep(8000);
const mods = existsSync(join(root, 'home', 'mod-events.log')) ? readFileSync(join(root, 'home', 'mod-events.log'), 'utf8') : '';
for (const s of seats) check(`${s.seat}: its mod said hello`, mods.includes(`"sid":"${s.sid.slice(0, 8)}","kind":"start"`));

// messaging: ask the lead to message the worker; the worker answers the lead
// your board post to the idle lead wakes it (decision 1); the lead sends with the new direct kind (decision 2)
const ask = await call('POST', `/api/projects/${p.id}/posts`, { kind: 'direct', to: [lead.sid], text: 'Test: send the Worker a message with project_post, kind direct, to the Worker, saying exactly: ping 42. Then stop.' });
check('your message to the lead posted', ask.ok === true || !!ask.post, JSON.stringify(ask).slice(0, 200));
let thread = [];
for (let i = 0; i < 90; i++) {
  thread = (await project(p.id)).thread ?? [];
  if (thread.some((x) => /pong\s*42/i.test(x.text ?? ''))) break;
  await sleep(4000);
}
const worker = seats.find((s) => s.seat === 'worker');
const ping = thread.find((x) => x.by === lead.sid && /ping\s*42/i.test(x.text ?? ''));
const pong = thread.find((x) => x.by === worker?.sid && /pong\s*42/i.test(x.text ?? ''));
check('your board post woke the lead', !!ping);
check('the lead used the direct kind and it went through', !!ping && ping.kind === 'direct' && !ping.blocked, ping ? ping.kind : '');
check('the lead messaged the worker (ping 42)', !!ping, ping ? `${ping.kind} → ${(ping.to ?? []).map((t) => t.slice(0, 8))}${ping.blocked ? ' BLOCKED ' + ping.blocked : ''}` : '');
check('the worker answered the lead (pong 42)', !!pong, pong ? `${pong.kind}${pong.blocked ? ' BLOCKED ' + pong.blocked : ''}` : '');
console.log('\nthread:');
for (const x of thread) console.log(`  ${x.kind} by ${x.by?.slice(0, 8)} to ${JSON.stringify((x.to ?? []).map((t) => t.slice(0, 8)))}${x.blocked ? ' BLOCKED: ' + x.blocked : ''}: ${(x.text ?? '').slice(0, 100).replace(/\n/g, ' ')}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s; project ${p.id}`);
