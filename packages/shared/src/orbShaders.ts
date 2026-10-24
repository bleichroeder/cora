// The fluid orb shader (oobleck roll, ferrofluid spikes leaning to a target, ripples, shiver), plus uFerro: fewer,
// taller, sharper cones. The splash and the lock screen draw Cora with it.

const NOISE = `
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

const COMMON = `
uniform float uTime, uThink, uWork, uBusy, uShiver, uFerro;
uniform vec3 uTarget; uniform float uLean;
uniform vec3 uRipDir[6]; uniform float uRipAge[6]; uniform float uRipAmp[6];
${NOISE}
float disp(vec3 n){
  float t=uTime;
  float d=snoise(n*1.1+vec3(0.0,0.0,t*0.25))*0.025;
  d+=snoise(n*1.25+vec3(t*0.18,0.0,t*0.32))*0.11*uThink*(1.0-0.6*uWork);
  float freq=3.6+uBusy*0.7-uFerro*1.1;
  float s=snoise(n*freq+vec3(0.0,t*0.55,0.0));
  float lean=mix(1.0,0.35+1.25*max(dot(n,uTarget),0.0),uLean);
  d+=pow(max(s,0.0),2.6+uFerro*1.6)*(0.22+0.08*uBusy)*(1.0+uFerro*1.3)*uWork*lean;
  for(int i=0;i<6;i++){
    if(uRipAge[i]<0.0||uRipAge[i]>1.2) continue;
    float th=acos(clamp(dot(n,uRipDir[i]),-1.0,1.0));
    float front=uRipAge[i]*3.4;
    d+=exp(-pow((th-front)/0.22,2.0))*uRipAmp[i]*(1.0-uRipAge[i]/1.2);
  }
  d+=snoise(n*9.0+vec3(t*6.0))*0.05*uShiver;
  return d;
}
vec3 displaced(vec3 p){ vec3 n=normalize(p); return n*(length(p)*(1.0+disp(n))); }
`;

export const ORB_VS = `${COMMON}
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  vec3 p=displaced(position);
  vec3 n=normalize(position);
  vec3 t1=normalize(cross(n,abs(n.y)<0.99?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0)));
  vec3 t2=cross(n,t1);
  vec3 pa=displaced(position+t1*0.01); vec3 pb=displaced(position+t2*0.01);
  vec3 nn=normalize(cross(pa-p,pb-p));
  if(dot(nn,n)<0.0) nn=-nn;
  vP=position;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vN=normalize(normalMatrix*nn); vV=normalize(-mv.xyz);
  gl_Position=projectionMatrix*mv;
}`;

export const ORB_FS = `uniform vec3 uColor; uniform float uTime, uThink, uWork, uAlert, uFlash, uVis;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
${NOISE}
void main(){
  float facing=max(dot(normalize(vN),normalize(vV)),0.0);
  float fr=pow(1.0-facing,2.2);
  vec3 p=normalize(vP)*1.7;
  float t=uTime*(0.22+uThink*0.95+uWork*0.4);
  float n=snoise(p+vec3(0.0,0.0,t))+0.5*snoise(p*2.2-vec3(t*1.4,0.0,t*0.3));
  float fil=smoothstep(0.9,1.0,1.0-abs(sin(n*3.4+t*2.2)));
  vec3 base=mix(uColor,vec3(1.0,0.25,0.28),uAlert);
  vec3 col=base*(0.16+0.22*(n*0.5+0.5))+base*fr*2.0+mix(base,vec3(1.0),0.55)*fil*(0.22+1.6*uThink+0.5*uWork)+base*pow(facing,3.0)*0.3+base*uFlash*0.6;
  gl_FragColor=vec4(col*uVis,1.0);
}`;
