// The startup splash: droplets coalesce into the orb (with ferrofluid reaching for them) in front of a gentle
// star stream that settles into the galaxy. Driven by the server's real startup stages, relayed by the main process.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FS, VS } from './shaders';

type StageMsg = { s: 'host' | 'tx' | 'listen' | 'cora' | 'note'; e: 'start' | 'done' | 'skip' | 'progress' | 'warn'; done?: number; total?: number; kept?: number; sessions?: number; live?: number; how?: 'kept' | 'started' | 'error'; key?: 'hooks' | 'nohost' };
type SplashMsg =
  | { t: 'ready' }
  | { t: 'error'; message: string }
  | { t: 'about'; build: string | null; electron: string; changes: number | null; electronFrom: string | null }
  | { t: 'hooks'; ok: boolean; message?: string }
  | StageMsg;
type SplashApi = { start(noHost: boolean): void; done(): void; openLog(): void; on(cb: (m: SplashMsg) => void): () => void };
const api = (window as unknown as { coraDesktop?: { splash?: SplashApi } }).coraDesktop?.splash;

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#06090f');
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 300);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.55, 0.82));
composer.addPass(new OutputPass());

const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.22, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const glow = (color: THREE.ColorRepresentation, size: number, opacity: number) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.set(size, size, 1);
  return s;
};
const RED = new THREE.Color('#f87171');
const GEO_HI = new THREE.SphereGeometry(1, 160, 96);
const GEO_LO = new THREE.SphereGeometry(1, 64, 40);
const bez = (a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) => {
  const u = 1 - t;
  return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
};

// ---------------------------------------------------------------- the fluid orb (the app's shader, plus a ferrofluid setting)
type OrbState = 'idle' | 'think' | 'work' | 'needs';
class Orb {
  r: number;
  color: THREE.Color;
  group = new THREE.Group();
  body = new THREE.Group();
  u: Record<string, { value: any }>;
  mesh: THREE.Mesh;
  halo: THREE.Sprite;
  aura: THREE.Sprite;
  k = { think: 0, work: 0, busy: 0, shiver: 0, alert: 0, flash: 0, lean: 0, vis: 1, squash: 0, grow: 1 };
  growTo = 1;
  state: OrbState = 'idle';
  inflight = 0;
  target: THREE.Vector3 | null = null;
  clock = Math.random() * 10;
  ripples: Array<{ dir: THREE.Vector3; age: number; amp: number }> = [];
  dead = false;
  constructor(parent: THREE.Object3D, color: string, r: number, pos: THREE.Vector3, hi = true) {
    this.r = r;
    this.color = new THREE.Color(color);
    this.group.position.copy(pos);
    parent.add(this.group);
    this.group.add(this.body);
    this.u = {
      uColor: { value: this.color.clone() }, uTime: { value: 0 }, uThink: { value: 0 }, uWork: { value: 0 }, uBusy: { value: 0 }, uShiver: { value: 0 }, uFerro: { value: 0 },
      uTarget: { value: new THREE.Vector3(1, 0, 0) }, uLean: { value: 0 }, uAlert: { value: 0 }, uFlash: { value: 0 }, uVis: { value: 1 },
      uRipDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0, 0)) }, uRipAge: { value: new Array(6).fill(-1) }, uRipAmp: { value: new Array(6).fill(0) },
    };
    this.mesh = new THREE.Mesh(hi ? GEO_HI : GEO_LO, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.u }));
    this.mesh.scale.setScalar(r);
    this.halo = glow(color, r * 4.4, 0.22);
    this.aura = glow(color, r * 7, 0.05);
    this.body.add(this.aura, this.halo, this.mesh);
  }
  ripple(dir: THREE.Vector3, amp: number) {
    this.ripples.push({ dir: dir.clone().normalize(), age: 0, amp });
    if (this.ripples.length > 6) this.ripples.shift();
  }
  dirTo(p: THREE.Vector3) {
    return p.clone().sub(this.group.position).normalize();
  }
  update(dt: number) {
    const k = this.k, e = Math.min(1, dt * 3);
    const frozen = this.state === 'needs';
    k.think += ((this.state === 'think' ? 1 : 0) - k.think) * e;
    k.work += ((this.state === 'work' || this.inflight > 0 ? 1 : 0) - k.work) * e;
    k.busy += (Math.min(3, this.inflight) - k.busy) * e;
    k.lean += ((this.target ? 1 : 0) - k.lean) * e;
    k.alert += ((frozen ? 1 : 0) - k.alert) * Math.min(1, dt * 6);
    k.vis += ((this.dead ? 0 : 1) - k.vis) * Math.min(1, dt * 2);
    k.grow += (this.growTo - k.grow) * Math.min(1, dt * 3.5);
    k.shiver *= Math.pow(0.05, dt);
    k.flash *= Math.pow(0.08, dt);
    this.clock += dt * (1 - k.alert * 0.98);
    for (const r of this.ripples) r.age += dt * (frozen ? 0 : 1);
    this.ripples = this.ripples.filter((r) => r.age < 1.2);
    const u = this.u;
    u.uTime.value = this.clock;
    u.uThink.value = k.think;
    u.uWork.value = k.work;
    u.uBusy.value = k.busy;
    u.uShiver.value = k.shiver;
    const toLocal = this.mesh.quaternion.clone().invert();
    u.uLean.value = k.lean;
    if (this.target) (u.uTarget.value as THREE.Vector3).lerp(this.dirTo(this.target).applyQuaternion(toLocal), Math.min(1, dt * 4)).normalize();
    u.uAlert.value = Math.max(k.alert, k.shiver * 0.7);
    u.uFlash.value = k.flash;
    u.uVis.value = 0.15 + 0.85 * k.vis;
    for (let i = 0; i < 6; i++) {
      const r = this.ripples[i];
      u.uRipAge.value[i] = r ? r.age : -1;
      u.uRipAmp.value[i] = r ? r.amp : 0;
      if (r) (u.uRipDir.value[i] as THREE.Vector3).copy(r.dir).applyQuaternion(toLocal);
    }
    this.mesh.rotation.y += dt * (0.12 + k.think * 0.4) * (1 - k.alert);
    k.squash *= Math.pow(0.02, dt);
    const sq = k.squash * Math.cos((1 - k.squash) * 9);
    this.body.scale.set(1 + 0.25 * sq, 1 - 0.35 * sq, 1 + 0.25 * sq).multiplyScalar((0.4 + 0.6 * k.vis) * k.grow);
    this.halo.material.color.copy(this.color).lerp(RED, Math.max(k.alert, k.shiver * 0.6));
    this.halo.material.opacity = (0.18 + 0.15 * k.work + 0.45 * k.flash + 0.2 * k.alert) * k.vis;
    this.aura.material.opacity = (0.05 + 0.1 * k.flash) * k.vis;
  }
}

// Cora's colour (yours to pick; the app passes it): the orb, and Cora's own row
const CORA_Q = new URLSearchParams(location.search).get('cora') ?? '';
const CORA = /^#[0-9a-f]{6}$/i.test(CORA_Q) ? CORA_Q : '#2dd4bf';

// ---------------------------------------------------------------- startup stages
const STAGES = [
  { label: 'Starting the server', color: '#22d3ee' },
  { label: 'Terminal host', color: '#a78bfa' },
  { label: 'Reading transcripts', color: '#fbbf24' },
  { label: 'Connecting', color: '#2dd4bf' },
];
const root = new THREE.Group();
scene.add(root);

/** A dim star stream flowing past behind the orb, slowing with each stage, settling into the galaxy at the end. */
function starStream() {
  const N = 1200, CY = 0.9, CZ = -15, TILT = -1.12;
  const pos = new Float32Array(N * 6), col = new Float32Array(N * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  root.add(new THREE.LineSegments(geo, mat));
  const WHITE = new THREE.Color('#c7d2fe');
  let tint = WHITE.clone();
  const stars = Array.from({ length: N }, (_, i) => {
    const a = Math.random() * Math.PI * 2, r = 2 + Math.pow(Math.random(), 0.7) * 14;
    const arm = i % 3, d = 0.6 + Math.pow(Math.random(), 0.6) * 13;
    return { x: Math.cos(a) * r, y: CY + Math.sin(a) * r, z: -115 + Math.random() * 125, c: WHITE.clone().multiplyScalar(0.4 + Math.random() * 0.6), d, th: (arm * Math.PI * 2) / 3 + d * 0.42 + (Math.random() - 0.5) * 0.6, gy: (Math.random() - 0.5) * 0.5 * (1 - d / 14), sx: 0, sy: 0, sz: 0 };
  });
  const SPEEDS = [20, 15, 10, 6];
  let speed = 0, speedT = reduced ? 0 : SPEEDS[0], m = -1, rot = 0, failed = 0;
  const ct = Math.cos(TILT), stt = Math.sin(TILT);
  return {
    stage(i: number) {
      if (!reduced) speedT = SPEEDS[i];
      tint = new THREE.Color(STAGES[i].color);
    },
    fail() {
      speedT = 0;
      failed = 1;
    },
    settle() {
      for (const st of stars) Object.assign(st, { sx: st.x, sy: st.y, sz: st.z });
      m = 0;
    },
    update(dt: number) {
      speed += (speedT - speed) * Math.min(1, dt * 0.9);
      mat.opacity += (0.6 - mat.opacity) * Math.min(1, dt * 0.8);
      if (m >= 0) m = Math.min(1, m + dt / 2.2);
      const e = m < 0 ? 0 : m < 0.5 ? 4 * m * m * m : 1 - Math.pow(-2 * m + 2, 3) / 2;
      rot += dt * 0.025;
      const camZ = camera.position.z - 1;
      const streak = speed * 0.045 * (1 - e);
      for (let i = 0; i < N; i++) {
        const st = stars[i];
        let x: number, y: number, z: number;
        if (m < 0) {
          st.z += speed * dt;
          if (st.z > camZ) {
            st.z -= 125;
            st.c.copy(Math.random() < 0.35 ? tint : WHITE).multiplyScalar(0.4 + Math.random() * 0.6);
          }
          x = st.x; y = st.y; z = st.z;
        } else {
          const a = st.th + rot, gx = Math.cos(a) * st.d, gz0 = Math.sin(a) * st.d;
          const gy = st.gy * ct - gz0 * stt + CY, gz = st.gy * stt + gz0 * ct + CZ;
          x = st.sx + (gx - st.sx) * e; y = st.sy + (gy - st.sy) * e; z = st.sz + (gz - st.sz) * e;
        }
        const o = i * 6;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        pos[o + 3] = x; pos[o + 4] = y; pos[o + 5] = z - streak - 0.02;
        const red = failed ? 0.6 : 0, fade = failed ? 0.45 : 1;
        const r = st.c.r + (0.97 - st.c.r) * red, g = st.c.g * (1 - red * 0.75), b = st.c.b * (1 - red * 0.7);
        col[o] = r * fade; col[o + 1] = g * fade; col[o + 2] = b * fade;
        col[o + 3] = r * 0.08; col[o + 4] = g * 0.08; col[o + 5] = b * 0.08;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}

/** Droplets, a pair per stage, pulled into the orb as each stage finishes; the orb reaches for them with ferrofluid spikes. */
function coalesce() {
  const main = new Orb(root, CORA, 1.05, new THREE.Vector3(0, 0.9, 0));
  main.k.grow = 0.18;
  main.growTo = 0.18;
  main.u.uFerro.value = 1;
  type Drop = { o: Orb; si: number; a: number; R: number; Rt: number; y: number; ph: number; spd: number; pull: { from: THREE.Vector3; ctrl: THREE.Vector3; at: number; ms: number; dir: THREE.Vector3 } | null; gone: boolean; vy: number; falling: boolean };
  const drops: Drop[] = [];
  STAGES.forEach((s, si) => {
    for (let j = 0; j < 2; j++) {
      const o = new Orb(root, s.color, 0.2, new THREE.Vector3(), false);
      o.k.vis = 0;
      o.u.uFerro.value = 0.6;
      const R = 5.5 + Math.random() * 2.2;
      drops.push({ o, si, a: Math.random() * Math.PI * 2, R, Rt: R, y: (Math.random() - 0.5) * 3.2, ph: Math.random() * 9, spd: 0.12 + Math.random() * 0.08, pull: null, gone: false, vy: 0, falling: false });
    }
  });
  const step = (1 - 0.18) / drops.length;
  const tgt = new THREE.Vector3(), P = new THREE.Vector3(), prev = new THREE.Vector3(), pullTo = new THREE.Vector3();
  let stage = -1, settled = false;
  return {
    main,
    stageStart(i: number) {
      stage = i;
      for (const d of drops) if (d.si === i) Object.assign(d, { Rt: 3.0, spd: 0.55 }), (d.o.state = 'work'), (d.o.inflight = 1), (d.o.target = main.group.position);
    },
    stageDone(i: number) {
      drops
        .filter((d) => d.si === i && !d.pull)
        .forEach((d, j) =>
          setTimeout(() => {
            const from = d.o.group.position.clone();
            const dir = from.clone().sub(main.group.position).normalize();
            const ctrl = from.clone().lerp(main.group.position, 0.5).add(new THREE.Vector3(-dir.z, 0.6, dir.x).multiplyScalar(1.6));
            d.pull = { from, ctrl, at: performance.now(), ms: 700, dir };
          }, j * 160),
        );
    },
    fail() {
      settled = true;
      main.inflight = 0;
      main.target = null;
      main.state = 'needs';
      for (const d of drops) if (!d.pull && !d.gone) (d.falling = true), (d.o.dead = true);
    },
    settle() {
      settled = true;
      main.inflight = 0;
      main.target = null;
      main.state = 'idle';
      main.growTo = 1;
      main.k.squash = 1;
      main.k.flash = 1;
      main.ripple(new THREE.Vector3(0, 1, 0), 0.14);
      main.ripple(new THREE.Vector3(0, -1, 0), 0.14);
    },
    update(dt: number, now: number) {
      if (!settled) {
        // reach for the nearest droplet being pulled in; otherwise for this stage's pair as it gathers
        let best: Drop | null = null, bd = Infinity, pulling = false;
        for (const d of drops) {
          if (d.gone || d.falling || !(d.pull || d.si === stage)) continue;
          if (d.pull && !pulling) (pulling = true), (bd = Infinity);
          if (pulling && !d.pull) continue;
          const dist = d.o.group.position.distanceTo(main.group.position);
          if (dist < bd) (bd = dist), (best = d);
        }
        if (best) {
          pullTo.copy(best.o.group.position);
          main.target = pullTo;
          main.inflight = pulling ? 3 : 1;
          main.state = 'work';
        } else if (stage >= 0) {
          main.target = null;
          main.inflight = 0;
          main.state = 'think';
        }
      }
      main.update(dt);
      for (const d of drops) {
        if (d.gone) continue;
        const o = d.o;
        if (d.pull) {
          const u = Math.min(1, Math.max(0, (now - d.pull.at) / d.pull.ms));
          tgt.copy(main.group.position).addScaledVector(d.pull.dir, main.r * main.k.grow * 0.9);
          prev.copy(o.group.position);
          bez(d.pull.from, d.pull.ctrl, tgt, u * u, o.group.position);
          const v = P.subVectors(o.group.position, prev).length() / Math.max(dt, 1e-3);
          o.body.lookAt(P.copy(o.group.position).multiplyScalar(2).sub(prev));
          o.inflight = 2;
          o.update(dt);
          const s = Math.min(0.9, v * 0.06);
          o.body.scale.multiply(P.set(1 - 0.25 * s, 1 - 0.25 * s, 1 + s));
          if (u >= 1) {
            d.gone = true;
            root.remove(o.group);
            main.growTo += step;
            main.k.flash = Math.max(main.k.flash, 0.7);
            main.ripple(d.pull.dir, 0.14);
          }
          continue;
        }
        if (d.falling) (d.vy -= dt * 3), (d.y += d.vy * dt);
        d.R += (d.Rt - d.R) * Math.min(1, dt * 1.5);
        d.a += dt * d.spd * (reduced ? 0.2 : 1);
        o.group.position.set(Math.cos(d.a) * d.R, 0.9 + d.y * (d.R / 7) + Math.sin((now / 1000) * 0.6 + d.ph) * 0.25, Math.sin(d.a) * d.R * 0.55);
        o.body.rotation.set(0, 0, 0);
        o.update(dt);
      }
    },
  };
}

// ---------------------------------------------------------------- status rows
const stagesEl = document.getElementById('stages')!;
// the stages (one per orb), then Cora's own (no orb: it shows only when Cora is on)
const ROW = (label: string, color: string) => `<div class="st" style="--c:${color}"><i class="g"></i><span>${label} <span class="d"></span></span><span class="t"></span></div>`;
stagesEl.innerHTML = STAGES.map((s) => ROW(s.label, s.color)).join('') + ROW('Cora', CORA);
const rows = Array.from(stagesEl.children) as HTMLElement[];
const coraRow = rows.pop()!;
coraRow.hidden = true;
const setRow = (i: number, cls: string, t?: string, detail?: string) => {
  rows[i].className = `st ${cls}`;
  if (t != null) rows[i].querySelector('.t')!.textContent = t;
  if (detail != null) rows[i].querySelector('.d')!.textContent = detail;
  if (cls !== 'run') rows[i].querySelector('.slow')?.remove();
};
/** A thin bar under a stage (transcripts): `p` from 0 to 1, or null to take it away. */
function setBar(i: number, p: number | null) {
  let bar = rows[i].querySelector<HTMLElement>('.bar');
  if (p == null) return void bar?.remove();
  if (!bar) {
    bar = document.createElement('span');
    bar.className = 'bar';
    bar.innerHTML = '<i></i>';
    rows[i].append(bar);
  }
  (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.min(1, p) * 100)}%`;
}

// ---------------------------------------------------------------- how long each stage usually takes (to say when one is slow)
const TIMES = 'cora.splash.times';
let usual: number[] = [];
try {
  usual = JSON.parse(localStorage.getItem(TIMES) ?? '[]');
} catch {
  usual = [];
}
const took: number[] = [];
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
// a stage well past its usual time says so, with what's usual and the log
setInterval(() => {
  if (finished) return;
  state.forEach((st, i) => {
    if (st !== 'run') return;
    const ms = performance.now() - startedAt[i];
    const u = usual[i];
    if (!u || ms < Math.max(u * 3, u + 3000, 2500)) return;
    rows[i].querySelector('.t')!.textContent = secs(ms);
    if (rows[i].querySelector('.slow')) return;
    const slow = document.createElement('span');
    slow.className = 'slow';
    slow.innerHTML = `Taking longer than usual <em>(usually ${secs(u)})</em><button>Open log</button>`;
    slow.querySelector('button')!.onclick = () => api?.openLog();
    rows[i].append(slow);
  });
}, 500);

// ---------------------------------------------------------------- what you should know, under the stages
const notesEl = document.getElementById('notes')!;
function note(key: string, kind: 'warn' | 'info' | 'ok', title: string, sub: string, button?: { label: string; run(b: HTMLButtonElement): void }) {
  let el = notesEl.querySelector<HTMLElement>(`[data-k="${key}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.k = key;
    notesEl.append(el);
  }
  el.className = `note ${kind}`;
  el.innerHTML = `<i></i><span><b></b><em></em></span><span></span>`;
  el.querySelector('b')!.textContent = title;
  el.querySelector('em')!.textContent = sub;
  if (button) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = button.label;
    b.onclick = () => button.run(b);
    el.lastElementChild!.replaceWith(b);
  }
}
let hoveringNotes = false;
notesEl.onmouseenter = () => (hoveringNotes = true);
notesEl.onmouseleave = () => (hoveringNotes = false);

// ---------------------------------------------------------------- the run (restartable: Retry resets in place)
let stream = starStream();
let co = coalesce();
let state: Array<'idle' | 'run' | 'done' | 'skip' | 'fail'> = [];
let startedAt: number[] = [];
let finished = false;
let diving = 0;
let txTotal = 0;

function reset() {
  root.clear();
  stream = starStream();
  co = coalesce();
  state = STAGES.map(() => 'idle');
  startedAt = [];
  finished = false;
  diving = 0;
  rows.forEach((_, i) => (setRow(i, '', '', ''), setBar(i, null)));
  coraRow.hidden = true;
  notesEl.textContent = '';
  document.getElementById('sub')!.textContent = 'Starting up';
  document.getElementById('err')!.classList.remove('on');
  document.body.classList.remove('out');
  layout();
}

function run(i: number) {
  if (state[i] !== 'idle') return;
  state[i] = 'run';
  startedAt[i] = performance.now();
  setRow(i, 'run');
  co.stageStart(i);
  stream.stage(i);
}
function done(i: number) {
  if (state[i] === 'done' || state[i] === 'skip' || state[i] === 'fail') return;
  if (state[i] === 'idle') run(i);
  state[i] = 'done';
  took[i] = performance.now() - startedAt[i];
  setRow(i, 'done', secs(took[i]));
  co.stageDone(i);
}
function skip(i: number) {
  if (state[i] !== 'idle' && state[i] !== 'run') return;
  if (state[i] === 'idle') run(i);
  state[i] = 'skip';
  setRow(i, 'skip', 'skipped');
  co.stageDone(i);
}
const doneThrough = (n: number) => {
  for (let i = 0; i <= n; i++) done(i);
};

function onMsg(m: SplashMsg) {
  // what it says about this start, and notes and Cora's stage, can land while the finale plays
  if ('t' in m && m.t === 'about') return about(m);
  // (the hooks aren't the splash's to ask about: the setup screen, which stays, shows when they're missing)
  if ('s' in m && m.s === 'note') {
    if (m.key === 'nohost') note('nohost', 'warn', "The terminal host isn't available", "Sessions you start in Cora end when its server stops.");
    return;
  }
  if ('s' in m && m.s === 'cora') {
    coraRow.hidden = false;
    coraRow.className = `st ${m.how === 'kept' ? 'done' : m.how === 'error' ? 'fail' : 'run'}`;
    coraRow.querySelector('.d')!.textContent = m.how === 'kept' ? '· still running' : m.how === 'error' ? "· couldn't start" : '· picking up where it left off';
    return;
  }
  if (finished) return;
  if ('t' in m) {
    if (m.t === 'ready') void ready();
    else if (m.t === 'error') fail(m.message);
    return;
  }
  if (m.s === 'host') {
    if (m.e === 'start') doneThrough(0), run(1);
    else if (m.e === 'done') doneThrough(1), setRow(1, state[1], undefined, m.kept ? `· ${m.kept} session${m.kept === 1 ? '' : 's'} kept running` : '· started');
    else if (m.e === 'skip') doneThrough(0), skip(1);
  } else if (m.s === 'tx') {
    if (m.e === 'start') doneThrough(1), run(2);
    else if (m.e === 'progress' && m.total) (txTotal = m.total), setRow(2, state[2], undefined, `· ${m.done} of ${m.total}`), setBar(2, (m.done ?? 0) / m.total);
    else if (m.e === 'done') doneThrough(2), setBar(2, null), setRow(2, state[2], undefined, m.sessions != null ? `· ${m.sessions} session${m.sessions === 1 ? '' : 's'}, ${m.live ?? 0} live` : txTotal ? `· ${txTotal} transcripts` : '');
    else if (m.e === 'skip') doneThrough(1), skip(2);
  } else if (m.s === 'listen' && m.e === 'done') {
    doneThrough(2);
    run(3);
  }
}

/** The footer (this build, Electron, changes since the last start), and a note when Electron was updated. */
function about(m: Extract<SplashMsg, { t: 'about' }>) {
  const foot = document.getElementById('foot')!;
  foot.innerHTML = `${m.build ? `<span><b>Cora</b> ${m.build}</span>` : ''}<span>Electron ${m.electron}</span>${m.changes ? `<span><b>${m.changes} change${m.changes === 1 ? '' : 's'}</b> since last start</span>` : ''}`;
  if (m.electronFrom) note('electron', 'info', `Updated Electron to ${m.electron}`, `Security fixes (from ${m.electronFrom}).`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ready() {
  finished = true;
  doneThrough(2);
  run(3);
  await wait(250);
  done(3);
  try {
    localStorage.setItem(TIMES, JSON.stringify(STAGES.map((_, i) => took[i] ?? usual[i] ?? null)));
  } catch {
    /* not kept */
  }
  // a quick start gets a quicker finale
  const quick = performance.now() < 2500 ? 0.6 : 1;
  await wait(900 * quick);
  co.settle();
  stream.settle();
  await wait(1250 * quick);
  // something to read (a warning, an update): a few seconds more, and as long as the pointer is on it
  if (notesEl.childElementCount) {
    await wait(notesEl.querySelector('.warn') ? 3500 : 1500);
    while (hoveringNotes) await wait(200);
  }
  diving = performance.now();
  document.body.classList.add('out');
  await wait(420);
  api?.done();
}

function fail(message: string) {
  finished = true;
  const i = Math.max(0, state.findIndex((s) => s === 'run' || s === 'idle'));
  state[i] = 'fail';
  setRow(i, 'fail', 'failed');
  document.getElementById('sub')!.textContent = "Couldn't start";
  co.fail();
  stream.fail();
  document.getElementById('errmsg')!.textContent = message;
  setTimeout(() => document.getElementById('err')!.classList.add('on'), 500);
}

function start(noHost = false) {
  reset();
  setTimeout(() => document.querySelector('.word')!.classList.add('on'), 200);
  run(0);
  api?.start(noHost);
}
document.getElementById('retry')!.onclick = () => start(false);
document.getElementById('nohost')!.onclick = () => start(true);
document.getElementById('log')!.onclick = () => api?.openLog();

function layout() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const t = Math.tan(((camera.fov / 2) * Math.PI) / 180);
  camera.position.set(0, 0.4, Math.max(8.6 / (t * camera.aspect), 6.2 / t));
  // the orb sits a little above the middle, with the status block under it: the pair reads as centred
  look.set(0, -0.15, 0);
  camera.lookAt(look);
}
addEventListener('resize', layout);

const diveTo = new THREE.Vector3();
/** Where the camera looks: eased onto the orb during the dive (snapping to it made the orb jump down). */
const look = new THREE.Vector3(0, -0.15, 0);
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stream.update(dt);
  co.update(dt, now);
  if (diving) {
    // ease toward the orb as the splash hands over to the dashboard
    const u = Math.min(1, (now - diving) / 700);
    diveTo.copy(co.main.group.position);
    camera.position.lerp(diveTo.clone().add(new THREE.Vector3(0, 0.3, 4)), dt * 2.2 * u);
    look.lerp(diveTo, dt * 2.2 * u);
    camera.lookAt(look);
  }
  composer.render();
  requestAnimationFrame(frame);
}

api?.on(onMsg);
start();
requestAnimationFrame(frame);
