# Uniview Plugin — Manual QA Procedure

> **Status**: manual QA checklist. The Uniview plugin cannot be exercised by CI
> because it needs a physical device on the local network; there is no committed
> camera fixture and no public test camera (the project deliberately avoids a
> public demo of other people's cameras — see [CONTRIBUTING.md](../CONTRIBUTING.md)
> and the zero-telemetry policy in the README).
>
> Unit coverage lives in `packages/plugins/uniview/src/*.test.ts` (62 tests):
> MD5 against RFC 1321 vectors + a platform oracle, digest auth against RFC 7616
> reference vectors, the tolerant JSON response helpers, the RTSP (IPC + NVR) /
> snapshot / MJPEG URL builders, the PTZ path/body builders, and the device
> client's digest handshake against an injected `fetch`. What the unit suite
> *cannot* prove is a real digest handshake against firmware, so a human runs
> this list once per release against a real Uniview camera/NVR.

---

## 0. Scope

The plugin (`@vigilkit/plugin-uniview`) implements, from the public LightAPI
protocol documentation (see `docs/vendor-sdk-research.md` §3):

1. **HTTP Digest authentication** (RFC 7616, MD5) — the auth every `/LAPI/V1.0` call needs.
2. **Device info** — `GET /LAPI/V1.0/System/DeviceInfo` (name / model / serial / firmware, JSON).
3. **Channel enumeration** — `GET /LAPI/V1.0/Channels` (JSON array of `{Id, Name, Enable}`).
4. **PTZ control** — `PUT /LAPI/V1.0/Channels/<id>/PTZCtrl/Continuous` with a JSON
   pan/tilt/zoom velocity body (motion continues until an all-zero `stop` body).
5. **Stream URL building** — RTSP IPC (`rtsp://…/media/video1|2|3`), RTSP NVR
   (`rtsp://…/unicast/c<N>/s<0|1>/live`), MJPEG (`/video/mjpeg/stream1..3`) and
   snapshot (`/images/snapshot.jpg`) URLs.

Out of scope: audio, motion/event handling, the Uniview private P2P protocol,
the closed UNV Network Device SDK, and the unlicensed third-party LAPI research
toolkits (all prohibited by the license boundary — reference-only).

## 1. Prerequisites

- One Uniview (UNV) camera or NVR with the LightAPI HTTP interface reachable
  (the modern web UI usually leaves `/LAPI/V1.0` enabled; if the "integration"
  options are off, re-enable them).
- The device reachable over HTTP (default port 80) from the test machine. Same subnet.
- A known admin username/password.
- Node.js 20+ (to run the ad-hoc scripts below).
- Optional: `ffprobe`/`ffplay` (any standard build) for the RTSP/MJPEG checks.

Record these before you start:

| Item | Value |
| --- | --- |
| Model | e.g. `IPC3616SR3-DUF` |
| Firmware | e.g. `V1.0.0 build 2024-01-15` |
| IP / port | e.g. `192.168.1.108:80` |
| Username | `admin` |
| Channel count | e.g. `1` (IPC) or `N` (NVR) |
| PTZ capable? | yes / no |
| Device form | IPC or NVR (selects the RTSP template) |

## 2. Digest auth handshake (the critical path)

Every LightAPI call follows: first request is unauthenticated → server answers
`401` with `WWW-Authenticate: Digest …` → client answers with the computed
`Authorization` header. Verify this once manually:

```sh
# 1) Challenge probe — expect 401 + a Digest header
curl -si http://<IP>/LAPI/V1.0/System/DeviceInfo | grep -iE '^(HTTP|WWW-Authenticate)'
#    HTTP/1.1 401 Unauthorized
#    WWW-Authenticate: Digest qop="auth", realm="Login to <serial>", nonce="…", …
```

- [ ] Response is `401 Unauthorized`, **not** `200` (digest enabled) and **not** `Basic` only.
- [ ] `WWW-Authenticate` starts with `Digest` and carries a `nonce` and `realm`.

If the device is configured for **Basic** auth instead of Digest, the plugin's
`request()` will throw `UniviewError('AUTH', …)`. Re-enable digest or note the
device is out of scope.

## 3. Run the end-to-end smoke script

From the repo root, with the package built:

```sh
pnpm --filter @vigilkit/plugin-uniview build
node - <<'EOF'
import { UniviewDevice } from '@vigilkit/plugin-uniview';

const cam = new UniviewDevice({ host: '192.168.1.108', password: '<password>' });

// 3.1 Device info
const info = await cam.getDeviceInfo();
console.log('info:', info);
// expect: deviceName / model / serialNumber / firmwareVersion populated

// 3.2 Channels
const channels = await cam.listChannels();
console.log('channels:', channels);
// expect: at least one { id: '1', name: …, enabled: true|false }

// 3.3 Stream URLs
console.log('rtsp-ipc:', cam.buildRtspUrl(1));                 // rtsp://admin:***@…:554/media/video1
console.log('rtsp-nvr:', cam.buildRtspUrl(1, 'main', { nvr: true })); // …/unicast/c1/s0/live
console.log('mjpeg:', cam.buildMjpegUrl(1));                   // http://…/video/mjpeg/stream1
console.log('snap:', cam.buildSnapshotUrl());                  // http://…/images/snapshot.jpg
EOF
```

### 3.1 — Device info

- [ ] `model` matches the device sticker / web UI.
- [ ] `serialNumber` matches the web UI **System → Device Information**.
- [ ] `firmwareVersion` matches the web UI version string.

### 3.2 — Channel enumeration

- [ ] Channel count matches the physical inputs.
- [ ] `id` matches the web UI channel numbers; `name` is populated; `enabled`
      reflects the channel enable state when the firmware reports it.

### 3.3 — Stream URLs

- [ ] IPC device: RTSP URL matches `rtsp://<user>:<pass>@<ip>:554/media/video1`
      (sub = `video2`, third = `video3`).
- [ ] NVR device: URL matches `rtsp://<user>:<pass>@<ip>:554/unicast/c<ch>/s<0|1>/live`.
- [ ] `buildSnapshotUrl()` yields `http://<ip>/images/snapshot.jpg`.

## 4. Playback (proves the URL is actually consumable)

The plugin produces URLs; it does **not** decode. Prove the RTSP URL with an
external player on the same machine (both are standard, non-commercial tools):

```sh
# ffprobe (or ffplay) the main stream — expect an h264 stream to enumerate
ffprobe -v error -rtsp_transport tcp -i "rtsp://admin:<password>@<IP>:554/media/video1" \
  -show_streams -select_streams v:0 | grep -E 'codec_name|width|height'
# NVR form:
ffprobe -v error -rtsp_transport tcp -i "rtsp://admin:<password>@<IP>:554/unicast/c1/s0/live" \
  -show_streams -select_streams v:0 | grep -E 'codec_name|width|height'
```

- [ ] `codec_name=h264` (or `hevc`) and sane `width`/`height`.
- [ ] (Optional) `ffplay -rtsp_transport tcp <url>` shows live video.

> The RTSP URL is meant to feed a server-side relay (MediaMTX / go2rtc) that a
> vigilkit `ws`/`flv`/`hls` plugin then consumes in the browser. Uniview has no
> native RTSP-over-WebSocket bridge (unlike Dahua) — see §5 for the
> browser-friendly MJPEG path.

## 5. MJPEG / snapshot (browser-native check)

MJPEG is the most reliable browser-native live view for Uniview (HTTP multipart
under digest/basic auth, no plugin needed):

```sh
# 5.1 Snapshot — expect a current JPEG frame
curl -s -u admin:<password> --digest http://<IP>/images/snapshot.jpg -o snap.jpg
file snap.jpg   # JPEG image data …

# 5.2 MJPEG — expect live motion-JPEG
ffplay -rtsp_transport tcp "http://admin:<password>@<IP>/video/mjpeg/stream1"
```

- [ ] `snap.jpg` opens and shows a current frame.
- [ ] MJPEG stream plays live (stream index 2/3 when the camera exposes them).
- [ ] The same URLs load in a browser (digest prompt) or through a CORS proxy.

> **CI cannot test this**: the exact digest + multipart behavior needs real
> firmware (the research doc's mock-server idea covers only the transport shape).

## 6. PTZ (only if the device supports it)

LightAPI PTZ is a `PUT` of a velocity JSON body to the continuous-control path;
motion continues until an all-zero `stop` body is PUT to the same path:

```sh
node - <<'EOF'
import { UniviewDevice } from '@vigilkit/plugin-uniview';
const cam = new UniviewDevice({ host: '<IP>', password: '<password>' });

await cam.ptzMove(1, 'right');               // pans right ({"PTZ":{"Pan":1,"Tilt":0,"Zoom":0}})
await new Promise(r => setTimeout(r, 1500));
await cam.ptzStop(1);                        // stops (all zeros)
await cam.ptzMove(1, 'in');                  // zooms in
await new Promise(r => setTimeout(r, 1500));
await cam.ptzStop(1);
EOF
```

- [ ] Camera physically moves on `ptzMove`, keeps moving until `ptzStop`.
- [ ] `ptzMove(1, 'in')` / `ptzMove(1, 'out')` change the zoom (tele/wide).
- [ ] Diagonal directions (`upLeft`, `upRight`, …) move diagonally.

> **Known protocol fact**: LightAPI continuous PTZ uses a velocity body, so
> `ptzStop` PUTs an all-zero body (no separate stop action exists). If a
> firmware revision expects lowercase `pan/tilt/zoom` field names instead of
> the documented PascalCase `Pan/Tilt/Zoom`, only `ptzBody` in `src/ptz.ts`
> needs to change — record the working firmware version in the issue.

## 7. Negative / boundary checks

- [ ] Wrong password → `getDeviceInfo()` rejects with `UniviewError` code `'HTTP'`
      (a `401` after the digest retry) — not a hang, not an uncaught exception.
- [ ] Unreachable IP → rejects with a network error (fetch rejects), no hang.
- [ ] Invalid channel (`buildRtspUrl(0)`, `ptzMove(0, 'up')`) → `UniviewError` code
      `'INVALID_ARGUMENT'`.
- [ ] Invalid stream (`buildRtspUrl(1, 'third')` on an NVR, `buildMjpegUrl(4)`)
      → `UniviewError` code `'INVALID_ARGUMENT'`.
- [ ] `rtspUrl` percent-encodes special characters in credentials (`a@d min` / `p:ass`).
- [ ] Malformed LightAPI JSON → `UniviewError` code `'PARSE'`.

## 8. Sign-off

| Field | Value |
| --- | --- |
| Tester | |
| Date | |
| Device model / firmware | |
| Channel count verified | |
| Digest handshake | pass / fail |
| System info / channels | pass / fail |
| RTSP playback (IPC and/or NVR form) | pass / fail / n/a (device form) |
| MJPEG / snapshot | pass / fail |
| PTZ (if applicable) | pass / fail / n/a |
| Negative checks | pass / fail |

Any failure: file an issue with the device model + firmware and the exact
`WWW-Authenticate` / JSON response (redact the password and nonce).
