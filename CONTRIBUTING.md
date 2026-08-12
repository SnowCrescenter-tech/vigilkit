# Contributing to vigilkit

Thanks for considering a contribution. This document covers how the repository is organized, how to add a plugin, the project's business boundary, and the engineering standards every PR must meet.

## Repository layout

```
packages/
  core/            vigilkit (microkernel engine, zero third-party runtime deps)
  plugin-sdk/      @vigilkit/plugin-sdk (contract types + registry)
  media-utils/     @vigilkit/media-utils (shared byte-reader / NALU / AVC helpers)
  plugins/
    flv/           @vigilkit/plugin-flv (demuxer, built on media-utils)
    ws/            @vigilkit/plugin-ws (transport)
    hls/           @vigilkit/plugin-hls (source plugin: m3u8 + MPEG-TS)
    hevc-wasm/     @vigilkit/plugin-hevc-wasm (libde265 soft-decoder adapter)
    whep/          @vigilkit/plugin-whep (WHEP WebRTC egress source plugin)
  renderer/        @vigilkit/renderer (WebGPU + WebGL2 + Canvas2D surfaces)
examples/
  basic/           @vigilkit/example-basic (private example app + e2e fixtures)
  basic/vendor/    Vendored libde265 WASM artifact (LGPL-3.0, sha256-pinned, isolated)
e2e/               Playwright browser QA
scripts/           tooling (license scan, fixture fetch)
```

## Development workflow

Prerequisites: Node.js 20+ and pnpm 9+.

```sh
pnpm install

pnpm lint                     # ESLint over the monorepo
pnpm -r typecheck             # strict TypeScript, all packages
pnpm -r test                  # unit tests (vitest)
pnpm test:e2e                 # Playwright e2e (first run: pnpm exec playwright install chromium)

node scripts/check-licenses.mjs --ci   # license scan, must stay PASS
```

## Engineering standards

Every package and every PR must satisfy all of the following. These are enforced in review and partly in CI.

- **TDD**: write a failing test before the implementation. Each feature or fix lands with tests that exercise the real behavior, not just happy-path mocks. Browser-boundary code uses the fake decoder fixture (`packages/core/src/fake-video-decoder.fixture.ts`).
- **Strict TypeScript**: `strict: true` everywhere (see `tsconfig.base.json`). No `any`, no `ts-ignore`, no `@ts-expect-error` used to dodge real type problems. Type-only imports where the value is not needed.
- **File size ceiling**: no source file over 250 lines. Split by responsibility (demuxer, parser helpers, errors, plugin factory) as the FLV package does.
- **Zero third-party runtime dependencies in lib packages**: `vigilkit`, `@vigilkit/plugin-sdk`, `@vigilkit/media-utils`, plugins, and `@vigilkit/renderer` may depend only on workspace packages. Tooling lives in `devDependencies`. This is what keeps the core a true zero-dependency engine.
- **Share demuxer plumbing via `@vigilkit/media-utils`**: byte readers, NALU walking, and AVC helpers live in `media-utils`, not inside individual plugins. FLV and HLS both consume it; a new demuxer or source plugin should too, instead of re-implementing byte handling.
- **License scan must stay PASS**: CI runs `node scripts/check-licenses.mjs --ci`, which fails on any GPL, AGPL, or LGPL dependency, direct or transitive. Run it locally before pushing. If you must add a dependency, check its license first. Do not add `@ffmpeg/core`, `h265webjs`, `x264`, `x265`, `fdk-aac`, or any other GPL or proprietary component.
- **Vendored-artifact policy (the LGPL boundary)**: LGPL is allowed in exactly one form: a physically isolated, runtime-loaded WASM artifact that is never an npm dependency. `@vigilkit/plugin-hevc-wasm` is the reference: it vendors `@yume-chan/libde265` artifacts under `examples/basic/vendor/`, pins them with a sha256 that the loader verifies at load time, ships an LGPL source offer, and keeps the adapter's own code Apache-2.0. Any new LGPL-copyleft code must follow the same pattern: isolated artifact, sha256-pinned, NOTICE + source offer, never a dependency. Never add an LGPL package to `dependencies`; the license scan will reject it.
- **No vendor SDK or GPL-derived code**: the vendor protocol plugins are written from scratch. Never copy vendor SDK code or code from GPL reverse-engineering projects.

## Business boundary (read before contributing a plugin)

This project is open core. Where the open part ends matters, so it is stated explicitly.

- **Welcome from the community**: general and long-tail protocol plugins such as HLS, WHEP, MQTT, WebTransport/MoQ, and similar. Open an issue to discuss the design, then submit the PR. Standard open-source process applies.
- **Reserved to the core team**: the three major vendor plugins for Hikvision, Dahua, and Uniview. These are the project's monetization surface, developed in-house as part of the commercial offering. Do not implement these, and do not submit PRs for them, without coordinating with the maintainers first. Uncoordinated vendor-plugin PRs will be closed with a pointer to this policy.
- **Why this boundary exists**: the project commits to keeping the core and standard plugins Apache-2.0 forever. Vendor-protocol work funds that commitment. A blanket rule keeps it predictable for everyone.

If you are unsure whether a plugin falls on the community side, ask in the issue tracker before writing code.

## Adding a transport, demuxer, or source plugin

A plugin is a plain object that satisfies the contract in `@vigilkit/plugin-sdk`. The engine never imports plugin code directly; it resolves plugins through the registry at runtime. Transport and demuxer plugins existed in v0.1; source plugins arrived in v0.2 and are the recommended shape for whole-container formats like HLS, with WHEP (v0.3) as the direct-frame variant.

### Transport plugin

Implements `TransportPlugin` (`packages/plugin-sdk/src/types.ts`):

```ts
export interface TransportPlugin {
  type: 'transport';
  id: string;
  schemes: readonly string[];   // e.g. ['ws', 'wss']
  create(url: string): Transport;
}
```

`Transport` is `connect()`, `close()`, and `onEvent(listener)` which returns an unsubscribe function. Events are `open`, `data` (raw `Uint8Array`), `close`, and `error` (`MediaErrorInfo`).

Reference implementation: `packages/plugins/ws/` (`ws-transport.ts` + `plugin.ts`).

### Demuxer plugin

Implements `DemuxerPlugin`:

```ts
export interface DemuxerPlugin {
  type: 'demuxer';
  id: string;
  mimeTypes: readonly string[]; // e.g. ['video/x-flv']
  schemes: readonly string[];   // e.g. ['flv']
  create(): Demuxer;
}
```

`Demuxer` is `push(chunk)`, `flush()`, `onEvent(listener)`, and `close()`. A demuxer parses container bytes and emits demuxer events: `metadata`, `sequence-header` (a `VideoDecoderConfig`), `audio-config` (an `AudioDecoderConfig`), `video` / `audio` chunks, `frame` (a direct decoded `VideoFrame`), and `error`.

**Audio-config emission:** a demuxer that carries audio must emit `audio-config` once, before its first `audio` chunk, so the engine can configure its WebCodecs `AudioDecoder`. Audio chunks carry the raw encoded payload with no container framing. FLV is the reference: it emits the AAC AudioSpecificConfig from the AAC sequence header and passes AAC RAW packets through unchanged. HLS derives the config from the first ADTS frame and strips the ADTS headers from the payload (see `packages/plugins/hls/src/ts/ts-demuxer.ts`).

Reference implementation: `packages/plugins/flv/` (`flv-demuxer.ts` + `plugin.ts`).

### Source plugin

A source plugin replaces the transport + demuxer pair when the format is self-fetching: it owns fetching, parsing, and demuxing all in one object. This is the shape of the HLS plugin and the recommended route for any format where the container itself tells you where the media lives (m3u8 playlists, MPEG-DASH manifests, and so on).

Implements `SourcePlugin` (`packages/plugin-sdk/src/types.ts`):

```ts
export interface SourcePlugin {
  type: 'source';
  id: string;
  mimeTypes: readonly string[];   // e.g. ['application/vnd.apple.mpegurl', 'application/x-mpegURL']
  schemes: readonly string[];     // e.g. ['http', 'https']
  create(url: string, options?: SourceOptions): MediaSource;
}

export interface MediaSource {
  start(): void;             // begin fetching/parsing (called by engine on play)
  stop(): void;              // stop fetching; idempotent; no events after stop
  onEvent(listener: (event: DemuxerEvent) => void): () => void;  // same event union as Demuxer
}
```

`MediaSource` emits the same event union as a `Demuxer` (`metadata`, `sequence-header`, `audio-config`, `video` / `audio` chunks, `frame`, `error`), so the engine treats it uniformly once the source branch resolves the URL scheme. The engine calls `create(url, sourceOptions)` when a matching plugin claims the URL scheme, then `start()` on play and `stop()` on teardown. `SourceOptions.variant` selects HLS ABR variant (`'lowest' | 'highest' | number`, default `'lowest'`).

Reference implementation: `packages/plugins/hls/` (m3u8 parser + MPEG-TS demuxer + `hls-source.ts` + `plugin.ts`). Note how it builds on `@vigilkit/media-utils` for byte reading and NALU handling rather than re-implementing them.

**Direct-frame sources (the WHEP pattern):** a source plugin that receives already-decoded media can emit `{ type: 'frame', frame }` events instead of encoded chunks. The `frame` event bypasses the encoded decode chain entirely: no `sequence-header`, no codec routing, no jitter-buffer scheduling. The engine counts each frame like a scheduler-decoded frame, hands it to the renderer (which takes ownership), and closes it itself when no renderer is attached. Ownership rules for the emitting source:

- Never close a frame after dispatching it to the engine.
- Close any frame read after `stop()` instead of dispatching it (the engine owns every frame it was handed).

Reference implementation: `packages/plugins/whep/` (`whep-source.ts` + `whep-sdp.ts` + `plugin.ts`). It POSTs an SDP offer to a WHEP resource URL, adopts the server's answer (or answers a 406 counter-offer via PATCH), trickles ICE candidates over PATCH, and reads decoded `VideoFrame`s from a `MediaStreamTrackProcessor`. Note that it claims no URL schemes: WHEP resource URLs are plain `http(s)` endpoints that already belong to the HLS source, so the engine resolves the plugin by source id (`demuxer: 'whep'`) instead.

### Steps

1. **Open an issue** proposing the plugin (schemes, mime types, format support scope). This catches registry collisions early: the registry rejects a plugin whose `id`, `scheme`, or `mimeType` is already claimed, raising `PluginCollisionError`.
2. **Scaffold** `packages/plugins/<name>/` mirroring the WS, FLV, HLS, or WHEP package: `package.json` (name `@vigilkit/plugin-<name>`, Apache-2.0, only workspace deps), `tsconfig.json`, `src/` split into files under 250 lines, and a factory function `<name>Plugin()`. For demuxers and source plugins, depend on `@vigilkit/media-utils` for byte-reader / NALU / AVC helpers instead of hand-rolling them. Mirror WHEP when your source hands out already-decoded frames, HLS when it self-fetches an encoded container.
3. **Write tests first** (TDD): unit tests for the parser and for the plugin contract. For demuxers, feed real container bytes; the committed FLV fixture under `examples/basic/fixtures/` is a convenient source. Assert the `audio-config` ordering explicitly (it must precede the first `audio` chunk). For soft-decoder adapters, the HEVC plugin's Node smoke test (`pnpm --filter @vigilkit/plugin-hevc-wasm smoke`) decodes a real fixture end to end.
4. **Implement** until the tests pass. Keep the contract types from `@vigilkit/plugin-sdk`, do not redefine them.
5. **Wire up an example** (optional but appreciated): register the plugin in `examples/basic/src/main.ts` so the e2e surface can grow.
6. **Verify**: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, and `node scripts/check-licenses.mjs --ci` all clean.
7. **Submit the PR** and reference the design issue.

## Writing a soft decoder plugin (HEVC boundary)

Browsers without native HEVC WebCodecs need a software decoder. `@vigilkit/plugin-hevc-wasm` is the reference: an Apache-2.0 adapter that implements the core's `VideoCodecDecoder` interface around the LGPL-3.0 libde265 WASM build, registered through `SoftVideoDecoderFactory` and selected by `CodecRoutingDecoder` after the WebCodecs probe fails (or `forceSoft: true` forces it).

If you extend HEVC soft-decode, the LGPL boundary rules apply:

- **Only `@yume-chan/libde265` artifacts** are allowed as the vendored binary. No other LGPL/GPL decoder may be added to the dependency tree.
- The artifact **must stay physically isolated**: vendored under `examples/basic/vendor/`, never an npm dependency, never imported into package JavaScript. The adapter reaches it through a sha256-verified loader (`loadLibde265`) that injects the wasm via the standard Emscripten `wasmBinary` option.
- Any change to the vendored files must update **both** pins: the ESM hash in `examples/basic/vendor/libde265.sha256` and the wasm hash documented in `examples/basic/vendor/README.md` (the loader verifies the wasm hash; the smoke script re-verifies the ESM hash). Keep the NOTICE + source offer accurate.
- **Worker-path caveat**: the HEVC demo supports `?worker=1` to decode off the main thread, but headless Chromium can wedge the vendored wasm inside a dedicated worker (native wasm spin, no message, no return). The main-thread path is the tested default; treat the worker path as experimental until the wedge is understood.

## Contribution agreement

By contributing, you agree that your contribution is licensed under the Apache License 2.0, the same license as the project (see [LICENSE](LICENSE)). For larger contributions, the maintainers may ask you to confirm authorship of the code and that you have the right to license it.
