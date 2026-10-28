import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { CoraState } from '../state/orchestrator';
import { sessionEvents, useBrain } from '../state/store';
import { coraReading, useVoice, voiceLevels } from '../lib/voice';
import { FLUID_VS, ORB_FS } from '../scene/shaders';
import { glowTexture } from '../scene/fx';
import { ThoughtMotes } from '../scene/parts';
import { CoraCrown } from './CoraCrown';
import { TRIP, tripAt, tripTime, useCoraLinks } from '../lib/coraLinks';
import { sessionColor } from '../lib/format';

const R = 0.85;
/** the camera's view at the orb: this many world units from the canvas's top to its bottom */
const VIEW_H = 2 * 4.1 * Math.tan((20 * Math.PI) / 180);
const easeIO = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOutQ = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) * (1 - t));
const easeInQ = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t);
/** Cora's orb (its card) and the open session's (its card), for reaching between them */
const ORB_EL = { cora: '.cora-bridge.orb-mode .cb-lens .cora-orb', session: '.scard .sc-orb .cora-orb' } as const;
const RED = new THREE.Color('#f87171');
const GREY = new THREE.Color('#64748b');
const INDIGO = new THREE.Color('#818cf8');
/** Where your pointer was last seen anywhere in the window (the orb's gaze follows it), and when you last did anything. */
const pointer = { x: -1e4, y: -1e4, at: 0, input: Date.now() };
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => ((pointer.x = e.clientX), (pointer.y = e.clientY), (pointer.at = Date.now()), (pointer.input = pointer.at)), { passive: true });
  window.addEventListener('keydown', () => void (pointer.input = Date.now()), { passive: true });
}
/** Late at night and you've been away from the keyboard a while: it sleeps (Away mode too). */
const nightQuiet = (now: number) => {
  const h = new Date(now).getHours();
  return (h >= 23 || h < 7) && now - pointer.input > 10 * 60_000;
};

/** Your hand on the orb itself: over it (and where), pressed (a poke), held (talking). */
type Touch = { hover: boolean; at: { x: number; y: number } | null; pokes: number };

const cssColor = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--cora').trim();
  return v || '#f472b6';
};

/**
 * Cora's eye as a main agent's orb (the 3D scene's fluid orb, in Cora's colour), with all of a main orb's moves, driven
 * by Cora's own agent: the neural layer firing while it thinks (deeper the longer it thinks) with motes spiralling in,
 * spikes while it runs a tool, a flash at each step, frozen with a red glow while it waits for you, ripples toward you
 * as you talk, spikes with its voice as it speaks, a squash when it compacts, a shiver when a call fails, and its slow
 * bob. And alive: it looks toward your pointer, swells under it with ripples where you touch, jiggles when poked, and
 * (`onHold`) listens while you hold it; it breathes, now and then ripples, turns or glints on its own, and sleeps in
 * Away mode or late at night when you've gone quiet, waking with a flash. Sized to the card: the canvas is bigger than
 * the orb so its glow and motes spill out, and nothing leaves it.
 */
export function CoraOrb({ state, size, progress, agent, away, onHold, glow, color, speaking, reach, wide, master, ferro }: { state: CoraState; size: number; progress?: number; agent?: string | null; away?: boolean; onHold?(on: boolean): void; /** an element its light falls on (--orb-glow, --orb-tint) */ glow?: React.RefObject<HTMLElement | null>; /** another's colour (a session's orb): none, Cora's */ color?: string; /** another's voice speaking (a session's orb): none, Cora's */ speaking?: boolean; /** which orb it is, for reaching between Cora's card and the open session's (lib/coraLinks) */ reach?: 'cora' | 'session'; /** its canvas this wide (its card's width), so an arm has room to reach the card's edge */ wide?: number; /** Cora's own (it wears the crown: rings, your sessions riding them, a shell) */ master?: boolean; /** all ferrofluid: its spikes up and pulsing, as if it spoke (Cora's Slack banner) */ ferro?: boolean }) {
  const touch = useRef<Touch>({ hover: false, at: null, pokes: 0 });
  const hold = useRef<{ timer: number; on: boolean }>({ timer: 0, on: false });
  const where = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y: (e.clientY - (r.top + r.height / 2)) / (r.height / 2) };
  };
  const release = () => {
    clearTimeout(hold.current.timer);
    if (hold.current.on) (hold.current.on = false), onHold?.(false);
  };
  const box = Math.round(size * 1.7);
  // a goal's progress (autopilot): a ring around it, as the lens has
  const ring = state === 'autopilot' && progress != null ? progress : null;
  return (
    <span
      className={`cora-orb st-${state}${size < 40 ? ' small' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden
      onPointerEnter={() => void (touch.current.hover = true)}
      onPointerLeave={() => ((touch.current.hover = false), (touch.current.at = null), release())}
      onPointerMove={(e) => void (touch.current.at = where(e))}
      onPointerDown={(e) => {
        touch.current.pokes++;
        touch.current.at = where(e);
        // held: it listens (talk to Cora) until you let go
        if (onHold && e.button === 0) hold.current.timer = window.setTimeout(() => ((hold.current.on = true), onHold(true)), 380);
      }}
      onPointerUp={release}
    >
      {ring != null ? (
        <svg className="co-ring" viewBox="0 0 100 100" aria-label={`Goal ${Math.round(ring * 100)}% done`}>
          <title>{`Autopilot: the goal is about ${Math.round(ring * 100)}% done`}</title>
          <circle cx="50" cy="50" r="47" pathLength={100} strokeDasharray={`${Math.round(ring * 100)} 100`} />
        </svg>
      ) : null}
      <span className="co-canvas" style={{ width: Math.max(box, wide ?? 0), height: box, margin: `${-(box - size) / 2}px 0 0 ${-(Math.max(box, wide ?? 0) - size) / 2}px` }}>
        <Canvas dpr={[1, 2]} gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }} camera={{ position: [0, 0, 4.1], fov: 40 }}>
          <OrbBody state={state} agent={agent ?? null} small={size < 40} away={!!away} touch={touch} glow={glow} color={color} speaking={speaking} reach={size < 40 ? undefined : reach} master={size >= 40 && !!master} ferro={!!ferro} />
        </Canvas>
      </span>
    </span>
  );
}

/** What Cora's agent is doing, from its events: tool calls in flight, its last step, its last compaction and failure. */
function useAgentSignals(agent: string | null) {
  const version = useBrain((s) => (agent ? s.versions[agent] : 0));
  return useMemo(() => {
    const out = { open: 0, last: 0, compact: 0, fail: 0 };
    if (!agent) return out;
    // in flight: started, not finished (wherever its end comes in the list: around a restart they can come out of
    // order), and since the turn last ended (a turn that ended runs nothing, even if a tool's end never came)
    const starts = new Map<string, number>();
    const ended = new Set<string>();
    let turnEnd = 0;
    for (const e of sessionEvents(agent)) {
      if (e.agentId !== 'main') continue;
      out.last = Math.max(out.last, e.ts);
      if (e.kind === 'compact') out.compact = e.ts;
      if (e.kind === 'turn_end') turnEnd = Math.max(turnEnd, e.ts);
      if (e.kind !== 'tool' || !e.toolUseId) continue;
      if (e.phase === 'start') starts.set(e.toolUseId, e.ts);
      else {
        ended.add(e.toolUseId);
        if (e.tool?.failed) out.fail = e.ts;
      }
    }
    out.open = [...starts].filter(([id, ts]) => !ended.has(id) && ts > turnEnd).length;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, version]);
}

function OrbBody({ state, agent, small, away, touch, glow, color: own, speaking: theirs, reach, master, ferro }: { state: CoraState; agent: string | null; small: boolean; away: boolean; touch: React.MutableRefObject<Touch>; glow?: React.RefObject<HTMLElement | null>; color?: string; speaking?: boolean; reach?: 'cora' | 'session'; master?: boolean; ferro?: boolean }) {
  const coraSpeaking = useVoice((v) => coraReading(v.reading));
  const speaking = theirs ?? coraSpeaking;
  const ownRef = useRef(own);
  ownRef.current = own;
  const sig = useAgentSignals(agent);
  const live = useRef({ state, speaking, sig, away });
  live.current = { state, speaking, sig, away };
  const body = useRef<THREE.Group>(null);
  const look = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.SpriteMaterial>(null);
  const color = useMemo(() => new THREE.Color(own ?? cssColor()), []); // eslint-disable-line react-hooks/exhaustive-deps
  // what's already been seen (a compaction or a failure from before it was on screen doesn't replay)
  const k = useRef({ think: 0, work: 0, busy: 0, alert: 0, listen: 0, speak: 0, off: 0, clock: Math.random() * 20, ripT: 0, tint: 0, shiver: 0, squash: 0, neural: 0, deep: 0, thinkSince: 0, sawCompact: sig.compact, sawFail: sig.fail, lit: -1, litTint: '', gx: 0, gy: 0, hover: 0, hripT: 0, sawPokes: 0, glint: 0, spin: 0, idleT: 12 + Math.random() * 15, sleep: 0, asleep: false });
  const fires = useRef<Array<{ dir: THREE.Vector3; age: number }>>([]);
  const ripples = useRef<Array<{ dir: THREE.Vector3; age: number; amp: number }>>([]);
  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uThink: { value: 0 }, uEnergy: { value: 0.3 }, uAlert: { value: 0 }, uVis: { value: 1 },
      uWork: { value: 0 }, uBusy: { value: 0 }, uShiver: { value: 0 }, uLean: { value: 0 }, uFerro: { value: 0 }, uTarget: { value: new THREE.Vector3(1, 0, 0) },
      uRipDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0, 0, 1)) }, uRipAge: { value: new Array(6).fill(-1) }, uRipAmp: { value: new Array(6).fill(0) },
      uNeural: { value: 0 }, uDeep: { value: 0 }, uReachDir: { value: new THREE.Vector3(1, 0, 0) }, uReach: { value: 0 }, uReachW: { value: 0.93 }, uCore: { value: 0 }, uFireDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0, 0)) }, uFireAge: { value: new Array(6).fill(-1) },
    }),
    [],
  );
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: FLUID_VS, fragmentShader: ORB_FS, uniforms, toneMapped: false }), [uniforms]);
  useEffect(() => () => mat.dispose(), [mat]);
  // a message between the cards: a small copy of the sender (the same fluid, moving with this orb's clock, in the
  // sender's colour), and what this orb has already done for the trip in view (a touch, taking it back)
  const messengerRef = useRef<THREE.Mesh>(null);
  const messengerMat = useMemo(() => {
    const quiet = { uRipDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0, 0, 1)) }, uRipAge: { value: new Array(6).fill(-1) }, uRipAmp: { value: new Array(6).fill(0) } };
    return new THREE.ShaderMaterial({ vertexShader: FLUID_VS, fragmentShader: ORB_FS, uniforms: { ...uniforms, uColor: { value: new THREE.Color() }, uReach: { value: 0 }, ...quiet }, toneMapped: false });
  }, [uniforms]);
  useEffect(() => () => messengerMat.dispose(), [messengerMat]);
  const tripSeen = useRef({ at: 0, touched: false, home: false });
  const q = useMemo(() => new THREE.Quaternion(), []);
  const thinkingNow = state === 'thinking' || state === 'autopilot';

  useFrame(({ clock, gl }, dt) => {
    const s = k.current;
    const { state, speaking, sig, away } = live.current;
    const io = touch.current;
    const now = Date.now();
    const t = clock.elapsedTime;
    const ease = (cur: number, to: number, rate: number) => cur + (to - cur) * Math.min(1, dt * rate);
    // the theme's colour can change while it runs: look again now and then
    s.tint += dt;
    if (s.tint > 1) {
      s.tint = 0;
      color.set(ownRef.current ?? cssColor());
    }
    // one-shots: a compaction squashes it, a failed call makes it shiver
    if (sig.compact > s.sawCompact) (s.sawCompact = sig.compact), (s.squash = 1);
    if (sig.fail > s.sawFail) (s.sawFail = sig.fail), (s.shiver = 1);
    s.shiver *= Math.pow(0.05, dt);
    s.squash *= Math.pow(0.02, dt);
    const thinking = (state === 'thinking' || state === 'autopilot') && !sig.open;
    s.think = ease(s.think, state === 'thinking' || state === 'autopilot' ? 1 : 0, 4);
    s.work = ease(s.work, sig.open ? 1 : 0, 3);
    s.busy = ease(s.busy, Math.min(3, sig.open), 3);
    s.alert = ease(s.alert, state === 'needs-you' ? 1 : 0, 6);
    s.listen = ease(s.listen, state === 'listening' ? 1 : 0, 5);
    s.speak = ease(s.speak, speaking ? 1 : 0, 5);
    s.off = ease(s.off, state === 'off' || state === 'error' || state === 'starting' ? 1 : 0, 3);
    // asleep: Away mode, or late at night with you gone quiet (only while it has nothing to do); waking: a flash
    const asleep = state === 'idle' && (away || nightQuiet(now));
    if (s.asleep && !asleep) {
      s.glint = 1;
      s.spin = 2;
      for (let i = 0; i < 3; i++) ripples.current.push({ dir: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, 0.8).normalize(), age: -i * 0.15, amp: 0.07 });
    }
    s.asleep = asleep;
    s.sleep = ease(s.sleep, asleep ? 1 : 0, 0.6);
    // its gaze: toward your pointer while it's near and moving (it loses interest after a while)
    const box = gl.domElement.getBoundingClientRect();
    const dx = pointer.x - (box.left + box.width / 2);
    const dy = pointer.y - (box.top + box.height / 2);
    const keen = now - pointer.at < 8000 ? Math.max(0, Math.min(1, 1 - (Math.hypot(dx, dy) - 120) / 900)) * (1 - s.sleep) : 0;
    s.gx = ease(s.gx, Math.max(-1, Math.min(1, dx / 380)) * keen, 3);
    s.gy = ease(s.gy, Math.max(-1, Math.min(1, dy / 380)) * keen, 3);
    // under your hand: it swells, ripples where you touch, and a poke jiggles it
    s.hover = ease(s.hover, io.hover ? 1 : 0, 8);
    s.hripT -= dt;
    if (io.hover && io.at && s.hripT <= 0) {
      ripples.current.push({ dir: new THREE.Vector3(io.at.x, -io.at.y, 0.8).normalize(), age: 0, amp: 0.03 });
      s.hripT = 0.16;
    }
    if (io.pokes > s.sawPokes) {
      s.sawPokes = io.pokes;
      s.squash = Math.max(s.squash, 0.55);
      s.glint = Math.max(s.glint, 0.6);
      ripples.current.push({ dir: new THREE.Vector3(io.at?.x ?? 0, -(io.at?.y ?? 0), 0.8).normalize(), age: 0, amp: 0.09 });
    }
    // on its own now and then while idle: a ripple, a turn or a glint
    s.idleT -= dt;
    if (s.idleT <= 0) {
      s.idleT = 18 + Math.random() * 22;
      if (state === 'idle' && !io.hover && s.sleep < 0.5) {
        const pick = Math.floor(Math.random() * 3);
        if (pick === 0) ripples.current.push({ dir: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.2).normalize(), age: 0, amp: 0.06 });
        else if (pick === 1) s.spin = 2.5;
        else s.glint = 1;
      }
    }
    s.spin *= Math.pow(0.25, dt);
    s.glint *= Math.pow(0.15, dt);
    if (ripples.current.length > 6) ripples.current.splice(0, ripples.current.length - 6);
    // needs you: the fluid stops dead (its clock freezes) until answered; asleep, it slows right down
    const frozen = s.alert > 0.5;
    s.clock += dt * (1 - s.alert * 0.98) * (1 - s.off * 0.7) * (1 - s.sleep * 0.65);
    uniforms.uTime.value = s.clock;
    uniforms.uThink.value = s.think;
    // thinking, made visible: the neural layer, firing more often (and deeper) the longer it thinks
    if (thinking && !s.thinkSince) s.thinkSince = now;
    if (!thinking) s.thinkSince = 0;
    const long = s.thinkSince ? Math.min(1, (now - s.thinkSince) / 6000) : 0;
    s.neural = ease(s.neural, thinking ? 1 : 0, 2);
    s.deep = ease(s.deep, thinking ? long : 0, 1);
    if (thinking && !frozen && Math.random() < dt * (2.2 + long * 4)) {
      fires.current.push({ dir: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), age: 0 });
      if (fires.current.length > 6) fires.current.shift();
    }
    for (const f of fires.current) f.age += frozen ? 0 : dt * 1.4;
    fires.current = fires.current.filter((f) => f.age < 1);
    uniforms.uNeural.value = s.neural;
    uniforms.uDeep.value = s.deep;
    for (let i = 0; i < 6; i++) {
      const f = fires.current[i];
      uniforms.uFireAge.value[i] = f ? f.age : -1;
      if (f) uniforms.uFireDir.value[i].copy(f.dir);
    }
    // a tool call in flight: spikes (more with more calls); speaking: a ferrofluid speaker driven by its voice
    uniforms.uWork.value = Math.max(s.work, s.speak * (0.15 + voiceLevels.speak * 1.6));
    uniforms.uBusy.value = Math.max(s.busy, s.speak * voiceLevels.speak * 2.5);
    uniforms.uFerro.value = s.speak;
    // all ferrofluid: tall sharp cones, swelling and settling as a voice would drive them
    if (ferro) {
      const lv = 0.5 + 0.5 * Math.sin(t * 4.1) * Math.sin(t * 1.7 + 0.8);
      uniforms.uWork.value = 0.7 + 0.45 * lv;
      uniforms.uBusy.value = 0.35 + 0.9 * lv;
      uniforms.uFerro.value = 1;
    }
    uniforms.uColor.value.copy(color).lerp(INDIGO, s.speak * 0.5).lerp(GREY, s.off * 0.8);
    uniforms.uShiver.value = s.shiver;
    uniforms.uAlert.value = Math.max(s.alert, s.shiver * 0.7);
    // each step it takes: a flash of energy
    const energy = sig.last ? Math.max(0, 1.2 * Math.exp(-(now - sig.last) / 1500)) : 0;
    uniforms.uEnergy.value = (Math.max(0.25 + 0.2 * s.think, energy) + 0.3 * s.listen * voiceLevels.listen + 0.7 * s.glint + 0.15 * s.hover) * (1 - s.sleep * 0.5);
    uniforms.uVis.value = (1 - s.off * 0.45) * (1 - s.sleep * 0.3);
    // Cora's: lit from within, brighter as it works or thinks, low asleep or off
    uniforms.uCore.value = master ? (0.75 + 0.35 * Math.min(1, s.work + s.think * 0.6) + 0.15 * Math.sin(t * 1.2)) * (1 - s.sleep * 0.6) * (1 - s.off * 0.8) : 0;
    // its slow bob, leaning a little toward where it looks
    if (body.current) body.current.position.set(s.gx * 0.07, Math.sin(t * 0.6) * 0.07 * (1 - s.sleep * 0.5) - s.gy * 0.07, 0);
    if (look.current) look.current.rotation.set(s.gy * 0.45, s.gx * 0.55, 0);
    if (core.current) {
      core.current.rotation.y += dt * (0.15 + s.think * 0.4 + s.spin) * (1 - s.alert) * (1 - s.sleep * 0.6);
      const sq = s.squash * Math.cos((1 - s.squash) * 9);
      // it breathes (slower and deeper asleep, hardly at all while it works), and swells under your hand
      const b = (1 + (0.022 + 0.015 * s.sleep) * Math.sin(t * (1.5 - 0.7 * s.sleep)) * (1 - s.think * 0.8)) * (1 + 0.07 * s.hover);
      core.current.scale.set(b * (1 + 0.25 * sq), b * (1 - 0.35 * sq), b * (1 + 0.25 * sq));
      core.current.getWorldQuaternion(q).invert();
      // listening: ripples land on the side facing you
      s.ripT -= dt;
      if (s.listen > 0.3 && voiceLevels.listen > 0.06 && s.ripT <= 0) {
        const toYou = new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 1).normalize();
        ripples.current.push({ dir: toYou, age: 0, amp: 0.04 + voiceLevels.listen * 0.16 });
        if (ripples.current.length > 6) ripples.current.shift();
        s.ripT = 0.11;
      }
      for (const rp of ripples.current) rp.age += frozen ? 0 : dt;
      ripples.current = ripples.current.filter((rp) => rp.age < 1.2);
      for (let i = 0; i < 6; i++) {
        const rp = ripples.current[i];
        uniforms.uRipAge.value[i] = rp ? rp.age : -1;
        uniforms.uRipAmp.value[i] = rp ? rp.amp : 0;
        if (rp) uniforms.uRipDir.value[i].copy(rp.dir).applyQuaternion(q);
      }
    }
    // its light on the card: brighter with energy, thought, a glint or your hand; red while it needs you; dim asleep
    const el = glow?.current;
    if (el) {
      const lit = Math.min(1, (0.3 + 0.45 * energy + 0.25 * s.think + 0.5 * s.glint + 0.35 * s.alert + 0.15 * s.hover + 0.3 * s.speak * voiceLevels.speak) * (1 - s.sleep * 0.65) * (1 - s.off * 0.7));
      if (Math.abs(lit - s.lit) > 0.01) el.style.setProperty('--orb-glow', (s.lit = lit).toFixed(3));
      const tint = s.alert > 0.5 || s.shiver > 0.3 ? '#f87171' : '';
      if (tint !== s.litTint) (s.litTint = tint) ? el.style.setProperty('--orb-tint', tint) : el.style.removeProperty('--orb-tint');
    }
    // reaching between the cards (Cora and the open session talking): an arm out of it, or the other's coming in
    if (reach && messengerRef.current) tripFrame(s, gl.domElement);
    else uniforms.uReach.value = 0;
    if (halo.current) {
      halo.current.color.copy(color).lerp(RED, Math.max(s.alert, s.shiver * 0.6)).lerp(GREY, s.off * 0.8);
      halo.current.opacity = (0.22 + 0.3 * energy + 0.12 * s.think + 0.25 * s.alert + 0.3 * s.listen * voiceLevels.listen + 0.35 * s.speak * voiceLevels.speak + 0.3 * s.glint + 0.1 * s.hover) * (1 - s.off * 0.6) * (1 - s.sleep * 0.5);
    }
  });

  /** A message on its way (lib/coraLinks' trip): this orb's part of it, as sender or receiver. */
  function tripFrame(s: typeof k.current, canvas: HTMLCanvasElement) {
    const m = messengerRef.current!;
    m.visible = false;
    uniforms.uReach.value = 0;
    const L = useCoraLinks.getState();
    const now = Date.now();
    const trip = tripAt(L.trips, now);
    // (where it is on its timeline: Cora's stays circling the session while its call is still going)
    const t = trip ? tripTime(trip, now) : Infinity;
    const theirs = trip && t < TRIP.end ? document.querySelector(ORB_EL[reach === 'cora' ? 'session' : 'cora']) : null;
    if (!trip || !theirs) return;
    const seen = tripSeen.current;
    if (seen.at !== trip.at) tripSeen.current = { at: trip.at, touched: false, home: false };
    // toward the other orb, out through this card's side
    const cv = canvas.getBoundingClientRect();
    const tr = theirs.getBoundingClientRect();
    let dx = tr.left + tr.width / 2 - (cv.left + cv.width / 2);
    let dy = tr.top + tr.height / 2 - (cv.top + cv.height / 2);
    const slope = cv.height / cv.width;
    if (Math.abs(dy) > Math.abs(dx) * slope) dy = Math.sign(dy) * Math.abs(dx) * slope;
    const dl = Math.hypot(dx, dy) || 1;
    const dir = new THREE.Vector3(dx / dl, -dy / dl, 0);
    const edge = (cv.width / 2 / Math.max(0.2, Math.abs(dir.x))) * (VIEW_H / cv.height) + 0.45;
    const r = R * 0.3;
    const sender = trip.from === reach;
    const colour = trip.from === 'cora' ? cssColor() : sessionColor(useBrain.getState().sessions[trip.sid] ?? ({} as never));
    (messengerMat.uniforms.uColor.value as THREE.Color).set(colour);
    const bulge = (amount: number, toward: THREE.Vector3, width: number) => {
      uniforms.uReachDir.value.copy(toward).normalize().applyQuaternion(q).normalize();
      uniforms.uReach.value = amount;
      uniforms.uReachW.value = width;
    };
    const show = (pos: THREE.Vector3, scale: number) => {
      m.visible = scale > 0.01;
      m.position.copy(pos);
      m.scale.setScalar(scale);
    };
    if (sender) {
      if (t < TRIP.bud) {
        // it swells on that side, and a small copy of it buds off
        const u = t / TRIP.bud;
        bulge(0.28 * Math.sin(Math.PI * u), dir, 0.82);
        show(dir.clone().multiplyScalar(R * (0.55 + 0.75 * easeOutQ(u))), r * (0.45 + 0.55 * u));
      } else if (t < TRIP.out) {
        const u = (t - TRIP.bud) / (TRIP.out - TRIP.bud);
        show(dir.clone().multiplyScalar(R * 1.3 + (edge - R * 1.3) * easeInQ(u)), r);
      } else if (t >= TRIP.back && t < TRIP.home) {
        // home again
        const u = (t - TRIP.back) / (TRIP.home - TRIP.back);
        show(dir.clone().multiplyScalar(edge + (R * 1.25 - edge) * easeOutQ(u)), r);
      } else if (t >= TRIP.home) {
        // taken back in: it sinks into the orb, which swells and ripples
        const u = Math.min(1, (t - TRIP.home) / (TRIP.end - TRIP.home));
        bulge(0.2 * (1 - u), dir, 0.85);
        show(dir.clone().multiplyScalar(R * (1.25 - 0.85 * easeIO(u))), r * (1 - easeInQ(u)));
        if (u > 0.45 && !seen.home) {
          seen.home = true;
          ripples.current.push({ dir: new THREE.Vector3(dir.x, dir.y, 0.4).normalize(), age: 0, amp: 0.1 });
          s.squash = Math.max(s.squash, 0.35);
          s.glint = Math.max(s.glint, 0.7);
        }
      }
      return;
    }
    // the other's messenger: in from the edge, once around this orb (touching it halfway), and out again
    const R0 = R * 1.5;
    const perp = new THREE.Vector3(-dir.y, dir.x, 0);
    const e2 = perp.multiplyScalar(0.45).add(new THREE.Vector3(0, 0, 0.9)).normalize();
    const around = (a: number) => {
      // nearer when it touches (in front, a quarter of the way round)
      const rad = R0 - R * 0.42 * Math.exp(-Math.pow((a - Math.PI / 2) / 0.32, 2));
      return dir.clone().multiplyScalar(Math.cos(a) * rad).add(e2.clone().multiplyScalar(Math.sin(a) * rad));
    };
    if (t >= TRIP.inStart && t < TRIP.arrive) {
      const u = (t - TRIP.inStart) / (TRIP.arrive - TRIP.inStart);
      show(dir.clone().multiplyScalar(edge + (R0 - edge) * easeOutQ(u)), r);
    } else if (t >= TRIP.arrive && t < TRIP.orbit) {
      const a = easeIO((t - TRIP.arrive) / (TRIP.orbit - TRIP.arrive)) * Math.PI * 2;
      const pos = around(a);
      show(pos, r);
      // the touch: it rises to meet it, and both light up
      const near = Math.exp(-Math.pow((a - Math.PI / 2) / 0.32, 2));
      if (near > 0.05) bulge(0.2 * near, pos, 0.8);
      if (near > 0.85 && !seen.touched) {
        seen.touched = true;
        ripples.current.push({ dir: pos.clone().normalize(), age: 0, amp: 0.1 });
        s.glint = Math.max(s.glint, 0.8);
      }
    } else if (t >= TRIP.orbit && t < TRIP.leave) {
      const u = (t - TRIP.orbit) / (TRIP.leave - TRIP.orbit);
      show(dir.clone().multiplyScalar(R0 + (edge - R0) * easeInQ(u)), r);
    }
  }

  return (
    <group ref={body}>
      {/* the glow stays inside the canvas (cut off at its edge it would show as a square) */}
      <sprite scale={[R * 3.4, R * 3.4, 1]}>
        <spriteMaterial ref={halo} map={glowTexture()} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
      {/* a message between the cards: a small copy of the sender (see tripFrame) */}
      {reach ? (
        <mesh ref={messengerRef} material={messengerMat} visible={false}>
          <sphereGeometry args={[1, 64, 40]} />
        </mesh>
      ) : null}
      {/* turned a little toward where it looks */}
      <group ref={look}>
        <mesh ref={core} material={mat}>
          <sphereGeometry args={[R, small ? 64 : 112, small ? 40 : 72]} />
        </mesh>
      </group>
      {/* motes close in, inside the card (the scene's spread far wider) */}
      {small ? null : <ThoughtMotes r={R} thinking={thinkingNow} color={color} ring={[1.15, 0.55]} tall={1.6} />}
      {master ? <CoraCrown R={R} uniforms={uniforms} color={color} work={() => Math.max(k.current.work, k.current.think * 0.6, k.current.speak * 0.5)} /> : null}
    </group>
  );
}
