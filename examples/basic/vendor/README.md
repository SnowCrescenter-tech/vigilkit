# Vendored libde265 WASM

Physically isolated LGPL-3.0 module used for HEVC soft-decode in browsers without native HEVC WebCodecs (e.g. Firefox). Loaded only when HEVC playback is requested.

- Source: npm package `@yume-chan/libde265@1.0.0` (tarball from `npm pack`)
- Files:
  - `libde265-esm.js` — ESM dist (package `browser`/`type: module` entry, `libde265.mjs` in the tarball). Exports a default async function that returns the Emscripten Module exposing the `Decoder` class.
  - `libde265.wasm` — the WebAssembly binary (resolved at runtime via `new URL("libde265.wasm", import.meta.url)`, so it must live next to `libde265-esm.js`).
- SHA-256 (`libde265-esm.js`): 3d431114c87569ff71b3a8f434c3a67ba8239fbef18cea80e2f22e5049d7b0ab
- SHA-256 (`libde265.wasm`): 440c6bbc60af222e72141583ce583423b0b8dd3fe0b53e823fa2e99988eca5b8
- License: LGPL-3.0-only

## Which hash is which (two sha256 pins, two purposes)

There are two digest files in the plugin and this directory, and they cover different artifacts:

- `libde265.sha256` (in this directory) pins **the ESM wrapper** `libde265-esm.js`. The plugin's smoke test (`packages/plugins/hevc-wasm/scripts/smoke.mjs`) re-hashes the ESM file and fails if it drifts from this pin.
- The runtime loader in `@vigilkit/plugin-hevc-wasm` (`libde265-loader.ts`) verifies **the wasm binary** `libde265.wasm`, and it expects the hash listed above for `libde265.wasm` (`440c6bbc…`). That wasm digest is intentionally documented here rather than in `libde265.sha256`, so the loader and the smoke test read the same number from the same file. If the wasm file ever changes, update this README's `libde265.wasm` hash; if the ESM wrapper ever changes, update `libde265.sha256`.

## LGPL-3.0 source offer

This vendored artifact is LGPL-3.0. Source code: https://github.com/yume-chan/libde265 or the npm package tarball. It is loaded as a physically isolated module; the vigilkit packages themselves are Apache-2.0. Re-linking: replace this file with any build of libde265 exposing the same ESM API.

## API shape (Node 22 smoke-verified)

The Emscripten module is built with `ENVIRONMENT_IS_WORKER` hardcoded, so in Node its `fetch(file://)` fails and its XHR fallback does not exist. Inject the wasm bytes as the standard Emscripten `wasmBinary` module option:

```js
import { readFileSync } from 'node:fs';
import createModule from './libde265-esm.js'; // default export is an async factory

const wasmBinary = new Uint8Array(readFileSync('./libde265.wasm'));
const mod = await createModule({ wasmBinary }); // Emscripten Module instance
// mod.Decoder is the HEVC decoder constructor
```

In the browser the module can load the wasm itself (`new URL("libde265.wasm", import.meta.url)`); passing `wasmBinary` only matters when running under Node.
