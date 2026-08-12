# HEVC Test Fixture

FFmpeg FATE HEVC Annex-B elementary stream, sha256-pinned, used by the vigilkit HEVC soft-decode tests.

- Source: https://fate-suite.ffmpeg.org/hevc/paired_fields.hevc (primary landed)
- File: `paired_fields.hevc` (591931 bytes, Annex-B start code 00 00 00 01)
- SHA-256: 094418f329076bae05a2905ed6126ce7fe303e7656c8e317b934ec08f3ef14be
- Fallback (not used): https://fate-suite.ffmpeg.org/hevc/food.hevc

Purpose: deterministic HEVC stream for exercising the vendored libde265 WASM decoder in unit tests and e2e QA.

License note: FFmpeg FATE sample stream — used for testing only; an openly distributed test asset.
