// node scripts/wake-check.mjs <wav 16k mono> [model] — runs Cora's wake pipeline on a WAV and prints the best score
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
const dir = process.env.WAKE_DIR ?? 'packages/client/public/wake';
const [wav, model = `${dir}/hey_cora.onnx`] = process.argv.slice(2);
const buf = readFileSync(wav);
const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
const { WakeFeatures } = await import('../packages/client/src/lib/wake/features.ts');
const S = (f) => ort.InferenceSession.create(readFileSync(f));
const [mel, emb, wake] = await Promise.all([S(`${dir}/melspectrogram.onnx`), S(`${dir}/embedding_model.onnx`), S(model)]);
const run = async (s, d, dims) => (await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', d, dims) }))[s.outputNames[0]].data;
const f = new WakeFeatures((a) => run(mel, a, [1, a.length]), (w, n) => run(emb, w, [n, 76, 32, 1]));
let best = 0;
for (let i = 0; i < pcm.length; i += 1280) {
  const made = await f.push(pcm.subarray(i, i + 1280));
  for (let k = 0; k < made; k++) best = Math.max(best, (await run(wake, f.features(16), [1, 16, 96]))[0]);
}
console.log(JSON.stringify({ wav, model, best: Number(best.toFixed(3)) }));
