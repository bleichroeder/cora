import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { DEFAULT_VOICE, type VoiceKeyInfo, type VoiceSettings, directionTag, takesTags, takesStyle } from '@cora/shared';
import { writeFileAtomic } from './fsx';
import { readSecret, writeSecret } from './secrets';

// CORA_ELEVENLABS_URL: point at a stand-in (testing without spending credits)
const API = process.env.CORA_ELEVENLABS_URL ?? process.env.AGENT_BRAIN_ELEVENLABS_URL ?? 'https://api.elevenlabs.io';
export type Fetch = typeof fetch;
type Perms = VoiceKeyInfo['perms'];

/** Clean up a pasted key: invisible characters out, and a base64-encoded key ("c2tf…" is "sk_…") decoded. */
export function normalizeKey(raw: string): string {
  let k = String(raw ?? '').replace(/[^\x21-\x7e]/g, '');
  if (!k.startsWith('sk_') && /^[A-Za-z0-9+/]+=*$/.test(k)) {
    const d = Buffer.from(k, 'base64').toString('utf8').trim();
    if (/^sk_[\x21-\x7e]+$/.test(d)) k = d;
  }
  return k;
}

export const keyHint = (k: string) => `${k.slice(0, 3)}…${k.slice(-4)}`;

/** ElevenLabs' own reason for a refusal (e.g. missing_permissions), not just the status code. */
export async function elevenReason(r: Response): Promise<{ status: string; message: string }> {
  const body = await r.text().catch(() => '');
  try {
    const d = JSON.parse(body).detail;
    if (d && typeof d === 'object') return { status: String(d.status ?? r.status), message: String(d.message ?? '') };
    if (typeof d === 'string') return { status: String(r.status), message: d };
  } catch {
    /* not JSON */
  }
  return { status: String(r.status), message: body.slice(0, 200) };
}

/** Voices offered when the key may not list the account's own (ElevenLabs' standard voices). */
export const BUILTIN_VOICES = [
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', note: 'British, deep and measured' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', note: 'British, warm' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', note: 'British, clear' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', note: 'American, deep' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', note: 'American, soft' },
];

export type VoiceOption = { id: string; name: string; note?: string; preview?: string };
const TICKET_MS = 60_000;

/** The ElevenLabs side of voice: the stored key (never sent to the page), its permissions, speech and transcription tokens. */
export class Voice {
  private stored: { key: string; perms: Perms } | null = null;
  private tickets = new Map<string, { text: string; voice: VoiceSettings; at: number }>();

  private fetchFn: Fetch;

  constructor(
    private file: string | null,
    fetchFn: Fetch = fetch,
  ) {
    // offline, DNS, ElevenLabs down: say so plainly rather than "fetch failed"
    this.fetchFn = async (input, init) => {
      try {
        return await fetchFn(input, init);
      } catch (e) {
        throw new Error(`couldn't reach ElevenLabs (${(e as Error).message})`);
      }
    };
    try {
      if (file) this.stored = JSON.parse(readSecret(file));
    } catch {
      /* no key yet */
    }
  }

  info(): VoiceKeyInfo {
    return this.stored ? { set: true, hint: keyHint(this.stored.key), perms: { ...this.stored.perms } } : { set: false, hint: null, perms: { tts: null, stt: null, voices: null } };
  }

  /** Store a key after checking what it may do; null removes it. Throws with ElevenLabs' reason when the key is refused outright. */
  async setKey(raw: string | null): Promise<VoiceKeyInfo> {
    if (raw === null || raw === '') {
      this.stored = null;
      if (this.file) rmSync(this.file, { force: true });
      return this.info();
    }
    const key = normalizeKey(raw);
    if (key.length < 20) throw new Error(`that doesn't look like an ElevenLabs API key (${key.length} characters)`);
    const h = { 'xi-api-key': key };
    // voices: also tells a valid key (missing_permissions) from an invalid one
    const v = await this.fetchFn(`${API}/v1/voices?page_size=1`, { headers: h });
    let voices: boolean;
    if (v.ok) voices = true;
    else {
      const why = await elevenReason(v);
      if (why.status !== 'missing_permissions') throw new Error(`ElevenLabs refused the key (${keyHint(key)}): ${why.status}${why.message ? `, ${why.message}` : ''}`);
      voices = false;
    }
    const perm = async (r: Response) => (r.ok ? true : (await elevenReason(r)).status === 'missing_permissions' ? false : null);
    // speech to text: minting a single-use token is free
    const stt = await perm(await this.fetchFn(`${API}/v1/single-use-token/realtime_scribe`, { method: 'POST', headers: h }));
    // text to speech: a three-character request
    const tts = await perm(
      await this.fetchFn(`${API}/v1/text-to-speech/${BUILTIN_VOICES[0].id}?output_format=mp3_22050_32`, {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Hi.', model_id: 'eleven_flash_v2_5' }),
      }),
    );
    this.stored = { key, perms: { tts, stt, voices } };
    this.save();
    return this.info();
  }

  /** The account's voices, or the standard ones when the key may not list them. */
  async voices(): Promise<{ voices: VoiceOption[]; builtin: boolean }> {
    const fallback = { voices: BUILTIN_VOICES, builtin: true };
    if (!this.stored || this.stored.perms.voices === false) return fallback;
    const r = await this.fetchFn(`${API}/v1/voices`, { headers: { 'xi-api-key': this.stored.key } }).catch(() => null);
    if (!r?.ok) return fallback;
    const j = (await r.json()) as { voices?: Array<{ voice_id: string; name: string; preview_url?: string; labels?: Record<string, string> }> };
    const list = (j.voices ?? []).map((x) => ({ id: x.voice_id, name: x.name, note: [x.labels?.accent, x.labels?.gender, x.labels?.description].filter(Boolean).join(', ') || undefined, preview: x.preview_url }));
    return list.length ? { voices: list, builtin: false } : fallback;
  }

  /** A single-use ticket for one piece of speech: the audio element streams it with a plain GET. */
  ticket(text: string, voice: VoiceSettings): string {
    const now = Date.now();
    for (const [k, t] of this.tickets) if (now - t.at > TICKET_MS) this.tickets.delete(k);
    const id = randomBytes(18).toString('base64url');
    this.tickets.set(id, { text, voice, at: now });
    return id;
  }

  /** Redeem a ticket: ElevenLabs' streaming response (the chosen model, Flash v2.5 by default), or null for an unknown/used ticket. */
  async speech(ticket: string): Promise<Response | null> {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || Date.now() - t.at > TICKET_MS || !this.stored) return null;
    const r = await this.fetchFn(`${API}/v1/text-to-speech/${encodeURIComponent(t.voice.voiceId)}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.stored.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: t.text,
        model_id: t.voice.model || DEFAULT_VOICE.model,
        voice_settings: { stability: t.voice.stability, similarity_boost: 0.75, speed: t.voice.speed, ...(t.voice.style && takesStyle(t.voice.model || DEFAULT_VOICE.model) ? { style: t.voice.style } : {}) },
      }),
    });
    if (r.status === 401) this.noted(r.clone(), 'tts');
    return r;
  }

  /**
   * A whole clip (not a stream), for a debrief video: its MP3. The model that sounds best rather than fastest, told
   * what was said before it so the voice carries on from it.
   */
  async synthesize(text: string, o: { voiceId: string; speed: number; model?: string; previousText?: string }): Promise<Uint8Array> {
    if (!this.stored) throw new Error('Cora has no ElevenLabs key: add one in Settings › Voice');
    const model = o.model || 'eleven_multilingual_v2';
    const r = await this.fetchFn(`${API}/v1/text-to-speech/${encodeURIComponent(o.voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.stored.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      // what came before (so it carries on) only where the model takes it: the v2 family; v3 and v4 refuse it
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: o.speed }, ...(o.previousText && /_v2/.test(model) ? { previous_text: o.previousText.slice(-1000) } : {}) }),
    });
    if (!r.ok) {
      if (r.status === 401) this.noted(r.clone(), 'tts');
      const why = await elevenReason(r);
      throw new Error(`ElevenLabs refused the narration (${why.status}${why.message ? `: ${why.message}` : ''})`);
    }
    return new Uint8Array(await r.arrayBuffer());
  }

  /** A single-use token the page uses to stream the microphone straight to Scribe (the key stays here). */
  async sttToken(): Promise<string> {
    if (!this.stored) throw new Error('no ElevenLabs key');
    const r = await this.fetchFn(`${API}/v1/single-use-token/realtime_scribe`, { method: 'POST', headers: { 'xi-api-key': this.stored.key } });
    if (!r.ok) {
      const why = await elevenReason(r);
      if (why.status === 'missing_permissions' && this.stored.perms.stt !== false) {
        this.stored.perms.stt = false;
        this.save();
      }
      throw new Error(`ElevenLabs: ${why.status}${why.message ? `, ${why.message}` : ''}`);
    }
    return ((await r.json()) as { token: string }).token;
  }

  /** Remember a permission ElevenLabs turned out to refuse. */
  private async noted(r: Response, perm: keyof Perms) {
    if (this.stored && (await elevenReason(r)).status === 'missing_permissions') {
      this.stored.perms[perm] = false;
      this.save();
    }
  }

  private save() {
    if (this.file && this.stored) writeSecret(this.file, JSON.stringify(this.stored, null, 2) + '\n');
  }
}

/** An audio tag ElevenLabs reads as direction: `[laughs]`, `[said warmly, a little amused]` (no colons or digits). */
const TAG = /\[[A-Za-z][A-Za-z ,'-]{0,60}\]/g;

/**
 * The text as ElevenLabs gets it: your pronunciations swapped in; on a model that follows audio tags, your direction
 * (Cora's own for Cora's lines) in front; on one that doesn't, any tags taken out (it would read them aloud).
 */
export function spokenText(text: string, v: Pick<VoiceSettings, 'model' | 'delivery' | 'coraDelivery' | 'pronounce'>, cora = false): string {
  let t = text;
  for (const p of v.pronounce ?? []) {
    const esc = p.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, 'gi'), p.to);
  }
  if (!takesTags(v.model)) return t.replace(TAG, '').replace(/ {2,}/g, ' ').trim();
  // as a proper audio tag (a few words): a description in brackets would be read aloud
  const d = directionTag((cora && v.coraDelivery?.trim()) || v.delivery?.trim() || '');
  return d ? `${d} ${t}` : t;
}
