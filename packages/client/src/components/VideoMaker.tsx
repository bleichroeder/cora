import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_VIDEO, VOICE_MODELS, captions, planSlides, videoSlides, type Debrief, type Settings, type VideoPlan, type VideoSettings } from '@cora/shared';
import { makeVideo, useVideos } from '../state/videos';
import { useBrain } from '../state/store';
import { sessionColor } from '../lib/format';
import { SlideView } from './VideoSlides';
import { CoraOrb } from './CoraOrb';

/** the title card's orb, its centre across the slide (the bar, the padding, half its box) */
const ORB_X = 12 + 140 + 210;
import { Icon } from './Icon';
import './videoMaker.css';

/**
 * Make a video: a debrief's video as you want it. Left,
 * its slides: leave steps out, drag them into another order, change what each says, with the one you're on shown as
 * the video will show it. Right, how it sounds and looks: the voice (hear it first), its pace, the title card's words,
 * size, code, the orb, subtitles, its accent, how long it's kept. It all starts from your settings; "Save as my
 * defaults" puts these back there. What it'll cost to voice is counted as you go (lines voiced before are free).
 */
type Row = { id: string; title: string; label: string; include: boolean; narration: string };
type Voice = { id: string; name: string; note?: string; preview?: string };

export function VideoMaker() {
  const target = useVideos((s) => s.maker);
  if (!target) return null;
  return <Maker key={`${target.sessionId}/${target.debriefId}`} sessionId={target.sessionId} debriefId={target.debriefId} />;
}

function Maker({ sessionId, debriefId }: { sessionId: string; debriefId: string }) {
  const close = () => useVideos.getState().make(null);
  const session = useBrain((s) => s.sessions[sessionId]);
  const [d, setD] = useState<Debrief | null>(null);
  const [opts, setOpts] = useState<VideoSettings>(DEFAULT_VIDEO);
  const [rows, setRows] = useState<Row[]>([]);
  const [title, setTitle] = useState('');
  const [sub, setSub] = useState('');
  const [at, setAt] = useState(0);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [chars, setChars] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const drag = useRef<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [hearing, setHearing] = useState<string | null>(null);

  // the debrief, your settings, your voices
  useEffect(() => {
    void Promise.all([
      fetch(`/api/debriefs/${encodeURIComponent(sessionId)}/${encodeURIComponent(debriefId)}`).then((r) => (r.ok ? (r.json() as Promise<Debrief>) : null)),
      fetch('/api/settings').then((r) => (r.ok ? (r.json() as Promise<Settings>) : null)),
      fetch('/api/voice/voices').then((r) => (r.ok ? (r.json() as Promise<{ voices?: Voice[] }>) : null)),
    ])
      .then(([deb, set, vs]) => {
        if (!deb) return setErr("Couldn't load the debrief");
        const o = { ...DEFAULT_VIDEO, ...set?.debrief?.video };
        setOpts(o);
        setD(deb);
        setTitle(deb.title);
        setSub(deb.task);
        setRows(videoSlides(deb, { code: true }).map((x) => ({ id: x.id, title: x.kind === 'title' ? 'Title card' : x.title, label: x.kind === 'title' ? 'Title' : String(x.n), include: true, narration: x.narration })));
        setVoices(vs?.voices ?? []);
      })
      .catch(() => setErr("Couldn't load the debrief"));
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => (window.removeEventListener('keydown', key), audio.current?.pause());
  }, [sessionId, debriefId]); // eslint-disable-line react-hooks/exhaustive-deps

  const color = opts.accent === 'session' ? sessionColor(session) : undefined;
  const plan: VideoPlan | null = d
    ? { voiceId: opts.voiceId, model: opts.model, speed: opts.speed, size: opts.size, code: opts.code, keepHours: opts.keepHours, orb: opts.orb, subtitles: opts.subtitles, title, sub, slides: rows.filter((r) => r.include).map((r) => ({ id: r.id, narration: r.narration })), ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}) }
    : null;
  // the slide you're on, as the video will have it
  const shown = useMemo(() => {
    if (!d || !plan) return null;
    const all = planSlides(videoSlides(d, { code: plan.code }), { ...plan, slides: rows.map((r) => ({ id: r.id, narration: r.narration })) });
    const s = all.find((x) => x.id === rows[at]?.id) ?? all[0];
    if (!s) return null;
    const kept = planSlides(videoSlides(d, { code: plan.code }), plan);
    const placed = kept.find((x) => x.id === s.id);
    const cap = plan.subtitles && s.narration ? captions(s.narration)[0] : undefined;
    return { ...s, ...(placed ? { n: placed.n, of: placed.of } : {}), ...(cap ? { caption: cap } : {}) };
  }, [d, rows, at, title, sub, opts]); // eslint-disable-line react-hooks/exhaustive-deps

  // what voicing it costs (lines voiced before with this voice and pace are free), counted as you edit
  const lines = (plan?.slides ?? []).map((x) => x.narration);
  const linesKey = JSON.stringify([opts.voiceId, opts.model, opts.speed, lines]);
  useEffect(() => {
    if (!plan) return;
    const t = setTimeout(() => {
      void fetch('/api/videos/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId: opts.voiceId, model: opts.model, speed: opts.speed, lines }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { chars?: number } | null) => setChars(j?.chars ?? null))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [linesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = lines.reduce((n, l) => n + l.length, 0);
  const minutes = Math.max(1, Math.round(total / 15 / opts.speed / 60 + rows.filter((r) => r.include).length * 1.3 / 60));

  const set = (p: Partial<VideoSettings>) => (setOpts((o) => ({ ...o, ...p })), setSaved(false));
  const hear = (v: Voice) => {
    audio.current?.pause();
    if (hearing === v.id || !v.preview) return setHearing(null);
    const a = new Audio(v.preview);
    audio.current = a;
    a.onended = () => setHearing(null);
    void a.play().catch(() => setHearing(null));
    setHearing(v.id);
  };
  const move = (from: number, to: number) => {
    // the title card stays first
    if (from === to || from === 0 || to === 0) return;
    setRows((rs) => {
      const next = rs.slice();
      const [r] = next.splice(from, 1);
      next.splice(to, 0, r);
      return next;
    });
    setAt(to);
  };
  const saveDefaults = async () => {
    const { voiceId, model, speed, size, code, keepHours, orb, subtitles, accent } = opts;
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ debrief: { video: { voiceId, voiceName: voices.find((v) => v.id === voiceId)?.name ?? '', model, speed, size, code, keepHours, orb, subtitles, accent } } }) }).catch(() => null);
    setSaved(!!r?.ok);
  };
  const make = async () => {
    if (!plan) return;
    setBusy(true);
    setErr(null);
    const e = await makeVideo(sessionId, debriefId, plan);
    setBusy(false);
    if (e) return setErr(e);
    useVideos.getState().make(null);
  };

  return (
    <div className="vm-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="vm">
        <div className="vm-h">
          <Icon name="Clapperboard" size={15} />
          <b>Make a video</b>
          <span className="dim">
            {d ? `· ${d.title} · ${d.steps.length} step${d.steps.length === 1 ? '' : 's'}` : ''}
          </span>
          <span className="spacer" />
          <button className="vm-x" title="Close (Esc)" onClick={close}>
            <Icon name="X" size={15} />
          </button>
        </div>
        {!d ? (
          <div className="vm-load">{err ?? 'Loading…'}</div>
        ) : (
          <div className="vm-body">
            <div className="vm-left">
              <Preview slide={shown} color={color} label={`slide ${at + 1} of ${rows.length}`} media={shown?.shot && shown.n ? `/api/debriefs/${encodeURIComponent(sessionId)}/${encodeURIComponent(debriefId)}/shots/${shown.n - 1}` : undefined} />
              <div className="vm-lbl">Slides · what each says</div>
              <div className="vm-rows">
                {rows.map((r, i) => (
                  <div
                    key={r.id}
                    className={`vm-row${i === at ? ' on' : ''}${r.include ? '' : ' off'}`}
                    onClick={() => setAt(i)}
                    draggable={i > 0}
                    onDragStart={(e) => ((drag.current = i), (e.dataTransfer.effectAllowed = 'move'))}
                    onDragOver={(e) => i > 0 && drag.current != null && e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag.current != null) move(drag.current, i);
                      drag.current = null;
                    }}
                  >
                    {i > 0 ? (
                      <input type="checkbox" checked={r.include} title={r.include ? 'Leave this step out' : 'Put it back'} onClick={(e) => e.stopPropagation()} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, include: e.target.checked } : x)))} />
                    ) : (
                      <span className="vm-pin" title="The title card comes first">
                        <Icon name="Pin" size={11} />
                      </span>
                    )}
                    <span className="vm-n">{r.label}</span>
                    <div className="vm-rt">
                      <div className="vm-t">{r.title}</div>
                      {r.include ? (
                        <textarea
                          value={r.narration}
                          rows={i === at ? 4 : 2}
                          placeholder="(nothing said: the slide shows for a few seconds)"
                          onFocus={() => setAt(i)}
                          onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, narration: e.target.value.slice(0, 2000) } : x)))}
                        />
                      ) : (
                        <div className="vm-out">Left out</div>
                      )}
                    </div>
                    {i > 0 ? (
                      <span className="vm-grip" title="Drag to move it">
                        <Icon name="GripVertical" size={14} />
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="vm-right">
              <Field label="Voice">
                <div className="vm-voices">
                  <button className={`vm-voice${!opts.voiceId ? ' on' : ''}`} onClick={() => set({ voiceId: '', voiceName: '' })}>
                    <span className="nm">Cora's voice</span>
                    <span className="nt">the one Cora speaks with</span>
                  </button>
                  {voices.map((v) => (
                    <div key={v.id} className={`vm-voice${opts.voiceId === v.id ? ' on' : ''}`} onClick={() => set({ voiceId: v.id, voiceName: v.name })}>
                      <span className="nm">{v.name}</span>
                      {v.note ? <span className="nt">{v.note}</span> : null}
                      {v.preview ? (
                        <button className="vm-hear" title={hearing === v.id ? 'Stop' : 'Hear it'} onClick={(e) => (e.stopPropagation(), hear(v))}>
                          <Icon name={hearing === v.id ? 'Square' : 'Play'} size={11} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Field>
              <Field label="Voice model">
                <div className="vm-models">
                  {VOICE_MODELS.map((m) => (
                    <button key={m.id} className={`vm-model${opts.model === m.id ? ' on' : ''}`} onClick={() => set({ model: m.id })}>
                      <span className="nm">{m.name}</span>
                      <span className="nt">{m.note}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Pace">
                <Seg value={opts.speed} options={[[0.9, 'Slower'], [1, 'Normal'], [1.1, 'Faster']]} onChange={(speed) => set({ speed })} />
              </Field>
              <Field label="Title card">
                <input className="vm-in" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} onFocus={() => setAt(0)} />
                <textarea className="vm-in" value={sub} maxLength={600} rows={2} onChange={(e) => setSub(e.target.value)} onFocus={() => setAt(0)} />
              </Field>
              <Field label="Look">
                <Seg value={opts.size} options={[['1080', '1080p'], ['720', '720p (smaller to send)']]} onChange={(size) => set({ size })} />
                <Check on={opts.code} label="Show the code" onChange={(code) => set({ code })} />
                <Check on={opts.orb} label="Orb on the title card" onChange={(orb) => set({ orb })} />
                <Check on={opts.subtitles} label="Subtitles (what's said, under each slide)" onChange={(subtitles) => set({ subtitles })} />
              </Field>
              <Field label="Accent">
                <Seg value={opts.accent} options={[['cora', 'Your Cora colour'], ['session', "The session's colour"]]} onChange={(accent) => set({ accent })} />
              </Field>
              <Field label="Keep it">
                <Seg value={opts.keepHours} options={[[1, 'An hour'], [24, 'A day'], [168, 'A week']]} onChange={(keepHours) => set({ keepHours })} />
              </Field>
            </div>
          </div>
        )}
        <div className="vm-foot">
          <span className="dim">
            {chars == null ? '…' : chars ? `≈ ${chars.toLocaleString()} characters to voice` : 'Nothing new to voice'} · about {minutes} min · lines voiced before are free
          </span>
          {err && d ? <span className="vm-err">{err}</span> : null}
          <span className="spacer" />
          <button className="btn ghost" disabled={!d} onClick={() => void saveDefaults()} title="Voice, pace, look, accent and keep-for, for next time (Settings › Sessions › Debrief)">
            <Icon name={saved ? 'Check' : 'Save'} size={12} /> {saved ? 'Saved' : 'Save as my defaults'}
          </button>
          <button className="btn allow" disabled={!plan || busy || !plan.slides.length} onClick={() => void make()}>
            <Icon name={busy ? 'LoaderCircle' : 'Clapperboard'} size={12} /> Make it
          </button>
        </div>
      </div>
    </div>
  );
}

/** The slide, scaled to fit its box (drawn as the video draws it). */
function Preview({ slide, color, label, media }: { slide: ReturnType<typeof planSlides>[number] | null; color?: string; label: string; media?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1920));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="vm-prev" ref={box} style={{ height: 1080 * scale, ...(color ? { ['--cora' as string]: color } : {}) }}>
      <div className="vm-prev-in" style={{ transform: `scale(${scale})` }}>
        {slide ? <SlideView slide={slide} orbSlot media={media} /> : null}
      </div>
      {/* the title's orb at its own size over its slot (a 3D canvas inside the scaled slide would shrink twice) */}
      {slide?.kind === 'title' && slide.orb !== false ? (
        <span className="vm-prev-orb" style={{ left: ORB_X * scale, top: 540 * scale }}>
          <CoraOrb state="idle" size={Math.round(300 * scale)} ferro {...(color ? { color } : {})} />
        </span>
      ) : null}
      <span className="vm-prev-l">preview · {label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="vm-f">
      <div className="vm-lbl">{label}</div>
      {children}
    </div>
  );
}
function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange(v: T): void }) {
  return (
    <div className="vm-seg">
      {options.map(([v, l]) => (
        <button key={String(v)} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
function Check({ on, label, onChange }: { on: boolean; label: string; onChange(v: boolean): void }) {
  return (
    <label className="vm-chk">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
