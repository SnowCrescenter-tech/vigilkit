# G.726 — DEFERRED

> **Status**: DEFERRED. The G.726 (ITU-T G.726, 40/32/24/16 kbit/s ADPCM) codec
> is **not** shipped in this package. See the reasoning below. This document
> follows the same pattern as `packages/plugins/openh264-wasm/DEFERRED.md`.

## What is deferred

`G726Encoder` / `G726Decoder` — adaptive differential PCM at 40/32/24/16
kbit/s (5/4/3/2 bits per sample), the ITU-T G.726 standard used by some
surveillance platforms (GB28181/RTSP relay streams).

## Why

A from-scratch TypeScript implementation was attempted. The G.72x predictor /
quantizer / step-size adaptation is a tightly-coupled fixed-point algorithm
whose correctness depends on the exact ITU-T reference tables and update
equations. A first implementation passed structural tests (no crashes,
chunked decode identical to whole-stream decode) but failed the decisive
signal-fidelity test: RMS round-trip error on a 1 kHz sine was ~33 000 LSB
(i.e. the output was noise, not the input) — the quantizer code mapping and
step-size adaptation were wrong. Shipping a codec that produces noise would
be worse than not shipping one.

Fixing it requires porting the reference algorithm **with an authoritative
oracle**: the ITU-T G.726 reference implementation (or the well-known
`g726.c` lineage) as a test vector generator, plus the official ITU-T test
vectors if available. No such oracle is vendored in this repo, and none could
be fetched reliably in the environment where this decision was made.

## Why it matters less than it seems

- **G.711 (μ-law / A-law) is the primary surveillance audio codec** and IS
  shipped, byte-exact against the CCITT reference (encode + decode verified
  over the full 16-bit range against Python `audioop`, which copies the CCITT
  tables). GB28181/RTSP-relay cameras overwhelmingly use G.711A.
- G.726 appears in a minority of deployments. Until a verified G.726 lands,
  such streams can be handled by decoding server-side (MediaMTX/FFmpeg relay
  to G.711 or AAC), which is already the documented architecture boundary for
  non-browser-native codecs.

## Unblocking criteria

1. Vendor an oracle: add the ITU-T G.726 reference implementation (or a
   verified port such as the public-domain `g726.c` lineage) under
   `test/oracle/` and generate golden vectors.
2. Reimplement `g726.ts` from the reference equations (tables: qtab, dqlntab,
   witab, fitab per rate; step-size adaptation; pole/zero predictor with the
   correct truncation limits).
3. Gate on: (a) sine round-trip RMS < the ITU-T SNR expectation for that rate,
   (b) silence stays silent, (c) official ITU-T test vectors match if
   available, (d) deterministic PRNG fuzz never throws.

## Package scope today

`@vigilkit/media-audio-codecs` ships:

- `g711.ts` — G.711 μ-law / A-law encode + decode (byte-exact CCITT)
- `pcm.ts` — 16-bit little-endian PCM passthrough

No G.726 symbols are exported. Do not import `g726` from this package.
