# OpenH264 WASM — deferred (research & decision)

**Status: DEFERRED (v0.5, W2).** No shippable pre-built OpenH264 WASM artifact
exists that satisfies the ROADMAP P1-6 constraint. This document records the
research, the decision, and the path to un-deferring.

## The constraint (ROADMAP P1-6)

> **OpenH264 仅用 Cisco 官方二进制，禁止重编译** — OpenH264 MUST be the Cisco
> official binary; NO recompilation. Cisco's patent license
> (http://www.openh264.org/BINARY_LICENSE.txt) covers only the binaries Cisco
> itself builds and distributes. A third-party WASM build of OpenH264 is a
> recompilation and is therefore NOT covered — shipping one would expose
> end users to H.264/AVC patent liability that the Cisco license is meant to
> remove.

## Phase-0 candidate research table

| Candidate | License | Size | Cisco-official? | Verdict |
| --- | --- | --- | --- | --- |
| Cisco official binaries (ciscobinary.openh264.org) | BSD-2-Clause + Cisco binary/patent license | n/a (native `.so`/`.dll`/`.dylib` only) | ✅ yes | **No WASM artifact exists.** Only native shared/static libs (android/ios/linux/mac/windows). |
| `@jsquash/openh264` (npm) | — | — | — | **Does not exist on npm** (404; JSQuash ships image codecs only). |
| `@yume-chan/openh264` (npm) | — | — | — | **Does not exist on npm** (404; yume-chan ships libde265 only for video). |
| Niap/openh264.wasm (GitHub) | — | ~1 MB wasm | ❌ third-party emscripten build | **Rejected.** Not a Cisco build → no patent license coverage; unmaintained. |
| ttyridal/openh264-js (GitHub) | — | — | ❌ third-party emscripten build | **Rejected.** Same patent reason; demo from 2015. |
| gliese1337/h264decoder (npm, from TinyH264Decoder) | ISC | ~? wasm (base64-inlined) | ❌ third-party (h264bsd fork) | **Rejected.** Not OpenH264 at all; h264bsd lineage, baseline-only. |
| cisco/openh264 PR #3577 "add wasm build support" | BSD-2-Clause (source) | buildable (~1–2 MB wasm, projection) | ❌ **source-only; never merged/released as an official binary** | **Rejected for now.** Requires emscripten toolchain to build (none on this machine); even if built locally it would be a *non-Cisco* build → patent gap. |

## Why deferral (not "ship another artifact")

The one hard blocker is the **Cisco-official-binary requirement**. Every
existing WASM OpenH264 is a third-party recompilation, and Cisco does not
publish a WASM build. There is no way to ship H.264 soft-decode via OpenH264
under the ROADMAP constraint without either:

1. Cisco publishing an official `openh264.wasm` (+ JS glue) at
   ciscobinary.openh264.org, or
2. A permissive-licensed, patent-clean alternative H.264 decoder that is
   already a Cisco build — none exists.

WebCodecs H.264 covers Chrome/Edge/Firefox-desktop/Safari-modern. The only
gap the soft path would fill is Firefox Android / old Safari — a niche that
does not justify violating the patent boundary.

## Size projection (if un-deferred)

- OpenH264 decoder core alone (`libopenh264` with `ENABLE_ENCODER=0`),
  compiled with emscripten, is projected at **~0.8–1.2 MB wasm** (uncompressed)
  — at/over the ≤1 MB gzipped budget. A no-SIMD generic build would be larger;
  a WASM-SIMD build is ~1 MB. Would need lazy load + careful compression.
- The decoder must be fed **Annex-B**; vigilkit demuxers emit AVCC
  length-prefixed H.264 → conversion via `@vigilkit/media-utils`
  `naluToAnnexB` on `isLengthPrefixed` chunks (same seam as HEVC).
- Output is YUV420 → reuse the I420 → `VideoFrame` planar + canvas fallback
  pattern from `@vigilkit/plugin-dav1d-wasm` / `hevc-soft-decoder.ts`.

## Build instructions (for a future iteration, only if Cisco still won't ship)

```sh
# NOT Cisco-official → not shippable under P1-6. Documented for completeness.
git clone --depth 1 -b v2.6.0 https://github.com/cisco/openh264.git
cd openh264
emmake make ARCH=wasm OS=wasm EMFS=nodefs   # PR #3577 build flags
# produces h264dec.js / h264dec.wasm (decode-only build requires editing makefile)
```

## Un-defer trigger

- Cisco publishes an official WASM build (watch ciscobinary.openh264.org /
  cisco/openh264 releases), **or**
- ROADMAP P1-6 is amended to permit a specific third-party WASM build whose
  author has obtained H.264 patent coverage (e.g. a Mozilla/Google-hosted
  artifact) — unlikely and out of scope for vigilkit.
