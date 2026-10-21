import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { compileThen } from '../warmup';
import { NOISE } from '../shaders';
import { PLANET_TYPES, type PlanetType } from './generate';

/**
 * A planet's surface (or cloud cover) rendered once, on the GPU, into a texture wrapped around the sphere
 * (longitude across, latitude up), from noise on the sphere itself, so it has no seam. Surfaces carry their height
 * in alpha: the planet's lighting uses it for relief, oceans (below 0.5) and lava's glowing seams (near 0).
 */

/** a colour as linear light: the scene renders in linear and the glow pass turns it back into the colour shown */
export const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};

const FRAG = /* glsl */ `
varying vec2 vUv; uniform int uType, uMode; uniform vec3 uC0, uC1, uC2, uC3, uSeed;
${NOISE}
float fbm(vec3 p, int oct){ float a=0.5, s=0.0; for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*snoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
float ridged(vec3 p, int oct){ float a=0.5, s=0.0, w=1.0; for(int i=0;i<7;i++){ if(i>=oct) break; float n=1.0-abs(snoise(p)); n*=n*w; w=clamp(n*1.8,0.0,1.0); s+=n*a; p=p*2.05+vec3(3.1,1.3,7.7); a*=0.5; } return s; }
vec3 hash3(vec3 p){ p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453); }
vec2 worley(vec3 p){ vec3 i=floor(p), f=fract(p); float d1=8.0, d2=8.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){ vec3 g=vec3(float(x),float(y),float(z)); vec3 r=g+hash3(i+g)-f; float d=dot(r,r); if(d<d1){ d2=d1; d1=d; } else if(d<d2) d2=d; }
  return sqrt(vec2(d1,d2)); }
vec3 warp(vec3 p, float k){ return p + k*vec3(fbm(p,4), fbm(p+vec3(5.2,1.3,2.8),4), fbm(p+vec3(1.7,9.2,4.1),4)); }
vec3 ramp(float t){ t=clamp(t,0.0,1.0); vec3 c=mix(uC0,uC1,smoothstep(0.0,0.35,t)); c=mix(c,uC2,smoothstep(0.3,0.7,t)); return mix(c,uC3,smoothstep(0.65,1.0,t)); }
/** craters: round bowls with raised rims, each its own size (some cells have none); returns (depth, rim) */
vec2 craters(vec3 p){ vec3 i=floor(p), f=fract(p); float bowl=0.0, rim=0.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g=vec3(float(x),float(y),float(z)); vec3 hh=hash3(i+g+7.0); if(hh.y<0.55) continue;
    float rad=0.18+0.32*hh.x*hh.x; float d=length(g+hash3(i+g)-f)/rad;
    bowl=max(bowl, 1.0-smoothstep(0.0,1.0,d*d)); rim=max(rim, exp(-pow((d-1.0)*4.5,2.0))*(1.0-bowl*0.6)); }
  return vec2(bowl,rim); }
void main(){
  float lon=(vUv.x-0.5)*6.2831853, lat=(vUv.y-0.5)*3.14159265;
  vec3 p=vec3(cos(lat)*cos(lon), sin(lat), cos(lat)*sin(lon));
  vec3 q=p*1.6+uSeed;
  float polar=abs(p.y);
  if(uMode==2){
    // a nebula: warped gas in two or three colours, dark dust lanes through it, fading at the edges
    vec3 nq=vec3(vUv.x*2.8, vUv.y*1.6, 0.0)+uSeed;
    vec3 nw=warp(nq,1.3);
    float d=fbm(nw,6)*0.5+0.5;
    float gas=smoothstep(0.42,0.9,d)*(0.45+0.55*smoothstep(-0.35,0.35,fbm(nq*0.35+21.0,3)));   // uneven, never empty
    float dust=ridged(nq*1.6+5.0,5);
    float tint=fbm(nq*0.6+11.0,3)*0.5+0.5;
    vec3 c=mix(uC0,uC1,smoothstep(0.3,0.7,tint)); c=mix(c,uC2,smoothstep(0.72,0.95,d));
    float a=gas*(1.0-0.8*smoothstep(0.5,0.85,dust))+0.05*smoothstep(0.35,0.75,d);
    float edge=smoothstep(0.0,0.12,vUv.x)*(1.0-smoothstep(0.88,1.0,vUv.x))*smoothstep(0.0,0.22,vUv.y)*(1.0-smoothstep(0.78,1.0,vUv.y));
    gl_FragColor=vec4(c*a*edge,1.0);
    return;
  }
  if(uMode==1){
    // clouds: swirled, stretched along the latitudes, with fine wisps
    vec3 c=q*vec3(1.0,2.3,1.0)*1.4;
    float n=fbm(warp(c,0.9),6)+0.35*fbm(c*4.0+vec3(7.0),4);
    gl_FragColor=vec4(1.0,1.0,1.0,smoothstep(0.08,0.62,n)*(1.0-0.5*smoothstep(0.85,1.0,polar)));
    return;
  }
  vec3 col; float h;
  if(uType==0){ // rocky: warped highlands and maria, ridged mountains, craters at two scales
    vec3 w=warp(q*1.1,0.8);
    float base=fbm(w,5)*0.5+0.5;
    float mtn=ridged(q*2.0+3.0,5);
    vec2 c1=craters(q*3.2), c2=craters(q*8.5+11.0), c3=craters(q*20.0+5.0);
    h=base*0.5+mtn*0.25-c1.x*0.3+c1.y*0.14-c2.x*0.14+c2.y*0.07-c3.x*0.05;
    float maria=smoothstep(0.42,0.3,base);
    col=ramp(base*0.7+mtn*0.35); col*=1.0-maria*0.35;
    col*=1.0-c1.x*0.28-c2.x*0.16; col*=1.0+c1.y*0.25+c2.y*0.12;
    col*=(0.94+0.12*fbm(q*7.0,3))*1.25;
  } else if(uType==1){ // desert: dune seas, dark rock basins, canyons
    vec3 w=warp(q,0.7);
    float base=fbm(w*0.9,6)*0.5+0.5;
    float dunes=sin(dot(w,vec3(26.0,8.0,15.0))+fbm(q*2.5,3)*4.0)*0.5+0.5;
    float sea=smoothstep(0.45,0.7,fbm(q*1.4+7.0,4)*0.5+0.5);
    float canyon=(1.0-smoothstep(0.0,0.11,abs(snoise(warp(q*1.1,0.6)))))*(1.0-sea);
    h=base*0.7+dunes*0.07*sea-canyon*0.22;
    col=ramp(base*0.75+dunes*0.1*sea+sea*0.12); col*=1.0-canyon*0.3;
    col*=0.95+0.1*fbm(q*6.0,3);
    col=mix(col, uC3*1.1, smoothstep(0.88,0.97,polar)*0.7);
  } else if(uType==2){ // ice: pale plains, a web of dark cracks, brighter poles
    vec3 w=warp(q*0.9,0.6);
    float base=fbm(w,5)*0.5+0.5;
    float crack=1.0-smoothstep(0.015,0.06,abs(snoise(warp(q*1.5,0.45))));
    float crack2=(1.0-smoothstep(0.0,0.03,abs(snoise(warp(q*3.2+5.0,0.3)))))*smoothstep(0.1,0.5,fbm(q*2.0+3.0,3)+0.3);
    float crackH=1.0-smoothstep(0.0,0.2,abs(snoise(warp(q*1.5,0.45))));
    h=0.55+base*0.3-crackH*0.18;
    col=ramp(0.35+base*0.55);
    col=mix(col, mix(uC0,vec3(0.32,0.24,0.2),0.35)*0.9, crack*0.7+crack2*0.4);
    col=mix(col, uC3*1.12, smoothstep(0.7,0.95,polar)*0.6);
  } else if(uType==3){ // lava: dark crust plates, glowing seams between them
    vec3 w=warp(q*1.2,0.5);
    vec2 cell=worley(w*3.0);
    float seam=1.0-smoothstep(0.0,0.07,cell.y-cell.x);
    float crust=fbm(q*4.0,5)*0.5+0.5;
    float seamH=1.0-smoothstep(0.0,0.16,cell.y-cell.x);
    h=min(mix(0.4+0.35*crust, 0.12, seamH), mix(1.0, 0.0, seam));
    col=mix(uC0,uC2,crust*0.8); col*=1.0-seam*0.6;
  } else if(uType==4){ // ocean: continents with ragged coasts, shelves, ice caps
    vec3 w=warp(q*1.05,0.85);
    float e=fbm(w,7);
    float land=smoothstep(0.02,0.05,e);
    float depth=smoothstep(-0.6,0.02,e);
    vec3 water=mix(uC0*0.7,uC1,depth); water=mix(water, uC1*1.25, smoothstep(-0.05,0.02,e)*0.6);
    float hl=smoothstep(0.02,0.5,e);
    vec3 ground=mix(uC2,uC3,hl+0.15*fbm(q*8.0,3)); ground*=0.85+0.25*ridged(q*3.0,4);
    col=mix(water,ground,land);
    float cap=smoothstep(0.78,0.86,polar+0.05*fbm(q*5.0,3));
    col=mix(col, vec3(0.62,0.66,0.7), cap);
    h=mix(0.5*depth, 0.52+0.45*hl, land); h=max(h, cap*0.6);
  } else { // gas giant: turbulent bands, fine streaks, one storm
    vec3 t=warp(vec3(p.x*1.4,p.y*5.0,p.z*1.4)+uSeed,0.35);
    float y=p.y+0.06*fbm(t,5)+0.02*fbm(t*4.0,3);
    float b=sin(y*13.0)*0.5+0.5, b2=sin(y*41.0+1.3)*0.5+0.5, b3=sin(y*97.0)*0.5+0.5;
    float tone=b*0.6+b2*0.28+b3*0.12;
    vec3 s=vec3(0.6,-0.32+0.0*uSeed.x,0.75); s=normalize(s);
    float sd=distance(p*vec3(1.0,1.7,1.0), s*vec3(1.0,1.7,1.0));
    float storm=1.0-smoothstep(0.1,0.17,sd);
    float swirl=sin(atan(p.y-s.y,p.x-s.x)*3.0+sd*60.0)*0.5+0.5;
    col=ramp(tone); col=mix(col, mix(uC3*1.15,uC2,swirl*0.5), storm*0.85);
    col*=0.92+0.16*fbm(t*6.0,3);
    h=0.5;
  }
  gl_FragColor=vec4(col, clamp(h,0.0,1.0));
}`;

let quad: { scene: THREE.Scene; cam: THREE.OrthographicCamera; mat: THREE.ShaderMaterial } | null = null;
function bakeQuad() {
  if (quad) return quad;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uType: { value: 0 }, uMode: { value: 0 }, uC0: { value: new THREE.Vector3() }, uC1: { value: new THREE.Vector3() }, uC2: { value: new THREE.Vector3() }, uC3: { value: new THREE.Vector3() }, uSeed: { value: new THREE.Vector3() } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  quad = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat };
  return quad;
}

/** The bake shader, compiled off the main thread for this renderer (once): baking after it never stalls the page. */
let warm: { gl: THREE.WebGLRenderer; done: boolean; ready: Promise<void> } | null = null;
export function warmBake(gl: THREE.WebGLRenderer): Promise<void> {
  if (warm?.gl === gl) return warm.ready;
  const q = bakeQuad();
  // as it's used: into a half-float target (three.js builds a different variant for the screen)
  const rt = target(2);
  const prev = gl.getRenderTarget();
  let started: Promise<unknown>;
  try {
    gl.setRenderTarget(rt);
    started = compileThen(gl, q.scene, q.cam, q.scene);
  } finally {
    gl.setRenderTarget(prev);
  }
  const w: { gl: THREE.WebGLRenderer; done: boolean; ready: Promise<void> } = { gl, done: false, ready: Promise.resolve() };
  w.ready = started.catch(() => {}).then(() => {
    rt.dispose();
    w.done = true;
  });
  warm = w;
  return w.ready;
}
/** Is the bake shader ready for this renderer (it's started compiling if not)? */
export function useBakeReady(gl: THREE.WebGLRenderer): boolean {
  const [ok, setOk] = useState(() => warm?.gl === gl && warm.done);
  useEffect(() => {
    let live = true;
    void warmBake(gl).then(() => live && setOk(true));
    return () => {
      live = false;
    };
  }, [gl]);
  return ok;
}

type BakeOpts = { type: PlanetType; palette: readonly string[]; seed: number; clouds?: boolean; nebula?: boolean; width: number };

function setUniforms(o: BakeOpts) {
  const u = bakeQuad().mat.uniforms;
  u.uType.value = PLANET_TYPES.indexOf(o.type);
  u.uMode.value = o.nebula ? 2 : o.clouds ? 1 : 0;
  (['uC0', 'uC1', 'uC2', 'uC3'] as const).forEach((k, i) => u[k].value.copy(lin(o.palette[Math.min(i, o.palette.length - 1)])));
  const s = (o.seed % 10007) / 10007;
  u.uSeed.value.set(s * 91.7, s * 37.3 + 11, s * 53.1 - 7);
}

function target(width: number) {
  const rt = new THREE.WebGLRenderTarget(width, width / 2, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.anisotropy = 4;
  return rt;
}

/**
 * A surface rendered a band at a time, a band per `step()` (one per frame), so a new system never stalls the scene;
 * `step()` says when it's done (the last band builds the mipmaps).
 */
export function bakeInBands(gl: THREE.WebGLRenderer, o: BakeOpts, bands = 8): { rt: THREE.WebGLRenderTarget; step(): boolean } {
  const rt = target(o.width);
  let next = 0;
  return {
    rt,
    step() {
      if (next >= bands) return true;
      const q = bakeQuad();
      setUniforms(o);
      const h = o.width / 2;
      const y0 = Math.floor((next * h) / bands), y1 = Math.floor(((next + 1) * h) / bands);
      rt.scissor.set(0, y0, o.width, y1 - y0);
      rt.scissorTest = true;
      next++;
      rt.texture.generateMipmaps = next === bands;
      const prev = gl.getRenderTarget();
      const auto = gl.autoClear;
      gl.autoClear = false;
      gl.setRenderTarget(rt);
      gl.render(q.scene, q.cam);
      gl.setRenderTarget(prev);
      gl.autoClear = auto;
      if (next === bands) rt.scissorTest = false;
      return next >= bands;
    },
  };
}

/** Render a surface (or clouds: `clouds`) into a new texture. The caller disposes the target. */
export function bake(gl: THREE.WebGLRenderer, o: BakeOpts): THREE.WebGLRenderTarget {
  const q = bakeQuad();
  const rt = target(o.width);
  rt.texture.generateMipmaps = true;
  setUniforms(o);
  const prev = gl.getRenderTarget();
  const auto = gl.autoClear;
  gl.autoClear = true;
  gl.setRenderTarget(rt);
  gl.render(q.scene, q.cam);
  gl.setRenderTarget(prev);
  gl.autoClear = auto;
  return rt;
}
