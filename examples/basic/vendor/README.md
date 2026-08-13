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

---

# Vendored dav1d WASM (AV1)

Physically isolated BSD-2-Clause dav1d core + CC0-1.0 wrapper module used for AV1 soft-decode in browsers without native AV1 WebCodecs (e.g. older Safari / Firefox Android). Loaded only when AV1 playback is requested.

- Source: npm package `dav1d.js@0.1.1` (tarball from `npm pack`; repo https://github.com/Kagami/dav1d.js)
- Files:
  - `dav1d-esm.js` — the package's ESM wrapper (`dav1d.js` in the tarball). Exports `default = { create({ wasmData }) }`; `create` returns a `Dav1d` instance with `decodeFrameAsYUV(obu)` / `decodeFrameAsBMP(obu)` / `unsafeCleanup()`.
  - `dav1d.wasm` — the WebAssembly binary (fed to the wrapper as `wasmData`; the wrapper does not self-load it by URL).
  - `dav1d-CC0-COPYING` — CC0-1.0 text for the wrapper code.
- SHA-256 (`dav1d-esm.js`): 18841e6ed40b28d5104d0690442a5fc93b15716008709f5c434768624534da67 (also pinned in `dav1d.sha256`)
- SHA-256 (`dav1d.wasm`): db43216c275e6eb82662125a0aec794fd4a30153a1e60915558fe53113365487
- License: dav1d core BSD-2-Clause; wrapper CC0-1.0

## AV1 test fixture

- `av1-fixtures/av1-film_grain.ivf` — 352x288 8-bit 4:2:0 AV1 IVF elementary stream (10 frames, from Chromium's media test data, 28,634 bytes).
- SHA-256: ba3edd82a58414f009e1c821b947ec8de4e0420f33803ca7bfea39af6aeea155 (pinned in `av1-fixtures/fixture.sha256`)
- Used by the `@vigilkit/plugin-dav1d-wasm` Node smoke test.

## Which hash is which (dav1d)

- `dav1d.sha256` (in this directory) pins **the ESM wrapper** `dav1d-esm.js`. The plugin's smoke test (`packages/plugins/dav1d-wasm/scripts/smoke.mjs`) re-hashes the ESM file and fails if it drifts from this pin.
- The runtime loader in `@vigilkit/plugin-dav1d-wasm` (`dav1d-loader.ts`) verifies **the wasm binary** `dav1d.wasm`, and it expects the hash listed above (`db43216c…`). That wasm digest is intentionally documented here rather than in a second pin file, so the loader and the smoke test read the same number from the same file. If the wasm file ever changes, update this README's `dav1d.wasm` hash; if the ESM wrapper ever changes, update `dav1d.sha256`.

## API shape (Node 22 smoke-verified)

The wrapper is a small hand-rolled Emscripten-free loader: pass the wasm bytes directly and it instantiates with a minimal import table:

```js
import { readFileSync } from 'node:fs';
import dav1d from './dav1d-esm.js'; // default export is { create }

const wasmData = new Uint8Array(readFileSync('./dav1d.wasm'));
const d = await dav1d.create({ wasmData });
const { width, height, data } = d.decodeFrameAsYUV(obu); // tight I420: Y, then U, then V
d.unsafeCleanup?.();
```

`decodeFrameAsYUV` decodes **one AV1 frame** from its OBU payload (a temporal unit: for IVF, the 4-byte-size + 8-byte-pts-prefixed frame body). Feed one frame's OBUs per call. Output is 8-bit 4:2:0 I420 with no row padding (`width*height` Y bytes, then `ceil(width/2)*ceil(height/2)` U bytes, then the same for V). 10-bit or 4:4:4 frames are rejected by the wrapper (`null` picture -> throw) and must be avoided or surfaced as a decode error.
