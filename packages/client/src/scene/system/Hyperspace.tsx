import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useWarp, warpLevels } from './warp';

/**
 * The jump itself: streaks of starlight rushing past (they lengthen as the warp builds) and a short flash at full
 * warp. It rides with the camera. Low effects: neither (the system just fades out and in).
 */
const N = 260;

export function Hyperspace({ lowFx }: { lowFx: boolean }) {
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const { streaks, flash } = useMemo(() => {
    const start = new Float32Array(N * 2 * 3);
    const end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.pow(Math.random(), 0.7) * 44;
      const z = Math.random() * 230;
      for (let j = 0; j < 2; j++) {
        start.set([Math.cos(a) * r, Math.sin(a) * r, z], (i * 2 + j) * 3);
        end[i * 2 + j] = j;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(start, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uW: { value: 0 } },
      vertexShader: `attribute float aEnd; uniform float uT, uW; varying float vA;
        void main(){ float z=-mod(position.z+uT*150.0, 200.0)-34.0; z+=aEnd*uW*uW*30.0;
          vA=(1.0-smoothstep(-80.0,-34.0,z)*0.7)*smoothstep(-234.0,-160.0,z);
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position.xy,z,1.0); }`,
      fragmentShader: `uniform float uW; varying float vA; void main(){ gl_FragColor=vec4(vec3(0.72,0.86,1.0)*vA*uW*0.45, 1.0); }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const streaks = new THREE.LineSegments(g, mat);
    streaks.frustumCulled = false;
    streaks.renderOrder = -20;
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: '#dbeaff', transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    flash.position.z = -3;
    flash.renderOrder = 60;
    return { streaks, flash };
  }, []);

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    g.position.copy(camera.position);
    g.quaternion.copy(camera.quaternion);
    const w = useWarp.getState();
    const lv = warpLevels(w.phase, Date.now() - w.at);
    const mat = streaks.material as THREE.ShaderMaterial;
    mat.uniforms.uT.value = clock.elapsedTime;
    mat.uniforms.uW.value = lv.warp;
    streaks.visible = !lowFx && lv.warp > 0.001;
    (flash.material as THREE.MeshBasicMaterial).opacity = lowFx ? 0 : lv.flash * 0.28;
    flash.visible = !lowFx && lv.flash > 0.001;
  });

  return (
    <group ref={group}>
      <primitive object={streaks} />
      <primitive object={flash} />
    </group>
  );
}
