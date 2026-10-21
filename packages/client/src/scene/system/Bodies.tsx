import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { NOISE } from '../shaders';
import { bake, bakeInBands, lin, useBakeReady } from './bake';
import { CompiledFirst } from '../warmup';
import { KEEP_OUT, PLANET_TYPES, SUN_DEPTH, fit, luma, type StarSystem } from './generate';
import { useWarp, warpLevels } from './warp';

/**
 * The bodies of a star system: the star's glow, the planet (its baked surface lit by the star, with relief, a soft
 * terminator, ocean glints, haze and an atmosphere rim, drifting clouds, the rings' shadow), rings, moons and an
 * asteroid belt. Placed by view position from the camera as it is now, behind the agents and in front of the stars.
 * Anything in the agents' area is dimmed. In a hyperspace jump they rush past outward (with the streaks); the new
 * system's bodies ease into place. They lag a fast camera move a little (so they read as far away), then settle back.
 * Their surfaces appear at once, coarse, and sharpen a band per frame (so a new system never stalls the scene).
 */

const PLANET_D = 120;
const MOON_D = 128;

// the agents' area on screen: what's drawn there is dimmed (a safety net under the generator's own rules)
const MASK = /* glsl */ `
uniform vec2 uRes;
float clearOfAgents(){ vec2 n=abs(gl_FragCoord.xy/uRes*2.0-1.0);
  return max(smoothstep(${(KEEP_OUT.x - 0.08).toFixed(2)},${(KEEP_OUT.x + 0.06).toFixed(2)},n.x), smoothstep(${(KEEP_OUT.y - 0.08).toFixed(2)},${(KEEP_OUT.y + 0.06).toFixed(2)},n.y)); }
vec3 capped(vec3 c){ float l=dot(c,vec3(0.2126,0.7152,0.0722)); return c*min(1.0,0.55/max(l,1e-4)); }`;

/**
 * An equirect lookup without the seam where longitude wraps, smoothed (a B-spline from four filtered taps) so a big
 * planet's magnified texture shows no blocky texels.
 */
const EQUI = /* glsl */ `
vec4 bsp(float v){ vec4 n=vec4(1.0,2.0,3.0,4.0)-v; vec4 s=n*n*n; float x=s.x, y=s.y-4.0*s.x, z=s.z-4.0*s.y+6.0*s.x; return vec4(x,y,z,6.0-x-y-z)/6.0; }
vec4 smoothTex(sampler2D t, vec2 uv, vec2 dx, vec2 dy){
  vec2 sz=vec2(textureSize(t,0)); vec2 p=uv*sz-0.5; vec2 f=fract(p); p-=f;
  vec4 xc=bsp(f.x), yc=bsp(f.y); vec4 c=p.xxyy+vec2(-0.5,1.5).xyxy;
  vec4 s=vec4(xc.xz+xc.yw, yc.xz+yc.yw); vec4 o=(c+vec4(xc.yw,yc.yw)/s)/sz.xxyy;
  vec4 a=textureGrad(t,o.xz,dx,dy), b=textureGrad(t,o.yz,dx,dy), cc=textureGrad(t,o.xw,dx,dy), d=textureGrad(t,o.yw,dx,dy);
  float sx=s.x/(s.x+s.y), sy=s.z/(s.z+s.w);
  return mix(mix(d,cc,sx), mix(b,a,sx), sy); }
vec4 equiTex(sampler2D m, vec3 n){ n=normalize(n);
  vec2 uv=vec2(atan(n.z,n.x)/6.2831853+0.5, asin(clamp(n.y,-1.0,1.0))/3.14159265+0.5);
  vec2 ub=vec2(fract(uv.x+0.5)-0.5, uv.y);
  vec2 dx=dFdx(uv), dy=dFdy(uv), dxb=dFdx(ub), dyb=dFdy(ub);
  if(dot(dxb,dxb)<dot(dx,dx)) dx=dxb; if(dot(dyb,dyb)<dot(dy,dy)) dy=dyb;
  // magnified (a texel spans more than a pixel): smooth; otherwise the plain filtered lookup
  float texel=max(length(dx), length(dy))*float(textureSize(m,0).x);
  return texel<1.0 ? smoothTex(m, uv, dx, dy) : textureGrad(m, uv, dx, dy); }`;

const VS_PLAIN = /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const LIT_VS = /* glsl */ `
uniform mat3 uRot, uCloudRot; varying vec3 vN; varying vec3 vW; varying vec3 vTex; varying vec3 vCloud;
void main(){ vTex=uRot*normal; vCloud=uCloudRot*normal; vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; vN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*viewMatrix*w; }`;

const LIT_FS = /* glsl */ `
uniform sampler2D uMap, uCloudMap; uniform vec3 uL, uAtmo, uStar, uCenter, uRingN; uniform int uType;
uniform float uFade, uAtmoK, uBump, uBright, uRingIn, uRingOut, uCities, uHasClouds, uDetail;
varying vec3 vN; varying vec3 vW; varying vec3 vTex; varying vec3 vCloud;
${NOISE}
${MASK}
${EQUI}
void main(){
  vec3 N=normalize(vN); vec4 t=equiTex(uMap, vTex); float h=t.a; vec3 alb=t.rgb;
  bool ocean=uType==4, lava=uType==3, ice=uType==2;
  float water=ocean ? 1.0-smoothstep(0.495,0.51,h) : 0.0;
  // fine detail beyond the texture, only where it's magnified enough to show (fades out before it could shimmer)
  vec3 on=normalize(vTex); float px=length(fwidth(on));
  float near=uDetail*(1.0-smoothstep(0.002,0.006,px))*(1.0-water);
  if(near>0.001){ float dn=snoise(on*90.0)*0.6+snoise(on*210.0)*0.4; alb*=1.0+dn*0.14*near; h+=dn*0.012*near; }
  // relief: the height's slope on screen tilts the normal (none on water)
  vec3 dpx=dFdx(vW), dpy=dFdy(vW); float dhx=dFdx(h), dhy=dFdy(h);
  vec3 r1=cross(dpy,N), r2=cross(N,dpx); float det=dot(dpx,r1);
  // relief only where texels are at least about pixel-sized (shrunk smaller, it would sparkle)
  float tpp=px*float(textureSize(uMap,0).x)/6.2831853;
  vec3 grad=sign(det)*(dhx*r1+dhy*r2)*uBump*(1.0-water)*(1.0-smoothstep(1.2,3.5,tpp));
  vec3 Nb=normalize(abs(det)*N-grad);
  vec3 V=normalize(cameraPosition-vW);
  float dg=dot(N,uL);
  float day=smoothstep(-0.1,0.3,dg);
  float lam=clamp((dot(Nb,uL)+0.1)/1.1,0.0,1.0);
  // the rings' shadow: toward the star, does the ray cross the ring plane between its edges?
  float ringShade=1.0;
  if(uRingOut>0.0){ float dn=dot(uL,uRingN); if(abs(dn)>1e-3){ float tt=dot(uCenter-vW,uRingN)/dn; if(tt>0.0){ float r=length(vW+uL*tt-uCenter); float inR=smoothstep(uRingIn*0.98,uRingIn*1.04,r)*(1.0-smoothstep(uRingOut*0.96,uRingOut,r)); ringShade=1.0-0.55*inR; } } }
  // the clouds' shadows on the ground
  float cloudShade=uHasClouds>0.5 ? 1.0-0.38*equiTex(uCloudMap, vCloud).a : 1.0;
  vec3 c=alb*lam*day*ringShade*cloudShade*uStar;
  c+=alb*0.018;
  // twilight along the terminator, tinted by the atmosphere
  float tw=exp(-pow(dg*5.0,2.0)); c+=uAtmo*uAtmoK*tw*0.07;
  // glints: water (and a little on ice)
  vec3 H=normalize(uL+V); float spec=pow(max(dot(Nb,H),0.0), ocean?260.0:40.0)*day*ringShade;
  c+=uStar*spec*(water*0.6+(ice?0.05:0.0));
  // haze toward the edge, on the lit side
  float fres=pow(1.0-max(dot(N,V),0.0),2.2);
  c=mix(c, uAtmo*uAtmoK*(0.08+0.55*day), fres*0.55*uAtmoK);
  // city lights on the night side: clusters on land, thicker near coasts, a scatter of single lights between
  if(uCities>0.0 && (ocean ? water<0.5 : true)){
    float night=1.0-smoothstep(-0.18,0.08,dg);
    if(night>0.01){
      float cl=smoothstep(0.2,0.65,snoise(on*9.0+3.0)*0.55+snoise(on*26.0)*0.45);
      float coast=ocean ? 1.0-smoothstep(0.51,0.62,h) : 0.6;
      float dots=smoothstep(0.45,0.85,snoise(on*140.0))*0.8+smoothstep(0.5,0.9,snoise(on*55.0))*0.7;
      // a soft glow over each settled region, the bright points of towns and cities on top
      float lights=cl*(0.35+0.65*coast)*(0.07+dots*dots*1.3)*uCities*night;
      c+=vec3(1.0,0.7,0.36)*lights*1.25*(1.0-0.75*(1.0-cloudShade)/0.38);
    }
  }
  // lava's seams glow, more so on the night side
  if(lava){ float e=1.0-smoothstep(0.0,0.06,h); c+=vec3(1.0,0.32,0.08)*e*0.3*(1.0-0.6*day); }
  c=capped(c*uBright);
  gl_FragColor=vec4(c*uFade*mix(0.5,1.0,clearOfAgents()),1.0); }`;

const ATMO_FS = /* glsl */ `
uniform vec3 uL, uAtmo; uniform float uFade, uAtmoK, uBright; varying vec3 vN; varying vec3 vW; varying vec3 vTex;
${MASK}
void main(){ vec3 N=normalize(vN); vec3 V=normalize(cameraPosition-vW); float f=max(dot(N,V),0.0);
  float a=pow(1.0-f,3.0)*smoothstep(0.0,0.25,f)*(0.1+0.9*smoothstep(-0.3,0.5,dot(N,uL)));
  gl_FragColor=vec4(capped(uAtmo*uAtmoK*1.3*a*uBright)*uFade*mix(0.3,1.0,clearOfAgents()), 1.0); }`;

const CLOUD_FS = /* glsl */ `
uniform sampler2D uMap; uniform vec3 uL, uStar; uniform float uFade, uBright; varying vec3 vN; varying vec3 vW; varying vec3 vTex;
${MASK}
${EQUI}
void main(){ float a=equiTex(uMap, vTex).a; float d=dot(normalize(vN),uL); float lit=smoothstep(-0.08,0.45,d);
  vec3 c=capped(vec3(0.32)*uStar*(0.04+lit)*uBright);
  gl_FragColor=vec4(c, a*0.8*uFade*mix(0.3,1.0,clearOfAgents())); }`;

const RING_VS = /* glsl */ `varying vec3 vW; varying vec2 vP; void main(){ vP=position.xy; vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const RING_FS = /* glsl */ `
uniform vec3 uColor, uL, uCenter, uRingN, uStar; uniform float uR, uIn, uOut, uFade, uSeed, uBright; varying vec3 vW; varying vec2 vP;
${NOISE}
${MASK}
void main(){ float r=(length(vP)-uIn)/(uOut-uIn);
  float d=0.55+0.3*snoise(vec3(r*18.0,uSeed,0.0))+0.15*snoise(vec3(r*70.0,uSeed+3.0,0.0))+0.08*snoise(vec3(r*190.0,uSeed+5.0,0.0))+0.06*snoise(vec3(r*520.0,uSeed+7.0,0.0));
  d*=0.82+0.18*snoise(vec3(vP*9.0,uSeed));          // clumps along the ring
  d*=1.0-0.92*exp(-pow((r-0.58)*38.0,2.0));       // a dark gap (the Cassini division's cousin)
  d*=mix(0.35,1.0,smoothstep(0.0,0.25,r));         // a faint inner ring
  float edge=smoothstep(0.0,0.03,r)*(1.0-smoothstep(0.93,1.0,r));
  // the planet's shadow, with a soft edge
  vec3 oc=vW-uCenter; float b=dot(oc,uL); float far=sqrt(max(dot(oc,oc)-b*b,0.0));
  float shadow=b<0.0 ? mix(0.12,1.0,smoothstep(uR*0.96,uR*1.06,far)) : 1.0;
  vec3 V=normalize(cameraPosition-vW);
  float lit=0.35+0.65*abs(dot(uL,uRingN))+0.9*pow(max(-dot(V,uL),0.0),3.0);   // backlit ice and dust glow
  vec3 col=uColor*(0.85+0.3*snoise(vec3(r*9.0,uSeed+9.0,0.0)));
  float a=clamp(d,0.0,1.0)*edge*0.6*mix(0.12,1.0,clearOfAgents());
  gl_FragColor=vec4(capped(col*uStar*lit*shadow*uBright)*uFade, a*uFade); }`;

const SUN_VS = /* glsl */ `varying vec2 vUv; void main(){ vUv=uv*2.0-1.0; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const SUN_FS = /* glsl */ `
uniform vec3 uColor; uniform float uT, uFade, uCore; varying vec2 vUv;
${NOISE}
void main(){ float d=length(vUv); float rc=uCore; float a=atan(vUv.y,vUv.x);
  vec3 c=vec3(0.0);
  if(d<rc){ float mu=sqrt(1.0-pow(d/rc,2.0)); float limb=0.45+0.55*pow(mu,0.6);
    float gran=0.92+0.08*snoise(vec3(vUv/rc*7.0,uT*0.15));
    c=mix(uColor,vec3(1.0),0.55)*limb*gran*3.2; }
  float r=max(d-rc,0.0);
  float streams=0.65+0.35*snoise(vec3(cos(a)*3.0,sin(a)*3.0,uT*0.05+d*2.0));
  c+=uColor*exp(-r/(rc*0.9))*1.4*streams*smoothstep(rc*0.97,rc*1.05,d);
  c+=uColor*exp(-d/(rc*3.0))*0.22;
  c+=uColor*exp(-d*4.0)*0.035;
  float sp=exp(-abs(vUv.y)/(rc*0.08))*exp(-abs(vUv.x)*2.6)+exp(-abs(vUv.x)/(rc*0.08))*exp(-abs(vUv.y)*2.6);
  vec2 q=mat2(0.7071,-0.7071,0.7071,0.7071)*vUv;
  sp+=0.45*(exp(-abs(q.y)/(rc*0.06))*exp(-abs(q.x)*4.0)+exp(-abs(q.x)/(rc*0.06))*exp(-abs(q.y)*4.0));
  c+=mix(uColor,vec3(1.0),0.4)*sp*0.35*smoothstep(rc*0.9,rc*2.0,d);
  float edge=1.0-smoothstep(0.75,1.0,d);
  gl_FragColor=vec4(c*edge*uFade,1.0); }`;

const ROCK_VS = /* glsl */ `varying vec3 vN; void main(){ vN=normalize(mat3(modelMatrix*instanceMatrix)*normal); gl_Position=projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(position,1.0); }`;
const ROCK_FS = /* glsl */ `uniform vec3 uColor, uL; uniform float uFade, uBright; varying vec3 vN; ${MASK}
void main(){ gl_FragColor=vec4(capped(uColor*(0.06+0.94*max(dot(normalize(vN),uL),0.0))*uBright)*uFade*mix(0.3,1.0,clearOfAgents()),1.0); }`;


/** fine detail per planet type (none for gas giants) */
const DETAIL: Record<string, number> = { rocky: 1, desert: 0.7, ice: 0.5, lava: 0.6, ocean: 0.6, gas: 0 };

/** relief strength per planet type (none for gas giants) */
const BUMP: Record<string, number> = { rocky: 2.2, desert: 1.4, ice: 0.55, lava: 1.0, ocean: 1.6, gas: 0 };

export type BodiesOptions = { moons: boolean; rings: boolean; belts: boolean; clouds: boolean; cities: boolean; suns: boolean; bright: number };

/** The system's planets and moons, once their bake shader is compiled (off the main thread: no stall on first load). */
export function Bodies(p: { system: StarSystem; lowFx: boolean; o: BodiesOptions }) {
  const ready = useBakeReady(useThree((s) => s.gl));
  return ready ? (
    <CompiledFirst>
      <BodiesNow {...p} />
    </CompiledFirst>
  ) : null;
}

function BodiesNow({ system, lowFx, o }: { system: StarSystem; lowFx: boolean; o: BodiesOptions }) {
  const gl = useThree((s) => s.gl);
  const { planet, star } = system;
  const moons = o.moons ? system.moons : [];
  const rings = o.rings ? planet.rings : null;
  const showClouds = o.clouds && planet.clouds;

  // baked per system: coarse at once, then the sharp versions a band per frame (swapped in as each finishes)
  const tex = useMemo(() => {
    const surface = bake(gl, { type: planet.type, palette: planet.palette, seed: planet.surface, width: 512 });
    const clouds = planet.clouds ? bake(gl, { type: planet.type, palette: planet.palette, seed: planet.surface + 7, clouds: true, width: 512 }) : null;
    const moonTex = system.moons.map((m) => bake(gl, { type: m.type, palette: m.palette, seed: m.surface, width: 128 }));
    return { surface, clouds, moons: moonTex };
  }, [gl, system, planet]);
  const sharp = useMemo(
    () => [
      { key: 'surface' as const, b: bakeInBands(gl, { type: planet.type, palette: planet.palette, seed: planet.surface, width: 2048 }, 32) },
      ...(planet.clouds ? [{ key: 'clouds' as const, b: bakeInBands(gl, { type: planet.type, palette: planet.palette, seed: planet.surface + 7, clouds: true, width: 2048 }, 32) }] : []),
      ...system.moons.map((m, i) => ({ key: i, b: bakeInBands(gl, { type: m.type, palette: m.palette, seed: m.surface, width: 512 }, 2) })),
    ],
    [gl, system, planet],
  );
  useEffect(() => () => [tex.surface, tex.clouds, ...tex.moons, ...sharp.map((x) => x.b.rt)].forEach((t) => t?.dispose()), [tex, sharp]);

  const L = useMemo(() => new THREE.Vector3(), []);
  const res = useMemo(() => new THREE.Vector2(1, 1), []);
  const ringN = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const center = useMemo(() => new THREE.Vector3(), []);
  const starCol = useMemo(() => lin(star.color), [star]);
  const bright = useMemo(() => ({ value: o.bright }), []);
  bright.value = o.bright;
  const mats = useMemo(() => {
    const base = () => ({ uL: { value: L }, uFade: { value: 1 }, uRot: { value: new THREE.Matrix3() }, uCloudRot: { value: new THREE.Matrix3() }, uRes: { value: res }, uBright: bright, uStar: { value: starCol }, uCities: { value: 0 }, uHasClouds: { value: 0 }, uCloudMap: { value: tex.surface.texture }, uDetail: { value: 0.8 } });
    const surface = new THREE.ShaderMaterial({
      vertexShader: LIT_VS,
      fragmentShader: LIT_FS,
      uniforms: { ...base(), uMap: { value: tex.surface.texture }, uType: { value: PLANET_TYPES.indexOf(planet.type) }, uAtmo: { value: lin(planet.atmo) }, uAtmoK: { value: planet.atmoK }, uBump: { value: BUMP[planet.type] ?? 1 }, uCenter: { value: center }, uRingN: { value: ringN }, uRingIn: { value: 0 }, uRingOut: { value: 0 }, uCities: { value: o.cities ? planet.cities : 0 }, uHasClouds: { value: tex.clouds && o.clouds ? 1 : 0 }, uCloudMap: { value: tex.clouds?.texture ?? tex.surface.texture }, uDetail: { value: DETAIL[planet.type] ?? 0 } },
    });
    const atmo = new THREE.ShaderMaterial({ vertexShader: LIT_VS, fragmentShader: ATMO_FS, uniforms: { ...base(), uAtmo: { value: lin(planet.atmo) }, uAtmoK: { value: planet.atmoK } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const clouds = tex.clouds ? new THREE.ShaderMaterial({ vertexShader: LIT_VS, fragmentShader: CLOUD_FS, uniforms: { ...base(), uMap: { value: tex.clouds.texture } }, transparent: true, depthWrite: false }) : null;
    const ring = planet.rings
      ? new THREE.ShaderMaterial({ vertexShader: RING_VS, fragmentShader: RING_FS, uniforms: { uColor: { value: lin(planet.rings.color) }, uL: { value: L }, uCenter: { value: center }, uRingN: { value: ringN }, uStar: { value: starCol }, uR: { value: 1 }, uIn: { value: planet.rings.inner }, uOut: { value: Math.min(planet.rings.outer, 1.75) }, uFade: { value: 1 }, uSeed: { value: (planet.surface % 997) / 97 }, uRes: { value: res }, uBright: bright }, transparent: true, depthWrite: false, side: THREE.DoubleSide })
      : null;
    const moonMats = tex.moons.map((t, i) => new THREE.ShaderMaterial({ vertexShader: LIT_VS, fragmentShader: LIT_FS, uniforms: { ...base(), uMap: { value: t.texture }, uType: { value: PLANET_TYPES.indexOf(system.moons[i].type) }, uAtmo: { value: new THREE.Vector3() }, uAtmoK: { value: 0 }, uBump: { value: system.moons[i].type === 'ice' ? 0.55 : 2.0 }, uCenter: { value: new THREE.Vector3() }, uRingN: { value: new THREE.Vector3(0, 0, 1) }, uRingIn: { value: 0 }, uRingOut: { value: 0 } } }));
    const rock = new THREE.ShaderMaterial({ vertexShader: ROCK_VS, fragmentShader: ROCK_FS, uniforms: { uColor: { value: lin(system.belt?.color ?? '#4a4640') }, uL: { value: L }, uFade: { value: 1 }, uRes: { value: res }, uBright: bright } });
    return { surface, atmo, clouds, ring, moons: moonMats, rock };
  }, [tex, L, res, ringN, center, starCol, bright, planet, system.belt, system.moons, o.cities, o.clouds]);
  useEffect(() => () => [mats.surface, mats.atmo, mats.clouds, mats.ring, mats.rock, ...mats.moons].forEach((m) => m?.dispose()), [mats]);

  // the asteroid belt: rocks along a strip (view positions), each tumbling
  const belt = useMemo(() => {
    const b = system.belt;
    if (!b || lowFx || !o.belts) return null;
    let s = system.seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    return Array.from({ length: b.count }, () => {
      const x = -1.3 + rnd() * 2.6;
      const y = b.y + b.slope * x + (rnd() - 0.5) * 0.06;
      const d = 135 + rnd() * 30;
      return { x, y, d, size: 0.12 + rnd() * 0.45, axis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), spin: (rnd() - 0.5) * 0.6, ph: rnd() * 6.28 };
    });
  }, [system, lowFx, o.belts]);

  const sun = o.suns ? star.sun : undefined;
  const sunMat = useMemo(() => (sun ? new THREE.ShaderMaterial({ vertexShader: SUN_VS, fragmentShader: SUN_FS, uniforms: { uColor: { value: lin(star.color) }, uT: { value: 0 }, uFade: { value: 1 }, uCore: { value: 0.06 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }) : null), [sun, star]);
  useEffect(() => () => sunMat?.dispose(), [sunMat]);
  const sunM = useRef<THREE.Mesh>(null);
  const rocks = useRef<THREE.InstancedMesh>(null);
  const planetG = useRef<THREE.Group>(null);
  const ringM = useRef<THREE.Mesh>(null);
  const cloudM = useRef<THREE.Mesh>(null);
  const moonMs = useRef<Array<THREE.Mesh | null>>([]);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), m3: new THREE.Matrix3(), q: new THREE.Quaternion(), v: new THREE.Vector3(), d: new THREE.Vector3(), s: new THREE.Vector3(), e: new THREE.Euler() }), []);
  // where the camera has been, slowly: the bodies lag fast moves by a fraction of the way, then settle back
  const slow = useRef<THREE.Vector3 | null>(null);
  const origin = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock, camera, size, gl: renderer }, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const t = clock.elapsedTime;
    // a band of the next sharp surface (one per frame), swapped in when it's whole
    const job = sharp.find((x) => !(x.b as { done?: boolean }).done);
    if (job && job.b.step()) {
      (job.b as { done?: boolean }).done = true;
      const map = job.b.rt.texture;
      if (job.key === 'surface') mats.surface.uniforms.uMap.value = map;
      else if (job.key === 'clouds') {
        if (mats.clouds) mats.clouds.uniforms.uMap.value = map;
        mats.surface.uniforms.uCloudMap.value = map;
      }
      else mats.moons[job.key] && (mats.moons[job.key].uniforms.uMap.value = map);
    }
    if (!slow.current) slow.current = cam.position.clone();
    slow.current.lerp(cam.position, 1 - Math.exp(-Math.min(dt, 0.1) / 2.5));
    origin.copy(cam.position).lerp(slow.current, 0.2);
    const unit = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const aspect = size.width / Math.max(1, size.height);
    renderer.getDrawingBufferSize(res);
    // the jump: leaving, we fly forward: bodies rush outward past us, growing; arriving, the new ones ease in
    const w = useWarp.getState();
    const { away } = warpLevels(w.phase, Date.now() - w.at);
    const leaving = w.phase === 'out' || w.phase === 'flash';
    const spread = leaving ? 1 + 1.6 * away * away : 1 - 0.18 * away;
    const grow = leaving ? 1 + 1.4 * away * away : 1 - 0.3 * away;
    const fade = 1 - away;
    const vis = fade > 0.01;
    const at = (x: number, y: number, depth: number, out: THREE.Vector3) => {
      tmp.d.set(x * spread * unit * aspect, y * spread * unit, -1).applyQuaternion(cam.quaternion);
      return out.copy(origin).addScaledVector(tmp.d, depth);
    };
    const R = fit(planet.radius, aspect) * unit * PLANET_D * grow;
    L.set(...star.dir).normalize().applyQuaternion(cam.quaternion);
    // a sun on screen: placed like the others; the light comes from it
    if (sun && sunM.current && sunMat) {
      at(sun.anchor[0], sun.anchor[1], SUN_DEPTH, sunM.current.position);
      const size = (fit(sun.radius, aspect) * unit * SUN_DEPTH * grow) / 0.06;
      sunM.current.scale.setScalar(size);
      sunM.current.quaternion.copy(cam.quaternion);
      sunM.current.visible = vis;
      sunMat.uniforms.uT.value = t;
      sunMat.uniforms.uFade.value = fade;
    }

    if (planetG.current) {
      at(planet.anchor[0], planet.anchor[1], PLANET_D, planetG.current.position);
      planetG.current.scale.setScalar(R);
      planetG.current.visible = vis;
      center.copy(planetG.current.position);
      if (sun && sunM.current) L.copy(sunM.current.position).sub(center).normalize();
    }
    // the planet's turn: tilted, spinning slowly; clouds a little faster
    tmp.e.set(0, t * planet.spin, planet.tilt, 'ZYX');
    tmp.m3.setFromMatrix4(tmp.m.makeRotationFromEuler(tmp.e));
    mats.surface.uniforms.uRot.value.copy(tmp.m3);
    mats.atmo.uniforms.uRot.value.copy(tmp.m3);
    if (mats.clouds) {
      tmp.e.set(0, t * planet.spin * 1.35 + 1.3, planet.tilt, 'ZYX');
      mats.clouds.uniforms.uRot.value.setFromMatrix4(tmp.m.makeRotationFromEuler(tmp.e));
      mats.surface.uniforms.uCloudRot.value.copy(mats.clouds.uniforms.uRot.value);
    }
    if (cloudM.current) cloudM.current.visible = showClouds && !lowFx;
    for (const m of [mats.surface, mats.atmo, mats.clouds, mats.ring, mats.rock, ...mats.moons]) if (m) m.uniforms.uFade.value = fade;
    // the rings: their plane (for both shadows) and size
    if (ringM.current && rings) {
      ringM.current.updateWorldMatrix(true, false);
      ringN.set(0, 0, 1).transformDirection(ringM.current.matrixWorld);
      ringM.current.visible = vis;
      mats.ring!.uniforms.uR.value = R;
      mats.surface.uniforms.uRingIn.value = rings.inner * R;
      mats.surface.uniforms.uRingOut.value = Math.min(rings.outer, 1.75) * R;
    } else mats.surface.uniforms.uRingOut.value = 0;
    moons.forEach((m, i) => {
      const mesh = moonMs.current[i];
      if (!mesh) return;
      tmp.e.set(0, t * 0.02 * (i % 2 ? -1 : 1) + i, 0.2, 'ZYX');
      mats.moons[i]?.uniforms.uRot.value.setFromMatrix4(tmp.m.makeRotationFromEuler(tmp.e));
      at(m.anchor[0], m.anchor[1], MOON_D, mesh.position);
      mesh.scale.setScalar(fit(m.radius, aspect) * unit * MOON_D * grow);
      mesh.visible = vis;
    });

    if (rocks.current && belt) {
      belt.forEach((b, i) => {
        at(b.x, b.y, b.d, tmp.v);
        tmp.q.setFromAxisAngle(b.axis, b.ph + t * b.spin);
        tmp.s.setScalar(fit(b.size, aspect) * (b.d / 140) * grow);
        rocks.current!.setMatrixAt(i, tmp.m.compose(tmp.v, tmp.q, tmp.s));
      });
      rocks.current.instanceMatrix.needsUpdate = true;
      rocks.current.visible = vis;
    }
  });

  return (
    <group>
      {sunMat ? (
        <mesh ref={sunM} material={sunMat} renderOrder={-6} frustumCulled={false}>
          <planeGeometry args={[2, 2]} />
        </mesh>
      ) : null}
      <group ref={planetG}>
        <mesh material={mats.surface} renderOrder={-4}>
          <sphereGeometry args={[1, 128, 96]} />
        </mesh>
        {mats.clouds ? (
          <mesh ref={cloudM} material={mats.clouds} scale={1.012} renderOrder={-3}>
            <sphereGeometry args={[1, 96, 64]} />
          </mesh>
        ) : null}
        <mesh material={mats.atmo} scale={1.05} renderOrder={-2}>
          <sphereGeometry args={[1, 96, 64]} />
        </mesh>
        {mats.ring && rings ? (
          <mesh ref={ringM} material={mats.ring} rotation={[rings.tilt, 0, planet.tilt * 0.6]} renderOrder={-1}>
            <ringGeometry args={[rings.inner, Math.min(rings.outer, 1.75), 256, 1]} />
          </mesh>
        ) : null}
      </group>
      {moons.map((m, i) => (
        <mesh key={i} ref={(el) => void (moonMs.current[i] = el)} material={mats.moons[i]} renderOrder={-4}>
          <sphereGeometry args={[1, 64, 48]} />
        </mesh>
      ))}
      {belt ? (
        <instancedMesh ref={rocks} args={[undefined, mats.rock, belt.length]} renderOrder={-4} frustumCulled={false}>
          <icosahedronGeometry args={[1, 0]} />
        </instancedMesh>
      ) : null}
    </group>
  );
}

/**
 * A star system's nebula: painted once (coarse at once, then sharp a band per frame) onto a wide sheet far behind
 * everything, in the system's colours; it brightens a little as the session gets busy, and fades in a jump.
 */
/** The system's nebula, once its bake shader is compiled (see Bodies). */
export function Nebula(p: { system: StarSystem; strength: number; busy: React.MutableRefObject<number> }) {
  const ready = useBakeReady(useThree((s) => s.gl));
  return ready ? (
    <CompiledFirst>
      <NebulaNow {...p} />
    </CompiledFirst>
  ) : null;
}

function NebulaNow({ system, strength, busy }: { system: StarSystem; strength: number; busy: React.MutableRefObject<number> }) {
  const gl = useThree((s) => s.gl);
  const palette = useMemo(() => {
    const c = system.nebula.map((n) => n.color);
    return [c[0], c[1] ?? c[0], c[2] ?? c[1] ?? c[0]];
  }, [system]);
  const coarse = useMemo(() => bake(gl, { type: 'gas', palette, seed: system.seed + 13, nebula: true, width: 256 }), [gl, palette, system]);
  const sharpNeb = useMemo(() => bakeInBands(gl, { type: 'gas', palette, seed: system.seed + 13, nebula: true, width: 1024 }, 16), [gl, palette, system]);
  useEffect(() => () => [coarse, sharpNeb.rt].forEach((t) => t.dispose()), [coarse, sharpNeb]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: coarse.texture }, uK: { value: 0 } },
        vertexShader: VS_PLAIN,
        fragmentShader: `uniform sampler2D uMap; uniform float uK; varying vec2 vUv; void main(){ gl_FragColor=vec4(texture2D(uMap,vUv).rgb*uK,1.0); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [coarse],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  // dark hues (deep reds, blues) barely show: each system's nebula is evened out to about the same brightness
  const even = useMemo(() => {
    const m = palette.reduce((t, c) => t + luma(c), 0) / palette.length;
    return Math.min(3, Math.max(0.7, 0.2 / Math.max(m, 0.02)));
  }, [palette]);
  const done = useRef(false);
  const sheet = useRef<THREE.Mesh>(null);
  useFrame(({ clock, camera, size }) => {
    // the sheet fills the view at its depth whatever the scene's shape, so the whole painting is always on screen
    if (sheet.current) {
      const cam = camera as THREE.PerspectiveCamera;
      const hgt = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * (cam.position.z + 245) * 1.2;
      sheet.current.scale.set(hgt * (size.width / Math.max(1, size.height)), hgt, 1);
    }
    if (!done.current && sharpNeb.step()) {
      done.current = true;
      mat.uniforms.uMap.value = sharpNeb.rt.texture;
    }
    const w = useWarp.getState();
    const { away } = warpLevels(w.phase, Date.now() - w.at);
    mat.uniforms.uK.value = even * strength * (0.32 + Math.min(0.14, busy.current * 0.03) + 0.02 * Math.sin(clock.elapsedTime * 0.3)) * (1 - away);
  });
  return (
    <mesh ref={sheet} position={[2.2, -2.2, -245]} material={mat} renderOrder={-9}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}
