import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { loadConfig } from '../src/config';
import { applyPatch } from '../src/prefs';
import { startServer, type Running } from '../src/server';
import { normalizeKey, Voice, type Fetch } from '../src/voice';
import { readSecret } from '../src/secrets';

const KEY = 'sk_' + 'a1b2c3d4'.repeat(6);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: string) => json(401, { detail: { status, message: `nope: ${status}` } });

/** A fake ElevenLabs: `scopes` is what the key may do; calls are recorded. */
function fakeEleven(scopes: { voices?: boolean; tts?: boolean; stt?: boolean; valid?: boolean } = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn: Fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const key = (init?.headers as Record<string, string>)?.['xi-api-key'];
    if (scopes.valid === false || key !== KEY) return refuse('invalid_api_key');
    if (url.includes('/v1/voices')) return scopes.voices === false ? refuse('missing_permissions') : json(200, { voices: [{ voice_id: 'v123456789', name: 'Jarvisish', labels: { accent: 'british' } }] });
    if (url.includes('/single-use-token/')) return scopes.stt === false ? refuse('missing_permissions') : json(200, { token: 'tok_1' });
    if (url.includes('/text-to-speech/')) return scopes.tts === false ? refuse('missing_permissions') : new Response(new Uint8Array([0xff, 0xfb, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    return json(404, {});
  };
  return { fn, calls };
}

describe('normalizeKey', () => {
  it('decodes a base64-encoded key and strips invisible characters', () => {
    expect(normalizeKey(Buffer.from(KEY).toString('base64'))).toBe(KEY);
    expect(normalizeKey(`​ ${KEY}\n`)).toBe(KEY);
    expect(normalizeKey('not-a-key')).toBe('not-a-key');
  });
});

describe('Voice', () => {
  it('records what a scoped key may do, and refuses an invalid key with ElevenLabs\' reason', async () => {
    const v = new Voice(null, fakeEleven({ voices: false, stt: false }).fn);
    expect(await v.setKey(Buffer.from(KEY).toString('base64'))).toEqual({ set: true, hint: 'sk_…c3d4', perms: { voices: false, stt: false, tts: true } });
    await expect(new Voice(null, fakeEleven({ valid: false }).fn).setKey(KEY)).rejects.toThrow(/invalid_api_key/);
  });

  it('says plainly when ElevenLabs is unreachable', async () => {
    const down: Fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(new Voice(null, down).setKey(KEY)).rejects.toThrow(/couldn't reach ElevenLabs/);
  });

  it('falls back to the standard voices when the key may not list them', async () => {
    const v = new Voice(null, fakeEleven({ voices: false }).fn);
    await v.setKey(KEY);
    expect((await v.voices()).builtin).toBe(true);
    const w = new Voice(null, fakeEleven().fn);
    await w.setKey(KEY);
    expect(await w.voices()).toEqual({ builtin: false, voices: [{ id: 'v123456789', name: 'Jarvisish', note: 'british', preview: undefined }] });
  });

  it('stores the key in its own file and can remove it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ab-v-')), 'elevenlabs.json');
    const v = new Voice(file, fakeEleven().fn);
    await v.setKey(KEY);
    expect(JSON.parse(readSecret(file)).key).toBe(KEY);
    expect(new Voice(file).info().set).toBe(true);
    await v.setKey(null);
    expect(existsSync(file)).toBe(false);
  });
});

describe('voice settings', () => {
  it('validates the voice patch', () => {
    const s = applyPatch(DEFAULT_SETTINGS, { voice: { enabled: true, read: 'full', cap: 900 } });
    expect(s.voice).toMatchObject({ enabled: true, read: 'full', cap: 900, voiceName: 'Daniel' });
    expect(DEFAULT_SETTINGS.voice.enabled).toBe(false);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { read: 'always' as any } })).toThrow(/voice.read/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { voiceId: '../etc' } })).toThrow(/voiceId/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { stability: 3 } })).toThrow(/stability/);
  });
});

describe('voice endpoints', () => {
  let srv: Running | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });
  const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
  const cfg = () => loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-ve-')), dbPath: ':memory:', hookToken: 'h', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') });

  it('never returns the key; speech is a single-use ticket bought with an origin-checked POST', async () => {
    const eleven = fakeEleven();
    srv = await startServer(cfg(), { tail: false, listen: false, voiceFetch: eleven.fn });
    const set = await srv.app.inject({ method: 'POST', url: '/api/voice/key', headers: H, payload: { key: KEY } });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain(KEY);
    expect((await srv.app.inject({ url: '/api/voice', headers: { cookie: H.cookie } })).body).not.toContain(KEY);

    expect((await srv.app.inject({ method: 'POST', url: '/api/voice/speech', headers: { ...H, origin: 'https://evil.example' }, payload: { text: 'hello' } })).statusCode).toBe(403);
    const t = await srv.app.inject({ method: 'POST', url: '/api/voice/speech', headers: H, payload: { text: 'Build passed.' } });
    const url = t.json().url as string;
    const audio = await srv.app.inject({ url, headers: { cookie: H.cookie } });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(JSON.parse(eleven.calls.at(-1)!.body!)).toMatchObject({ text: 'Build passed.', model_id: 'eleven_flash_v2_5' });
    expect((await srv.app.inject({ url, headers: { cookie: H.cookie } })).statusCode).toBe(404);

    // the model picked in Settings is the one speech uses
    expect((await srv.app.inject({ method: 'POST', url: '/api/settings', headers: H, payload: { voice: { model: 'eleven_v4' } } })).statusCode).toBe(200);
    const t2 = await srv.app.inject({ method: 'POST', url: '/api/voice/speech', headers: H, payload: { text: 'Deployed.' } });
    expect((await srv.app.inject({ url: t2.json().url, headers: { cookie: H.cookie } })).statusCode).toBe(200);
    expect(JSON.parse(eleven.calls.at(-1)!.body!)).toMatchObject({ text: 'Deployed.', model_id: 'eleven_v4' });
  });

  it('mints Scribe tokens; a bad key is a 400 with the reason', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false, voiceFetch: fakeEleven().fn });
    const bad = await srv.app.inject({ method: 'POST', url: '/api/voice/key', headers: H, payload: { key: 'sk_wrongwrongwrongwrongwrong' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/invalid_api_key/);
    await srv.app.inject({ method: 'POST', url: '/api/voice/key', headers: H, payload: { key: KEY } });
    expect((await srv.app.inject({ method: 'POST', url: '/api/voice/stt-token', headers: H })).json()).toEqual({ token: 'tok_1' });
  });

  it('types a spoken prompt into a hosted terminal, then Enter', async () => {
    const writes: string[] = [];
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write: (d: string) => void writes.push(d), resize() {}, kill() {} });
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: fakeSpawn });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-vt-'));
    const t = (await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd } })).json();
    const r = await srv.app.inject({ method: 'POST', url: `/api/terminals/${t.terminalId}/input`, headers: H, payload: { text: 'run the tests please', submit: true } });
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 150));
    expect(writes).toEqual(['run the tests please', '\r']);
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals/nope/input', headers: H, payload: { text: 'x' } })).statusCode).toBe(404);
  });
});
