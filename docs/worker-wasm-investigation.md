# Worker-WASM Wedge Investigation — libde265 dedicated-worker spin

**Status: investigated (2026-08-13), v0.4 / T-E. Root cause NOT fixed — documented as a
known limitation with exact behavior, rejected hypotheses, and upgrade criteria.**

Scope: `?source=hevc&worker=1` on the `@vigilkit/example-basic` demo app. In headless
Chromium the dedicated worker wedges on the first NAL chunk: an uninterruptible native
wasm spin that posts no worker message and never returns, so the demo's worker path
produces no frames and no errors.

This document records the symptom, the hypotheses tested, the test matrix, the evidence,
the verdict, and the recommendations. The deliverable touches only
`examples/basic/server.mjs` (verified, no edit required — see below) and this file.

---

## 1. Environment under test

| Item | Value |
| --- | --- |
| Headless browser | HeadlessChrome **145.0.7632.6** (Playwright 1.62.1, `chromium-1234`) |
| OS | Windows 10 x64, Node 22.17.0 |
| App | `examples/basic` built by Vite 6.4.3 (`dist/` is gitignored) |
| Vendored artifact | `@yume-chan/libde265@1.0.0` (`vendor/libde265-esm.js` + `libde265.wasm`) |
| Server mode A | `node server.mjs --port 8090` (default, no isolation headers) |
| Server mode B | `node server.mjs --port 8091 --coop` (COOP `same-origin` + COEP `require-corp` on every response) |
| Probe | Throwaway Playwright script (see §5), polling `window.__vigilkit.hevc` every 500 ms for 30 s after clicking `#connect` |

The demo starts decoding only after the `#connect` button is clicked, and headless
Chromium needs `navigator.gpu` hidden via an init script (the WebGPU-probe-before-WebGL2
renderer quirk documented in `e2e/hevc.spec.ts`) for `window.__vigilkit` to appear at all.

---

## 2. Symptom (as reported in v0.3, and as observed now)

- **v0.3 report:** the dedicated worker wedges on the first NAL chunk — an uninterruptible
  native wasm spin (CDP `Debugger.pause` cannot interrupt; `Runtime.evaluate` drops). The
  same code + module on the **main thread terminates in ~4 ms**. Nondeterministic (~1 in 5
  runs reached flush). The worker emits no message when wedged, so the demo fallback never
  engaged → 0 frames, 0 errors.
- **v0.4 observation (this run):** identical wedge inside the worker — the worker posts
  **no** `frame`/`error`/`done` message and the JS `drain()` loop spins. Two differences:
  1. The v0.4 demo carries a 15 s `WORKER_TIMEOUT_MS` guard (`src/hevc-demo.ts`), so the
     **main-thread fallback does engage** after 15 s and delivers the fixture's 2 frames.
     The v0.3 "fallback never engages → 0 frames" state is therefore **fixed**, but the
     user-visible behavior on `?worker=1` is now a **~15 s stall followed by main-thread
     playback**.
  2. The wedge was **deterministic** in this environment: 18/18 worker-path failures (see
     §3). The v0.3 "1 in ~5 reach flush" nondeterminism did not reproduce on Chrome 145.

---

## 3. Hypothesis tests and matrix

Probe criterion per run (polled 30 s): **pass** = worker path completes and posts frames
(`#status` contains `hevc: done (worker)`, first frame < 10 s);
**wedge** = no worker message, fallback to main thread only after the 15 s timeout
(first frame ≈ 15.7 s, `#status` = `hevc: done (main)`);
**fail-fast** = worker posts an error message (distinguishable by `errors_text`).

| # | Variant | Runs | Result | First-frame |
| --- | --- | --- | --- | --- |
| 1 | Default server (8090, original build) | 5 | **5/5 wedge** | 15 670–15 704 ms |
| 2 | `--coop` server (8091, original build) | 5 | **5/5 wedge** | 15 670–15 734 ms |
| 3 | Default server — ESM dynamic import via `blob:` URL (probe edit in `hevc-worker.ts`) | 5 | **5/5 wedge** | 15 687–15 795 ms |
| 4 | Default server — worker script as inline blob (`?worker&inline`) + origin-absolute URLs (probe edits) | 5 | 4 fail-fast at init (path-relative URL defect) + **1/1 wedge once URLs fixed** | 15 717 ms |
| 5 | Default server — original build, confirmation re-runs | 2 | **2/2 wedge** | 15 687–15 905 ms |
| 6 | Default server — main-thread path (fallback after worker timeout) | (all runs) | **always passes** | 600–900 ms after fallback starts |

**Totals: 18/18 dedicated-worker path failures across every variant; 100% of main-thread
decodes succeed (~0.6 s for the same chunks + same wasm + same `HevcSoftDecoder` class).**

> Chrome 131 (chromium-1187) was also probed; the runs were polluted by concurrent
> in-progress rebuilds of `dist/` (asset-hash 404s, demo never started) and are reported
> as **inconclusive noise**, not evidence.

---

## 4. Hypothesis analysis

### H1 — SAB/pthreads + COOP/COEP → **REJECTED**

Reasoning: the vendored Emscripten wrapper (`vendor/libde265-esm.js`) is a
**single-threaded build** — a marker scan finds **0** occurrences of
`SharedArrayBuffer`, `Atomics`, `PThread`/`pthread`, or `_spawn_thread`, and the only
`ENVIRONMENT_IS_WORKER` hits are the hardcoded runtime-environment flag that selects the
sync-XHR wasm fallback loader. A single-threaded build never touches SAB, so
cross-origin isolation cannot be a precondition.

Empirical: `--coop` mode (headers verified via `curl -I` on `/`, `/vendor/*`, `/healthz`)
wedged **5/5**, byte-identical to the default server. crossOriginIsolation is not the
cause. The `--coop` flag therefore stays exactly as it was — an opt-in compatibility
surface (correct for any future pthread artifact), **not** a fix for this wedge.

### H2 — Import path (blob-URL variants) → **REJECTED**

- **H2a** (dynamic `import()` of the vendored ESM from a `blob:` URL instead of the http
  URL): 5/5 wedge. (The ESM wrapper's `findWasmBinary()` `new URL("libde265.wasm",
  import.meta.url)` throws on a blob base, so the probe also passed a dummy
  `locateFile`; the wasm is injected via `wasmBinary` regardless.)
- **H2b** (worker **script** served from a `blob:` URL via Vite `?worker&inline`, with the
  worker's `/vendor/*` fetch URLs made origin-absolute): once the URL-resolution defect
  was worked around, the worker reached decode and **wedged** identically.

Neither the ESM-import origin nor the worker-script origin changes the spin. The e2e
spec's earlier note that "the same code terminates in ~4 ms in a blob worker" could not
be reproduced as a fix; the blob variants either fail earlier (URL resolution) or wedge
identically.

**Defect found en route (app-level, not the wedge):** the worker fetches path-absolute
URLs (`/vendor/libde265-esm.js`, `/vendor/libde265.wasm`). Inside a `blob:`-based worker
these cannot be resolved (`Failed to parse URL from /vendor/libde265.wasm`). Any future
move to inline/blob workers must switch to origin-absolute URLs (`new URL('/vendor/...',
self.location.origin)`).

### H3 — Artifact version → **MOOT (no newer artifact exists)**

`npm view @yume-chan/libde265 versions` returns exactly **`1.0.0`** — the only version
ever published (created 2026-01-20). There is no newer build to swap to, so the
sha256-pinned vendored artifacts cannot be refreshed along the version axis today.
Criteria for a future swap are in §7.

### Root-cause analysis (evidence-bound)

The wedge is a **dedicated-worker-only native spin inside the libde265 decode loop**:

1. The worker's `handleChunk` → `HevcSoftDecoder.decode()` →
   `pushData(chunk, pts)` + `drain()`; `drain()` is a synchronous
   `while (more) { this.decoder.decode(); ... }` loop (verified in the built
   `dist/assets/hevc-worker-*.js`). Each `decoder.decode()` is a wasm call
   (`de265_decode` via embind). If it returns `more: true` forever, the JS thread spins
   in a tight wasm-calling loop — which matches "CDP pause cannot interrupt, `Runtime.evaluate`
   drops", because there is no yield point for the debugger to stop on.
2. The **same** chunks, the **same** wasm bytes (sha256-pinned), and the **same**
   `HevcSoftDecoder` class complete on the main thread in ~0.6 s. So the input and the
   decoder logic are not the differentiator — **the dedicated-worker execution context
   is**. Origin, isolation headers, and import scheme were all excluded (H1–H2), so the
   remaining axes are V8's worker-isolate wasm behavior and/or a libde265-internal state
   loop (e.g. the decode queue not advancing for a given input when memory/registers
   differ). The exact C-level loop cannot be pinned from the vendored artifact: the
   embind `Decoder` is registered dynamically by the wasm, there is no JS source for the
   loop, and the spin is uninterruptible by the debugger.
3. Because the wasm module is single-threaded, the spin is not a deadlock/Atomics-wait —
   it is a plain infinite loop, which is why it burns a core and never resolves.

---

## 5. Reproducing (probe)

Throwaway probe (outside the repo, cleaned up after):

```text
C:\Users\Administrator\AppData\Local\Temp\opencode\worker-probe\probe.py
python probe.py --port 8090 --runs 5 --tag default
python probe.py --port 8091 --runs 5 --tag coop
```

Per run: launch headless Chromium with `navigator.gpu` hidden, open
`http://localhost:<port>/?source=hevc&worker=1`, wait for `window.__vigilkit`, click
`#connect`, poll `__vigilkit.hevc` + `#status` + `#errors` every 500 ms for 30 s, capture
console/pageerror. Console evidence of the wedge on every run:

```text
[warning] [vigilkit] hevc worker path failed/timed out; using main-thread decode
#status: "hevc: done (main) — 2 frames"    # first frame at ~15.7 s
#errors: (empty)                            # no worker error message was ever posted
```

---

## 6. `--coop` flag verification (task step 1)

**Already fully implemented — no edit to `server.mjs` was required.** Verified:

- `COOP_HEADERS` = `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`.
- `withCoop()` merges the headers onto **every** response path in the HTTP handler:
  `/healthz`, 200 file responses (HTML/JS/wasm via the alias routes too), 404, 405.
- Default **off** (`args.coop = false`); `--coop` is parsed, documented in the usage
  comment, and logged at startup.
- `curl -I` confirms the headers on `/`, `/vendor/libde265-esm.js`, `/healthz` with
  `--coop` (port 8091) and their absence without (port 8090).

---

## 7. Verdict and recommendations

**Verdict: not fixed — documented as a known limitation.** The worker wedge is a
dedicated-worker-only native wasm spin in the vendored single-threaded libde265 decode,
deterministic on Chrome 145, and **not** attributable to cross-origin isolation (H1
rejected), import/worker origin (H2 rejected), or artifact version (H3 moot).

Recommendations:

1. **Do not rely on the worker path.** `?source=hevc` (main thread) is the tested,
   reliable path and delivers frames in <1 s. The worker path (`?worker=1`) should stay
   experimental; its v0.4 behavior is a guaranteed ~15 s stall before the main-thread
   fallback takes over.
2. **Production worker policy (if a worker path is ever required):** add a
   no-progress watchdog at the decoder level — e.g. if no `frame`/`error` message and no
   `queueSize` change for N ms, `terminate()` the worker and either recreate it with
   backoff or permanently fall back to main-thread decode. The current 15 s
   `WORKER_TIMEOUT_MS` in `hevc-demo.ts` already covers this for the demo, but it is a
   stall, not a recovery that surfaces any diagnostic.
3. **COOP/COEP (`--coop`):** keep as an opt-in flag. It is correct and harmless, but it
   does **not** fix this wedge. It becomes a requirement only if a pthread-based
   artifact (SAB/`Atomics`) is ever vendored.
4. **Version-upgrade criteria:** swap the vendored artifact only when
   `@yume-chan/libde265` publishes a build that (a) changes the threading axis (pthreads /
   SAB), (b) fixes worker decode, or (c) is otherwise known to alter decode behavior.
   Re-pin both sha256s (`vendor/libde265.sha256` and the wasm digest in
   `vendor/README.md` + the loaders), regenerate the vendor files, and re-run this
   matrix (18 runs) before accepting it. Today 1.0.0 is the only published version.
5. **Chrome-version axis:** on Chrome 145 the wedge is deterministic. If a future Chrome
   or a different V8 wasm tiering changes the worker-isolate behavior, re-run the matrix;
   the probe script in §5 is the regression harness.
6. **App hardening (unrelated to the wedge):** worker `fetch`/`import` URLs are
   path-absolute and break inside blob-based workers — make them origin-absolute if
   inline workers are ever adopted.

---

## 8. e2e verification (`pnpm test:e2e`)

Full run (6 spec files × chromium + firefox, Playwright 1.62.1, server started by the
config **without** `--coop`): **6 passed, 7 failed, 1 skipped** (elapsed 1.2 m).

Attribution of every failure to concurrent, in-progress work that predates/parallels
this investigation (this task changed nothing in the e2e path):

| Spec | Result | Cause |
| --- | --- | --- |
| `hevc.spec.ts` (HEVC soft-decode, main thread) | **PASS** chromium + firefox | — (the spec most relevant to this investigation) |
| `hls.spec.ts` | **PASS** chromium + firefox | — |
| `basic.spec.ts` (chromium 178/330, firefox 330) | FAIL | duplicate `#frames` id — the in-progress multiview work added a second `id="frames"` to `index.html` (strict-mode violation: `locator('#frames') resolved to 2 elements`). Not related to COOP/worker changes. |
| `hevc-flv.spec.ts`, `hevc-ts.spec.ts` | FAIL | brand-new untracked specs (added 2026-08-13 12:29, in-progress FLV-HEVC / TS-HEVC engine integration). Timeout waiting for decode. |
| (1 skipped) | — | firefox I420 construction probe skip per spec design |

The pre-existing baseline was already red before this session started
(`index.html`/`src/main.ts` showed uncommitted multiview changes in the initial
`git status`). The deliverable (`server.mjs` verification — no edit — plus this doc)
cannot regress any of the above; the worker/COOP investigation specs (`hevc.spec.ts`)
pass on both browsers.

---

## 9. Files touched by this investigation

- `examples/basic/server.mjs` — **no change** (the `--coop` flag was verified complete).
- `docs/worker-wasm-investigation.md` — **this file (new)**.
- Probe artifacts lived outside the repo (`%TEMP%\opencode\worker-probe\`) and are
  throwaway. Temporary source edits made during the H2 probes (`hevc-worker.ts`,
  `hevc-demo.ts`) were reverted with `git checkout`; `dist/` is gitignored and was rebuilt
  from the reverted source. No commit was made.
