# vigilkit API reference

This site documents the public TypeScript API of the vigilkit monorepo, built
from the source entry points with [TypeDoc](https://typedoc.org/). It is
generated locally with `pnpm docs` (root script; not part of CI).

## Packages covered

| Package | Entry point | What it provides |
| --- | --- | --- |
| `vigilkit` | `packages/core/src/index.ts` | The microkernel engine: `createPlayer`, `PlayerOptions` / `PlayerEvents` / `PlayerStats`, the codec-routing decoder interfaces, and the QoS plumbing. |
| `@vigilkit/plugin-sdk` | `packages/plugin-sdk/src/index.ts` | The plugin contract: `Transport`, `Demuxer`, `MediaSource`, their plugins and event unions, `MediaErrorCode` / `MediaErrorInfo`, and `PluginRegistry`. |
| `@vigilkit/media-utils` | `packages/media-utils/src/index.ts` | Shared byte-reader / NALU / AVC / HEVC / AAC helpers used by the demuxer plugins. |
| `@vigilkit/plugin-flv` | `packages/plugins/flv/src/index.ts` | FLV demuxer plugin (H.264/AAC). |
| `@vigilkit/plugin-ws` | `packages/plugins/ws/src/index.ts` | WebSocket transport plugin with optional reconnect. |
| `@vigilkit/plugin-hls` | `packages/plugins/hls/src/index.ts` | HLS source plugin (m3u8 + MPEG-TS, VOD + live + ABR). |
| `@vigilkit/plugin-whep` | `packages/plugins/whep/src/index.ts` | WHEP (WebRTC egress) source plugin. |
| `@vigilkit/plugin-hevc-wasm` | `packages/plugins/hevc-wasm/src/index.ts` | libde265 WASM soft-decode adapter (HEVC). |
| `@vigilkit/plugin-dav1d-wasm` | `packages/plugins/dav1d-wasm/src/index.ts` | dav1d WASM soft-decode adapter (AV1). |
| `@vigilkit/plugin-hikvision` | `packages/plugins/hikvision/src/index.ts` | Hikvision ISAPI vendor plugin (Digest auth, PTZ, URLs). |
| `@vigilkit/plugin-dahua` | `packages/plugins/dahua/src/index.ts` | Dahua CGI vendor plugin (Digest auth, PTZ, URLs). |
| `@vigilkit/renderer` | `packages/renderer/src/index.ts` | `createRendererAsync` with WebGPU → WebGL2 → canvas2d fallback. |

## Related documentation

- [Error codes reference](./error-codes.md) — every `MediaErrorCode` and
  plugin-level error, where each is raised, and how to react.
- [Architecture overview](./vigilkit-architecture.svg)

## Regenerating

```sh
pnpm install   # once, to fetch the typedoc devDependency
pnpm docs      # rebuild docs/api/
```

The output lands in `docs/api/` (start at `docs/api/index.html`). The site is a
manual/local artifact — it is not wired into CI.
