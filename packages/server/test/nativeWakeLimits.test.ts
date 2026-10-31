import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';

it('wake each other on: idle deliveries back and forth go straight through, each counted once (the mod and the prompt hook both see it)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cora-wakes-'));
  const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
  const A = '7e13fc35-0000-0000-0000-000000000001';
  const B = '3dadd0ec-0000-0000-0000-000000000002';
  const name = { [A]: 'cora-7e13', [B]: 'cora-3dad' };
  const mod = (b: object) => srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: b }).then((r) => r.json());
  const hook = (sid: string, prompt: string) => srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/code/cora', prompt, prompt_id: `${sid}-${prompt.length}-${Math.random()}` } });
  // a turn ended: the session is idle again (its Stop hook, here)
  const idle = () => { for (const id of [A, B]) srv.store.upsertSession({ id, state: 'idle' } as never); };
  const env = (from: string, t: string) => `<cross-session-message from="uds:x" from-name="${from}" from-mode="prompting">\n${t}\n</cross-session-message>`;
  try {
    const now = Date.now();
    for (const id of [A, B]) srv.store.upsertSession({ id, cwd: 'C:/code/cora', state: 'idle', startedAt: now, lastTs: now } as never);
    const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Drill', sessionId: A } })).json().project;
    await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: B } });
    await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { autoWake: true } });
    for (const s of [A, B]) await mod({ session: s, kind: 'start' });
    // three idle deliveries: A to B, B to A, A to B
    for (const [from, to, t] of [[A, B, 'one'], [B, A, 'two'], [A, B, 'three']] as const) {
      idle();
      await mod({ session: from, kind: 'send', to: name[to], text: t });
      expect(await mod({ session: to, kind: 'receive', text: env(name[from], t) })).toEqual({ ok: true });
      expect((await hook(to, `Another Claude session sent a message:\n${env(name[from], t)}`)).body).not.toMatch(/block/);
    }
    // a fourth goes through too; a fifth in ten minutes is over the pair's rails: it waits for the user, and says why
    idle();
    await mod({ session: B, kind: 'send', to: name[A], text: 'four' });
    expect(await mod({ session: A, kind: 'receive', text: env(name[B], 'four') })).toEqual({ ok: true });
    idle();
    await mod({ session: A, kind: 'send', to: name[B], text: 'five' });
    const held = await mod({ session: B, kind: 'receive', text: env(name[A], 'five') });
    expect(held.hold ?? '').toMatch(/woken each other a lot/);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
