# HLS Test Fixtures

FFmpeg FATE MPEG-TS stream, sha256-pinned, used by the vigilkit HLS transport/demuxer tests.

- Source: https://fate-suite.ffmpeg.org/mpegts/h264small.ts
- File: `seg-0.ts` (16544 bytes, H.264 + AAC MPEG-TS, TS sync byte 0x47 at every 188-byte packet)
- SHA-256: 5e999d972e3d53e5780851933dd0a8428697e14a4d6ba83034960b82e39a920c
- Playlists:
  - `index.m3u8` — VOD media playlist, 10 segments of `seg-0.ts` (TARGETDURATION 2.0s)
  - `master.m3u8` — variant playlist with two renditions of `index.m3u8`

Purpose: deterministic local HLS fixture for e2e browser QA and plugin unit tests, without depending on a network HLS server.

License note: FFmpeg FATE sample stream — used for testing only; an openly distributed test asset.
