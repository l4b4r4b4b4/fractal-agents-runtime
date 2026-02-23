# Research: Open-Source Music Source Separation & Transcription

> **Date:** 2026-02-16
> **Context:** Side research during Goal 31 Session 36. Investigating open-source models for
> WAV input → per-instrument/track/voice music transcription, with focus on permissive licensing
> for commercial use.

## Problem Statement

Given a WAV audio file (e.g., a full song), separate it into individual stems (vocals, drums,
bass, other instruments) and then transcribe each stem into structured musical notation (MIDI).

This is a two-stage pipeline:
1. **Source Separation** — split a mixed audio signal into individual instrument/vocal tracks
2. **Music Transcription** — convert each audio track into MIDI / note events

## Key Distinction: These Are NOT LLM Workloads

Source separation and music transcription models are CNN/transformer architectures operating
on spectrograms and waveforms. They are **not** autoregressive text generators, so:

- **vLLM does not apply.** vLLM is designed for LLM inference (KV-cache, continuous batching
  for token generation). Totally different compute pattern.
- **GPU acceleration** is via standard PyTorch CUDA, not LLM serving frameworks.
- **For scalable serving**, use Triton Inference Server (NVIDIA), TorchServe, or BentoML —
  not vLLM.

## Source Separation Models

### License & Status Overview

| Project | License | Stars | Status | Commercial? | Notes |
|---------|---------|-------|--------|-------------|-------|
| [Demucs v4 / HTDemucs](https://github.com/facebookresearch/demucs) (Meta) | **MIT** | 9.7k | ⚠️ **ARCHIVED** | ✅ Yes | Hybrid transformer, was SOTA. No longer maintained. |
| [UVR5](https://github.com/Anjok07/ultimatevocalremovergui) | **MIT** | 23.6k | ✅ Active | ✅ Yes | Most popular tool. Custom MDX23C + Mel-Band RoFormer models. |
| [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | **MIT** | 1k | ✅ Active | ✅ Yes | Clean Python API wrapping UVR models. `pip install audio-separator`. |
| [MSST (ZFTurbo)](https://github.com/ZFTurbo/Music-Source-Separation-Training) | **MIT** | 1.2k | ✅ Active | ✅ Yes | Training framework. Supports Demucs, BSRNN, MDX23C, RoFormer, etc. |
| [Open-Unmix](https://github.com/sigsep/open-unmix-pytorch) | **MIT** | 1.5k | ✅ Active | ✅ Yes | Lightweight reference implementation. Lower quality than SOTA. |
| [ByteDance music_source_separation](https://github.com/bytedance/music_source_separation) | **Apache 2.0** | 1.4k | ⚠️ **ARCHIVED** | ✅ Yes | BSRNN official code. Apache 2.0 includes patent grant. |
| [BandSplitRNN-PyTorch](https://github.com/amanteur/BandSplitRNN-PyTorch) | ⚠️ **No license** | 187 | Active | ❌ **No** | Unofficial BSRNN reimplementation. No license = all rights reserved. |
| [MSST-WebUI](https://github.com/SUC-DriverOld/MSST-WebUI) | — | 966 | ✅ Active | Check | WebUI for MSST + UVR combined. |

### Quality Ranking (SDR — Signal-to-Distortion Ratio on vocals)

| Model | SDR (vocals) | Open Source | License |
|-------|-------------|-------------|---------|
| BSRNN (ByteDance) | ~10+ dB | ⚠️ Weights only, code archived | Apache 2.0 |
| MDX23C / Mel-Band RoFormer (UVR) | ~9-10 dB | ✅ Full | MIT |
| Bandit (Cisco) | ~9 dB | ✅ Full | MIT |
| HTDemucs v4 (Meta) | ~8.5 dB | ✅ Full (archived) | MIT |
| Open-Unmix | ~6 dB | ✅ Full | MIT |

### Key Findings — Source Separation

1. **Demucs is archived by Meta.** Code and weights still work but no updates, no security
   fixes. Risky for long-term commercial dependency.

2. **UVR5 is the de facto standard** (23.6k stars). Their custom-trained MDX23C and
   Mel-Band RoFormer models are competitive with or better than Demucs v4. Actively maintained.

3. **python-audio-separator** is the cleanest API for programmatic use. Wraps all UVR models
   as a pip-installable package. MIT licensed. This is the recommended integration point.

4. **ZFTurbo's MSST** is the training framework if you need to train custom models or
   fine-tune on your own data. Supports all major architectures. MIT licensed.

5. **The unofficial BSRNN PyTorch repo has NO LICENSE** — legally "all rights reserved."
   Do not use commercially. The official ByteDance repo is Apache 2.0 but archived.

## Music Transcription Models (Audio → MIDI)

### License & Status Overview

| Project | License | Stars | Status | Commercial? | Notes |
|---------|---------|-------|--------|-------------|-------|
| [Basic Pitch](https://github.com/spotify/basic-pitch) (Spotify) | **Apache 2.0** | 4.7k | ✅ Active | ✅ Yes | Polyphonic pitch detection, WAV → MIDI. Lightweight. |
| [MT3](https://github.com/magenta/mt3) (Google Magenta) | **Apache 2.0** | 1.7k | Maintenance | ✅ Yes | Multi-instrument transcription, ~100 instrument classes. JAX/Flax. |
| [Aria-AMT](https://github.com/EleutherAI/aria-amt) (EleutherAI) | **Apache 2.0** | 64 | ✅ Active | ✅ Yes | Autoregressive piano transcription. Newer, potentially higher quality. |
| [Transkun](https://github.com/Yujia-Yan/Transkun) | — | 294 | Active | Check | Piano transcription with CRF. PyTorch. |
| [YourMT3](https://github.com/mimbres/YourMT3) | — | 201 | Active | Check | Multi-task/multi-track MT3 variant. |

### Key Findings — Transcription

1. **Basic Pitch is the safest bet for commercial.** Apache 2.0 (includes patent grant),
   actively maintained by Spotify, 4.7k stars, lightweight enough to run on CPU.

2. **MT3 is more capable** (multi-instrument, ~100 classes) but uses JAX/Flax which is
   harder to deploy and serve than PyTorch. Research-grade code, not production-ready.

3. **Aria-AMT** is newer and potentially higher quality for piano, but only 64 stars —
   small community, higher risk of abandonment.

## Patent Considerations

- **Apache 2.0 > MIT for commercial use.** Apache 2.0 includes an explicit patent grant
  (Section 3). MIT does not mention patents at all. If there are patents on the underlying
  algorithms (e.g., BSRNN architecture from ByteDance), Apache 2.0 provides legal protection.

- **BSRNN** — the Band-Split RNN architecture originated at ByteDance. Their code is
  Apache 2.0 (patent grant included), but the unofficial reimplementations have no license
  and no patent grant. Using unofficial BSRNN code commercially carries patent risk.

- **Mel-Band RoFormer** — used in UVR/MSST. The architecture paper is from the community,
  and the UVR implementations are MIT licensed. Lower patent risk than BSRNN.

## GPU Acceleration & Serving

These are NOT LLM workloads. Do not use vLLM.

| Serving Framework | CUDA Container? | Batching? | Best For |
|-------------------|----------------|-----------|----------|
| **Triton Inference Server** (NVIDIA) | ✅ Official | ✅ Dynamic batching | Production at scale. Export models to ONNX/TorchScript. |
| **TorchServe** (PyTorch) | ✅ Official | ✅ Batch inference | Simpler than Triton. Good middle ground. |
| **BentoML** | ✅ GPU support | ✅ Adaptive batching | Python-native. Easiest to wrap existing code. Auto-containerization. |
| Raw PyTorch + FastAPI | ✅ Manual | ❌ Manual | Prototyping only. |

### Performance Characteristics

- **Demucs/MDX23C inference** on a 4-minute song: ~5-10 seconds on a decent GPU (RTX 3090).
- **Basic Pitch inference** on a 4-minute song: ~1-2 seconds (lightweight, runs on CPU too).
- The separation step is the bottleneck, not transcription.
- For batch processing (offline), no serving framework needed — just run PyTorch directly.
- For real-time multi-user serving, expect significant GPU costs.

## Recommended Commercial Pipeline

```
Separation:    python-audio-separator (MIT)
               → Uses UVR5 models (MDX23C, Mel-Band RoFormer)
               → pip install audio-separator
               → GPU-accelerated via PyTorch CUDA

Transcription: Basic Pitch (Apache 2.0)
               → pip install basic-pitch
               → Runs on CPU (lightweight) or GPU

Serving:       BentoML or TorchServe for production
               → Triton if you need maximum throughput
```

### Why This Stack

1. **Strongest legal footing** — MIT + Apache 2.0 with patent grant. No archived repos
   (except Demucs which we avoid). No missing licenses.
2. **Active maintenance** — Both projects have active maintainers and recent commits.
3. **Production-ready APIs** — `audio-separator` and `basic-pitch` are pip-installable
   with clean Python APIs. No research-grade code gymnastics.
4. **GPU-accelerated** — Both use PyTorch and work with CUDA out of the box.

## Alternative Approaches Worth Watching

- **Mel-Band RoFormer** — newer architecture showing up in UVR/MSST, potentially surpassing
  MDX23C. Already available through `python-audio-separator`.
- **Hybrid models** — combining separation + transcription in a single end-to-end model.
  No production-ready options exist yet, but active research area.
- **Whisper for lyrics transcription** — if you also need lyrics, OpenAI's Whisper (MIT)
  works well on isolated vocal stems after separation.

## References

- [UVR5 GitHub](https://github.com/Anjok07/ultimatevocalremovergui) — 23.6k ⭐
- [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) — 1k ⭐
- [Basic Pitch](https://github.com/spotify/basic-pitch) — 4.7k ⭐
- [MSST Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) — 1.2k ⭐
- [Demucs v4](https://github.com/facebookresearch/demucs) — 9.7k ⭐ (archived)
- [MT3](https://github.com/magenta/mt3) — 1.7k ⭐
- [Aria-AMT](https://github.com/EleutherAI/aria-amt) — 64 ⭐
- [ByteDance BSRNN](https://github.com/bytedance/music_source_separation) — 1.4k ⭐ (archived)
- [Open-Unmix](https://github.com/sigsep/open-unmix-pytorch) — 1.5k ⭐
- [Papers With Code — Music Source Separation](https://paperswithcode.com/task/music-source-separation)