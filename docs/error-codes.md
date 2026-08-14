# vigilkit error codes

Complete reference for every error vigilkit can raise, where each one is
emitted in the source, and what an application should do about it.

The canonical code list lives in
[`packages/plugin-sdk/src/types.ts`](../packages/plugin-sdk/src/types.ts)
(`MediaErrorCode`, lines 8–11); the `VigilkitError` / `mediaError` helpers live
in [`packages/core/src/errors.ts`](../packages/core/src/errors.ts). All line
references below were verified against the current source.

---

## 1. How errors propagate

vigilkit has one fatal-error path: **every media error funnels into
`Engine.handleError`** (`packages/core/src/engine.ts:248-256`) and ends the
playback session.

```
transport/demuxer/source event stream            engine internals
──────────────────────────────────────────      ─────────────────────────
TransportEvent 'error' ──┐
TransportPipeline (core/transport-pipeline.ts:93-95)
  └─ callbacks.onError ──┼─► Engine.handleError ──► stop pump
Transport 'close' while connecting                 │   pipeline.teardown()
  └─ engine.ts:211-221 (TRANSPORT)                 │   sourceBranch.disconnect()
Connect timeout (10 s)                             │   state = 'error'
  └─ transport-pipeline.ts:112-118 (TIMEOUT)       │   emit 'error' (once)
DemuxerEvent 'error' ──┐                           └─ errors[] grows (PlayerStats)
SourcePlugin 'error' ──┤
  └─ engine.ts:242-244 ─┘
Decoder onError (DECODE / UNSUPPORTED)
  └─ engine.ts:63
Audio pipeline onError (DECODE)
  └─ engine.ts:61-62
Scheduler fatal stall (STALLED)
  └─ engine.ts:74
Renderer draw failure (RENDERER)
  └─ scheduler.ts:169, engine.ts:240 → render-surface.ts:22-27
Plugin registration failure (PLUGIN_COLLISION / UNSUPPORTED)
  └─ engine.ts:151-155 → plugin-utils.ts:15-23
Engine start resolution failures (UNSUPPORTED)
  └─ engine.ts:161, 171-173, 182
```

Semantics of `handleError`:

- **First error wins.** Once `state === 'error'`, later errors are ignored
  (engine.ts:249). Your app receives exactly one `'error'` event per session.
- **The session is torn down**: pump stopped, transport + demuxer closed,
  source branch disconnected. There is no auto-recovery.
- **Errors are observable afterwards** through `PlayerStats.errors`
  (engine.ts:128) and the player's `'stats'` events.
- **`play()` can restart from the `'error'` state** (engine.ts:92) — the
  engine re-runs `start()`, which re-registers plugins (skipped if already
  registered), re-resolves the URL/plugins, and rebuilds the pipeline.
- The WS transport's opt-in `reconnect` option can turn transient socket drops
  into non-fatal reconnects before they ever reach the engine (see
  `TRANSPORT` below).

Layer names used below: **transport** (WS plugin / WHEP / HLS fetches),
**demuxer** (FLV, MPEG-TS, m3u8), **decoder** (WebCodecs wrapper,
`CodecRoutingDecoder`, soft decoders, audio decoder), **renderer** (WebGPU /
WebGL2 / canvas2d surfaces), **engine** (`Engine`, `TransportPipeline`,
`Scheduler`, QoS watchdog).

---

## 2. `MediaErrorCode` master table

| Code | Emitted? | Emitting layer | Meaning |
| --- | --- | --- | --- |
| `TRANSPORT` | ✅ | transport, engine | Socket / fetch / WebRTC connection failed, or the transport closed before the handshake finished |
| `DEMUX` | ✅ | demuxer | Container / playlist / TS framing is malformed, or a fetch the source relies on failed |
| `DEMUX_BAD_SIGNATURE` | ✅ | demuxer (FLV) | The stream does not start with the `FLV` signature |
| `DEMUX_MISSING_SEQUENCE_HEADER` | ✅ | demuxer (FLV) | Encoded frames arrived before the codec sequence header |
| `DECODE` | ✅ | decoder | WebCodecs / soft decoder configure, decode, or output failure |
| `BUFFER_OVERFLOW` | ⛔ reserved | — | No code path emits it yet; reserved for future jitter-buffer overflow classification |
| `RENDERER` | ✅ | renderer | A renderer `draw()` threw during playback |
| `PLUGIN_COLLISION` | ✅ | engine (registry) | Two plugins claim the same id, scheme, or mimeType |
| `UNSUPPORTED` | ✅ | engine, decoder, source | No plugin / decoder for what was requested; URL unparseable; feature the plugin refuses |
| `STALLED` | ✅ | engine (QoS watchdog) | No data for longer than `qos.fatalStallMs` (default 10 s) |
| `NETWORK` | ⛔ reserved | — | Reserved for future connection-level outage classification; nothing emits it yet |
| `TIMEOUT` | ✅ | engine (transport pipeline) | The transport did not emit `open` within the 10 s connect window |

---

## 3. Per-code reference

### `TRANSPORT`

- **Meaning** — the connection between the player and the media source failed:
  the WebSocket errored, a WHEP fetch/ICE failed, or the transport closed
  before the handshake completed.
- **Typical causes** — server down / unreachable, wrong host or port, TLS
  failure, WSS rejected, WebSocket error frame, WHEP server HTTP errors (PATCH
  answer/candidate), ICE connection dropped, non-WHEP server, proxy drop.
- **Emitting layer** — transport plugins and the engine:
  - `packages/plugins/ws/src/ws-transport.ts:145-146` — WebSocket `onerror` →
    `{ code: 'TRANSPORT', message: 'WebSocket error' }`.
  - `packages/core/src/engine.ts:215` — transport `close` while
    `state === 'connecting'`: `'transport closed before connecting'`.
  - `packages/core/src/transport-pipeline.ts:44-48` — transport plugin
    `create()` threw (e.g. the WS plugin's `'invalid scheme'` at
    `ws-transport.ts:96`): `'transport create failed'` or the error message.
  - `packages/plugins/whep/src/whep-source.ts:79-86` — any `connect()` failure
    that is not a `WhepUnsupportedError` maps to `TRANSPORT`.
  - `packages/plugins/whep/src/whep-source.ts:201-206` — answer PATCH
    non-2xx; `:235-240` — candidate PATCH non-2xx; `:246-248` — ICE
    connection `failed` / `disconnected`.
- **What the app should do** — surface to the user and retry. Transient cases
  (brief outage, server restarting) are worth one automatic retry after a
  short backoff. Prefer enabling the WS transport's `reconnect` option
  (`ws-transport.ts:8-18`), which absorbs unexpected closes with exponential
  backoff instead of emitting an error — but note a *connect-timeout* is still
  fatal: after reconnect attempts the transport finally closes, and a close
  while `connecting` yields this error anyway. For WHEP, check the server URL
  and that the endpoint is a real WHEP resource.

### `DEMUX`

- **Meaning** — the byte stream is not a valid container/playlist as expected:
  framing, AMF script data, TS sections, AES-128 key material, variant
  selection, or the HTTP fetches that feed the source failed.
- **Typical causes** — wrong demuxer chosen for the stream, truncated/corrupt
  stream, unsupported codec framing (e.g. legacy HEVC FLV), HLS playlist with
  no usable variants, HTTP 4xx/5xx on playlist/segment/key URLs, invalid
  `EXT-X-BYTERANGE`, AES-128 key missing / bad IV / wrong key length, PMT
  containing no H.264/HEVC/AAC stream, malformed SPS/PPS/hvcC/ASC/ADTS.
- **Emitting layer** — demuxers and sources:
  - FLV: `packages/plugins/flv/src/flv-demuxer.ts:124` (`tag exceeds maximum
    size`), `:169-172` (script AMF parse failure, via `amf0.ts:126,142`),
    `:204` (`unsupported HEVC framing: expected Enhanced-RTMP header`),
    `:247-249` (`malformed HEVC sequence header: no hvcC record`),
    `:336-341` (`failOnFormatError` — any `MediaFormatError` from
    `@vigilkit/media-utils` thrown while parsing avcC/hvcC/ASC configs at
    `:212-215`, `:252-256`, `:305-309`).
  - HLS: `packages/plugins/hls/src/hls-source.ts:73-76` (bootstrap failure)
    and `:140-143` (live reload failure) convert any thrown `HlsError` /
    `MediaFormatError` into the `DEMUX` error event; `HlsError` is thrown at
    `hls-source.ts:102,105,116` (variant selection), `:191` (AES-128 segment
    without key URI), `:206,220` (HTTP status on playlist/segment), `:215`
    (invalid byterange), `:240,245` (segment URI resolution / scheme), and in
    `aes-cbc.ts:23,55,74` (IV parse, key import, decrypt). MPEG-TS:
    `ts/ts-demuxer.ts:128,136` (`no recognized streams in PMT`) and
    `:208-218` (parameter-set config builders reject the data).
  - `@vigilkit/media-utils` `MediaFormatError` (code `'DEMUX'`) is thrown by
    the shared helpers — `byte-reader.ts:87`, `bit-reader.ts:35,38,65`,
    `avc.ts:20,34,73,103`, `hevc.ts:100,120`, `hvcc.ts:96,101,118,125,156`,
    `aac.ts:17,25,30,73,81` — and is converted to a `DEMUX` error event by the
    FLV demuxer (`flv-demuxer.ts:336-341`) or the HLS demuxer
    (`ts-demuxer.ts:213-218`).
- **What the app should do** — surface to the user as "stream not
  playable/corrupt". Do not retry blindly; verify the URL serves the expected
  container (`demuxer` option matches the actual stream), check the HLS server
  logs for HTTP errors, and consider CORS (HLS needs CORS on all playlist /
  segment / key responses). Recreating the player after fixing the source is
  the correct recovery.

### `DEMUX_BAD_SIGNATURE`

- **Meaning** — the FLV header's 3-byte signature is not `FLV`.
- **Typical causes** — the URL serves something that is not FLV (an HTML error
  page, a plain file, HTTP chunked garbage), or a non-FLV stream was routed to
  the FLV demuxer.
- **Emitting layer** — FLV demuxer:
  `packages/plugins/flv/src/flv-demuxer.ts:96-99` (`invalid FLV signature`).
- **What the app should do** — surface as a source/format mismatch. Verify the
  endpoint really returns `video/x-flv` and that the `demuxer` option is
  correct; a WS server that replies before the FLV header (e.g. a greeting
  line) will trigger this too.

### `DEMUX_MISSING_SEQUENCE_HEADER`

- **Meaning** — encoded video frames arrived before the AVC (`avcC`) or HEVC
  (`hvcC`) sequence header, so no decoder config can be derived.
- **Typical causes** — server started mid-stream / keyframe-less tail, a
  record that begins with a delta frame, or a muxer that omits the sequence
  header.
- **Emitting layer** — FLV demuxer:
  `packages/plugins/flv/src/flv-demuxer.ts:219-224` (`received AVC NALU before
  the sequence header`) and `:260-265` (`received HEVC coded frames before the
  sequence header`).
- **What the app should do** — surface as a stream-quality issue; typically
  unrecoverable for that session. Restart playback (or have the server send
  from the beginning of the GOP). Nothing to fix client-side.

### `DECODE`

- **Meaning** — the WebCodecs decoder (or a soft decoder) could not be
  configured, rejected a decode, or failed while producing output.
- **Typical causes** — `VideoDecoder.configure()` threw (bad/unsupported
  config, closed decoder reuse), `decode()` called before `configure()`,
  WebCodecs fatal decode error (corrupt bitstream, hardware driver issue),
  `AudioContext` unavailable or audio output failure, libde265/dav1d WASM
  decode errors, soft decoder unable to build a `VideoFrame` from the decoded
  picture.
- **Emitting layer** — decoders:
  - WebCodecs video wrapper: `packages/core/src/decoder.ts:86` (`decoder
    configure failed`), `:92` (`decode called before configure`), `:104`
    (`decode failed`), `:159-162` (native decoder error callback).
  - Routing decoder: `packages/core/src/decoder-chain.ts:189` (soft impl
    `configure()` threw → `decoder configure failed`).
  - Audio: `packages/core/src/audio-decoder.ts:73,79,90,143`;
    `packages/core/src/audio-output.ts:42` (`AudioContext unavailable`), `:65`
    (`audio output failed`).
  - Soft decoders: `packages/plugins/hevc-wasm/src/hevc-soft-decoder.ts:110,
    121,133,179,227` (libde265 flush/push/result errors, VideoFrame
    construction); `packages/plugins/dav1d-wasm/src/dav1d-soft-decoder.ts:155,
    176` (dav1d frame decode, VideoFrame construction), both via their `fail()`
    helper (`hevc-soft-decoder.ts:293-299`, `dav1d-soft-decoder.ts:230-236`).
- **What the app should do** — surface as "decoder failed" and tear down (the
  engine already did). Retrying the same stream is usually futile for a fatal
  WebCodecs error; it may recover on a different browser/hardware. If it
  happens consistently on one codec, consider `forceSoft` / `softDecoder`
  (HEVC) or a different renderer. A transient `AudioContext` suspension
  (autoplay policy) is not fatal by itself — the engine falls back to the wall
  clock — but repeated `AudioContext unavailable` suggests the page's audio
  context is blocked.

### `BUFFER_OVERFLOW`

- **Meaning** — reserved. The SDK declares the code for future jitter-buffer
  overflow classification; **no code path emits it today** (verified: zero
  `BUFFER_OVERFLOW` references outside `types.ts`).
- **What the app should do** — handle it defensively like `DECODE` (it will be
  a decoder/buffer-layer fatal error if it ever ships); no current action
  required.

### `RENDERER`

- **Meaning** — a renderer `draw()` threw mid-playback.
- **Typical causes** — WebGPU/WebGL2 context loss, canvas resized away,
  texture upload failure, `importExternalTexture` failure, GL errors surfacing
  as throws.
- **Emitting layer** — renderer:
  - Runtime draw failures: `packages/core/src/render-surface.ts:22-27`
    (`drawOrClose` catches the throw, emits `RENDERER`; invoked from
    `scheduler.ts:169` and the direct-frame path `engine.ts:240`).
  - Creation-time failures throw `RendererError` (code `'RENDERER'`)
    synchronously from `createRendererAsync` instead of being emitted:
    `packages/renderer/src/factory.ts:21,49,65`; WebGL2 init:
    `webgl2-renderer.ts:50,111,120,124,129,137,155,159`; canvas2d:
    `canvas2d-renderer.ts:13`.
- **What the app should do** — surface as a display failure. Try recreating
  the player with a different `renderer` (e.g. `createRendererAsync(canvas,
  { prefer: 'webgl2' })` — WebGPU is preferred but can be unavailable, e.g.
  headless Firefox). A context-loss recovery typically requires rebuilding the
  renderer surface.

### `PLUGIN_COLLISION`

- **Meaning** — during `play()`, two plugins tried to claim the same plugin
  `id`, URL `scheme`, or `mimeType`.
- **Typical causes** — registering the same plugin twice, or two plugins that
  both claim `ws`/`wss` or the same mime type (e.g. two FLV demuxers).
- **Emitting layer** — plugin registry + engine:
  - `packages/plugin-sdk/src/registry.ts:18,26,36` throw
    `PluginCollisionError`; coerced by `packages/core/src/plugin-utils.ts:17-19`
    (`asMediaError`) and routed through `Engine.handleError` from the
    registration loop (`engine.ts:149-156`).
- **What the app should do** — this is a programming error: fix the plugin
  list passed to `createPlayer` (deduplicate, or remove the conflicting
  plugin). Never surface to end users.

### `UNSUPPORTED`

- **Meaning** — the engine cannot fulfill the request: the URL is unparseable,
  no demuxer/source/transport plugin matches, no decoder exists for the
  codec, or a source/decoder explicitly refuses the input.
- **Typical causes** — misspelled `demuxer` option or unsupported scheme
  (`rtsp://` with no transport plugin), no source plugin for the URL, browser
  without WebCodecs for the stream codec (and no soft decoder registered —
  e.g. HEVC in Firefox without `@vigilkit/plugin-hevc-wasm`), AV1/HEVC stream
  routed to a decoder that does not handle it (`not an HEVC codec: avc1...`),
  WHEP used in a browser without WebRTC / `MediaStreamTrackProcessor`,
  `PluginNotFoundError` from the registry.
- **Emitting layer** — engine, decoder, sources:
  - Engine: `packages/core/src/engine.ts:161` (`cannot parse url`), `:171-173`
    (`no demuxer or source plugin`), `:182` (`no transport plugin for url
    scheme`); transport pipeline `demuxer create failed` at
    `transport-pipeline.ts:52-56`; registry misses coerced by
    `plugin-utils.ts:21-23`.
  - Decoder: `packages/core/src/decoder-chain.ts:198-205` (`no decoder
    available for codec ...`); soft decoders reject foreign codecs at
    `hevc-soft-decoder.ts:59-60` and `dav1d-soft-decoder.ts:69-70`.
  - WHEP: `WhepUnsupportedError` (`whep-source.ts:49`) thrown at `:123`
    (WebRTC/processor unavailable), `:151` (invalid SDP), `:185` (no video
    media section), mapped to `UNSUPPORTED` at `:81-85`.
  - SDK: `PluginNotFoundError` (`plugin-sdk/src/errors.ts:12-18`, code
    `'UNSUPPORTED'`).
- **What the app should do** — configuration/feature mismatch: fix the plugin
  list, register the right soft decoder for HEVC-in-Firefox, use a supported
  scheme, or check the browser's WebCodecs support table before offering
  playback. Can be surfaced to the user as "not supported in this browser".

### `STALLED`

- **Meaning** — the QoS watchdog observed no data activity for longer than
  `fatalStallMs`: the jitter buffer is empty **and** the decoder is idle.
- **Typical causes** — network dead while the socket stays "open" (no error
  frame), the server stopped publishing, a hung demuxer/decoder (e.g. the
  known HEVC worker wedge), bitrate far above what the browser can keep up
  with, paused encoder on the server.
- **Emitting layer** — engine QoS watchdog:
  - `packages/core/src/qos.ts` (`StallMonitor`, lines 56-85) tracks
    episodes; `packages/core/src/scheduler.ts:150-162`
    (`watchStall`) fires `'stalled'` (event, non-fatal) when an episode starts
    and `mediaError('STALLED', ...)` when the episode outlives
    `fatalStallMs` (default 10 s, `scheduler.ts:12`; stall threshold default
    1.5 s, `scheduler.ts:11`). Tune via `PlayerOptions.qos.stallThresholdMs`
    / `qos.fatalStallMs` (`engine.ts:71-72`).
- **What the app should do** — treat as a connection-quality failure. Use the
  non-fatal `'stalled'` event for UI buffering indicators; on `STALLED`, tear
  down (already done) and retry with backoff, or switch source/variant (HLS
  `variant` option) to a lower bitrate. Consider raising `fatalStallMs` for
  jittery networks, but note the watchdog is deliberately conservative —
  silence means no frames are being produced or consumed.

### `NETWORK`

- **Meaning** — reserved (see the taxonomy comment in
  `packages/plugin-sdk/src/types.ts:2-7`): intended for future connection-level
  outage classification distinct from a stalled pipeline. **No code path
  emits it today** (verified: zero references outside `types.ts`).
- **What the app should do** — nothing today; handle it in the same
  retry-path as `TRANSPORT` if you want to be forward-compatible.

### `TIMEOUT`

- **Meaning** — the transport pipeline started a connect and did not observe
  `open` within the 10-second window (`CONNECT_TIMEOUT_MS`,
  `packages/core/src/transport-pipeline.ts:12`).
- **Typical causes** — server never answers the handshake (WS endpoint that
  accepts TCP but never completes), firewall silently dropping packets, WHEP
  server that never answers the offer POST, ICE that never connects.
- **Emitting layer** — engine transport pipeline:
  `packages/core/src/transport-pipeline.ts:112-118` (`mediaError('TIMEOUT',
  'connect timeout')`), cleared on `open` (`:83-84`).
- **What the app should do** — surface as "connection timed out" and retry
  with backoff. If the server is usually slow to handshake, this is a server
  problem, not a client one; there is no configurable timeout knob today.

---

## 4. Plugin-level error taxonomy

These are the concrete error classes plugins throw / surface. All of them
either carry a `code` that maps onto `MediaErrorCode` or define their own
vendor code set; the mapping into the engine's single error stream is noted
per class.

### `TransportError` — `@vigilkit/plugin-ws`

`packages/plugins/ws/src/errors.ts:1-8`. Carries `code = 'TRANSPORT'`.

- Thrown at `ws-transport.ts:96` (`invalid scheme`) when `connect()` is called
  with a non-`ws:`/`wss:` URL.
- Propagation: `TransportPipeline.tryCreate`
  (`transport-pipeline.ts:44-48`) catches it and emits a `TRANSPORT` media
  error with the message → engine.

### `DemuxError` — `@vigilkit/plugin-flv`

`packages/plugins/flv/src/errors.ts:9-22`. Carries a `MediaErrorCode` —
`'DEMUX'`, `'DEMUX_BAD_SIGNATURE'`, or `'DEMUX_MISSING_SEQUENCE_HEADER'`.

- Thrown for malformed AMF script data at `amf0.ts:126,142`.
- Propagation: caught by the demuxer's event loop (`flv-demuxer.ts:169-171`)
  and re-emitted as a `DEMUX` error event with the original message.

### `HlsError` — `@vigilkit/plugin-hls`

`packages/plugins/hls/src/errors.ts:6-19`. Carries `code: 'DEMUX' |
'UNSUPPORTED'`.

- Thrown at `hls-source.ts:102,105,116,191,206,215,220,240,245` and
  `aes-cbc.ts:23,55,74`. **All current throw sites use `'DEMUX'`**; the
  `'UNSUPPORTED'` variant is declared but not yet raised anywhere (verified by
  grep).
- Propagation: `hls-source.ts:73-76` (bootstrap) and `:140-143` (reload) catch
  it and dispatch a `DEMUX` error event → engine. The m3u8 parser itself never
  throws (best-effort, `m3u8/parser.ts:66,153`); the surrounding fetch and
  selection logic does.

### `MediaFormatError` — `@vigilkit/media-utils`

`packages/media-utils/src/errors.ts:5-18`. Carries `code = 'DEMUX'`.

- Thrown by shared format helpers when the bytes are malformed:
  `byte-reader.ts:87`, `bit-reader.ts:35,38,65`, `avc.ts:20,34,73,103`,
  `hevc.ts:100,120`, `hvcc.ts:96,101,118,125,156`, `aac.ts:17,25,30,73,81`.
- Propagation: FLV demuxer converts it to a `DEMUX` error event
  (`flv-demuxer.ts:336-341`); HLS TS demuxer converts it to a `DEMUX` error
  event when parameter sets are rejected (`ts-demuxer.ts:208-218`) or skips a
  byte and resyncs for ADTS (`:245-252`); anything else bubbles to the
  `hls-source` catch → `DEMUX` error event.

### `DahuaError` — `@vigilkit/plugin-dahua`

`packages/plugins/dahua/src/errors.ts:1-14`. Codes:
`'AUTH' | 'HTTP' | 'PARSE' | 'INVALID_ARGUMENT'`; optional `status` (HTTP).

| Code | Thrown at | Condition |
| --- | --- | --- |
| `AUTH` | `digest.ts:21` | Server did not issue a Digest `WWW-Authenticate` challenge |
| `AUTH` | `digest.ts:35` | Challenge missing `realm` or `nonce` |
| `HTTP` | `device.ts:87` | Request timed out after `timeoutMs` |
| `HTTP` | `device.ts:106` | Non-2xx response (`status` attached) |
| `HTTP` | `device.ts:120` | Non-2xx response after the auth retry (`status` attached) |
| `PARSE` | `xml.ts:23,31` | Response XML has no root element |
| `INVALID_ARGUMENT` | `device.ts:62` | `host` / `password` missing |
| `INVALID_ARGUMENT` | `device.ts:72` | No fetch implementation (pass `fetchImpl`) |
| `INVALID_ARGUMENT` | `device.ts:100` | Request path does not start with `/` |
| `INVALID_ARGUMENT` | `urls.ts:52` | Invalid channel number |
| `INVALID_ARGUMENT` | `urls.ts:61` | Invalid stream subtype |
| `INVALID_ARGUMENT` | `ptz.ts:40-43, 52-55` | Dahua has no pan/tilt/zoom `stop` code |
| `INVALID_ARGUMENT` | `ptz.ts:60` | Invalid channel number (PTZ path) |
| `INVALID_ARGUMENT` | `ptz.ts:63` | Invalid/empty PTZ code |

- **Propagation**: these are thrown synchronously by the plugin's own methods
  (`createDahuaClient(...).request(...)`, PTZ helpers, etc.) and are **not**
  routed through the engine — the app catches them where it calls the vendor
  API. They do not carry a `MediaErrorCode`.

### `HikvisionError` — `@vigilkit/plugin-hikvision`

`packages/plugins/hikvision/src/errors.ts:1-14`. Identical code set
(`'AUTH' | 'HTTP' | 'PARSE' | 'INVALID_ARGUMENT'`; optional `status`).

| Code | Thrown at | Condition |
| --- | --- | --- |
| `AUTH` | `digest.ts:21` | No Digest `WWW-Authenticate` challenge |
| `AUTH` | `digest.ts:35` | Challenge missing `realm` or `nonce` |
| `HTTP` | `device.ts:82` | Request timed out after `timeoutMs` |
| `HTTP` | `device.ts:101` | Non-2xx response (`status` attached) |
| `HTTP` | `device.ts:115` | Non-2xx response after the auth retry (`status` attached) |
| `PARSE` | `isapi.ts:23,31` | Response XML has no root element |
| `INVALID_ARGUMENT` | `device.ts:57` | `host` / `password` missing |
| `INVALID_ARGUMENT` | `device.ts:67` | No fetch implementation (pass `fetchImpl`) |
| `INVALID_ARGUMENT` | `device.ts:95` | Request path does not start with `/` |
| `INVALID_ARGUMENT` | `urls.ts:40` | Invalid channel number |
| `INVALID_ARGUMENT` | `ptz.ts:51` | Unknown PTZ direction |
| `INVALID_ARGUMENT` | `ptz.ts:79, 87` | Invalid channel number (PTZ paths) |
| `INVALID_ARGUMENT` | `ptz.ts:90` | Invalid preset number |

- **Propagation**: same as `DahuaError` — synchronous throws from the plugin's
  own API surface; the app handles them at the call site.

### `RendererError` — `@vigilkit/renderer`

`packages/renderer/src/errors.ts:1-8`. Carries `code = 'RENDERER'`.

- Thrown synchronously by `createRendererAsync` when no backend can be
  created: `factory.ts:21,65` (`no renderer available`), `:49` (`webgpu
  unavailable`); WebGL2 init failures at `webgl2-renderer.ts:50,111,120,124,
  129,137,155,159`; canvas2d unavailable at `canvas2d-renderer.ts:13`.
- **Propagation**: synchronous — `createRendererAsync` rejects/throws before
  any player exists; it never appears as a media error event. The `RENDERER`
  *media* error (section 3) is a different, runtime path via
  `render-surface.ts`.

### `PluginCollisionError` / `PluginNotFoundError` — `@vigilkit/plugin-sdk`

`packages/plugin-sdk/src/errors.ts:3-18`. Codes `'PLUGIN_COLLISION'` (registry
duplicates, `registry.ts:18,26,36`) and `'UNSUPPORTED'` (no plugin for the
request). Both are converted by `asMediaError` (`core/plugin-utils.ts:15-23`)
and surfaced as engine media errors during `play()`.

### `WhepUnsupportedError` — `@vigilkit/plugin-whep` (internal)

`packages/plugins/whep/src/whep-source.ts:49`. Not exported; thrown when the
environment lacks WebRTC / `MediaStreamTrackProcessor` / the encoded-path
APIs (`:123`), the server SDP is invalid (`:151`), or the answer has no video
media section (`:185`). Mapped to an `UNSUPPORTED` media error
(`:81-85`); every other WHEP connect failure maps to `TRANSPORT` (see above).

> **`SipError`** — no SIP error class exists yet: the `gb28181` plugin is not
> present in this repository (checked `packages/plugins/`), so there is no
> SipError taxonomy to document. The `ps` plugin likewise does not exist yet.

---

## 5. Consumer-facing troubleshooting checklist

| Symptom (`error.code`) | Checklist |
| --- | --- |
| `TIMEOUT` | Is the server actually listening? Does a handshake complete in another client (browser WebSocket, `wscat`)? Firewall/proxy dropping the SYN or the WS upgrade? |
| `TRANSPORT` (WS) | Server up? Wrong port/path? TLS cert valid for `wss`? CORS irrelevant for WS, but check reverse-proxy timeout settings. Enable `reconnect` for transient drops. Was it "closed before connecting" (engine.ts:215) — i.e. the server closed the socket during handshake? |
| `TRANSPORT` (WHEP) | Is the endpoint a real WHEP resource (draft-ietf-wish-whep)? Does the POST return 2xx/406 with SDP? PATCH answer/candidate failures → check server logs. ICE failed/disconnected → check STUN/TURN reachability. |
| `DEMUX_BAD_SIGNATURE` | Point the URL at a real FLV stream; check the server isn't sending an HTTP body / banner before FLV bytes. |
| `DEMUX_MISSING_SEQUENCE_HEADER` | Server start-at-live-edge issue; restart the stream from the beginning of the GOP. |
| `DEMUX` (FLV) | Container mismatch? Corrupt/truncated capture? Legacy HEVC-FLV (unsupported framing)? AAC/HEVC configs malformed? |
| `DEMUX` (HLS) | HTTP status on playlist/segment/key? CORS headers present on all responses? AES-128 key URL reachable, IV valid, key 16/24/32 bytes? PMT has no H.264/HEVC/AAC → different MPEG-TS mux? Variant selection index out of range? |
| `DECODE` | Browser WebCodecs support for the codec+profile? Try `forceSoft` + `softDecoder` for HEVC. Corrupt bitstream? Hardware decoder driver issue → try another browser. Autoplay policy blocking `AudioContext`? |
| `UNSUPPORTED` | URL scheme has a transport/source plugin registered? `demuxer` option typo? HEVC in Firefox without `@vigilkit/plugin-hevc-wasm`? AV1 without `@vigilkit/plugin-dav1d-wasm`? WHEP needs WebRTC + `MediaStreamTrackProcessor`. |
| `PLUGIN_COLLISION` | Duplicate plugin instances or two plugins claiming the same id/scheme/mime in the `plugins` array. |
| `RENDERER` | Context loss → rebuild surface. Headless/GPU-less environment → prefer `webgl2`/`canvas2d` explicitly. Creation-time `RendererError` from `createRendererAsync` → catch it and fall back. |
| `STALLED` | Network silent-dead (no close frame)? Server still publishing? Decoder wedged (worker)? Lower the bitrate / switch HLS variant; tune `qos.fatalStallMs`. Watch the non-fatal `'stalled'` events for early warning. |
| `BUFFER_OVERFLOW` / `NETWORK` | Reserved — nothing emits these yet; forward-compatible handling only. |

---

## 6. Supporting references

- Taxonomy source: `packages/plugin-sdk/src/types.ts:8-13` (`MediaErrorCode`,
  `MediaErrorInfo`; the doc comment explains the `NETWORK` / `STALLED` /
  `TIMEOUT` split).
- Engine error helpers: `packages/core/src/errors.ts` (`VigilkitError`,
  `mediaError`).
- Error event contracts: `DemuxerEvent['error']` /
  `TransportEvent['error']` in `packages/plugin-sdk/src/types.ts:47,53`.
- Player surface: `'error'` / `'stalled'` events and `PlayerStats.errors` in
  `packages/core/src/engine.ts` (emission `:255`, accumulation `:128`).
- QoS watchdog: `packages/core/src/qos.ts` + tuning knobs
  `PlayerOptions.qos` (`engine.ts:71-72`).
