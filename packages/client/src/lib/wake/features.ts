/** The mel model: raw audio (float32 in int16 range) → mel frames × 32, flat. */
export type MelRunner = (audio: Float32Array) => Promise<Float32Array>;
/** The embedding model: n windows of 76×32 → n × 96. */
export type EmbedRunner = (windows: Float32Array, n: number) => Promise<Float32Array>;
/** A wake model: 16 × 96 → its score. */
export type WakeRunner = (features: Float32Array) => Promise<number>;

const CHUNK = 1280;
const CONTEXT = 480;
const BINS = 32;
const WINDOW = 76;
const MEL_MAX = 970;
const EMB = 96;
const FEAT_MAX = 120;

/**
 * openWakeWord's streaming features (its AudioFeatures), for the browser: audio in 80 ms chunks (with 30 ms of context)
 * becomes mel frames (×/10+2), every 8 of those a 76-frame window, each window a 96-number embedding. A wake model
 * reads the last 16 embeddings. Kept: 10 s of audio, 970 mel frames, 120 embeddings.
 */
export class WakeFeatures {
  private raw: number[] = [];
  private pending: number[] = [];
  private mel: number[][] = Array.from({ length: WINDOW }, () => new Array(BINS).fill(1));
  private feats: Float32Array[] = [];

  constructor(private melRun: MelRunner, private embedRun: EmbedRunner) {
    // as openWakeWord starts: a buffer of embeddings from noise, so a model has 16 to read from the start
    for (let i = 0; i < FEAT_MAX; i++) this.feats.push(new Float32Array(EMB));
  }

  get embeddings(): number {
    return this.feats.length;
  }

  /** Some audio (int16). Returns how many new embeddings it made (one per whole 80 ms chunk). */
  async push(chunk: Int16Array): Promise<number> {
    for (const v of chunk) this.pending.push(v);
    const whole = Math.floor(this.pending.length / CHUNK) * CHUNK;
    if (!whole) return 0;
    const take = this.pending.splice(0, whole);
    this.raw.push(...take);
    if (this.raw.length > 16000 * 10) this.raw.splice(0, this.raw.length - 16000 * 10);
    const ctx = this.raw.slice(-(whole + CONTEXT));
    const out = await this.melRun(Float32Array.from(ctx));
    for (let i = 0; i + BINS <= out.length; i += BINS) this.mel.push(Array.from(out.subarray(i, i + BINS), (x) => x / 10 + 2));
    if (this.mel.length > MEL_MAX) this.mel.splice(0, this.mel.length - MEL_MAX);
    const n = whole / CHUNK;
    const windows = new Float32Array(n * WINDOW * BINS);
    let made = 0;
    for (let i = n - 1; i >= 0; i--) {
      const end = this.mel.length - 8 * i;
      const rows = this.mel.slice(end - WINDOW, end);
      if (rows.length !== WINDOW) continue;
      windows.set(rows.flat(), made * WINDOW * BINS);
      made++;
    }
    if (!made) return 0;
    const emb = await this.embedRun(windows.subarray(0, made * WINDOW * BINS), made);
    for (let k = 0; k < made; k++) this.feats.push(emb.slice(k * EMB, (k + 1) * EMB));
    if (this.feats.length > FEAT_MAX) this.feats.splice(0, this.feats.length - FEAT_MAX);
    return made;
  }

  /** The last n embeddings, flat (n × 96). */
  features(n = 16): Float32Array {
    const out = new Float32Array(n * EMB);
    this.feats.slice(-n).forEach((f, i) => out.set(f, i * EMB));
    return out;
  }
}
