/** GLSL for the scene: the living orb, the context gauge ring and ambient motes. */

// Ashima 3D simplex noise (MIT).
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

export const ORB_VS = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){ vP=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;

/** A plasma core with a lit rim. Filaments speed up and brighten with uThink; uAlert shifts it red. */
export const ORB_FS = /* glsl */ `
uniform vec3 uColor; uniform float uTime, uThink, uEnergy, uAlert, uVis, uNeural, uDeep;
uniform vec3 uFireDir[6]; uniform float uFireAge[6];
varying vec3 vN; varying vec3 vV; varying vec3 vP;
${NOISE}
void main(){
  float facing=max(dot(normalize(vN),normalize(vV)),0.0);
  float fr=pow(1.0-facing,2.2);
  vec3 q=normalize(vP);
  vec3 p=q*1.7;
  float t=uTime*(0.22+uThink*0.95+uNeural*0.9);
  float n=snoise(p+vec3(0.0,0.0,t))+0.5*snoise(p*2.2-vec3(t*1.4,0.0,t*0.3));
  float fil=smoothstep(0.9,1.0,1.0-abs(sin(n*3.4+t*2.2)));
  // thinking, made visible: a second, finer web of filaments flowing the other way, and "fires" racing along them
  float n2=snoise(p*2.6-vec3(0.0,t*0.8,0.0));
  float web=smoothstep(0.93,1.0,1.0-abs(sin(n2*5.0-t*3.1)))*uNeural;
  float fire=0.0;
  for(int i=0;i<6;i++){
    if(uFireAge[i]<0.0||uFireAge[i]>1.0) continue;
    float th=acos(clamp(dot(q,uFireDir[i]),-1.0,1.0));
    fire+=exp(-pow((th-uFireAge[i]*2.6)/0.09,2.0))*(1.0-uFireAge[i])*(0.35+0.65*(fil+web));
  }
  vec3 base=mix(uColor,vec3(1.0,0.25,0.28),uAlert);
  vec3 hot=mix(base,vec3(1.0),0.6);
  vec3 col=base*(0.16+0.22*(n*0.5+0.5));
  col+=base*fr*(2.0+uDeep*1.2);
  col+=mix(base,vec3(1.0),0.55)*fil*(0.22+1.7*uThink);
  col+=hot*web*1.4;
  col+=vec3(0.85,0.95,1.0)*fire*1.6*uNeural;
  col+=base*pow(facing,3.0)*0.3;
  col+=base*uEnergy*0.55;
  gl_FragColor=vec4(col*uVis,1.0);
}`;

/**
 * Anthropic, as a fluid starburst (Claude's spark): a small core with gloopy arms in a ring facing the viewer.
 * Each arm sways, and stretches and shrinks on its own beat; uBusy (calls in flight) makes them longer and livelier.
 */
/** Anthropic's hub: a small, softly wobbling drop the arms grow out of. */
export const ANTH_HUB_VS = /* glsl */ `
uniform float uTime, uBusy;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
${NOISE}
void main(){
  vec3 n=normalize(position);
  vec3 p=position*(1.0+0.12*snoise(n*2.0+vec3(0.0,0.0,uTime*0.5)));
  vP=position;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vN=normalize(normalMatrix*n); vV=normalize(-mv.xyz);
  gl_Position=projectionMatrix*mv;
}`;

/**
 * One arm of the Claude spark (instanced over a capsule: radius 1, cylinder y -1..1, caps to ±2). Long, thin and
 * round-tipped like the logo's rays; each sways from the root, breathes in length and swells a gloopy bulb at its tip,
 * reaching further while calls are in flight.
 */
export const ANTH_ARM_VS = /* glsl */ `
uniform float uTime, uBusy;
attribute float aAngle, aLen, aSeed;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  float t=uTime, sd=aSeed*6.2831853;
  float L=aLen*(1.0+0.13*sin(t*(0.55+0.5*aSeed)+sd)+0.07*sin(t*1.7+sd*2.0))*(1.0+0.3*uBusy);
  float bulb=0.35+0.3*sin(t*(0.8+0.6*aSeed)+sd*1.3);
  float y=position.y;
  float s=clamp((y+1.0)*0.5,0.0,1.0);
  float rad=0.052*(1.0-0.32*s)+0.03*bulb*smoothstep(0.55,1.0,s)+0.012*sin(s*9.0-t*2.2+sd);
  float ya= y>1.0 ? L+(y-1.0)*rad : y<-1.0 ? (y+1.0)*rad : s*L;
  float u=clamp(ya/L,0.0,1.0);
  // a sway that grows toward the tip, plus a travelling ripple so the arm reads as liquid, not a stick
  float bend=(0.16*sin(t*(0.5+0.4*aSeed)+sd)+0.05*sin(t*1.9+sd*3.0-u*4.0))*u*u;
  float a=aAngle+bend;
  vec3 dir=vec3(cos(a),sin(a),0.0), perp=vec3(-sin(a),cos(a),0.0), up=vec3(0.0,0.0,1.0);
  float tilt=0.22*sin(sd*1.7)+0.08*sin(t*0.7+sd);
  vec3 p=dir*ya+perp*(position.x*rad)+up*(position.z*rad+tilt*ya);
  vec3 nn=normalize(dir*normal.y+perp*normal.x+up*normal.z);
  vP=p;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vN=normalize(normalMatrix*nn); vV=normalize(-mv.xyz);
  gl_Position=projectionMatrix*mv;
}`;

export const RING_VS = /* glsl */ `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;

/** A ring filled clockwise from 12 o'clock up to uPct, with faint ticks every 5%. */
export const GAUGE_FS = /* glsl */ `
uniform float uPct, uFlash, uVis; uniform vec3 uCol; varying vec3 vP;
void main(){
  float a=atan(vP.x,vP.y); float u=(a<0.0?a+6.2831853:a)/6.2831853;
  float on=step(u,uPct); float tick=step(0.975,fract(u*20.0));
  vec3 track=vec3(0.10,0.14,0.20)+tick*0.10;
  float edge=smoothstep(uPct-0.012,uPct,u)*on;
  vec3 col=mix(track,uCol*0.75,on)+uCol*edge*1.6+vec3(1.0)*uFlash;
  gl_FragColor=vec4(col*uVis,mix(0.6,1.0,on)*uVis);
}`;

export const MOTE_VS = /* glsl */ `
attribute float seed; uniform float uTime, uBusy; varying float vS;
void main(){ vS=seed; float t=uTime*(0.08+uBusy*0.1);
  vec3 p=position+vec3(sin(t+seed*40.0)*0.9, cos(t*1.3+seed*25.0)*0.6, sin(t*0.7+seed*13.0)*0.6);
  vec4 mv=modelViewMatrix*vec4(p,1.0); gl_PointSize=(1.6+seed*2.8)*(30.0/-mv.z); gl_Position=projectionMatrix*mv; }`;

export const MOTE_FS = /* glsl */ `
varying float vS; uniform float uTime;
void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.0,d)*(0.25+0.2*sin(uTime*0.8+vS*30.0));
  gl_FragColor=vec4(mix(vec3(0.4,0.8,1.0),vec3(0.7,0.55,1.0),vS)*a,a); }`;

/**
 * The fluid orb's surface (vertex displacement), blended from three behaviours:
 * thinking = a slow, heavy oobleck roll; working = ferrofluid spikes (more and taller with calls in flight, leaning
 * toward the current target); events = jelly ripples running across the surface from where a call left or a result
 * landed; failure = a hard shiver. Freezing (needs you) happens on the JS side by stopping uTime.
 * Directions are in the orb's own (rotating) frame.
 */
export const FLUID_VS = /* glsl */ `
uniform float uTime, uThink, uWork, uBusy, uShiver, uLean, uFerro;
uniform vec3 uTarget;
uniform vec3 uRipDir[6]; uniform float uRipAge[6]; uniform float uRipAmp[6];
varying vec3 vN; varying vec3 vV; varying vec3 vP;
${NOISE}
float disp(vec3 n){
  float t=uTime;
  float d=snoise(n*1.1+vec3(0.0,0.0,t*0.25))*0.025;
  d+=snoise(n*1.25+vec3(t*0.18,0.0,t*0.32))*0.11*uThink*(1.0-0.6*uWork);
  // uFerro: fewer, taller, sharper cones (the orb speaking: a ferrofluid speaker)
  float s=snoise(n*(3.6+uBusy*0.7-uFerro*1.1)+vec3(0.0,t*0.55,0.0));
  float lean=mix(1.0,0.35+1.25*max(dot(n,uTarget),0.0),uLean);
  d+=pow(max(s,0.0),2.6+uFerro*1.6)*(0.22+0.08*uBusy)*(1.0+uFerro*1.3)*uWork*lean;
  for(int i=0;i<6;i++){
    if(uRipAge[i]<0.0||uRipAge[i]>1.2) continue;
    float th=acos(clamp(dot(n,uRipDir[i]),-1.0,1.0));
    d+=exp(-pow((th-uRipAge[i]*3.4)/0.22,2.0))*uRipAmp[i]*(1.0-uRipAge[i]/1.2);
  }
  d+=snoise(n*9.0+vec3(t*6.0))*0.05*uShiver;
  return d;
}
vec3 displaced(vec3 p){ vec3 n=normalize(p); return n*(length(p)*(1.0+disp(n))); }
void main(){
  vec3 p=displaced(position);
  vec3 n=normalize(position);
  vec3 t1=normalize(cross(n,abs(n.y)<0.99?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0)));
  vec3 t2=cross(n,t1);
  float e=0.01*length(position);
  vec3 nn=normalize(cross(displaced(position+t1*e)-p,displaced(position+t2*e)-p));
  if(dot(nn,n)<0.0) nn=-nn;
  vP=position;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vN=normalize(normalMatrix*nn); vV=normalize(-mv.xyz);
  gl_Position=projectionMatrix*mv;
}`;

/** A faceted gem (the radiant's heart): flat facets from screen-space derivatives, lit, with glints. */
export const GEM_VS = /* glsl */ `varying vec3 vVP;
void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vVP=mv.xyz; gl_Position=projectionMatrix*mv; }`;
export const GEM_FS = /* glsl */ `uniform vec3 uColor; uniform float uFlash, uTime;
varying vec3 vVP;
void main(){
  vec3 n=normalize(cross(dFdx(vVP),dFdy(vVP)));
  vec3 v=normalize(-vVP);
  vec3 L=normalize(vec3(-0.5,0.8,0.6));
  float lambert=max(dot(n,L),0.0);
  float fr=pow(1.0-max(dot(n,v),0.0),2.0);
  float glint=pow(max(dot(reflect(-L,n),v),0.0),28.0);
  float shimmer=0.5+0.5*sin(dot(floor(n*4.0),vec3(12.9,78.2,37.7))+uTime*1.3);
  gl_FragColor=vec4(uColor*(0.25+0.55*lambert+0.15*shimmer)+uColor*fr*1.4+vec3(1.0)*glint*1.5+uColor*uFlash*0.9,1.0);
}`;

/** A liquid tube (resource → file droplet): see-through with bright edges, colour fading along it, a travelling band. */
export const TUBE_VS = /* glsl */ `attribute float aU; varying float vU; varying vec3 vN; varying vec3 vV;
void main(){ vU=aU; vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
export const TUBE_FS = /* glsl */ `uniform vec3 uA; uniform vec3 uB; uniform float uPulse, uVis; varying float vU; varying vec3 vN; varying vec3 vV;
void main(){
  float facing=abs(dot(normalize(vN),normalize(vV)));
  vec3 col=mix(uA,uB,smoothstep(0.0,1.0,vU));
  float body=0.18+0.55*pow(1.0-facing,1.5);
  float band=uPulse<0.0?0.0:exp(-pow((vU-uPulse)/0.07,2.0));
  gl_FragColor=vec4(col*(body+band*2.2)*uVis,(body*0.9+band)*uVis);
}`;
