import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Start compiling what's in `root` (the GPU driver links in the background where it can: KHR_parallel_shader_compile)
 * and resolve when it's done. three.js's own compileAsync crashes in its timer when a material is replaced while it
 * waits (its program is gone), and then never resolves: this checks each material itself, counts a replaced one as
 * done, and gives up after a few seconds, so the scene always draws (compiled on first use, at worst).
 */
export function compileThen(gl: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, maxMs = 8000): Promise<void> {
  let mats: Set<THREE.Material>;
  try {
    mats = gl.compile(root, camera, scene) as unknown as Set<THREE.Material>;
  } catch {
    return Promise.resolve();
  }
  const t0 = performance.now();
  return new Promise((done) => {
    const check = () => {
      for (const m of mats) {
        const p = (gl.properties.get(m) as { currentProgram?: { isReady?: () => boolean } }).currentProgram;
        if (!p?.isReady || p.isReady()) mats.delete(m);
      }
      if (!mats.size || performance.now() - t0 > maxMs) return done();
      setTimeout(check, 10);
    };
    check();
  });
}

/**
 * Compile what's in `root` off the main thread where the GPU driver can (KHR_parallel_shader_compile): for the screen,
 * and for an offscreen target (the glow's composer draws the scene into one, and three.js builds other variants for
 * that: no tone mapping, linear colour). Compiling starts at the call, so the target only needs to be set around it.
 * `scene` gives the lights the materials are built for.
 */
export function compileBoth(gl: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const prev = gl.getRenderTarget();
  const done: Promise<unknown>[] = [];
  try {
    done.push(compileThen(gl, root, camera, scene));
    gl.setRenderTarget(rt);
    done.push(compileThen(gl, root, camera, scene));
  } catch {
    /* drawn (and compiled) as it comes instead */
  } finally {
    gl.setRenderTarget(prev);
  }
  return Promise.allSettled(done).then(() => rt.dispose());
}

/**
 * The scene's shaders, compiled before its first frame (compileBoth), so the rest of the app stays live while they
 * build. Compiled on first draw instead, they held the whole window for seconds. The canvas doesn't draw
 * (frameloop 'never') until `onReady`.
 */
export function Warmup({ onReady }: { onReady(): void }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let live = true;
    // a frame for everything in the scene to mount, then all of it at once
    const id = requestAnimationFrame(() => void compileBoth(gl, scene, camera, scene).then(() => live && ready.current()));
    return () => {
      live = false;
      cancelAnimationFrame(id);
    };
  }, [gl, scene, camera]);
  return null;
}

/** What arrives after the scene's first frame (its planets, its nebula): hidden until its shaders are compiled. */
export function CompiledFirst({ children }: { children: ReactNode }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let live = true;
    const id = requestAnimationFrame(() => {
      if (group.current) void compileBoth(gl, group.current, camera, scene).then(() => live && setShown(true));
    });
    return () => {
      live = false;
      cancelAnimationFrame(id);
    };
  }, [gl, scene, camera]);
  return (
    <group ref={group} visible={shown}>
      {children}
    </group>
  );
}

/** Over the scene while it warms up: plain CSS (it keeps moving while the page is busy), Cora's splash in small. */
export function SceneVeil({ gone }: { gone: boolean }) {
  return (
    <div className={`scene-veil${gone ? ' gone' : ''}`} aria-hidden={gone}>
      <span className="sv-ring" />
      <span className="sv-word">CORA</span>
      <span className="sv-sub">warming up the scene</span>
    </div>
  );
}
