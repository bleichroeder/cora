import { useEffect, useState } from 'react';
import { DEFAULT_VOICE, VOICE_MODELS, type Settings, type VoiceSettings, takesTags, takesStyle, DELIVERY_MAX, PRONOUNCE_MAX } from '@cora/shared';
import { speak, stopSpeaking, useVoice, SILENCE_MS } from '../lib/voice';
import { useWake } from '../lib/wake/controller';
import { Icon } from './Icon';
import { desktop } from '../lib/desktop';

const openOut = (url: string) => (desktop?.openExternal ? desktop.openExternal(url) : void window.open(url, '_blank', 'noopener'));
import { Choice, Group, Row, Section, Toggle } from './settingsUi';

type VoiceOption = { id: string; name: string; note?: string };

const READ_HINT: Record<VoiceSettings['read'], string> = {
  buttons: 'Only when you press a reply’s speaker button.',
  summaries: 'At the end of each turn Claude says a sentence or two, written to be heard (sessions started after you choose this).',
  full: 'Each finished reply in the session you’re looking at. Code blocks are skipped.',
};

const Perm = ({ ok, children }: { ok: boolean | null; children: React.ReactNode }) => (
  <span className={`vperm ${ok === true ? 'ok' : ok === false ? 'no' : ''}`} title={ok === null ? 'not checked yet' : undefined}>
    <Icon name={ok === true ? 'Check' : ok === false ? 'X' : 'Minus'} size={11} /> {children}
  </span>
);

/** Settings → Voice: off by default; push-to-talk prompts and replies read aloud with an ElevenLabs voice. */
export function VoiceSection() {
  const v = useVoice((s) => s.settings);
  const key = useVoice((s) => s.key);
  const reading = useVoice((s) => s.reading);
  const [keyIn, setKeyIn] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voices, setVoices] = useState<{ voices: VoiceOption[]; builtin: boolean } | null>(null);
  const [customId, setCustomId] = useState('');

  const save = async (patch: Partial<VoiceSettings>) => {
    setErr(null);
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: patch }) });
    const j = await r.json();
    // a server from before voice existed answers without it: say so rather than lose the settings
    if (r.ok && (j as Settings).voice) useVoice.setState({ settings: { ...DEFAULT_VOICE, ...(j as Settings).voice } });
    else if (r.ok) setErr('The Cora server is older than this window: restart Cora to use voice.');
    else setErr(j.error ?? 'failed');
  };
  const loadVoices = () => void fetch('/api/voice/voices').then((r) => (r.ok ? r.json() : null)).then((j) => j && setVoices(j));
  useEffect(() => {
    if (v.enabled && key?.set) loadVoices();
  }, [v.enabled, key?.set]);

  const saveKey = async (k: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/voice/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'failed');
      useVoice.setState({ key: j });
      setKeyIn('');
      if (j.set) loadVoices();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (id: string) => {
    const o = voices?.voices.find((x) => x.id === id);
    void save({ voiceId: id, voiceName: o?.name ?? 'Custom voice' });
  };
  const previewing = reading?.id === 'voice-preview';
  const coraPreviewing = reading?.id === 'cora:voice-preview';
  const pickCora = (id: string) => {
    const o = voices?.voices.find((x) => x.id === id);
    void save({ coraVoiceId: id, coraVoiceName: id ? (o?.name ?? 'Custom voice') : '' });
  };

  // "Hey Cora": what it's doing, or why it can't
  const wake = useWake();
  const wakeHint =
    v.wake && (wake.state === 'paused' || wake.state === 'error') && wake.why
      ? `Not listening now: ${wake.why}.`
      : v.wake && wake.state === 'muted'
        ? "Muted from Cora's card: click the mic there to listen again."
        : 'Heard on this computer: nothing leaves it until you say it. Then your words go to Cora, as with Talk.';
  return (
    <Section id="voice" title="Voice" intro={<>Hold <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to talk to the session you&apos;re looking at, or <kbd>Ctrl</kbd>+<kbd>Space</kbd> to talk to Cora, and have replies read aloud with an ElevenLabs voice. Your key stays with Cora on this machine.</>}>
      <Toggle label="Turn on voice" hint="Push-to-talk and replies read aloud." checked={v.enabled} onChange={(enabled) => void save({ enabled })} />
      {v.enabled ? (
        <>
          <Row
            label="ElevenLabs key"
            wide={!!key?.set}
            hint={
              key?.set ? (
                <span className="vperms">
                  <Perm ok={key.perms.tts}>read aloud</Perm>
                  <Perm ok={key.perms.stt}>push-to-talk</Perm>
                  <Perm ok={key.perms.voices}>your voice list</Perm>
                  {key.perms.stt === false ? <span>Without Speech to Text on the key, use Claude Code&apos;s /voice in the terminal instead.</span> : null}
                </span>
              ) : (
                <>
                  No key yet? Sign in at ElevenLabs, then <b>Developers → API keys → Create key</b>. Give it <b>Text to Speech</b> (replies read aloud), <b>Speech to Text</b> (push-to-talk and &ldquo;Hey Cora&rdquo;) and <b>Voices: read</b> (your voice list), then paste it here.{' '}
                  <button className="linkish" onClick={() => openOut('https://elevenlabs.io/app/developers/api-keys')}>
                    Open ElevenLabs
                  </button>
                </>
              )
            }
          >
            {key?.set ? (
              <span className="vkey">
                <code>{key.hint}</code>
                <button className="btn ghost" onClick={() => void saveKey(null)} disabled={busy}>Remove</button>
              </span>
            ) : (
              <span className="vkey">
                <input type="password" placeholder="sk_… (or the base64 form)" value={keyIn} onChange={(e) => setKeyIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && keyIn && void saveKey(keyIn)} />
                <button className="btn" onClick={() => void saveKey(keyIn)} disabled={!keyIn || busy}>{busy ? 'Checking…' : 'Save'}</button>
              </span>
            )}
          </Row>

          {key?.set ? (
            <>
              <Group label="The voice">
              <Row label="Voice" hint="From your ElevenLabs voices.">
                <span className="vkey">
                  <select value={v.voiceId} onChange={(e) => pick(e.target.value)}>
                    {!voices?.voices.some((o) => o.id === v.voiceId) ? <option value={v.voiceId}>{v.voiceName}</option> : null}
                    {voices?.voices.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}{o.note ? ` · ${o.note}` : ''}</option>
                    ))}
                  </select>
                  <button className="btn ghost" onClick={() => (previewing ? stopSpeaking() : void speak('voice-preview', "Good evening. Your build passed, and I've summarised the changes in the transcript.", 5000, true, undefined, { now: true }))}>
                    <Icon name={previewing ? 'Square' : 'Play'} size={11} /> {previewing ? 'Stop' : 'Preview'}
                  </button>
                </span>
              </Row>
              <Row label="Cora's voice" hint="Cora (its console, notes and replies) speaks with this one, so you can tell it from your sessions.">
                <span className="vkey">
                  <select value={v.coraVoiceId ?? ''} onChange={(e) => pickCora(e.target.value)}>
                    <option value="">Same as sessions</option>
                    {v.coraVoiceId && !voices?.voices.some((o) => o.id === v.coraVoiceId) ? <option value={v.coraVoiceId}>{v.coraVoiceName || 'Custom voice'}</option> : null}
                    {voices?.voices
                      .filter((o) => o.id !== v.voiceId)
                      .map((o) => (
                        <option key={o.id} value={o.id}>{o.name}{o.note ? ` · ${o.note}` : ''}</option>
                      ))}
                  </select>
                  <button
                    className="btn ghost"
                    disabled={!v.coraVoiceId}
                    onClick={() => (coraPreviewing ? stopSpeaking() : void speak('cora:voice-preview', "Hi, it's Cora. Two sessions finished while you were away, and canvas needs you.", 5000, true, undefined, { now: true }))}
                  >
                    <Icon name={coraPreviewing ? 'Square' : 'Play'} size={11} /> {coraPreviewing ? 'Stop' : 'Preview'}
                  </button>
                </span>
              </Row>
              <Row label={voices?.builtin ? 'Or a voice ID' : 'Voice ID'}>
                <span className="vkey">
                  <input type="text" placeholder="paste from a voice's page" value={customId} onChange={(e) => setCustomId(e.target.value.trim())} />
                  <button className="btn" disabled={!/^[A-Za-z0-9]{8,40}$/.test(customId)} onClick={() => void save({ voiceId: customId, voiceName: `Voice ${customId.slice(0, 6)}…` }).then(() => setCustomId(''))}>Use</button>
                </span>
              </Row>
              <Row label="Model" hint="Faster ones start speaking sooner; slower ones sound more natural.">
                <span className="vkey">
                  <select value={v.model} onChange={(e) => void save({ model: e.target.value })}>
                    {!VOICE_MODELS.some((m) => m.id === v.model) ? <option value={v.model}>{v.model}</option> : null}
                    {VOICE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} · {m.note}</option>
                    ))}
                  </select>
                </span>
              </Row>
              <Row label="Steadiness">
                <Choice value={v.stability} onChange={(stability) => void save({ stability })} options={[[0.7, 'Steady'], [0.5, 'Balanced'], [0.3, 'Expressive']]} />
              </Row>
              <Row label="Pace">
                <Choice value={v.speed} onChange={(speed) => void save({ speed })} options={[[0.9, 'Slower'], [1, 'Normal'], [1.1, 'Faster']]} />
              </Row>
              </Group>
              <Group label="How it's said">
                <HowItsSaid v={v} save={save} />
              </Group>
              <Group label="Reading">
              <Row label="Read aloud" hint={READ_HINT[v.read]}>
                <Choice value={v.read} onChange={(read) => void save({ read })} options={[['buttons', 'Only when I click'], ['summaries', 'Short summaries'], ['full', 'Full replies']]} />
              </Row>
              {v.read === 'full' ? (
                <Row label="Read up to">
                  <Choice value={v.cap} onChange={(cap) => void save({ cap })} options={[[300, '~1 paragraph'], [650, '~2 paragraphs'], [1500, '~whole reply']]} />
                </Row>
              ) : null}
              <Row label="Stop listening" hint="When you click to talk (holding the key always listens until you let go).">
                <Choice
                  value={v.endOnSilence ?? SILENCE_MS}
                  onChange={(endOnSilence) => void save({ endOnSilence })}
                  options={[[800, 'After a short pause'], [SILENCE_MS, 'After a pause'], [2200, 'After a long pause'], [0, 'When I click']]}
                />
              </Row>
              <Row label="Talking to Cora" hint="Send when you stop, so it's a conversation; or check your words first.">
                <Choice value={v.coraAfter ?? 'send'} onChange={(coraAfter) => void save({ coraAfter })} options={[['send', 'Send when I stop'], ['review', 'Review, Enter sends']]} />
              </Row>
              <Toggle label="Answer straight away" hint={'When your words go, a quick line ("Checking the webapi pipeline now.") while the full answer comes. A small Haiku call each time.'} checked={v.front !== false} onChange={(front) => void save({ front })} />
              <Row label="To sessions" hint="Your words land in the composer to check, or go at once.">
                <Choice value={v.after} onChange={(after) => void save({ after })} options={[['review', 'Review, Enter sends'], ['send', 'Send at once']]} />
              </Row>
              </Group>
              <Group label={'"Hey Cora"'}>
                <Toggle label={'Listen for "Hey Cora"'} hint={wakeHint} checked={!!v.wake} onChange={(wake) => void save({ wake })} />
                {v.wake ? (
                  <>
                    <Row label="Sensitivity" hint="How readily it wakes: fewer false starts, or fewer misses.">
                      <Choice value={v.wakeSensitivity ?? 'balanced'} onChange={(wakeSensitivity) => void save({ wakeSensitivity })} options={[['low', 'Fewer false starts'], ['balanced', 'Balanced'], ['high', 'Catches more']]} />
                    </Row>
                    <Toggle label="Keep listening after Cora answers" hint="A few seconds for a follow-up, no wake word needed." checked={v.wakeFollowUp !== false} onChange={(wakeFollowUp) => void save({ wakeFollowUp })} />
                  </>
                ) : null}
              </Group>
              <Group label="Also say it when">
                <Toggle label="A session needs a permission decision" checked={v.announce} onChange={(announce) => void save({ announce })} />
                <Toggle label="A background command finishes" checked={v.announceTasks} onChange={(announceTasks) => void save({ announceTasks })} />
                <Toggle label="A tool fails" hint="In the session you're looking at." checked={v.announceFailures} onChange={(announceFailures) => void save({ announceFailures })} />
                <Toggle label="A GitLab pipeline finishes" hint="One a session follows." checked={v.announcePipelines} onChange={(announcePipelines) => void save({ announcePipelines })} />
              </Group>
            </>
          ) : null}
        </>
      ) : null}
      {err ? <div className="ny-err">{err}</div> : null}
    </Section>
  );
}

/** How it's said: direction (audio tags) for every line and for Cora's, style, and pronunciations. */
function HowItsSaid({ v, save }: { v: VoiceSettings; save: (p: Partial<VoiceSettings>) => Promise<void> }) {
  const tags = takesTags(v.model);
  const style = takesStyle(v.model);
  const [dir, setDir] = useState<string | null>(null);
  const [coraDir, setCoraDir] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = v.pronounce ?? [];
  const add = () => {
    if (!from.trim()) return;
    void save({ pronounce: [...list.filter((p) => p.from.toLowerCase() !== from.trim().toLowerCase()), { from: from.trim(), to: to.trim() }] });
    setFrom('');
    setTo('');
  };
  const field = (value: string | null, saved: string | undefined, set: (s: string | null) => void, key: 'delivery' | 'coraDelivery', ph: string) => (
    <input
      className="set-input"
      value={value ?? saved ?? ''}
      placeholder={ph}
      maxLength={DELIVERY_MAX}
      spellCheck={false}
      onChange={(e) => set(e.target.value)}
      onBlur={() => value != null && (void save({ [key]: value }), set(null))}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
  // its rows (the page's Group around them is what sets them apart)
  return (
    <>
      <Row
        label="Direction"
        hint={
          tags
            ? 'In front of every line, in ElevenLabs\u2019 audio tags: how it sounds. Spoken lines may add their own, like [laughs].'
            : 'Needs a v3 or v4 model (see Model above): Flash doesn\u2019t follow direction. Kept for when you switch.'
        }
      >
        {field(dir, v.delivery, setDir, 'delivery', '[relaxed, warm, unhurried]')}
      </Row>
      <Row label="Cora's direction" hint="For Cora's lines, so it sounds unlike your sessions in manner too. Empty: the same as above.">
        {field(coraDir, v.coraDelivery, setCoraDir, 'coraDelivery', '[bright, a little dry]')}
      </Row>
      <Row label="Style" hint={style ? 'Exaggerates the voice\u2019s character: more expressive, a little less steady.' : 'Not on this model: v4 goes by direction instead, and Flash and Turbo don\u2019t take it.'}>
        <Choice value={v.style ?? 0} onChange={(s) => void save({ style: s })} options={[[0, 'None'], [0.3, 'Some'], [0.6, 'More']]} />
      </Row>
      <Row wide label="Pronunciations" hint="Say this as that, before the text goes to ElevenLabs (whole words, any case).">
        <span className="vpron">
          {list.map((p) => (
            <span key={p.from} className="vpron-row">
              <code>{p.from}</code>
              <Icon name="ArrowRight" size={11} />
              <span>{p.to || <i className="dim">(left out)</i>}</span>
              <button className="icon-btn" title="Remove" onClick={() => void save({ pronounce: list.filter((x) => x.from !== p.from) })}>
                <Icon name="X" size={12} />
              </button>
            </span>
          ))}
          <span className="vpron-add">
            <input className="set-input" value={from} placeholder="Kubectl" spellCheck={false} onChange={(e) => setFrom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <Icon name="ArrowRight" size={11} />
            <input className="set-input" value={to} placeholder="cube control" spellCheck={false} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className="btn" disabled={!from.trim() || list.length >= PRONOUNCE_MAX} onClick={add}>
              <Icon name="Plus" size={12} /> Add
            </button>
          </span>
        </span>
      </Row>
    </>
  );
}
