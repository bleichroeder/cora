import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * The black hole, as a post-processing pass: light from the stars (and anything else behind the hole) is ray-traced
 * through Schwarzschild space so it bends around a true shadow with a thin photon ring, and the session's scene
 * falls in.
 *
 * The scene is drawn in two layers for this: the composer's own render has the swallowable part hidden (that's the
 * background: stars, effects), and this pass draws the swallowable part (`swallow`) on its own. Each of its pixels
 * then falls on a free-fall path of its own: inner things first, everything accelerating, stretched toward the hole
 * and squeezed sideways, reddening and freezing at the edge of the shadow, with only the last moments spiralling.
 *
 * Units: one `rs` is the Schwarzschild radius of the full-grown hole; `uRsPx` is how many buffer pixels that is.
 */

/** Everything the pass shows for a frame (see cosmic.tsx for how a collapse or a bang moves through these). */
export type HoleFrame = {
  /** The hole's mass, 0 (none) to 1 (full grown): its shadow and lensing scale with it. */
  mass: number;
  /** Infall progress: matter that started within this many rs has crossed the horizon (0: nothing has moved). */
  fallen: number;
  /** A white flash at the centre (0 to 1). */
  flash: number;
  /** Seconds since a bang went off (its shock fronts race out from it), or -1. */
  bang: number;
  /** How hot what comes out of a bang still glows (1 white-hot, 0 its own colours). */
  heat: number;
  /** Whether the swallowable layer still has anything to show (false once it's all gone: one render saved). */
  matter: boolean;
};

/** The shadow's radius in rs (3√3/2: light closer than this can't get away). */
export const SHADOW_RS = 2.598;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tBg, tFg;
uniform vec2 uRes, uCenter;
uniform float uRsPx, uMass, uFallen15, uFlash, uBang, uHeat, uMatter;
varying vec2 vUv;

const float SHADOW = 2.598;
const float L = 21.0;        // how far behind the hole the light's source sits (rs): sets how wide the lensing reaches
const float RT = 13.0;       // within this (in units of the hole's own rs) rays are traced; beyond, the weak-field formula
const float SPIN = 0.9;      // the matter's angular momentum: how much it spirals at the very end

// the background (stars, effects) at a point of the source plane, in rs from the hole's centre
vec3 bgAt(vec2 src) {
  vec2 uv = (uCenter + src * uRsPx) / uRes;
  // light from off screen: the sky is stars that way too (mirrored), not a dark band around the shadow
  uv = 1.0 - abs(mod(uv + 1.0, 2.0) - 1.0);
  return texture2D(tBg, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
}

// the swallowable layer at observed point d (rs from the centre): where that matter was before it started falling
vec4 matterAt(vec2 d) {
  float S = SHADOW * uMass;
  float b2 = dot(d, d);
  if (b2 <= S * S) return vec4(0.0);
  // nearby matter is lensed a little too (it's around the hole, not far behind it)
  vec2 dl = d * (1.0 - 0.18 * 2.0 * L * uMass / b2);
  float ro = length(dl);
  if (ro <= S) return vec4(0.0);
  // seen from far away nothing crosses: it piles up at the shadow's edge (ro → S as the proper radius → 0)
  float rp = sqrt(ro * ro - S * S);
  float R = pow(pow(rp, 1.5) + uFallen15, 2.0 / 3.0);
  float a = atan(dl.y, dl.x) - SPIN * uMass * (1.0 / (rp + 0.7) - 1.0 / (R + 0.7));
  vec2 src = R * vec2(cos(a), sin(a));
  vec2 uv = (uCenter + src * uRsPx) / uRes;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 m = texture2D(tFg, uv);
  // gravitational redshift: dimmer and redder near the edge, gone at it
  float g = uFallen15 > 0.0 ? rp / (rp + 1.4 * uMass) : 1.0;
  m.rgb = mix(m.rgb * vec3(1.0, 0.36, 0.16) * 1.4, m.rgb, g) * smoothstep(0.0, 0.5, g);
  m.a *= smoothstep(0.0, 0.35, g);
  // fresh out of a bang: white-hot, cooling to its own colours
  m.rgb = mix(m.rgb, vec3(1.0, 0.93, 0.85) * m.a * 2.2, uHeat * 0.45) + m.a * vec3(1.0, 0.62, 0.32) * uHeat * 1.4;
  return m;
}

void main() {
  vec2 px = vUv * uRes;
  vec2 d0 = (px - uCenter) / uRsPx;   // rs (of the full-grown hole) from the centre
  float r = length(d0);
  // a bang's shock fronts: three bright rings racing out, each bending space as it passes (what's behind ripples)
  vec2 d = d0;
  float rings = 0.0;
  if (uBang >= 0.0) {
    vec2 dir = d0 / max(r, 1e-4);
    for (int i = 0; i < 3; i++) {
      float t = uBang - float(i) * 0.14;
      if (t <= 0.0) continue;
      float R = 1.0 + (44.0 - float(i) * 11.0) * t;
      float amp = (i == 0 ? 1.0 : (i == 1 ? 0.6 : 0.35)) * exp(-t * 1.25);
      float w = 0.35 + R * 0.018;
      float k = (r - R) / w;
      d -= dir * amp * 1.8 * k * exp(-k * k);
      rings += amp * (k < 0.0 ? exp(-k * k * 1.2) * 0.1 : exp(-k * k * 2.5));
    }
  }
  vec3 col;
  if (uMass < 0.01) {
    col = uBang >= 0.0 ? bgAt(d) : texture2D(tBg, vUv).rgb;
  } else {
    float b = length(d);
    float m = uMass;
    if (b > RT * m) {
      // weak field: the thin-lens deflection
      col = bgAt(d * (1.0 - 2.0 * L * m / (b * b)));
    } else {
      // trace the ray back from the eye through curved space, in units of the hole's own rs
      vec3 x = vec3(d / m, -RT);
      vec3 v = vec3(0.0, 0.0, 1.0);
      vec3 hv = cross(x, v);
      float h2 = dot(hv, hv);
      bool caught = false;
      float rmin = 1e3;
      for (int i = 0; i < 160; i++) {
        float r = length(x);
        rmin = min(rmin, r);
        if (r < 1.0) { caught = true; break; }
        if (r > RT * 1.05 && dot(x, v) > 0.0) break;
        float dt = clamp(0.09 * r, 0.025, 1.2);
        vec3 a = -1.5 * h2 * x / pow(r, 5.0);
        vec3 xn = x + v * dt + 0.5 * a * dt * dt;
        vec3 an = -1.5 * h2 * xn / pow(length(xn), 5.0);
        vec3 vn = v + 0.5 * (a + an) * dt;
        x = xn;
        v = vn;
      }
      vec3 behind = vec3(0.0);
      if (!caught) {
        vec2 src = v.z > 0.08 ? x.xy + v.xy * (L / m - x.z) / v.z : normalize(v.xy + 1e-4) * (L / m) * 4.0;
        behind = bgAt(src * m);
      }
      // the photon ring: light that skimmed the photon sphere (r = 1.5) piles up in a thin bright ring at the shadow's edge
      float ring = caught ? 0.0 : exp(-pow((rmin - 1.5) / 0.09, 2.0));
      col = behind + vec3(0.72, 0.8, 1.0) * ring * 0.22 * smoothstep(0.2, 0.6, m);
    }
  }
  // the falling matter over it
  if (uMatter > 0.5) {
    vec4 fg = uMass < 0.01 && uFallen15 <= 0.0 && uBang < 0.0 ? texture2D(tFg, vUv) : matterAt(d);
    col = col * (1.0 - fg.a) + fg.rgb;
  }
  // the bang: a blinding core, a wide glow, a moment where it washes over everything; then the shock fronts
  col += vec3(1.0, 0.93, 0.82) * (uFlash * exp(-r * r / 6.0) * 9.0 + pow(uFlash, 3.0) * exp(-r * r / 60.0) * 1.2 + pow(uFlash, 10.0) * 0.3);
  col += vec3(0.82, 0.86, 1.0) * rings * 1.3;
  gl_FragColor = vec4(col, 1.0);
}`;

/** See the top of this file. `swallow` is the group the hole eats; the composer's render must have it hidden. */
export class BlackHolePass extends Pass {
  frame: HoleFrame = { mass: 0, fallen: 0, flash: 0, bang: -1, heat: 0, matter: true };
  center = new THREE.Vector3();
  /** The full-grown hole's Schwarzschild radius in world units. */
  rsWorld = 1.5 / 2.598;
  private fg: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private clear = new THREE.Color();

  /** Frames counted by the caller (tick), and the one it last drew in: the swallowable group may only be hidden
   * from the main render while the pass is actually drawing it (a slow frame must not count as stopped). */
  private frameNo = 0;
  private drewAt = -10;
  tick() {
    this.frameNo++;
  }
  drawing() {
    return this.frameNo - this.drewAt <= 2;
  }

  constructor(
    private cam: THREE.Camera,
    private swallow: () => THREE.Object3D | null,
  ) {
    super('BlackHolePass');
    this.needsSwap = true;
    this.fg = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, samples: 4 });
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tBg: { value: null },
        tFg: { value: this.fg.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uCenter: { value: new THREE.Vector2() },
        uRsPx: { value: 1 },
        uMass: { value: 0 },
        uFallen15: { value: 0 },
        uFlash: { value: 0 },
        uBang: { value: -1 },
        uHeat: { value: 0 },
        uMatter: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }

  /** Compiles the shader ahead of time (off the main thread where supported). */
  warm(renderer: THREE.WebGLRenderer) {
    return renderer.compileAsync(this.scene, this.camera);
  }

  override setSize(width: number, height: number) {
    this.fg.setSize(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget) {
    const f = this.frame;
    const u = this.mat.uniforms;
    this.drewAt = this.frameNo;
    const W = inputBuffer.width, H = inputBuffer.height;
    // where the hole is on screen, and how big its rs is there
    this.cam.updateMatrixWorld();
    this.v.copy(this.center).project(this.cam);
    this.w.setFromMatrixColumn(this.cam.matrixWorld, 0).multiplyScalar(this.rsWorld).add(this.center).project(this.cam);
    u.uCenter.value.set((this.v.x * 0.5 + 0.5) * W, (this.v.y * 0.5 + 0.5) * H);
    u.uRsPx.value = Math.max(0.5, Math.abs(this.w.x - this.v.x) * 0.5 * W);
    u.uRes.value.set(W, H);
    u.tBg.value = inputBuffer.texture;
    u.uMass.value = f.mass;
    u.uFallen15.value = Math.pow(Math.max(0, f.fallen), 1.5);
    u.uFlash.value = f.flash;
    u.uBang.value = f.bang;
    u.uHeat.value = f.heat;
    u.uMatter.value = f.matter ? 1 : 0;

    // the swallowable layer, on its own over transparent black
    const g = this.swallow();
    if (g && f.matter) {
      const was = g.visible;
      const prevTarget = renderer.getRenderTarget();
      renderer.getClearColor(this.clear);
      const prevAlpha = renderer.getClearAlpha();
      const prevAuto = renderer.autoClear;
      g.visible = true;
      renderer.setRenderTarget(this.fg);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.autoClear = false;
      renderer.render(g, this.cam);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(this.clear, prevAlpha);
      renderer.setRenderTarget(prevTarget);
      g.visible = was;
    }

    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  override dispose() {
    this.fg.dispose();
    this.mat.dispose();
    super.dispose();
  }
}
