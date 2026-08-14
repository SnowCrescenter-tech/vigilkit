# Dahua Plugin — Manual QA Procedure

> **Status**: manual QA checklist. The Dahua plugin cannot be exercised by CI
> because it needs a physical device on the local network; there is no committed
> camera fixture and no public test camera (the project deliberately avoids a
> public demo of other people's cameras — see [CONTRIBUTING.md](../CONTRIBUTING.md)
> and the zero-telemetry policy in the README).
>
> Unit coverage lives in `packages/plugins/dahua/src/*.test.ts` (49 tests):
> MD5 against RFC 1321 vectors + a platform oracle, digest auth against RFC 7616
> reference vectors, the tolerant CGI XML parser, the RTSP / RTSP-over-WebSocket /
> snapshot / MJPEG URL builders, PTZ CGI path builders, and the device client's
> digest handshake against an injected `fetch`. What the unit suite *cannot*
> prove is a real digest handshake against firmware, so a human runs this list
> once per release against a real Dahua camera/NVR.

---

## 0. Scope

The plugin (`@vigilkit/plugin-dahua`) implements, from the public Dahua HTTP
CGI protocol documentation (see `docs/vendor-sdk-research.md` §2):

1. **HTTP Digest authentication** (RFC 7616, MD5) — the auth every `cgi-bin` call needs.
2. **Device info** — `GET /cgi-bin/magicBox.cgi?action=getSystemInfo` (name / model / serial / firmware).
3. **Channel enumeration** — `GET /cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle`.
4. **PTZ control** — `GET /cgi-bin/ptz.cgi?action=start|stop&code=…` (directional + zoom).
5. **Stream URL building** — RTSP (`rtsp://…/cam/realmonitor?channel=N&subtype=S`),
   the unique RTSP-over-WebSocket bridge (`ws://…/rtspoverwebsocket`), CGI
   snapshot (`/cgi-bin/snapshot.cgi`) and MJPEG (`/cgi-bin/mjpg/video.cgi`) URLs.

Out of scope: audio, motion/event handling, the Dahua private P2P (DHIP/RPC2)
binary protocol, and anything needing the closed Dahua NetSDK (all prohibited by
the license boundary).

## 1. Prerequisites

- One Dahua camera or NVR with the HTTP CGI API enabled (default on the LAN-facing
  HTTP interface; the modern web UI may need "integration" options left on).
- The device reachable over HTTP (default port 80) from the test machine. Same subnet.
- A known admin username/password.
- Node.js 20+ (to run the ad-hoc scripts below).
- Optional: `ffprobe`/`ffplay` (any standard build) for the RTSP playback check.

Record these before you start:

| Item | Value |
| --- | --- |
| Model | e.g. `IPC-HFW1230S` |
| Firmware | e.g. `2.800.0000000.0` |
| IP / port | e.g. `192.168.1.108:80` |
| Username | `admin` |
| Channel count | e.g. `1` (IPC) or `N` (NVR) |
| PTZ capable? | yes / no |

## 2. Digest auth handshake (the critical path)

Every CGI call follows: first request is unauthenticated → server answers
`401` with `WWW-Authenticate: Digest …` → client answers with the computed
`Authorization` header. Verify this once manually:

```sh
# 1) Challenge probe — expect 401 + a Digest header
curl -si http://<IP>/cgi-bin/magicBox.cgi?action=getSystemInfo | grep -iE '^(HTTP|WWW-Authenticate)'
#    HTTP/1.1 401 Unauthorized
#    WWW-Authenticate: Digest qop="auth", realm="Login to <serial>", nonce="…", …
```

- [ ] Response is `401 Unauthorized`, **not** `200` (digest enabled) and **not** `Basic` only.
- [ ] `WWW-Authenticate` starts with `Digest` and carries a `nonce` and `realm`.

If the device is configured for **Basic** auth instead of Digest, the plugin's
`request()` will throw `DahuaError('AUTH', …)`. Re-enable digest or note the
device is out of scope.

## 3. Run the end-to-end smoke script

From the repo root, with the package built:

```sh
pnpm --filter @vigilkit/plugin-dahua build
node - <<'EOF'
import { DahuaDevice } from '@vigilkit/plugin-dahua';

const cam = new DahuaDevice({ host: '192.168.1.108', password: '<password>' });

// 3.1 System info
const info = await cam.getSystemInfo();
console.log('info:', info);
// expect: deviceName / model / serialNumber / firmwareVersion populated

// 3.2 Channels
const channels = await cam.listChannels();
console.log('channels:', channels);
// expect: at least one { id: '1', name: …, enabled: true }

// 3.3 Stream URLs
console.log('rtsp:', cam.buildRtspUrl(1));            // rtsp://admin:***@…:554/cam/realmonitor?channel=1&subtype=0
console.log('rtsp-sub:', cam.buildRtspUrl(1, 1));     // …&subtype=1
console.log('ws:', cam.buildRtspOverWebSocketUrl());  // ws://…/rtspoverwebsocket
console.log('snap:', cam.buildSnapshotUrl(1));        // http://…/cgi-bin/snapshot.cgi?channel=1
EOF
```

### 3.1 — System info

- [ ] `model` matches the device sticker / web UI.
- [ ] `serialNumber` matches the web UI **System → Device Information**.
- [ ] `firmwareVersion` matches the web UI version string.

### 3.2 — Channel enumeration

- [ ] Channel count matches the physical inputs.
- [ ] `id` is 1-based and matches the web UI channel numbers; `name` is populated.

### 3.3 — Stream URLs

- [ ] RTSP URL matches the documented `rtsp://<user>:<pass>@<ip>:554/cam/realmonitor?channel=<ch>&subtype=<0|1|2>` shape.
- [ ] `buildRtspOverWebSocketUrl()` yields `ws://<ip>/rtspoverwebsocket`.

## 4. Playback (proves the URL is actually consumable)

The plugin produces URLs; it does **not** decode. Prove the RTSP URL with an
external player on the same machine (both are standard, non-commercial tools):

```sh
# ffprobe (or ffplay) the main stream — expect an h264 stream to enumerate
ffprobe -v error -rtsp_transport tcp -i "rtsp://admin:<password>@<IP>:554/cam/realmonitor?channel=1&subtype=0" \
  -show_streams -select_streams v:0 | grep -E 'codec_name|width|height'
```

- [ ] `codec_name=h264` (or `hevc`) and sane `width`/`height`.
- [ ] (Optional) `ffplay -rtsp_transport tcp <url>` shows live video.
- [ ] (Optional) `curl -s -u admin:<password> --digest http://<IP>/cgi-bin/snapshot.cgi?channel=1 -o snap.jpg`
      then open `snap.jpg` — a current JPEG frame.
- [ ] (Optional) MJPEG: `ffplay http://<IP>/cgi-bin/mjpg/video.cgi?channel=1&subtype=1` — live MJPEG.

> The plain RTSP URL is meant to feed a server-side relay (MediaMTX / go2rtc)
> that a vigilkit `ws`/`flv`/`hls` plugin then consumes in the browser. The
> **browser-native** path is RTSP-over-WebSocket (see §5).

## 5. RTSP-over-WebSocket (unique Dahua browser path)

Dahua's `/rtspoverwebsocket` is a WebSocket endpoint that carries RTSP *inside*
the socket — a browser page can consume RTSP directly, with no relay server.
The plugin only builds the (static) WS URL; consuming the inner RTSP stream
requires a WebSocket client that speaks the bridge protocol (the camera expects
the inner `rtsp://…/cam/realmonitor?channel=…&subtype=…` URL in the client's
opening message, then streams RTSP/RTP over the socket).

- [ ] The URL `ws://<IP>/rtspoverwebsocket` connects (e.g. a browser `WebSocket`
      to the URL completes the handshake; a plain `ws` client that sends the
      inner RTSP URL as its first message receives RTSP/RTP bytes back).
- [ ] This is the documented behavior of newer firmware (reference PoCs:
      TeamDotworld/dahua-rtsp-web, stalniy/dahua-rtspoverws — both MIT; see
      `docs/vendor-sdk-research.md` §2.2). If the handshake fails, record the
      firmware version — some old firmware omits the bridge.

> **CI cannot test this**: the framing behavior needs real firmware (the
> research doc's mock-WS-server idea covers only the transport shape, not the
> camera's actual bridge semantics).

## 6. PTZ (only if the device supports it)

```sh
node - <<'EOF'
import { DahuaDevice, directionToCode } from '@vigilkit/plugin-dahua';
const cam = new DahuaDevice({ host: '<IP>', password: '<password>' });

await cam.ptzStart(1, 'right');            // camera pans right (action=start, code=Right)
await new Promise(r => setTimeout(r, 1500));
await cam.ptzStop(1, directionToCode('right')); // stops (action=stop, code=Right)
await cam.ptzStart(1, 'in');               // zooms in (code=ZoomTele)
await new Promise(r => setTimeout(r, 1500));
await cam.ptzStop(1, 'ZoomTele');
EOF
```

- [ ] Camera physically moves on `ptzStart`, keeps moving until `ptzStop`.
- [ ] `ptzStart(1, 'in')` / `ptzStart(1, 'out')` change the zoom (tele/wide).
- [ ] Diagonal directions (`upLeft` → `LeftUp`, etc.) move diagonally.

> **Known protocol fact**: the Dahua CGI has no pan/tilt "stop" code — motion
> continues until `action=stop` with the moving direction's code, which is why
> `directionToCode('stop')` and `zoomToCode('stop')` throw `DahuaError`
> (`'INVALID_ARGUMENT'`) instead of guessing.

## 7. Negative / boundary checks

- [ ] Wrong password → `getSystemInfo()` rejects with `DahuaError` code `'HTTP'`
      (a `401` after the digest retry) — not a hang, not an uncaught exception.
- [ ] Unreachable IP → rejects with a network error (fetch rejects), no hang.
- [ ] Invalid channel (`buildRtspUrl(0)`, `ptzStart(0, 'up')`) → `DahuaError` code
      `'INVALID_ARGUMENT'`.
- [ ] Invalid subtype (`buildRtspUrl(1, 3)`) → `DahuaError` code `'INVALID_ARGUMENT'`.
- [ ] `rtspUrl` percent-encodes special characters in credentials (`a@d min` / `p:ass`).

## 8. Sign-off

| Field | Value |
| --- | --- |
| Tester | |
| Date | |
| Device model / firmware | |
| Channel count verified | |
| Digest handshake | pass / fail |
| System info / channels | pass / fail |
| RTSP playback | pass / fail |
| RTSP-over-WebSocket | pass / fail / n/a (firmware support) |
| PTZ (if applicable) | pass / fail / n/a |
| Negative checks | pass / fail |

Any failure: file an issue with the device model + firmware and the exact
`WWW-Authenticate` / XML response (redact the password and nonce).
