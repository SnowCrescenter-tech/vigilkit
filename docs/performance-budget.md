# vigilkit multi-view performance budget

Reference budgets for the multi-stream (surveillance / IoT dashboard) surface,
enforced by the chromium-only e2e baseline at `e2e/multiview.spec.ts` and the
demo harness at `examples/basic/src/multiview-demo.ts` (`?source=multiview&views=N`).

The harness opens N independent WS-FLV streams on one page — one canvas + one
`createPlayer` per view — samples per-view `fps` / `framesDecoded` / `errors` /
`stalledCount` on a 1 s interval, and reports aggregate JS heap usage through
`performance.measureUserAgentSpecificMemory` when that API is available.

## Fixture and harness facts

- Fixture: `examples/basic/fixtures/Enigma_Principles_of_Lust-part.flv` — 512 KB,
  426×240 H.264 + AAC, ~352 video frames, ~11.6 s @ 30 fps. The e2e server
  (`server.mjs --loop`) ships the whole file in 8 × 64 KiB chunks (~320 ms) per
  WS connection, then replays it; each connection is independent.
- The baseline runs **video-only** (`audio: false`). With audio enabled, the
  engine's audio-master `resync()` (packages/core/src/engine.ts,
  `onFirstAudio`) re-bases the video clock on the next enqueue; because the e2e
  server bursts the entire clip in ~320 ms, that re-base lands near the clip
  tail and the scheduler's drop-late policy discards the buffered backlog
  (~260 of 352 frames), stalling every view (fatal `STALLED` after 10 s). The
  multi-view budget measures video decode/render throughput; single-stream
  audio is covered by `e2e/basic.spec.ts`.
- Memory: `performance.measureUserAgentSpecificMemory` requires a cross-origin
  isolated page (`server.mjs --coop`) **and does not resolve in headless
  Chromium at all** (30 s+ observation, isolated or not — the renderer never
  reports a measurement). CI therefore reports `memoryMB = null` and the
  aggregate-memory assertion is skipped per its "when the API is available"
  contract. The JS-heap proxy below (`performance.memory.usedJSHeapSize`,
  Chromium-only) is used for the measured numbers.

## Budget table

| # | Budget | Limit | Basis | Measured (2026-08-13, headless chromium, CI config) | Status |
|---|---|---|---|---|---|
| 1 | Per-stream memory | < 100 MB | JS-heap share of one 426×240 view | Aggregate JS heap 42.6 MB for 4 views ≈ **11 MB/view** (allocation spike during the first decode burst not separately measured) | ✅ PASS, ~9× headroom |
| 2 | Aggregate memory (4 views) | ≤ 1.5 GB | `measureUserAgentSpecificMemory` when available | API unavailable in headless (never resolves, even with `--coop`); JS-heap proxy: **42.6 MB** vs 1500 MB budget | ✅ PASS (proxy), ~35× headroom |
| 3 | Per-stream decode rate @ 4 views | ≥ 15 fps | CI chromium, 426×240 fixture | **54–61 fps per view** steady during the clip pass (decode burst; fixture content is 30 fps); all 4 views decode the full clip: **349/352 frames each in ~6 s, 0 errors, 0 stalls** | ✅ PASS, 3.6–4× headroom |
| 4 | 1080p per-stream rate | ≥ 15 fps | Extrapolated only — no 1080p fixture in the repo; 1920×1080 is ~20.3× the 426×240 pixel load (2,073,600 vs 102,240 px) | Not CI-measured. Linear pixel scaling of the 426×240 result gives ~3 fps/stream software-decoded; a 1080p budget requires a real fixture + hardware decode (CI is SwiftShader software) | ⚠️ EXTRAPOLATED — needs a 1080p fixture before it can be enforced |
| 5 | Stall-free steady state | stalledCount === 0 | QoS watchdog (defaults `stallThresholdMs` 1500, `fatalStallMs` 10000) | **0 stalls / 0 errors per view during the first clip pass** (0–6 s). Across loop restarts the engine's lateness policy drops the repeated timestamps and a stall episode is declared ~7.5 s after the clip drains (fatal `STALLED` at ~17.5 s) — see Known limitations | ✅ PASS within the first pass; ⚠️ engine limitation across loop restarts |
| 6 | 16-view HEVC soft-decode | — | Soft-decode in workers | **Blocked**: the vendored libde265 wasm wedges in dedicated workers in headless Chromium (native spin, no message), so 16 simultaneous soft-decode streams cannot be driven through the worker path | ⛔ Blocked — see docs/worker-wasm-investigation.md |

## Measured run detail (2026-08-13)

Harness: `pnpm test:e2e` webServer (`server.mjs --port 8090 --loop`),
`?source=multiview&views=4`, headless chromium, 960×640 viewport, WebGL2
renderers (SwiftShader; WebGPU adapter absent — "No available adapters" logged).

- Decode timeline (per view): 58 frames at t≈0 s → 118 → 178 → 238 → 298 →
  349 (full clip) at ~60 fps, then the pass drains.
- `e2e/artifacts/multiview-stats.json` (snapshot at ~2 s): fps 54–56, frames
  54–56, errors 0, stalledCount 0 per view.
- JS heap after warm-up: `usedJSHeapSize` 42.6 MB (4 views + app chrome).
- `e2e/artifacts/multiview.png`: full-page screenshot of the 2×2 grid.
- Firefox: the spec is skipped (chromium-only baseline; Firefox single-stream
  coverage lives in basic/hls/hevc specs).

## How to run

```sh
# build the example app (serves dist/) and run the e2e suite
pnpm --filter @vigilkit/example-basic build
pnpm test:e2e

# run only the multiview baseline
pnpm exec playwright test -c e2e/playwright.config.ts e2e/multiview.spec.ts --project=chromium

# watch it live (default 4 views; N views via ?views=N)
pnpm --filter @vigilkit/example-basic serve --port 8090 --loop
# open http://localhost:8090/?source=multiview&views=4

# memory via the real API (needs cross-origin isolation; still null in headless)
pnpm --filter @vigilkit/example-basic serve --port 8090 --loop --coop
```

## Known limitations (engine-owned, tracked here)

1. **Drop-late + burst-fed fixture**: with the e2e server's burst delivery,
   the scheduler's lateness policy (packages/core/src/scheduler.ts `tick()`)
   drops frames whose PTS falls > 1 s behind the wall-anchored clock. With
   audio enabled this turns catastrophic once `onFirstAudio` re-bases the
   clock at the clip tail (~260/352 frames dropped, pipeline dead, fatal
   `STALLED`). Worked around in the baseline with `audio: false`; the engine
   fix belongs in the resync/drop-late interplay (core, out of scope of the
   multi-view task).
2. **Loop restarts are not steady-state**: the clock is anchored once per
   player; every loop pass replays the same PTS range, which the lateness
   policy eventually drops entirely, so sustained decode across restarts is
   not guaranteed. Real streams with monotonically increasing PTS are
   unaffected. The e2e asserts the first-pass window for this reason.
3. **measureUserAgentSpecificMemory never resolves in headless Chromium**
   (even cross-origin isolated), so the aggregate-memory budget is enforced by
   a JS-heap proxy until a headed/isolated CI lane exists.
4. **16-view HEVC soft-decode** is blocked on the worker-wedge investigation —
   see docs/worker-wasm-investigation.md.
