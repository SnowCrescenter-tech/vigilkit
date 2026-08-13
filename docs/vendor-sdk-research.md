# Vendor SDK Research: Hikvision / Dahua / Uniview

> **Status**: Research snapshot, 2026-08-14. Purpose: establish what each of the three
> major Chinese surveillance vendors (海康威视 / 大华 / 宇视) publishes openly, what a
> browser can actually reach on modern firmware, which GitHub projects are safe to learn
> from vs. which are copyleft/red-flag, and what vigilkit can build and CI-test without
> owning a single camera.
>
> **Companion policy docs**: `CONTRIBUTING.md` (business boundary — the three vendor
> plugins are core-team-only; no copying from GPL/vendor SDK code) and `ROADMAP.md`
> (P1-8 "海康/大华/宇视插件" is the monetization surface, "建议先海康").

---

## 0. Executive summary (report)

| Vendor | Open platform | Best browser path today | Open-source signal on GitHub | License posture |
| --- | --- | --- | --- | --- |
| **Hikvision** | `open.hikvision.com`, `tpp.hikvision.com` (ISAPI guides behind MLA sign) | ISAPI digest auth + WS-FLV/HTTP-FLV via Web SDK 3.2+ (websocket), or H.264 over `httpPreview`, or H5player (closed WASM) | Strong: several MIT ISAPI wrappers; one famous GPL Go client; one no-license WS reverse-engineering repo | ISAPI spec = reference; GPL repos = reference-only; H5player = closed, protocol only |
| **Dahua** | `open.dahuatech.com` (device SDK), `depp.dahuasecurity.com` (DSS), `open-icc.dahuatech.com`, `open.cloud-dahua.com` | `cgi-bin` HTTP API + **RTSP-over-WebSocket** (`/rtspoverwebsocket`) — the only vendor with a *native* browser RTSP bridge | Good: MIT `rroller/dahua` (HA), GPL `nayrnet/node-dahua-api` (best CGI reference), MIT RTSP-over-WS demos | CGI API docs circulate freely; GPL repos = reference-only; P2P/RPC2 = RE territory |
| **Uniview (UNV)** | `global-open.uniview.com` (Unisee), SDK download center | ONVIF Profile S, RTSP (`/unicast/c1/s0/live`, `/media/video1`), MJPEG, **LightAPI** (digest) | **Weak**: no maintained UNV SDK wrapper; LAPI toolkit unlicensed; most "uniview" repos are unrelated | LightAPI doc is the key reference; UNV SDKs proprietary; almost nothing reusable as code |

**Bottom line**: all three vendors can be integrated from *documented* HTTP/RTSP surfaces.
Hikvision first (best docs + MIT wrappers), Dahua second (RTSP-over-WS is a unique
browser story), Uniview third (weakest ecosystem, LightAPI doc needed). All vendor SDK
binaries and all GPL/AGPL/no-license GitHub code are **reference-only** — vigilkit
plugins must be written from scratch against the protocol documentation.

---

## 1. Hikvision (海康威视)

### 1.1 Official open platform / developer portal

| Resource | URL | Access |
| --- | --- | --- |
| Hikvision Open Platform (海康开放平台) | https://open.hikvision.com/ | Free account (One Hikvision ID) |
| TPP — Technology Partner Portal | https://tpp.hikvision.com/ | Free account; **ISAPI & OTAP guides require signing the Materials License Agreement (MLA) via DocuSign** |
| ISAPI & OTAP Developer Guide hub | https://tpp.hikvision.com/download/ISAPI_OTAP | MLA-gated; searchable by device series |
| SDK download (Device Network SDK Win/Linux, Web SDK) | https://www.hikvision.com/us-en/support/download/sdk/ | Login-gated, free |
| Web development kit (Web SDK 3.2/3.3) | https://www.hikvision.com/us-en/support/download/sdk/web-development-kit/ | Login-gated |
| Hik-Connect / WASM (JSDecoder) dev kit | https://tpp.hikvision.com/products/HC-Integration | Partner approval + OpenAPI tools download |

What is freely downloadable once registered:
- **Device Network SDK** (Windows 32/64, Linux 32/64, ~180-400 MB) — C/C++/C# bindings, preview/playback/PTZ. Proprietary binaries, NDA-ish terms. **Not distributable in an Apache-2.0 project.**
- **Web SDK 3.2 / 3.3 (HCWebSDK)** — JavaScript wrapper around a browser plugin (ActiveX/NPAPI) for preview/playback/PTZ; 3.2 needs WebSocket-capable firmware, 3.3 needs the HCWebSDKPlugin control. Useful as a *behavioral* reference for the browser interaction surface.
- **ISAPI Developer Guide** — the core reference (REST/XML over HTTP, digest auth). MLA-gated but the protocol itself is publicly reverse-documented everywhere (see §1.3).

**Key protocol fact (ISAPI)**: ISAPI is a RESTful HTTP+XML API. Base path `/ISAPI/...`,
digest (or basic) auth by default. Path tree: `/ISAPI/System`, `/ISAPI/Streaming`,
`/ISAPI/Event`, `/ISAPI/Intelligent`, `/ISAPI/AccessControl`. Channel/stream encoding:
`101` = channel 1 main stream, `102` = channel 1 sub-stream, etc.

### 1.2 Browser access path (modern firmware)

- **RTSP (not browser-native)**: `rtsp://user:pass@IP:554/Streaming/Channels/101`
  (main) / `102` (sub). Also ISAPI-flavored `rtsp://IP:554/ISAPI/Streaming/channels/101`.
  Requires a server-side relay for a browser player (MediaMTX/go2rtc etc.).
- **ISAPI HTTP digest auth**: digest (RFC 2617-style) is the default on HTTP/HTTPS.
  This is the authentication the plugin must implement for *all* ISAPI calls.
- **`httpPreview` (H.264 over HTTP, ISAPI)**: `GET /ISAPI/Streaming/channels/102/httpPreview`
  returns a live H.264 stream to the browser over HTTP. Demonstrated at ~640×360 in
  Chrome/Firefox on firmware that still ships the old web UI; modern firmware prefers WebSocket.
- **WebSocket streaming (Web SDK 3.2+, ISAPI "Media Capabilities: webSocket")**: modern
  firmware exposes a WebSocket video path used by the official no-plugin Web SDK. The
  official `webVideoCtrl.js` flow: login (ISAPI) → WS to the device/relay → preview/PTZ.
  Two-layer WS protocol (hello/auth/key-exchange/video frames). **This is what Hikvision's
  H5player consumes.**
- **H5player (closed-source WASM)**: Hikvision's `h5player.min.js` + `Decoder.js`
  (WebAssembly) + `DecodeWorker.js` is **closed source and proprietary** — not
  redistributable. However its **protocol behavior is documented/reverse-engineered** in
  community repos (see §1.3 `holmesian/hik_ws_client`): WS handshake at
  `wss://host/media?version=0.1&cipherSuites=0&sessionID=&proxy=<device>`, message types
  `MSG_TYPE_AUTH_REQUEST=0x02`, `MSG_TYPE_KEY_EXCHANGE=0x04`, `MSG_TYPE_VIDEO_DATA=0x40`,
  AES-CBC encrypted video. Treat the *protocol description* as reference; never copy the
  JS/WASM.
- **MJPEG/snapshot (ISAPI)**: `GET /ISAPI/Streaming/channels/102/picture` (snapshot);
  MJPEG streams are available on many models (`/ISAPI/Streaming/channels/102/mjpeg`).
- **HLS**: no native HLS on Hikvision devices; typically requires a relay (FFmpeg/MediaMTX).

### 1.3 Open-source demos / wrappers on GitHub

| Repo | License | Language | What it demonstrates | Usable? |
| --- | --- | --- | --- | --- |
| [Rennbon/pyhikvision](https://github.com/Rennbon/pyhikvision) | MIT | Python | ISAPI wrapper: login, streaming URL discovery, PTZ, playback | ✅ learn/copy (MIT) |
| [ShadowWa1k3r/hikvision-isapi-wrapper](https://github.com/ShadowWa1k3r/hikvision-isapi-wrapper) | MIT | Python | Minimal ISAPI GET/PUT digest-auth wrapper | ✅ learn/copy |
| [jackblk/hikvision-isapi-py](https://github.com/jackblk/hikvision-isapi-py) | MIT | Python | ISAPI calls incl. digest auth, channel config | ✅ learn/copy |
| [corvis/homeassistant_hikvision](https://github.com/corvis/homeassistant_hikvision) | MIT | Python | HA integration over ISAPI (native, no SDK) | ✅ learn/copy |
| [Shaykhnazar/hikvision-isapi](https://github.com/Shaykhnazar/hikvision-isapi) | MIT | PHP | Laravel package for ISAPI face terminals | ✅ learn (PHP) |
| [fuqiangZ/hikvision-isapi-go](https://github.com/fuqiangZ/hikvision-isapi-go) | (no LICENSE file) | Go | ISAPI client (digest auth, snapshot) | ⚠️ reference-only (no license) |
| [loozhengyuan/hikvision-sdk](https://github.com/loozhengyuan/hikvision-sdk) | **GPL-3.0** | Go | ISAPI client for Hikvision | 🔴 reference-only |
| [holmesian/hik_ws_client](https://github.com/holmesian/hik_ws_client) | (no LICENSE file) | Python | **Reverse-engineering of Hikvision private WebSocket video protocol** (h5player) | 🔴 reference-only (no license; RE notes are gold) |
| [joygqz/hikvideoctrl](https://github.com/joygqz/hikvideoctrl) | MIT | TypeScript | TS wrapper around official `WebSDK_noPlugin V3.4.0` (`webVideoCtrl.js`); async/await preview/playback/PTZ | ✅ learn/copy (but binds to official SDK files) |
| [kCn3333/hikvision-manager](https://github.com/kCn3333/hikvision-manager) | (no LICENSE file) | Java | Spring Boot ISAPI + FFmpeg → HLS live view | ⚠️ reference-only |
| [evercam/hikvision_client](https://github.com/evercam/hikvision_client) | (no LICENSE file) | Elixir | HTTP client for ISAPI | ⚠️ reference-only |
| [648540858/wvp-GB28181-pro](https://github.com/648540858/wvp-GB28181-pro) | MIT | Java | **GB28181** signaling + streaming (ZLM) — server-side, not camera-side | ✅ learn (GB28181 belongs server-side) |

### 1.4 Testability without real hardware (Hikvision)

- **Digest auth**: fully testable in CI against a mock ISAPI server that returns `401
  WWW-Authenticate: Digest ...` and validates the `response` hash (vigilkit can host a tiny
  `node:http` mock in tests). No camera needed.
- **ISAPI XML parsing / PTZ command serialization**: pure functions — CI-testable.
- **H.264 over `httpPreview` / FLV / HLS**: vigilkit already demuxes FLV and TS in CI
  (see §5). Mock an HTTP server returning the fixture bytes.
- **Needs real camera**: the WebSocket two-layer auth/key-exchange handshake against real
  firmware, `webVideoCtrl.js` behavior, H5player end-to-end, codec/firmware quirks.

---

## 2. Dahua (大华)

### 2.1 Official open platform / developer portal

| Resource | URL | Access |
| --- | --- | --- |
| Dahua Open Platform (开放平台) | https://open.dahuatech.com/ (device SDK) | Account registration; SDK + docs per device model |
| DSS Integration (DIP) platform | https://www.dahuasecurity.com/products/software/ecosystem/integration-with-dss | Register at `depp.dahuasecurity.com` + sign NDA for API guide |
| ICC Open API (open-icc) | https://open-icc.dahuatech.com/ | Cloud/ICC platform SDK; Java SDK on Maven Central (`com.dahuatech.icc:java-sdk`) |
| Dahua Cloud Developer Platform | https://open.cloud-dahua.com/ | Cloud IoT/低代码 platform, SDK center |
| HTTP API documentation (mirrors) | e.g. `wiki.dno-it.ru` (v1.40 PDF), `cctvapp.net` (v1.67 + NVR/XVR v2.67) | **Public mirrors**; vendor itself gates current docs behind account/NDA |
| Dahua SDK download (support) | https://www.dahuasecurity.com/support/downloadCenter/softwares | Account |

**Key protocol facts**:
- **HTTP CGI API** (`cgi-bin`): digest or basic auth. Snapshot:
  `http://host/cgi-bin/snapshot.cgi?channel=1`; MJPEG:
  `http://host/cgi-bin/mjpg/video.cgi?channel=1&subtype=1`; config/PTZ under
  `/cgi-bin/configManager.cgi?action=...` and `/cgi-bin/ptz.cgi?action=...`.
- **RTSP**: `rtsp://user:pass@host:554/cam/realmonitor?channel=1&subtype=0`
  (subtype 0 = main, 1/2 = extra streams). Playback over RTSP uses `.dav` file URLs.
- **Dahua private P2P (DHIP / RPC2)**: binary protocol; RE-only, no official spec
  (see OpenIPC/python-dhip below).

### 2.2 Browser access path (modern firmware)

- **RTSP-over-WebSocket — the unique Dahua story**: newer Dahua IPC firmware implements
  **`/rtspoverwebsocket`**: `ws://host:port/rtspoverwebsocket` carrying
  `rtsp://host:port/cam/realmonitor?channel=1&subtype=0`. The camera speaks RTSP *inside*
  a WebSocket, so a browser page can consume RTSP directly (video via WebCodecs/ffmpeg.wasm)
  **without any relay server**. This is the strongest native browser path of the three
  vendors. (References: TeamDotworld/dahua-rtsp-web, stalniy/dahua-rtspoverws, npm
  `rtsp-wsss`.)
- **HTTP CGI**: MJPEG (`mjpg/video.cgi`) and snapshots are trivially browser-consumable;
  used by Home Assistant integrations.
- **HLS**: not native; requires relay (DSS/MediaMTX).
- **ONVIF**: Profile S broadly supported; useful for discovery + PTZ in a standards way.

### 2.3 Open-source demos / wrappers on GitHub

| Repo | License | Language | What it demonstrates | Usable? |
| --- | --- | --- | --- | --- |
| [rroller/dahua](https://github.com/rroller/dahua) | MIT | Python | Home Assistant integration over `cgi-bin`; config, snapshots, events, PTZ | ✅ learn/copy |
| [nayrnet/node-dahua-api](https://github.com/nayrnet/node-dahua-api) | **GPL-3.0** | JavaScript | Node.js module for Dahua IPC HTTP API — **best CGI reference** (snapshot, PTZ commands, events) | 🔴 reference-only (GPL) |
| [TeamDotworld/dahua-rtsp-web](https://github.com/TeamDotworld/dahua-rtsp-web) | MIT | JavaScript | **RTSP-over-WebSocket** PoC; WebCodecs player; no relay needed | ✅ learn/copy |
| [stalniy/dahua-rtspoverws](https://github.com/stalniy/dahua-rtspoverws) | MIT | JavaScript | Fork/evolution of the above; WebCodecs-first with ffmpeg.wasm fallback | ✅ learn/copy |
| [mcw0/DahuaConsole](https://github.com/mcw0/DahuaConsole) | MIT | Python | Access to Dahua internal debug console; RE/firmware research | ✅ learn (research tool) |
| [bp2008/DahuaLoginBypass](https://github.com/bp2008/DahuaLoginBypass) | **GPL-3.0** | JavaScript | CVE-2021-33044/33045 auth-bypass PoC (Chrome ext.) | 🔴 reference-only (GPL + vuln) |
| [tchellomello/python-amcrest](https://github.com/tchellomello/python-amcrest) | **GPL-2.0** | Python | Amcrest/Dahua HTTP API client (cgi-bin) | 🔴 reference-only (GPL) |
| [khoanguyen-3fc/dh-p2p](https://github.com/khoanguyen-3fc/dh-p2p) | MIT | Rust | PoC of **RTSP over Dahua P2P** protocol | ✅ learn (RE of P2P) |
| [OpenIPC/python-dhip](https://github.com/OpenIPC/python-dhip) | MIT | Python | Pure-stdlib client for Dahua **DHIP (binary RPC2)** protocol; live video via RTSP template or `RPC_Loadfile` (DHAV container) | ✅ learn (MIT) — note DHAV container ≠ FLV |
| [QuickNV/QuickNV.DahuaNetSDK](https://github.com/QuickNV/QuickNV.DahuaNetSDK) | (no LICENSE file) | C# | C# interop to Dahua NetSDK | ⚠️ reference-only |

### 2.4 Testability without real hardware (Dahua)

- **CGI snapshot/MJPEG**: mock `snapshot.cgi` / `mjpg/video.cgi` in a test HTTP server —
  fully CI-testable; MJPEG `multipart/x-mixed-replace` parsing is a pure parser vigilkit
  can unit-test with fixture bytes.
- **Digest auth**: same mock-401 approach as Hikvision (Dahua uses standard digest).
- **RTSP-over-WebSocket**: CI-testable against a **mock WS server** that implements the
  minimal `/rtspoverwebsocket` framing (or against MediaMTX which can wrap RTSP). The
  framing (binary WS carrying RTSP/RTP) can be exercised without hardware.
- **Needs real camera**: `rtspoverwebsocket` on actual firmware, DHIP/RPC2 specifics,
  `.dav` playback semantics, event `RPC_Event` feeds.

---

## 3. Uniview / UNV (宇视)

### 3.1 Official open platform / developer portal

| Resource | URL | Access |
| --- | --- | --- |
| Unisee global open platform | https://global-open.uniview.com/ | Registration; Documentation, API & SDK, UAOP, Partners, Support |
| Unisee (UAOP / docs) | https://unisee.uniview.com/en/home/openPlatform | Registration |
| Uniview SDK download center | https://global.uniview.com/Support/Download_Center/SDK/ | Network Device SDK (iOS/Android/Windows 32/64) |
| Uniview download center (tools/WebPlugin) | https://www.uniview.com/Support/Download_Center/Tool/ | WebPlugin (non-IE web plugin for live view/playback) |
| Platform SDK (IMOS, CN) | https://cn.uniview.com/Service/Service_Training/Download/SDK/... | Platform/IMOS SDK, C++ demo |

**Key protocol facts**:
- **LightAPI (LAPI)** — Uniview's ISAPI-equivalent: RESTful HTTP+JSON, **digest auth**.
  Base path `/LAPI/V1.0/...` e.g.
  `GET /LAPI/V1.0/Channels/12/Media/Video/Streams/0/Snapshot`,
  `/LAPI/V1.0/Channel/0/Media/Video/Streams/0/Records` (record search), PTZ under
  `PTZCtrl`/`Presets`/`Patrols`. The **LightAPI Interface User Guide v3.00** (EN) is the
  key reference; it circulates publicly (e.g. Scribd) but is normally handed out by UNV
  on request (contact a UNV representative / partner portal).
- **RTSP**: IPC: `rtsp://IP:554/media/video1` (main), `video2` (sub), `video3` (third).
  NVR: `rtsp://IP:554/unicast/c1/s0/live` (c = channel, s0 = main, s1 = sub). Playback:
  `rtsp://IP:554/c2/<begin>/<end>/replay/` (Unix timestamps).
- **MJPEG / snapshot**: `http://IP/video/mjpeg/stream1..3` (when codec = MJPEG);
  `http://IP/images/snapshot.jpg`.
- **ONVIF**: Profile S supported on current IPC/NVR lines — good for discovery/PTZ.

### 3.2 Browser access path (modern firmware)

- **No native RTSP-over-WebSocket equivalent** (unlike Dahua). Browser playback is
  plugin-based (`WebPlugin` / `WebPlayer`) on many firmware generations; modern web UI is
  improving but is the least documented of the three.
- **MJPEG** is the most reliable browser-native live view (HTTP multipart, no auth
  complexity beyond basic/digest).
- **LightAPI over HTTP(S)**: control plane (channel list, snapshot, PTZ, records) is fully
  HTTP+JSON+digest — browser-reachable with CORS/proxy.
- **HLS**: not native; needs relay.

### 3.3 Open-source demos / wrappers on GitHub

| Repo | License | Language | What it demonstrates | Usable? |
| --- | --- | --- | --- | --- |
| [GainSec/Uniview-LAPI-Research-Toolkit](https://github.com/GainSec/Uniview-LAPI-Research-Toolkit) | (no LICENSE file) | Python | Standalone LAPI endpoint browser; generic-uniview endpoint profile; read-safe defaults | 🔴 reference-only (no license) — but the **endpoint profile JSON is a great reference** |
| [freeload101/Python](https://github.com/freeload101/Python) (Uniview scripts) | (no LICENSE file) | Python | LAPI record download/snapshot via HTTPDigestAuth | 🔴 reference-only |
| [GhostDevil/UnvDeviceApi](https://github.com/GhostDevil/UnvDeviceApi) | (no LICENSE file) | C# | UNV device API wrapper | ⚠️ reference-only, unmaintained |

> ⚠️ Note: many GitHub repos matching "uniview" are **unrelated** (e.g. `r12a/uniview` is a
> Unicode character viewer; `RoboUniview` is a robotics dataset tool). The UNV camera
> ecosystem has **no maintained MIT/Apache wrapper** as of this research — the plugin will
> be written from the LightAPI doc + ONVIF + public URL patterns.

### 3.4 Testability without real hardware (Uniview)

- **LightAPI digest auth + JSON parsing**: mock `/LAPI/V1.0/...` server in CI — fully
  testable.
- **MJPEG / snapshot**: CI-testable (shared with other vendors).
- **RTSP URL template logic** (`/media/video1`, `/unicast/c1/s0/live`): pure functions,
  CI-testable.
- **Needs real camera**: plugin-based web UI behavior, PTZ over LightAPI against real
  firmware, ONVIF interop, GB28181 registration (server-side).

---

## 4. Browser integration matrix

Browser feasibility: 🟢 direct/native, 🟡 via relay or partial, 🔴 not feasible / plugin-only.

| Vendor | RTSP | HTTP-FLV | WS-FLV | HLS (.m3u8) | MJPEG | WebRTC |
| --- | --- | --- | --- | --- | --- | --- |
| **Hikvision** | 🟡 relay only (RTSP not browser-native) | 🟡 via ISAPI/relay; no official FLV endpoint | 🟢 modern firmware via Web SDK WS (H5player protocol; closed codec, protocol RE-documented) | 🟡 relay only (no native HLS) | 🟢 `ISAPI/.../picture` + MJPEG paths | 🔴 no native; via WHEP relay |
| **Dahua** | 🟢 **RTSP-over-WebSocket** (`/rtspoverwebsocket`) + WebCodecs | 🟡 via relay/`RPC_Loadfile` (DHAV container, not FLV) | 🟡 via relay | 🟡 relay only | 🟢 `cgi-bin/mjpg/video.cgi` | 🔴 no native; via WHEP relay |
| **Uniview (UNV)** | 🟡 relay only (RTSP not browser-native) | 🟡 relay only | 🔴 no documented WS-FLV | 🟡 relay only | 🟢 `/video/mjpeg/streamN`, `/images/snapshot.jpg` | 🔴 no native; via WHEP relay |

**vigilkit mapping**: vigilkit's existing plugins already cover the right primitives —
`@vigilkit/plugin-ws` (WS transport) + `@vigilkit/plugin-flv` (FLV demux) cover WS-FLV;
`@vigilkit/plugin-hls` covers the HLS relay path; `@vigilkit/plugin-whep` covers the
WebRTC relay path. The vendor plugins add (a) digest-auth HTTP control plane,
(b) vendor URL/template knowledge, (c) MJPEG demux (new), (d) Dahua RTSP-over-WS framing
(new transport), (e) optionally the Hikvision private WS protocol (reference-only RE).

---

## 5. What we can build without a camera

### CI-testable (no hardware) — reuse vigilkit's existing surfaces

| Capability | CI approach | Existing vigilkit support |
| --- | --- | --- |
| **Digest auth client** (RFC 2617 md5/md5-sess) shared by all three vendors | mock HTTP server issuing `401 WWW-Authenticate: Digest`; assert `Authorization` header + retry | none yet (new shared module — candidate for `media-utils` or a `vendor-core` pkg) |
| **ISAPI/LAPI/CGI XML+JSON control plane** (channel list, snapshot, PTZ command builders) | mock HTTP servers returning real-doc-shaped XML/JSON fixtures; assert parsed output & generated requests | none yet |
| **FLV demux** (WS-FLV for Hikvision relay; FLV relay generally) | existing `flv-demuxer.test.ts`, FFmpeg FATE FLV fixture | ✅ `@vigilkit/plugin-flv` |
| **HLS (m3u8 + TS)** relay path | existing `hls-source.test.ts` + `ts-demuxer.test.ts` | ✅ `@vigilkit/plugin-hls` |
| **MPEG-TS demux for GB28181-derived relays** | existing TS demuxer | ✅ (GB28181 itself is server-side) |
| **MJPEG `multipart/x-mixed-replace` demuxer** (all three vendors expose MJPEG) | fixture multipart body with several JPEG frames; assert frame events | ❌ new demuxer plugin (`@vigilkit/plugin-mjpeg`) — pure parser, fully CI-testable |
| **Dahua RTSP-over-WebSocket framing** | mock WS server replaying captured frames; assert RTSP/RTP byte flow | ❌ new transport (can build on `plugin-ws`) |
| **RTSP URL template builders** per vendor (Hik `Streaming/Channels/101`, Dahua `cam/realmonitor`, UNV `media/video1` / `unicast/c1/s0/live`) | pure-function unit tests | ❌ new |
| **Hikvision private WS protocol message parser** (from RE notes) | synthetic binary frames; **no camera needed for parser** | ❌ new (reference-only design) |

### Needs a real device (manual QA documented per ROADMAP P1-8)

- End-to-end live view/playback against real firmware (WebSocket handshake + key exchange +
  AES-CBC video on Hikvision; `/rtspoverwebsocket` on Dahua; LightAPI PTZ on UNV).
- Vendor-specific frames/quirks (Hikvision smart codecs, Dahua DHAV `.dav` playback,
  event subscription `RPC_Event`, Hikvision `Event/notification`).
- ONVIF interop quirks per model.
- PTZ behaviors (speed curves, preset round-trip) on real PTZ heads.

---

## 6. Recommendations — plugin implementation order

1. **Shared vendor-core package first** (`@vigilkit/vendor-core`, Apache-2.0): digest-auth
   HTTP client, MJPEG demuxer, URL/template builders, XML/JSON parsing helpers. Everything
   here is CI-testable against mock servers; it is the foundation for all three plugins and
   stays license-clean (written from protocol docs, not from GPL code).
2. **Hikvision plugin** (aligns with ROADMAP P1-8 "建议先海康"): ISAPI digest auth + channel
   enumeration + snapshot/MJPEG + PTZ. Reuse `plugin-ws`/`plugin-flv` for the relay path;
   optionally add the reference-only Hikvision private WS client later (parser CI-testable;
   E2E needs a camera).
3. **Dahua plugin**: `cgi-bin` control plane (same vendor-core), then the
   **RTSP-over-WebSocket** transport (unique differentiator; testable against mock WS +
   MediaMTX, final E2E on firmware).
4. **Uniview plugin**: LightAPI control plane + MJPEG + RTSP URL templates; lowest GitHub
   ecosystem support — budget time to request the LightAPI guide from UNV and rely on
   ONVIF for discovery.
5. Keep **GB28181 server-side** (wvp-GB28181-pro etc. are relay/server projects, MIT —
   fine as reference; not a camera plugin).

### License/compliance guardrails (reaffirm CONTRIBUTING.md)

- ✅ Freely usable as *reference*: ISAPI spec, Dahua HTTP API docs (public mirrors),
  LightAPI guide, ONVIF specs.
- ✅ MIT repos listed above can be studied and their *ideas* (not wholesale code) reused;
  if code is adapted, keep MIT attribution + NOTICE.
- 🔴 GPL-2.0/GPL-3.0 repos (`loozhengyuan/hikvision-sdk`, `nayrnet/node-dahua-api`,
  `tchellomello/python-amcrest`, `bp2008/DahuaLoginBypass`, `digital-divas/Onvif-IP-Camera-Mock`)
  are **reference-only** — never copy code into vigilkit (license scan will fail too).
- 🔴 No-license repos (`holmesian/hik_ws_client`, `fuqiangZ/hikvision-isapi-go`,
  `GainSec/Uniview-LAPI-Research-Toolkit`, `freeload101/Python`) are reference-only; their
  RE notes/endpoint profiles can inform design but their code cannot be copied.
- 🔴 Vendor SDK binaries (Hikvision Device Network SDK, HCWebSDK, UNV Network Device SDK,
  Dahua NetSDK) are **proprietary** — usable only as local test fixtures with vendor
  permission, never shipped or depended on; the plugins must be written from protocol docs.
- 🔴 H5player (`h5player.min.js`, `Decoder.js`) is closed source — never bundle; protocol
  behavior only.
- The existing `scripts/check-licenses.mjs` gate will reject any GPL/LGPL/proprietary
  dependency, so keeping vendor code out of `dependencies` is both policy and CI-enforced.

---

*Sources compiled 2026-08-14 from vendor portals (open.hikvision.com, tpp.hikvision.com,
dahuasecurity.com/open.dahuatech.com, global-open.uniview.com, cn.uniview.com) and GitHub
repo metadata (license verified via GitHub API per repo). Links are listed inline in each
table. All vendor-SDK download pages require account registration; ISAPI guides additionally
require the Hikvision Materials License Agreement.*
