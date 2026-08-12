# Contributing to vigilkit

Thanks for considering a contribution. This document covers how the repository is organized, how to add a plugin, the project's business boundary, and the engineering standards every PR must meet.

## Repository layout

```
packages/
  core/            vigilkit (microkernel engine, zero third-party runtime deps)
  plugin-sdk/      @vigilkit/plugin-sdk (contract types + registry)
  plugins/
    flv/           @vigilkit/plugin-flv (demuxer)
    ws/            @vigilkit/plugin-ws (transport)
  renderer/        @vigilkit/renderer (WebGL2 + Canvas2D surfaces)
examples/
  basic/           @vigilkit/example-basic (private example app + e2e fixture)
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
- **Zero third-party runtime dependencies in lib packages**: `vigilkit`, `@vigilkit/plugin-sdk`, plugins, and `@vigilkit/renderer` may depend only on workspace packages. Tooling lives in `devDependencies`. This is what keeps the core a true zero-dependency engine.
- **License scan must stay PASS**: CI runs `node scripts/check-licenses.mjs --ci`, which fails on any GPL, AGPL, or LGPL dependency, direct or transitive. Run it locally before pushing. If you must add a dependency, check its license first. Do not add `@ffmpeg/core`, `h265webjs`, `x264`, `x265`, `fdk-aac`, or any other GPL or proprietary component. LGPL-licensed HEVC software decode is planned only as an isolated, separately distributed WASM module.
- **No vendor SDK or GPL-derived code**: the vendor protocol plugins are written from scratch. Never copy vendor SDK code or code from GPL reverse-engineering projects.

## Business boundary (read before contributing a plugin)

This project is open core. Where the open part ends matters, so it is stated explicitly.

- **Welcome from the community**: general and long-tail protocol plugins such as HLS, WHEP, MQTT, WebTransport/MoQ, and similar. Open an issue to discuss the design, then submit the PR. Standard open-source process applies.
- **Reserved to the core team**: the three major vendor plugins for Hikvision, Dahua, and Uniview. These are the project's monetization surface, developed in-house as part of the commercial offering. Do not implement these, and do not submit PRs for them, without coordinating with the maintainers first. Uncoordinated vendor-plugin PRs will be closed with a pointer to this policy.
- **Why this boundary exists**: the project commits to keeping the core and standard plugins Apache-2.0 forever. Vendor-protocol work funds that commitment. A blanket rule keeps it predictable for everyone.

If you are unsure whether a plugin falls on the community side, ask in the issue tracker before writing code.

## Adding a transport or demuxer plugin

A plugin is a plain object that satisfies the contract in `@vigilkit/plugin-sdk`. The engine never imports plugin code directly; it resolves plugins through the registry at runtime.

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

`Demuxer` is `push(chunk)`, `flush()`, `onEvent(listener)`, and `close()`. A demuxer parses container bytes and emits demuxer events: `metadata`, `sequence-header` (a `VideoDecoderConfig`), `video` / `audio` chunks, and `error`.

Reference implementation: `packages/plugins/flv/` (`flv-demuxer.ts` + `plugin.ts`).

### Steps

1. **Open an issue** proposing the plugin (schemes, mime types, format support scope). This catches registry collisions early: the registry rejects a plugin whose `id`, `scheme`, or `mimeType` is already claimed, raising `PluginCollisionError`.
2. **Scaffold** `packages/plugins/<name>/` mirroring the WS or FLV package: `package.json` (name `@vigilkit/plugin-<name>`, Apache-2.0, only workspace deps), `tsconfig.json`, `src/` split into files under 250 lines, and a factory function `<name>Plugin()`.
3. **Write tests first** (TDD): unit tests for the parser and for the plugin contract. For demuxers, feed real container bytes; the committed FLV fixture under `examples/basic/fixtures/` is a convenient source.
4. **Implement** until the tests pass. Keep the contract types from `@vigilkit/plugin-sdk`, do not redefine them.
5. **Wire up an example** (optional but appreciated): register the plugin in `examples/basic/src/main.ts` so the e2e surface can grow.
6. **Verify**: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, and `node scripts/check-licenses.mjs --ci` all clean.
7. **Submit the PR** and reference the design issue.

## Contribution agreement

By contributing, you agree that your contribution is licensed under the Apache License 2.0, the same license as the project (see [LICENSE](LICENSE)). For larger contributions, the maintainers may ask you to confirm authorship of the code and that you have the right to license it.
