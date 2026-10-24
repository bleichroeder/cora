// Cora's lock screen (lockdown): the splash's star stream, Cora's orb on watch in the middle (its spikes follow your
// pointer; at rest it sweeps the room, a guard ring circling it), and your PIN under it. The server gives this page
// nothing but whether it's locked and how many sessions need you; the PIN opens it, then the dashboard comes back.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import '../design.css';
import './lock.css';
import { DEFAULT_CORA_COLOR, isCoraColor, ORB_FS, ORB_VS, type LockStatus } from '@cora/shared';
import { clockLine, lockedLine, waitLine } from './words';

type Desktop = { notify?(title: string, body: string, sessionId: string): void; setNeedsYou?(n: number): void };
const desktop = (window as unknown as { coraDesktop?: Desktop }).coraDesktop;

// ---------------------------------------------------------------- Cora's colour (the dashboard's, kept in this browser)
const CORA = (() => {
  try {
    const c = (JSON.parse(localStorage.getItem('ab:ui') ?? '{}') as { coraColor?: unknown }).coraColor;
    return isCoraColor(c) ? c.toLowerCase() : DEFAULT_CORA_COLOR;
  } catch {
    return DEFAULT_CORA_COLOR;
  }
})();
document.documentElement.style.setProperty('--cora', CORA);

// ---------------------------------------------------------------- the scene
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
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
const COLOR = new THREE.Color(CORA);

/** Cora on watch: the orb's ferrofluid spikes lean to what it watches (your pointer, or a slow sweep of the room). */
const orb = (() => {
  const R = 1.05;
  const group = new THREE.Group();
  scene.add(group);
  const u: Record<string, { value: any }> = {
    uColor: { value: COLOR.clone() }, uTime: { value: 0 }, uThink: { value: 0 }, uWork: { value: 0.8 }, uBusy: { value: 0.4 }, uShiver: { value: 0 }, uFerro: { value: 1 },
    uTarget: { value: new THREE.Vector3(0, 0, 1) }, uLean: { value: 1 }, uAlert: { value: 0 }, uFlash: { value: 0 }, uVis: { value: 1 },
    uRipDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0, 0)) }, uRipAge: { value: new Array(6).fill(-1) }, uRipAmp: { value: new Array(6).fill(0) },
  };
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 96), new THREE.ShaderMaterial({ vertexShader: ORB_VS, fragmentShader: ORB_FS, uniforms: u }));
  mesh.scale.setScalar(R);
  const halo = glow(CORA, R * 4.4, 0.2);
  const aura = glow(CORA, R * 7, 0.05);
  group.add(aura, halo, mesh);
  const k = { alert: 0, shiver: 0, flash: 0, grow: 1, growTo: 1, work: 0.8, workTo: 0.8 };
  const ripples: Array<{ dir: THREE.Vector3; age: number; amp: number }> = [];
  let clock = Math.random() * 10;
  const look = new THREE.Vector3(0, 0, 1);
  const tmp = new THREE.Vector3();
  return {
    R,
    group,
    /** a key pressed: a ripple toward you */
    tap() {
      ripples.push({ dir: new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.6, 1).normalize(), age: 0, amp: 0.09 });
      if (ripples.length > 6) ripples.shift();
      k.flash = Math.max(k.flash, 0.25);
    },
    /** a wrong PIN: red, a shiver */
    alarm() {
      k.alert = 1;
      k.shiver = 1;
    },
    /** checking the PIN: busier */
    busy(on: boolean) {
      k.workTo = on ? 1 : 0.8;
    },
    /** open: a flash, and it swells */
    open() {
      k.flash = 1;
      k.growTo = 1.25;
      ripples.push({ dir: new THREE.Vector3(0, 1, 0), age: 0, amp: 0.14 }, { dir: new THREE.Vector3(0, -1, 0), age: 0, amp: 0.14 });
    },
    update(dt: number, target: THREE.Vector3) {
      k.alert *= Math.pow(0.25, dt);
      k.shiver *= Math.pow(0.05, dt);
      k.flash *= Math.pow(0.08, dt);
      k.grow += (k.growTo - k.grow) * Math.min(1, dt * 3);
      k.work += (k.workTo - k.work) * Math.min(1, dt * 3);
      clock += dt;
      for (const r of ripples) r.age += dt;
      while (ripples.length && ripples[0].age > 1.2) ripples.shift();
      mesh.rotation.y += dt * 0.08 * (1 - k.alert);
      // where it looks, in the orb's own turning frame
      tmp.copy(target).sub(group.position).normalize();
      look.lerp(tmp, Math.min(1, dt * 3)).normalize();
      const toLocal = mesh.quaternion.clone().invert();
      (u.uTarget.value as THREE.Vector3).copy(look).applyQuaternion(toLocal);
      u.uTime.value = clock;
      u.uWork.value = k.work;
      u.uShiver.value = k.shiver;
      u.uAlert.value = Math.max(k.alert, k.shiver * 0.7);
      u.uFlash.value = k.flash;
      for (let i = 0; i < 6; i++) {
        const r = ripples[i];
        u.uRipAge.value[i] = r ? r.age : -1;
        u.uRipAmp.value[i] = r ? r.amp : 0;
        if (r) (u.uRipDir.value[i] as THREE.Vector3).copy(r.dir).applyQuaternion(toLocal);
      }
      group.scale.setScalar(k.grow);
      halo.material.color.copy(COLOR).lerp(RED, k.alert);
      halo.material.opacity = 0.2 + 0.45 * k.flash + 0.15 * k.alert;
      aura.material.opacity = 0.05 + 0.1 * k.flash;
      ring.update(dt, k.alert);
    },
  };
})();

/** The guard ring around it: a radar's sweep with its trail, ticks round the rim. */
const ring = (() => {
  const IN = 1.95, OUT = 2.75;
  const u = { uTime: { value: 0 }, uColor: { value: COLOR.clone() }, uAlert: { value: 0 }, uIn: { value: IN }, uOut: { value: OUT } };
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime, uAlert, uIn, uOut; uniform vec3 uColor; varying vec2 vP;
      void main(){
        float r = length(vP), a = atan(vP.y, vP.x) / 6.2831853 + 0.5;
        float sweep = fract(a + uTime * 0.11);
        float trail = pow(sweep, 7.0);
        float rim = smoothstep(uIn, uIn + 0.03, r) * (1.0 - smoothstep(uIn + 0.05, uIn + 0.08, r));
        float edge = smoothstep(uOut - 0.07, uOut - 0.04, r) * (1.0 - smoothstep(uOut - 0.02, uOut, r));
        float tick = step(0.9, fract(a * 72.0)) * smoothstep(uOut - 0.3, uOut - 0.26, r) * (1.0 - smoothstep(uOut - 0.12, uOut - 0.1, r));
        float band = smoothstep(uIn, uOut, r) * (1.0 - smoothstep(uOut - 0.05, uOut, r));
        vec3 col = mix(uColor, vec3(1.0, 0.3, 0.32), uAlert);
        float i = rim * 0.3 + edge * 0.16 + tick * (0.14 + 0.5 * trail) + band * trail * 0.32;
        gl_FragColor = vec4(col * i, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.RingGeometry(IN, OUT, 192, 1), mat);
  mesh.rotation.x = -Math.PI / 2 + 0.42;
  scene.add(mesh);
  return {
    OUT,
    tilt: 0.42,
    update(dt: number, alert: number) {
      u.uTime.value += dt * (reduced ? 0.15 : 1) * (1 + alert * 1.5);
      u.uAlert.value = alert;
    },
  };
})();

/** The splash's star stream: dim streaks flowing past behind the orb, a few in Cora's colour. */
const stream = (() => {
  const N = 900;
  const pos = new Float32Array(N * 6), col = new Float32Array(N * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.LineSegments(geo, mat));
  const WHITE = new THREE.Color('#c7d2fe');
  const pick = () => (Math.random() < 0.3 ? COLOR : WHITE).clone().multiplyScalar(0.35 + Math.random() * 0.6);
  const stars = Array.from({ length: N }, () => {
    const a = Math.random() * Math.PI * 2, r = 2.5 + Math.pow(Math.random(), 0.7) * 15;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, z: -115 + Math.random() * 125, c: pick() };
  });
  const SPEED = reduced ? 0 : 4;
  return {
    update(dt: number) {
      mat.opacity += (0.55 - mat.opacity) * Math.min(1, dt * 0.8);
      const camZ = camera.position.z - 1;
      const streak = SPEED * 0.05;
      for (let i = 0; i < N; i++) {
        const st = stars[i];
        st.z += SPEED * dt;
        if (st.z > camZ) (st.z -= 125), (st.c = pick());
        const o = i * 6;
        pos[o] = st.x; pos[o + 1] = st.y; pos[o + 2] = st.z;
        pos[o + 3] = st.x; pos[o + 4] = st.y; pos[o + 5] = st.z - streak - 0.02;
        col[o] = st.c.r; col[o + 1] = st.c.g; col[o + 2] = st.c.b;
        col[o + 3] = st.c.r * 0.08; col[o + 4] = st.c.g * 0.08; col[o + 5] = st.c.b * 0.08;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
})();

// ---------------------------------------------------------------- where things sit: the orb a little above the middle, the PIN under it
const ov = document.getElementById('ov')!;
/** the orb's centre sits this far up from the middle of the window (a share of its height) */
const LIFT = 0.17;
function layout() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  // the orb a size that suits the window's height (smaller on a short one, so the keypad fits)
  const units = h < 700 ? 15 : h < 760 ? 13.5 : 11.5;
  camera.position.set(0, 0, units / 2 / Math.tan(((camera.fov / 2) * Math.PI) / 180));
  camera.lookAt(0, 0, 0);
  camera.setViewOffset(w, h, 0, h * LIFT, w, h);
  camera.updateProjectionMatrix();
  // the words start under the ring
  const pxPerUnit = h / units;
  const below = Math.max(orb.R * 1.55, ring.OUT * Math.sin(ring.tilt)) * pxPerUnit;
  ov.style.top = `${Math.round(h / 2 - h * LIFT + below + 26)}px`;
  document.body.classList.toggle('short', h < 760);
}
window.addEventListener('resize', layout);
layout();

// what the orb watches: your pointer (on the orb's plane), or, when it rests, a slow sweep of the room
const pointer = { at: new THREE.Vector3(0, 0, 6), moved: -1e9 };
const ndc = new THREE.Vector2();
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.5);
window.addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  ray.ray.intersectPlane(plane, pointer.at);
  pointer.moved = performance.now();
  showPad();
});
const sweepAt = new THREE.Vector3();
const target = new THREE.Vector3();

let opening = 0;
let last = performance.now();
let acc = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  // 30 frames a second is plenty for a screen that's on for hours
  acc += now - last;
  last = now;
  if (acc < 32) return;
  const dt = Math.min(0.05, acc / 1000);
  acc = 0;
  const t = now / 1000;
  sweepAt.set(Math.sin(t * 0.35) * 5, Math.sin(t * 0.21) * 1.4, 2.5);
  const watching = now - pointer.moved < 4000;
  target.lerp(watching ? pointer.at : sweepAt, Math.min(1, dt * (watching ? 6 : 1.2)));
  stream.update(dt);
  orb.update(dt, target);
  if (opening) {
    // into the orb, as the splash hands over
    const u = Math.min(1, (now - opening) / 700);
    camera.position.z += (3.2 - camera.position.z) * dt * 2.4 * u;
    camera.updateProjectionMatrix();
  }
  composer.render();
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- the PIN
const pinEl = document.getElementById('pin')!;
const msgEl = document.getElementById('msg')!;
const padEl = document.getElementById('pad')!;
let digits = 4;
let entry = '';
let checking = false;
let waitUntil = 0;

function drawPin() {
  pinEl.innerHTML = Array.from({ length: digits }, (_, i) => `<i class="${i < entry.length ? 'on' : ''}"></i>`).join('');
}
function say(text: string, bad = false) {
  msgEl.textContent = text;
  msgEl.classList.toggle('bad', bad);
}

// the keypad: 1–9, then Clear, 0, and back a digit
padEl.innerHTML = [...'123456789'].map((d) => `<button data-d="${d}">${d}</button>`).join('') + '<button class="k" data-k="clear">Clear</button><button data-d="0">0</button><button class="k" data-k="back" aria-label="Back">&#9003;</button>';
padEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.dataset.d) press(b.dataset.d);
  else if (b.dataset.k === 'back') back();
  else if (b.dataset.k === 'clear') clear();
});
let padTimer = 0;
function showPad() {
  padEl.classList.add('on');
  clearTimeout(padTimer);
  padTimer = window.setTimeout(() => padEl.classList.remove('on'), 7000);
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (/^\d$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') back();
  else if (e.key === 'Escape') clear();
  else return;
  e.preventDefault();
});

function press(d: string) {
  if (checking || opening || Date.now() < waitUntil || entry.length >= digits) return;
  entry += d;
  orb.tap();
  pinEl.classList.remove('bad');
  drawPin();
  if (entry.length === digits) void check();
}
function back() {
  if (checking || opening) return;
  entry = entry.slice(0, -1);
  drawPin();
}
function clear() {
  if (checking || opening) return;
  entry = '';
  drawPin();
}

async function check() {
  checking = true;
  pinEl.classList.add('busy');
  orb.busy(true);
  let r: Response | null = null;
  try {
    r = await fetch('/api/lock/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: entry }) });
  } catch {
    r = null;
  }
  pinEl.classList.remove('busy');
  orb.busy(false);
  checking = false;
  if (r?.ok) return open();
  const body = r ? ((await r.json().catch(() => ({}))) as { waitMs?: number }) : {};
  entry = '';
  orb.alarm();
  pinEl.classList.remove('bad');
  void pinEl.offsetWidth;
  pinEl.classList.add('bad');
  setTimeout(() => (pinEl.classList.remove('bad'), drawPin()), 700);
  if (!r) return say("Can't reach Cora's server. Try again in a moment.", true);
  if (body.waitMs) return startWait(body.waitMs);
  say("That's not it.", true);
}

function open() {
  opening = performance.now();
  say('');
  orb.open();
  document.body.classList.add('out');
  setTimeout(() => location.replace('/'), 900);
}

/** Too many wrong PINs: the keypad rests, and a countdown says until when. */
function startWait(ms: number) {
  waitUntil = Date.now() + ms;
  padEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
  const tick = () => {
    const left = waitUntil - Date.now();
    if (left <= 0) {
      padEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return say('Type your PIN');
    }
    say(waitLine(left), true);
    setTimeout(tick, 250);
  };
  tick();
}

// ---------------------------------------------------------------- what's going on: locked still, and how many sessions need you
const clockEl = document.getElementById('clock')!;
const needEl = document.getElementById('need')!;
const subEl = document.getElementById('sub')!;
let needs = -1;
async function poll() {
  let st: LockStatus | null = null;
  try {
    const r = await fetch('/api/lock');
    if (r.status === 401) return say('Open Cora from its own window.', true);
    st = r.ok ? ((await r.json()) as LockStatus) : null;
  } catch {
    st = null;
  }
  if (!st || opening) return;
  // opened somewhere else (or never locked): back to the dashboard
  if (!st.locked) return open();
  if (st.digits && st.digits !== digits) (digits = st.digits), (entry = ''), drawPin();
  if (st.waitMs && Date.now() >= waitUntil) startWait(st.waitMs);
  subEl.textContent = lockedLine(st.lockedAt);
  const n = st.needsYou ?? 0;
  needEl.textContent = n ? `${n} session${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'Sessions keep running';
  needEl.classList.toggle('on', n > 0);
  // a nudge you can see from across the room, saying nothing about what
  if (needs >= 0 && n > needs) desktop?.notify?.('Cora is locked', n === 1 ? 'A session needs you.' : `${n} sessions need you.`, '');
  if (n !== needs) desktop?.setNeedsYou?.(n);
  needs = n;
}
const tickClock = () => (clockEl.textContent = clockLine(new Date()));
tickClock();
setInterval(tickClock, 1000);
drawPin();
void poll();
setInterval(() => void poll(), 5000);
