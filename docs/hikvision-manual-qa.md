# Hikvision Plugin — Manual QA Procedure

> **Status**: manual QA checklist. The Hikvision plugin cannot be exercised by CI
> because it needs a physical device on the local network; there is no committed
> camera fixture and no public test camera (the project deliberately avoids a
> public demo of other people's cameras — see [CONTRIBUTING.md](../CONTRIBUTING.md)
> and the zero-telemetry policy in the README).
>
> Unit coverage lives in `packages/plugins/hikvision/src/*.test.ts` (43 tests):
> MD5 against RFC 1321 vectors + a platform oracle, digest auth against RFC 7616
> reference vectors, the ISAPI XML parser, URL builders, PTZ command serialization,
> and the device client's digest handshake against an injected `fetch`. What the
> unit suite *cannot* prove is a real ISAPI handshake, so a human runs this list
> once per release against a real camera/NVR.

---

## 0. Scope

The plugin (`@vigilkit/plugin-hikvision`) implements, from the public ISAPI
protocol documentation (see `docs/vendor-sdk-research.md`):

1. **HTTP Digest authentication** (RFC 7616, MD5) — the auth every ISAPI call needs.
2. **Device discovery** — `GET /ISAPI/System/deviceInfo` (model / serial / firmware / MAC).
3. **Channel enumeration** — `GET /ISAPI/System/Video/inputs/channels`.
4. **PTZ control** — `PUT /ISAPI/PTZCtrl/channels/{id}/continuous` (move / zoom / stop) and preset-goto.
5. **Stream URL building** — RTSP (`rtsp://…/Streaming/Channels/101`) and ISAPI HTTP preview / snapshot URLs.

Out of scope: audio, motion/event handling, and anything needing the closed
Device Network SDK or the H5player WASM (both prohibited by the license boundary).

## 1. Prerequisites

- One Hikvision camera or NVR with ISAPI enabled (default: enabled on the LAN-facing
  HTTP interface; check **Configuration → Network → Advanced Settings → Integration
  Protocol** to confirm "Enable ISAPI" is on).
- The camera reachable over HTTP (default port 80) from the test machine. Same subnet.
- A known admin username/password. (Fresh devices ship `admin` + an activation-set password.)
- Node.js 20+ (to run the ad-hoc script in §5).

Record these before you start:

| Item | Value |
| --- | --- |
| Model | e.g. `DS-2CD2142FWD-I` |
| Firmware | e.g. `V5.5.0` |
| IP / port | e.g. `192.168.1.64:80` |
| Username | `admin` |
| Channel count | e.g. `1` (bullet) or `N` (NVR) |
| PTZ capable? | yes / no |

## 2. Digest auth handshake (the critical path)

Every ISAPI call follows: first request is unauthenticated → server answers
`401` with `WWW-Authenticate: Digest …` → client answers with the computed
`Authorization` header. Verify this once manually:

```sh
# 1) Challenge probe — expect 401 + a Digest header
curl -si http://<IP>/ISAPI/System/deviceInfo | grep -iE '^(HTTP|WWW-Authenticate)'
#    HTTP/1.1 401 Unauthorized
#    WWW-Authenticate: Digest qop="auth", realm="IP Camera(C4606)", nonce="…", …
```

- [ ] Response is `401 Unauthorized`, **not** `200` (digest enabled) and **not** `Basic` only.
- [ ] `WWW-Authenticate` starts with `Digest` and carries a `nonce` and `realm`.

If the device is configured for **Basic** auth instead of Digest, the plugin's
`request()` will throw `HikvisionError('AUTH', …)`. Re-enable digest or note the
device is out of scope.

## 3. Run the end-to-end smoke script

From the repo root, with the package built:

```sh
pnpm --filter @vigilkit/plugin-hikvision build
node - <<'EOF'
import { HikvisionDevice } from '@vigilkit/plugin-hikvision';

const cam = new HikvisionDevice({ host: '192.168.1.64', password: '<password>' });

// 3.1 Device info
const info = await cam.getDeviceInfo();
console.log('device:', info);
// expect: model / serialNumber / firmwareVersion / macAddress populated

// 3.2 Channels
const channels = await cam.listChannels();
console.log('channels:', channels);
// expect: at least one { id: '1', name: …, enabled: true }

// 3.3 RTSP URL
console.log('rtsp:', cam.buildRtspUrl(1));           // rtsp://admin:***@…:554/Streaming/Channels/101
console.log('rtsp-sub:', cam.buildRtspUrl(1, 'sub')); // …/Channels/102
EOF
```

### 3.1 — Device info

- [ ] `model` matches the device sticker / web UI.
- [ ] `serialNumber` matches the web UI **System → Device Information**.
- [ ] `firmwareVersion` is non-empty.

### 3.2 — Channel enumeration

- [ ] Channel count matches the physical inputs.
- [ ] `id`, `name`, and `enabled` are populated; `enabled` is a boolean.

### 3.3 — Stream URL

- [ ] RTSP URL is well-formed and matches the vendor's documented
      `rtsp://<user>:<pass>@<ip>:554/Streaming/Channels/<ch>01` shape.

## 4. Playback (proves the URL is actually consumable)

The plugin produces URLs; it does **not** decode. Prove the URL with an external
player on the same machine (both are standard, non-commercial tools):

```sh
# ffprobe (or ffplay) the main stream — expect an h264 stream to enumerate
ffprobe -v error -rtsp_transport tcp -i "rtsp://admin:<password>@<IP>:554/Streaming/Channels/101" \
  -show_streams -select_streams v:0 | grep -E 'codec_name|width|height'
```

- [ ] `codec_name=h264` (or `hevc`) and sane `width`/`height`.
- [ ] (Optional) `ffplay -rtsp_transport tcp <url>` shows live video.
- [ ] (Optional) Open `http://<IP>/ISAPI/Streaming/channels/101/httpPreview` in a
      browser after logging into the device web UI — a live image/video plays.

> The RTSP URL is meant to feed a server-side relay (MediaMTX / go2rtc) that a
> vigilkit `ws`/`flv`/`hls` plugin then consumes in the browser — the RTSP relay
> is a documented architecture boundary (RTSP is not browser-native).

## 5. PTZ (only if the device supports it)

```sh
node - <<'EOF'
import { HikvisionDevice, move, zoom } from '@vigilkit/plugin-hikvision';
const cam = new HikvisionDevice({ host: '<IP>', password: '<password>' });

await cam.ptzMove(1, move('right', 50));  // camera pans right
await new Promise(r => setTimeout(r, 1500));
await cam.ptzStop(1);                     // stops
await cam.ptzMove(1, zoom('in', 40));     // zooms in
await new Promise(r => setTimeout(r, 1500));
await cam.ptzStop(1);
EOF
```

- [ ] Camera physically moves on `move(...)`, stops on `ptzStop`.
- [ ] `zoom('in')`/`zoom('out')` change the zoom (tele/wide).
- [ ] `ptzGotoPreset(1, 1)` moves to a pre-saved preset (set one first in the web UI).

> **Known limitation**: the ISAPI `continuous` endpoint moves the camera while the
> command is "held" (the values are momentary, not absolute). Applications must send
> a zero/stop command on release — the plugin's `ptzStop` does exactly this.

## 6. Negative / boundary checks

- [ ] Wrong password → `getDeviceInfo()` rejects with `HikvisionError` code `'HTTP'`
      (a `401` after the digest retry) — not a hang, not an uncaught exception.
- [ ] Unreachable IP → rejects with a network error (fetch rejects), no hang.
- [ ] Invalid channel (`buildRtspUrl(0)`, `ptzMove(0, …)`) → `HikvisionError` code
      `'INVALID_ARGUMENT'`.
- [ ] `rtspUrl` percent-encodes special characters in credentials (`a@d min` / `p:ass`).

## 7. Sign-off

| Field | Value |
| --- | --- |
| Tester | |
| Date | |
| Device model / firmware | |
| Channel count verified | |
| Digest handshake | pass / fail |
| Device info / channels | pass / fail |
| RTSP playback | pass / fail |
| PTZ (if applicable) | pass / fail / n/a |
| Negative checks | pass / fail |

Any failure: file an issue with the device model + firmware and the exact
`WWW-Authenticate` / XML response (redact the password and nonce).
