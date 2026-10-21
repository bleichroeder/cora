/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
// its WASM, served by Cora (from the package in dev, as built assets in the app): never a CDN
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { WakeFeatures } from './features';
import { WakeDetector } from './detector';

/**
 * The wake word, off the main thread: openWakeWord's three models (mel spectrogram, embedding, the wake model) in
 * onnxruntime-web, fed 80 ms of 16 kHz audio at a time. Posts a hit, and now and then the score (for tuning).
 */
let feats: WakeFeatures | null = null;
let detector: WakeDetector | null = null;
let wake: ort.InferenceSession | null = null;
let lastLevel = 0;
let busy: Promise<void> = Promise.resolve();

const run = async (s: ort.InferenceSession, data: Float32Array, dims: number[]) => {
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
  return out[s.outputNames[0]].data as Float32Array;
};

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  busy = busy.then(() => handle(m)).catch((err) => self.postMessage({ t: 'error', message: String(err?.message ?? err) }));
};

async function handle(m: any) {
  if (m.t === 'init') {
    ort.env.wasm.wasmPaths = { wasm: ortWasm, mjs: ortMjs };
    ort.env.wasm.numThreads = 1;
    const load = (f: string) => ort.InferenceSession.create(`${m.base}wake/${f}`, { executionProviders: ['wasm'] });
    const [mel, embed, w] = await Promise.all([load('melspectrogram.onnx'), load('embedding_model.onnx'), load(m.model)]);
    wake = w;
    feats = new WakeFeatures(
      (audio) => run(mel, audio, [1, audio.length]),
      (windows, n) => run(embed, windows, [n, 76, 32, 1]),
    );
    detector = new WakeDetector({ threshold: m.threshold });
    self.postMessage({ t: 'ready' });
  } else if (m.t === 'threshold' && detector) detector.threshold = m.value;
  else if (m.t === 'reset' && feats) feats = new WakeFeatures((feats as any).melRun, (feats as any).embedRun);
  else if (m.t === 'audio' && feats && wake && detector) {
    const made = await feats.push(m.pcm);
    for (let i = 0; i < made; i++) {
      const score = (await run(wake, feats.features(16), [1, 16, 96]))[0];
      const now = performance.now();
      if (detector.score(score, now)) self.postMessage({ t: 'hit', score });
      if (now - lastLevel > 400) (lastLevel = now), self.postMessage({ t: 'level', score });
    }
  }
}
