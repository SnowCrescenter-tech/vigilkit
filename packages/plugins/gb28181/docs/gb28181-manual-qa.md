# GB28181（国标）manual QA — real-platform verification

This document covers the **manual QA** that requires a real GB/T 28181 platform
(国标平台 / 摄像头 / IPC). CI runs only the parsers and the session state
machine (`sip.test.ts`, `sdp.test.ts`, `digest.test.ts`, `session.test.ts` and
the `@vigilkit/plugin-ps` demuxer suite) — everything in this document must be
executed against real hardware/network and is not automated.

## Scope

| Layer | CI-covered | Manual QA |
| --- | --- | --- |
| SIP message parser/serializer (RFC 3261) | ✅ | — |
| SDP builder/parser (RFC 4566) | ✅ | — |
| Digest auth (RFC 7616 → SIP Authorization) | ✅ | — |
| `Gb28181Session` state machine | ✅ | — |
| PS demuxer (ISO/IEC 13818-1, Annex-B H.264/HEVC) | ✅ (crafted + fuzz) | — |
| Real SIP transport (WS / TCP / UDP) to a platform | ❌ | **here** |
| REGISTER with platform digest + keepalive | ❌ | **here** |
| INVITE, receive RTP, feed PS → decode | ❌ | **here** (RTP receive is the follow-on) |

## Prerequisites

- A GB/T 28181-2016 platform (e.g. a 国标 server such as wvp-pro-style
  platforms, or a GB28181-enabled NVR/IPC) with:
  - SIP server address + port (default 5060),
  - a device ID (20-digit, e.g. `34020000001320000001`),
  - digest username/password,
  - the camera's GB28181 channel registered to the platform.
- Node.js 20+, and the built packages:
  ```sh
  pnpm --filter @vigilkit/plugin-gb28181 build
  pnpm --filter @vigilkit/plugin-ps build
  ```

## 1. REGISTER with digest auth

The platform challenges REGISTER with `401 Unauthorized` and a
`WWW-Authenticate: Digest ...` header. The flow is exactly what
`session.test.ts` exercises in-process:

```ts
import { Gb28181Session } from '@vigilkit/plugin-gb28181';

const session = new Gb28181Session({
  server: '192.168.1.10:5060',
  deviceId: '34020000001320000001',
  username: '34020000001320000001',
  password: 'your-platform-password',
  localIp: '192.168.1.20',   // must be reachable from the platform
  transport: 'ws',           // or 'udp' / 'tcp' — see your platform
  ssrc: 1000000001,
});

// Transport: SIP-over-WebSocket, SIP-over-TCP or SIP-over-UDP. The session is
// transport-agnostic; wire it to your chosen socket and feed responses back:
//   ws.onmessage = (e) => session.handleResponse(e.data)
//   ws.send(serializeSipMessage(msg))

// 1) Initial REGISTER (no Authorization header).
ws.send(serializeSipMessage(session.register()));
// 2) On the 401, retry with the digest challenge the session captured.
//    (session.challenge is set after handleResponse consumed the 401)
ws.send(serializeSipMessage(session.register(session.challenge!)));
// 3) Expect 200 OK → session.isRegistered === true.
```

**QA checklist**
- [ ] First REGISTER is challenged with 401 + Digest (realm/nonce).
- [ ] Retried REGISTER carries a valid `Authorization: Digest ...` and is
      answered `200 OK`.
- [ ] Wrong password → 401 again (platform logs show digest failure); fix
      credentials, re-create the session (Call-ID must be fresh).
- [ ] GB/T 28181 keepalive (`MESSAGE` with `<?xml...><Keepalive>` payload) is
      **not implemented** in this package — real platforms drop the device
      registration after 3 missed keepalives. This is a documented follow-on.

## 2. INVITE (PS payload) and the SDP answer

```ts
// 4) INVITE with the SDP offer (PS payload 96, H.265 98, SSRC in a=ssrc + y=).
ws.send(serializeSipMessage(session.invite()));

// 5) On 200 OK: the session parsed the answer — RTP connection info:
const media = session.mediaInfo; // { ip, port, ssrc?, payloadTypes, rtpmap }
```

**QA checklist**
- [ ] 200 OK contains an SDP answer with `m=video <port> RTP/AVP 96` and
      `a=rtpmap:96 PS/90000` (or the platform's own PS payload type).
- [ ] `session.mediaInfo.ip/port` match the platform's advertised RTP target.
- [ ] `session.mediaInfo.ssrc` is present (from `a=ssrc:` or the `y=` header).
- [ ] A `486 Busy Here` / `404` moves the session to `ERROR` and
      `session.lastError` is set.
- [ ] BYE: `session.bye()` → send → 200 OK → `session.currentState === 'TERMINATED'`.

## 3. RTP → PS demuxer → decode (follow-on, not yet implemented)

RTP receive is **not implemented** in this package. The intended pipeline,
once the RTP-over-WebSocket/HTTP relay is added:

```
platform --RTP/PS--> relay/ws-gateway --PS bytes--> PsSource(ws) --> PsDemuxer
  --> sequence-header (avcC/hvcC) + video chunks --> WebCodecs decode
```

Meanwhile, an HTTP PS stream can already be played end-to-end in a browser:

```ts
import { createPlayer } from 'vigilkit';
import { psSourcePlugin } from '@vigilkit/plugin-ps';
import { createRenderer } from '@vigilkit/renderer';

const player = createPlayer({
  url: 'https://your-relay/live/channel1.ps', // any server serving raw PS
  demuxer: 'ps',
  plugins: [psSourcePlugin()],
  renderer: createRenderer(canvas),
});
player.play();
```

**QA checklist (HTTP PS relay)**
- [ ] Pack headers parse (MPEG-2; older encoders may emit MPEG-1 — both are
      detected; `demuxer.mpegVersion` reports which).
- [ ] First keyframe emits `sequence-header` (avcC or hvcC) before any video
      chunk; video chunks are AVCC-framed (length-prefixed) matching the
      config `description`.
- [ ] Audio (G.711 A/μ-law, G.726 or AAC-over-ADTS) emits raw audio chunks;
      AAC additionally emits one `audio-config`.
- [ ] Timestamps stay monotonic across PTS rollbacks and the 2^33 wrap.
- [ ] Truncated/garbage segments surface as `error` events and the demuxer
      resyncs instead of stalling.

**QA checklist (RTP follow-on — when implemented)**
- [ ] REGISTER + INVITE against the real platform, SSRC echoed back.
- [ ] RTP packets reassembled (sequence/PT handling), PS payloads extracted
      and fed to `PsDemuxer` with zero dropped start codes.
- [ ] `PLAYING` → BYE → platform stops RTP.

## Expected manual evidence

Record per test: platform model/SDK version, transport (ws/tcp/udp), the
INVITE/200-OK/401 transcript, `mediaInfo`, and for the PS path the first
`sequence-header` codec + decoded frame count. Note any platform quirks
(e.g. non-standard `a=rtpmap` names, missing `y=` header, MPEG-1 pack
headers) so the demuxer can be hardened against them.
