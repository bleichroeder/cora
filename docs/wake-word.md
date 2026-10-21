# "Hey Cora" wake-word model

How `packages/client/public/wake/hey_cora.onnx` was trained (2026-10-16), how well it does, and how to redo it, for example with David's own recordings. The training config is `docs/wake-word-config.yaml`.

## What ships

| File | What it is | Input | Output |
|---|---|---|---|
| `public/wake/melspectrogram.onnx` | openWakeWord v0.5.1 release asset (md5 `763f67cd…`) | `input` float32 `[batch_size, samples]` | `output` `[time, 1, Clipoutput_dim_2, 32]` |
| `public/wake/embedding_model.onnx` | openWakeWord v0.5.1 release asset (md5 `7602421d…`) | `input_1` float32 `[unk__314, 76, 32, 1]` | `conv2d_19` `[unk__315, 1, 1, 96]` |
| `public/wake/hey_cora.onnx` | ours, 621 KB, opset 13 (md5 `b3f3c144…`) | `input` float32 `[1, 16, 96]` | `score` float32 `[1, 1]`, 0 to 1 |

The two feature models are the same files the trainer used to compute features.

`hey_cora.onnx` is the **mean of two openWakeWord DNN models** joined into one graph: `score = (r1 + r2) / 2`. It needs only standard ops (Gemm, ReduceMean, Relu, Sigmoid, Flatten, Mean and so on), so `onnxruntime-web` runs it like any single openWakeWord model.
- **r1** is the standard recipe (layer 32, 50k steps). It almost never false-starts, but it misses some phrases, and its score peaks are narrow (often a single 80 ms frame).
- **r2** is the improvement round (layer 64, 75k steps, 2 augmentation rounds, wider end-of-phrase jitter). It catches nearly everything, but it false-starts about 1 per hour.

Neither met the bar alone. Their mean does (see below).

## Results

Everything was measured with the detector rule from the spec: score ≥ threshold for **2 chunks in a row**, then a **2 s cooldown**. The numbers come from `scripts/eval.py` (in `~/hey-cora` at training time; described under "Evaluation"). They are for the shipped mean model.

| Threshold | Recall, clean | Recall, room (RIR + noise 5–20 dB) | Recall, recipe augmentation (noise −10–15 dB) | False accepts / hour |
|---|---|---|---|---|
| 0.35 (Catches more) | 99.7% | 85.8% | 65.2% | 0.75 |
| **0.5 (Balanced)** | **99.1%** | 76.3% | 56.5% | **0.28** |
| 0.7 (Fewer false starts) | 85.4% | 51.5% | 38.3% | 0.00 |

- **Bar:** recall ≥ 90% at 0.5 and ≤ 0.5 false accepts per hour at 0.5. **Met on clean held-out clips** (99.1%, 0.28/h). **Not met in noise:** the room condition gives 76% at 0.5.
- **Recall** is on 2,000 held-out synthetic "hey cora" clips. They were generated separately, with different TTS noise settings from training and selection, and never used for training or checkpoint selection. Each clip is streamed through openWakeWord's own `Model` (mel, then embedding, then the wake model) in 1280-sample chunks, with 1 s of silence on each side.
  - *room:* a 50% chance of an MIT room impulse response, then AudioSet/FMA background at 5–20 dB SNR, at a random level from −20 to −3 dBFS.
  - *recipe:* openWakeWord's own training augmentation, which is deliberately brutal (background down to −10 dB SNR).
- **False accepts** are on openWakeWord's false-positive validation set: precomputed features for 10.7 h of speech, music and noise, scored every 80 ms. Caveat: the trainer also uses this set to pick checkpoints, so it isn't fully independent.
- Single-frame rule (no "2 in a row") at 0.5: 99.5% clean recall and 0.47 false accepts per hour.

**Near-miss phrases** (150 clean TTS clips each, fraction that triggers at 0.35 / 0.5 / 0.7):

| Phrase | 0.35 | 0.5 | 0.7 | Note |
|---|---|---|---|---|
| hey clara, hey laura, hey carla, hey cara, hey nora | 0 | 0 | 0 | |
| okay cora | 2% | 0.7% | 0 | |
| cora | 3.3% | 2% | 0 | |
| hey dora | 4% | 2% | 0.7% | not in training negatives |
| hey corey | 35% | 25% | 3% | |
| **hey core** | 93% | 84% | 33% | in training negatives, but the TTS says it almost like "hey cora" |
| hey kora | 99% | 99% | 86% | a homophone, so it can't be told apart (expected) |

For comparison, the two halves alone at 0.5 (2 in a row):

| Model | Clean | Room | Recipe | False accepts / h |
|---|---|---|---|---|
| r1 alone | 83.7% | 52.2% | 38.6% | 0.00 |
| r2 alone | 99.7% | 86.7% | 66.8% | 1.03 (0.75 at 0.7) |
| r1 + r2 mean (shipped) | 99.1% | 76.3% | 56.5% | 0.28 |

**Recommended thresholds:** Balanced = **0.5**. It meets both parts of the bar on clean speech and has 0.28 false starts per hour. Catches more = 0.35 is a reasonable trade in a noisy room: +10 points of noisy recall for about 0.75 false starts per hour. Fewer false starts = 0.7 measured 0 per hour, but clean recall drops to 85%.

All of this is on **synthetic** speech. The real test is David saying it into the dashboard mic, with Chrome's echo cancellation, noise suppression and auto gain on. That's closer to the "clean" column than to the "recipe" one. If misses are high in practice, retrain with his recordings (see below).

## How it was trained

Total wall time was about 3 h 45 min (18:05 to 21:50), on WSL2 Ubuntu with the RTX 3070 Ti (8 GB, CUDA 12.8 driver).

| Step | Time |
|---|---|
| Environment and downloads | ~15 min |
| TTS clip generation (66k clips) | 26 min |
| Augmentation and features, r1 | 25 min |
| Training, r1 | 17 min |
| Augmentation and features, r2 (2 rounds) | 46 min, plus 5 min recovery |
| Training, r2 | 37 min |
| Evaluation | ~15–20 min per model |

### 1. Environment (`~/hey-cora` in WSL)

- Python 3.11.17 through `uv`, which was installed into `~/hey-cora/tools`. The system Python is 3.12, and there's no passwordless sudo.
  ```sh
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$HOME/hey-cora/tools UV_NO_MODIFY_PATH=1 sh
  export UV_PYTHON_INSTALL_DIR=$HOME/hey-cora/python UV_CACHE_DIR=$HOME/hey-cora/uv-cache
  tools/uv python install 3.11 && tools/uv venv -p 3.11 venv && source venv/bin/activate
  uv pip install --index-url https://download.pytorch.org/whl/cu121 torch==2.4.1 torchaudio==2.4.1
  uv pip install "numpy<2" "scipy<1.14" onnxruntime==1.19.2 onnx==1.16.2 tqdm scikit-learn requests pyyaml \
    mutagen==1.47.0 torchinfo==1.8.0 torchmetrics==1.2.0 speechbrain==0.5.16 audiomentations==0.33.0 \
    torch-audiomentations==0.11.0 acoustics==0.2.6 pronouncing==0.2.0 deep-phonemizer==0.0.19 \
    webrtcvad-wheels piper-tts==1.3.0 soundfile pyarrow==17.0.0 remotezip "setuptools<70"
  git clone https://github.com/dscripka/openWakeWord          # @ 368c037
  git clone https://github.com/rhasspy/piper-sample-generator # @ 2971426 (v3.2.0)
  uv pip install --no-deps -e ./openWakeWord -e ./piper-sample-generator
  ```
  Pin torch to 2.4 (torchaudio ≥ 2.9 drops the soundfile backend) and keep numpy < 2 (speechbrain 0.5 and acoustics need it). That's also why pyarrow is pinned to 17. TensorFlow and onnx-tf were skipped, since there's no TFLite export.
- Feature models: `melspectrogram.onnx` and `embedding_model.onnx` from https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1, copied into `openWakeWord/openwakeword/resources/models/`.
- TTS: `en_US-libritts_r-medium.pt` (204 MB, LibriTTS-R, 904 speakers) from piper-sample-generator release v2.0.0, put in `piper-sample-generator/models/`.

### 2. Data

| Data | Source | Size | Used |
|---|---|---|---|
| Negative features | `davidscripka/openwakeword_features` → `openwakeword_features_ACAV100M_2000_hrs_16bit.npy` | 17.28 GB, 5.625M windows (~2,000 h) | **all** of it (sha256 checked) |
| False-positive validation | same repo → `validation_set_features.npy` | 185 MB, 481,345 frames = 10.7 h | all |
| Room impulse responses | `davidscripka/MIT_environmental_impulse_responses` (16 kHz) | 270 files, 6 MB | all |
| Background audio | `agkphysics/AudioSet` `data/bal_train/00–03.parquet` → 16 kHz wav | 2,000 × 10 s clips (~5.5 h), 612 MB | subset (the notebook's tar shard no longer exists, the repo is parquet now) |
| Music | FMA `fma_small.zip`, 240 random tracks pulled over HTTP range requests (`remotezip`) → 16 kHz wav | 2 h, 221 MB | subset (the notebook uses 1 h) |
| Positive clips | Piper LibriTTS-R, "hey cora", shuffled speaker pairs (slerp 0.5), length scales 0.75/1.0/1.25, noise 0.98 | 30,000 train (777 MB), 3,000 selection | |
| Adversarial clips | 9 custom phrases × 1200 + 30k phoneme-overlap phrases from `generate_adversarial_texts`, shuffled | 30,000 train (1.1 GB), 3,000 selection | |
| Held-out evaluation | Piper, noise 0.667/0.8, noise_w 0.8/0.9, length 0.8/1.0/1.2 | 2,000 "hey cora" + 11 near-miss phrases × 150 | |

The positive clips are short: median 0.68 s, 0.49–1.37 s. So the trainer picks a 2 s window: `total_length` = 32000 samples gives 16 embeddings, matching the `[1,16,96]` input.

`scripts/prep_background.py` did the RIR, AudioSet and FMA downloads and conversion: decode with soundfile, downmix, resample with torchaudio to 16 kHz int16.

Nothing had to be shrunk to fit the disk. The full ACAV100M file was used. C: went from 46.9 GiB free to a lowest reading of about 22.8 GiB. The AudioSet and FMA subsets are about the notebook's scale.

### 3. Adapting piper-sample-generator (`psg_shim/generate_samples.py`)

openWakeWord's `train.py` does `from generate_samples import generate_samples`, written for dscripka's old fork. That fork had the module at the repo root, made 16 kHz audio and set the model path by default. Upstream rhasspy v3 does none of these. The shim, which is `piper_sample_generator_path` in the config:
- adds the repo to `sys.path` (for `piper_train.vits`)
- calls upstream `generate_samples(..., model=models/en_US-libritts_r-medium.pt, max_speakers=904)`
- shuffles the text list, so the repeated custom near-misses mix with the generated ones
- on CUDA OOM, halves the batch and retries with fresh file names
- resamples every new 22.05 kHz wav in the output directory to 16 kHz mono int16 in place

It also needs one local patch to `piper_sample_generator/__main__.py`. Upstream walks speaker pairs in order, `(0,0),(0,1),…`, so the first ~900 clips are all 50% speaker 0. The patch shuffles the 904² pairs instead:
```python
_pairs = list(it.product(range(num_speakers), range(num_speakers)))
random.shuffle(_pairs)
speakers_iter = it.cycle(_pairs)
```

### 4. Patches to openWakeWord `train.py` / `data.py` (@ 368c037)

All are marked `# hey-cora patch` in the source:
1. **`custom_negative_phrases_repeat`**: repeat the custom near-miss phrases (×1200). Upstream adds each one once among ~30k generated phrases, which gives them about zero weight.
2. **`positive_end_jitter`** (r2 only): `augment_clips(..., end_jitter=…)` for the positive sets, 0.4 s instead of 0.2 s.
3. **`augmentation_rounds` bug**: `compute_features_from_generator(n_total=…)` ignored the rounds, so rounds beyond the first were silently dropped. It's now `len(clips) * augmentation_rounds`. This was fixed before r2; r1 used 1 round.
4. **DataLoader**: workers and prefetch are configurable (`dataloader_workers`, `dataloader_prefetch`). Each worker starts at a different offset. Upstream forked 8 identical generators that all yielded the same batches.
5. **False-positive validation data** is built lazily in 40k-window chunks from an mmap. Upstream built all ~480k (16,96) windows, about 3 GB, in RAM and sent them to the GPU in one batch, which won't fit next to the desktop's GPU use.
6. **`--convert_to_tflite`**: argparse's default is the *string* `"False"`, which is truthy, so it always tried the TFLite export and crashed after saving the ONNX. It's now `is True`.

### 5. Commands

```sh
cd ~/hey-cora && source venv/bin/activate
python openWakeWord/openwakeword/train.py --training_config hey_cora.yaml --generate_clips
python openWakeWord/openwakeword/train.py --training_config hey_cora.yaml --augment_clips
python openWakeWord/openwakeword/train.py --training_config hey_cora.yaml --train_model      # r1 → output/hey_cora.onnx
# r2: same clips, new features and model
python openWakeWord/openwakeword/train.py --training_config hey_cora_r2.yaml --augment_clips --overwrite
python openWakeWord/openwakeword/train.py --training_config hey_cora_r2.yaml --train_model
python scripts/ensemble.py models/hey_cora_r1.onnx models/hey_cora_r2.onnx models/hey_cora_ens.onnx
python scripts/eval.py models/hey_cora_ens.onnx eval/pos eval/adv
```
`hey_cora.yaml` (r1) and `hey_cora_r2.yaml` are both captured in `docs/wake-word-config.yaml`. It holds the r2 values, with the r1 values in comments.

Each step ran inside `systemd-run --user --scope -p MemoryMax=4–6G` (page cache included), so WSL stayed under about 6–8 GB while the desktop was in use.

The trainer's own end-of-training report (window-level, on its harshly augmented selection set, frames ≥ 0.5 per 11.3 h):
- r1: accuracy 0.63, recall 0.27, 0.18 FP/h
- r2: accuracy 0.71, recall 0.47, 3.36 FP/h

Both had "Increasing weight on negative examples" twice. These numbers aren't comparable to the evaluation above.

### 6. The mean model (`scripts/ensemble.py`)

```python
import onnx
from onnx import compose, helper, TensorProto
a = compose.add_prefix(onnx.load("hey_cora_r1.onnx"), "a_")
b = compose.add_prefix(onnx.load("hey_cora_r2.onnx"), "b_")
x = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 16, 96])
y = helper.make_tensor_value_info("score", TensorProto.FLOAT, [1, 1])
nodes = [helper.make_node("Identity", ["input"], [a.graph.input[0].name]),
         helper.make_node("Identity", ["input"], [b.graph.input[0].name]),
         *a.graph.node, *b.graph.node,
         helper.make_node("Mean", [a.graph.output[0].name, b.graph.output[0].name], ["score"])]
g = helper.make_graph(nodes, "hey_cora_ensemble", [x], [y],
                      initializer=[*a.graph.initializer, *b.graph.initializer])
m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)]); m.ir_version = a.ir_version
onnx.checker.check_model(m); onnx.save(m, "hey_cora.onnx")
```

### 7. Evaluation (`scripts/eval.py`)

- **False accepts/hour:** slide a 16-frame window over `validation_set_features.npy`, run the model on each `[1,16,96]` window (the model has a fixed batch of 1), and count detector events (2 in a row, 25-frame cooldown) per 10.7 h.
- **Recall:** `openwakeword.model.Model(wakeword_models=[…], inference_framework="onnx").predict_clip(audio, padding=1)` for each held-out clip, with `reset()` between clips. A hit is at least one detector event, under the three conditions above.
- **Near misses:** the same, on clean TTS of each phrase.

## Redoing it

- **With David's own recordings** (the planned next round if misses are high):
  - Record about 50–200 "Hey Cora"s at 16 kHz mono: different distances, rooms, energy levels, and through the dashboard's actual capture path if possible.
  - Hold out about 20% for evaluation.
  - Put the rest in `output/hey_cora/positive_train`, duplicated 10–20× (or use `augmentation_rounds` > 1) so they carry weight next to the 30k synthetic clips.
  - Rerun `--augment_clips --overwrite` and `--train_model`, then evaluate on the held-out real clips.
  - Recording some everyday near-misses ("hey, Laura", "core", TV audio) into `negative_train` helps false starts the same way.
- **Getting rid of the ensemble:** a single model between r1 and r2 should get there too. For example, r2's settings with `target_false_positives_per_hour: 0.2`, or `max_negative_weight: 3000`. That needs another training run and evaluation.
- **Disk:** peak use was about 33 GB inside WSL: 17.3 GB ACAV100M, ~6 GB venv and uv cache, ~3 GB clips and features, ~1 GB background audio.
- **The WSL disk doesn't give space back:** the Ubuntu `ext4.vhdx` is not sparse, so deleting the training data inside WSL doesn't return the space to C:. To reclaim it: `wsl --shutdown`, then either `wsl --manage Ubuntu --set-sparse true` (then `fstrim` inside WSL), or compact the vhdx (`Optimize-VHD`, or diskpart `compact vdisk`).
- **WSL memory:** the WSL VM was restarted twice during this run, under Windows memory pressure. Files written just before a restart were lost or corrupted: the downloaded ONNX feature models had to be downloaded again, and one feature pass died with a CUDA cuFFT error at 89% (the r2 negatives used the first 53,216 of 60,000 augmented clips). Cap WSL's memory (the `systemd-run` scopes above, or `memory=` in `.wslconfig`) and verify downloads (sha256 / onnxruntime load) after any restart.
