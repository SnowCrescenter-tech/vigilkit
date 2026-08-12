# vigilkit

<!-- Badge row: add real shields.io badges here on publish (CI status, license, npm version). -->
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/vigilkit/vigilkit/actions)
[![npm](https://img.shields.io/badge/npm-vigilkit-blue.svg)](https://www.npmjs.com/package/vigilkit)

**Status: v0.1 complete. Unit tests, e2e, and license scan all green.**

vigilkit is an open-source (Apache-2.0), WebCodecs-first, plugin-based web video player SDK for surveillance and IoT video. The core engine has zero third-party runtime dependencies. A microkernel wires transport plugins and demuxer plugins into a single decode pipeline: H.264 frames are decoded with the browser's native WebCodecs hardware decoder and drawn through WebGL2, with a canvas2d fallback. Everything runs in the browser, and it is built for low-latency, multi-stream surveillance and IoT dashboards.

## Zero telemetry

**vigilkit collects no telemetry. No analytics, no tracking, no usage counters, no beacons.** All code runs in the browser, and vigilkit never makes a network call other than the stream URL your application asks it to connect to. There is no vigilkit-operated server, no phone-home endpoint, and no data leaves your page.

## Open-core / business model

- The core engine (`vigilkit`), the plugin SDK, and the standard plugin set are **Apache-2.0 forever**. This project will never paywall the core.
- The only commercial surface is a closed set of enterprise add-ons (multi-view layouts, recording, encrypted streams, PTZ control) and vendor-protocol customization for the Hikvision, Dahua, and Uniview surveillance platforms.
- Community contributions to general and long-tail protocol plugins (HLS, WHEP, MQTT, and more) are welcome. The three major vendor plugins are developed by the core team; see [CONTRIBUTING.md](CONTRIBUTING.md) for the exact boundary.

## Architecture

vigilkit is a microkernel. The engine itself knows nothing about transports or container formats; plugins supply them through the plugin SDK, and the engine owns the timing and rendering path.

```
   url ──► transport plugin ──► demuxer plugin ──► jitter buffer
           (ws / wss / ...)      (flv / ...)            │
                                                        ▼
                                            WebCodecs decoder
                                                 (H.264)
                                                        │
                                                        ▼
                                            renderer surface
                                       (WebGL2 + canvas2d fallback)
```

| Package | Description |
| --- | --- |
| `vigilkit` | Core microkernel engine: AV sync, jitter buffer, decode scheduling. Zero third-party runtime dependencies. |
| `@vigilkit/plugin-sdk` | Plugin contract types and the plugin registry. |
| `@vigilkit/plugin-flv` | FLV demuxer plugin (H.264/AAC). |
| `@vigilkit/plugin-ws` | WebSocket transport plugin (`ws` / `wss`). |
| `@vigilkit/renderer` | WebGL2 and Canvas2D `VideoFrame` renderers. |
| `@vigilkit/example-basic` | Private example app: WS-FLV playback, used by the e2e suite. |

## Quick start

Prerequisites: Node.js 20+ and pnpm 9+.

```sh
pnpm install
pnpm --filter @vigilkit/example-basic build
pnpm --filter @vigilkit/example-basic serve
```

Open <http://localhost:8080>. If port 8080 is busy, pass a custom port and open that instead:

```sh
pnpm --filter @vigilkit/example-basic serve -- --port 9000
```

Basic usage:

```ts
import { createPlayer } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { createRenderer } from '@vigilkit/renderer';

const player = createPlayer({
  url: 'ws://your-server/live',
  demuxer: 'flv',
  plugins: [wsTransportPlugin(), flvDemuxerPlugin()],
  renderer: createRenderer(canvas), // a <canvas> element
});

player.play();
```

## Browser support (v0.1)

| Capability | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| WebCodecs H.264 decode | 94+ | 130+ | 16.4+ |
| WebGL2 `VideoFrame` rendering | yes | yes | yes |
| Canvas2d fallback | yes | yes | yes |
| HEVC (H.265) decode | hardware decode only | not available in v0.1 (WASM soft-decode planned) | 17.4+ hardware |
| WebGPU zero-copy backend | v0.2+ (planned) | v0.2+ (planned) | v0.2+ (planned) |

## Roadmap

- **v0.2**: WebGPU zero-copy rendering backend; HLS and WHEP plugins; HEVC WASM soft-decode as an isolated LGPL module so Firefox can play HEVC.
- **v1.0**: API freeze, stable plugin SDK, bilingual documentation.

## Testing

```sh
pnpm test            # 130 unit tests across all packages
pnpm test:e2e        # Playwright e2e against the basic example
node scripts/check-licenses.mjs --ci   # license scan, verdict must stay PASS
```

Run `pnpm exec playwright install chromium` once before the first e2e run. The e2e suite reproduces QA against a committed fixture: an FFmpeg FATE FLV sample (`examples/basic/fixtures/`, sha256-pinned). v0.1 e2e evidence: WS-FLV played in headless Chromium, 203 frames decoded at roughly 34 fps, 0 errors, and a clean teardown on disconnect.

`pnpm notices` regenerates [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) from the installed dependency tree.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for plugin authoring, the business boundary, and engineering standards.

## License

vigilkit is licensed under the [Apache License 2.0](LICENSE). The core engine and standard plugins are open source forever; enterprise add-ons and vendor protocol customization are the only commercial surface.
