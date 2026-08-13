# No-WebCodecs Fallback Strategy — Decision Record (Roadmap P1-9)

**Status:** Decision made — 2026-08-14. Documentation only; no code changes.
**Owner:** vigilkit core.
**Scope:** Roadmap item P1-9 ("no-WebCodecs 回退策略"). Decides vigilkit's posture for browsers
that lack WebCodecs `VideoDecoder`.
**Deliverables:** this document + the supported-browsers note appended to `README.md` /
`README.zh-CN.md`.

> **摘要 (TL;DR, 中文):** 采用 **方案 A —— 声明支持底线**。vigilkit 的解码管线要求浏览器提供
> WebCodecs `VideoDecoder`；官方支持 Chrome / Edge 94+、Firefox 桌面 130+、Safari / iOS 16.4+
> 的 H.264 视频（HEVC 硬件解码 17.4+）。**不支持** Firefox for Android（WebCodecs 至今未落地，
> Mozilla bug 1934008）、iOS Safari < 16.4 及更早的桌面浏览器。MSE / `<video>` 回退**不纳入核心**；
> 需要服务旧浏览器的应用使用文档化的应用层逃生通道：把原生可播流直接交给普通 `<video>` 元素
> （如 iOS 上的 HLS），或在 vigilkit 之外嵌入基于 MSE 的播放器（hls.js）。理由：WebCodecs 缺失
> 的浏览器在 2026 年占比极低（Firefox for Android ≈ 移动端 0.67%；iOS < 16.4 ≈ iOS 的个位数
> 百分比以内）；唯一实质回退（demux → fMP4 → MediaSource）是 2-4 周的架构级新增，且落在
> vigilkit 帧级管线**之外**（失去逐帧调度、canvas 多路合成与 WebAudio audio-master 同步），
> 只为 <1% 的用户服务；而主要目标（Firefox for Android）在 CI 中不可测（ROADMAP 风险 3）。

## 1. Decision (TL;DR)

**Posture (A): declare a supported-browser floor.**

- vigilkit's decode pipeline officially requires WebCodecs `VideoDecoder`.
- Supported: Chrome / Edge 94+, Firefox desktop 130+, Safari / iOS 16.4+ for H.264 video
  (HEVC hardware decode 17.4+; WebCodecs audio needs Safari 26+), Samsung Internet 17.0+,
  other Chromium-based browsers at Chromium 94+.
- **Not supported:** Firefox for Android (WebCodecs absent), iOS Safari < 16.4,
  Chrome / Edge < 94, Firefox < 130, Internet Explorer (any).
- MSE / `<video>` fallback is **explicitly out of scope for the core**. The documented
  app-level escape hatch: on an unsupported browser, give the application a plain `<video>`
  element pointed at a natively playable stream (HLS on iOS, or any stream an MSE player such
  as hls.js can play) and run vigilkit only where WebCodecs exists.
- Small follow-up (recommended, non-blocking): make `CodecRoutingDecoder` surface a clean
  `UNSUPPORTED` capability error when `globalThis.VideoDecoder` is missing, instead of today's
  confusing `DECODE: decoder configure failed` (see §3 and §8).

## 2. Verified WebCodecs support matrix (2026-08)

| Browser / platform | WebCodecs `VideoDecoder` (H.264) | HEVC via WebCodecs | `AudioDecoder` (AAC) | Verified source |
| --- | --- | --- | --- | --- |
| Chrome / Edge desktop + Android | 94+ | 107+ where HW exists | 94+ | caniuse webcodecs; BCD |
| Firefox desktop | 130+ | never (no HEVC WebCodecs) | 130+ | caniuse; BCD |
| **Firefox for Android** | **absent** | **absent** | **absent** | BCD `version_added:false`; caniuse ❌ 153; bug 1934008 |
| Safari macOS | 16.4+ | 17.4+ | **26+** | BCD VideoDecoder 16.4 / AudioDecoder 26; WebKit blog 17.4 |
| Safari iOS | 16.4+ | 17.4+ | **26+** | BCD; caniuse note "video-only support" |
| Samsung Internet | 17.0+ (Chromium) | inherits | inherits | caniuse webcodecs |
| Internet Explorer | — | — | — | never |

Key facts with sources:

1. **`VideoDecoder` exists on iOS Safari 16.4+, not 17.4.** MDN Browser Compat Data:
   `VideoDecoder.version_added` = `"16.4"` for Safari (`safari_ios` mirrors).
   [mdn/browser-compat-data VideoDecoder.json](https://github.com/mdn/browser-compat-data/blob/main/api/VideoDecoder.json)
2. **The 17.4 line is HEVC.** WebKit: "WebKit for Safari 17.4 … expands what WebCodecs can do
   with the addition of support for the HEVC codec."
   [WebKit Features in Safari 17.4](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/)
3. **Firefox for Android is still WebCodecs-less.** BCD `firefox_android.version_added: false`;
   caniuse marks Firefox for Android ❌ through 153; tracking bug
   [Mozilla bug 1934008 "Ship Web Codecs on Android"](https://bugzilla.mozilla.org/show_bug.cgi?id=1934008)
   remains open with no release assigned (FF 152–154 tracking empty). Baseline availability is
   "blocked since September 2025 by Firefox" —
   [web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/webcodecs/).
4. **Safari / iOS 16.4–18.7 is "video-only" WebCodecs.** caniuse marks the WebCodecs API
   "partial" for Safari / iOS 16.4–18.7 with note **"Video-only support"** — and BCD confirms
   why: `AudioDecoder` (and audio encode) only shipped in **Safari 26**.
   [caniuse.com/webcodecs](https://caniuse.com/webcodecs),
   [mdn/browser-compat-data AudioDecoder.json](https://github.com/mdn/browser-compat-data/blob/main/api/AudioDecoder.json)
5. **Global usage:** 89.83% full + 3.77% partial = **93.6%** of web traffic can run WebCodecs
   (caniuse; usage from StatCounter July 2026).

Implication for vigilkit:

- The "iOS < 17.4" framing in the roadmap is imprecise. H.264 video decode via WebCodecs works
  on iOS 16.4+. The real iOS gaps are: **iOS < 16.4 (no WebCodecs at all)** and **16.4–17.3 for
  HEVC hardware decode only** (HEVC soft-decode via libde265 WASM already covers that). The
  second real gap is **audio: Safari / iOS < 26 has no WebCodecs `AudioDecoder`**, so vigilkit's
  AAC branch fails on those versions (see §3).
- vigilkit's README table row "AAC audio (WebAudio sink) … Safari 16.4+" is therefore
  inaccurate (BCD: AudioDecoder = Safari 26+). Corrected in the note appended to the README by
  this decision.

## 3. Current behavior without WebCodecs (repo evidence)

- Video: `CodecRoutingDecoder.probeSupport()` returns `undefined` when `globalThis.VideoDecoder`
  is missing, and `configure()` then **activates the WebCodecs path anyway** —
  `packages/core/src/decoder-chain.ts:60-64` and `:207-221`. `nativeDecoderFactory` then runs
  `new VideoDecoder(...)` — `packages/core/src/decoder.ts:36-40` — throwing a `ReferenceError`
  that is caught and surfaced as **`DECODE: decoder configure failed`**
  (`decoder-chain.ts:186-190`), not the intended `UNSUPPORTED` error (`decoder-chain.ts:198-205`).
- Audio: the same pattern — `nativeAudioDecoderFactory` calls `new AudioDecoder(...)`
  (`packages/core/src/audio-decoder.ts:12-16`); the wrapper catches and surfaces `DECODE`
  (`audio-decoder.ts:60-75`). On Safari < 26 the AAC branch therefore errors at the first
  `audio-config`.
- Net effect today: on Firefox for Android the user sees a **decode error**, not an informative
  "this browser is unsupported" message. The floor decision makes this contract explicit and
  points the follow-up at a clean capability gate.

## 4. Fallback options (cost / benefit)

### Option A — Declared floor (recommended)

- What: document "requires WebCodecs"; publish an unsupported list; document the app-level
  `<video>` escape hatch.
- Cost: ~0.5–1 day of docs + the optional small capability-gate fix (§8). No architecture change.
- Covers: Firefox for Android, iOS < 16.4, pre-WebCodecs desktop.
- Benefit: honest, zero ongoing maintenance; keeps the frame-level pipeline the only decode path.
- Risk: none beyond "some legacy clients cannot run vigilkit" — which is the point of a floor.

### Option B — Minimal MSE fallback

- What: reuse the existing demuxer event stream — `sequence-header` (carries the avcC
  `description`), `video` chunks (AVCC-framed NALUs), `audio-config` (ASC), raw AAC — which are
  already the exact inputs an fMP4 muxer needs
  (`packages/plugin-sdk/src/types.ts:30-47`, `packages/media-utils/src/avc.ts:18-89`; the HLS TS
  demuxer already normalizes to AVCC via `rebuildAvcc` at
  `packages/plugins/hls/src/ts/es.ts:30-44`). Add an fMP4 muxer (ftyp/moov/stsd/avcC/mp4a/esds +
  moof/trun), a `MediaSource` sink, and a `<video>` renderer mode.
- Honest estimate: **2–4 weeks of solo-maintainer time** (new package + unit tests + e2e), plus
  stall/QoS mapping and a second playback architecture to keep alive.
- Architectural cost: the MSE path bypasses the engine's frame pipeline — no per-frame decode
  scheduling, no canvas multi-stream compositing (surveillance grids), no WebAudio audio-master
  sync (MSE owns A/V sync inside `<video>`). It is a second-class, single-stream mode for <1% of
  users.
- It would work where it matters: MSE + H.264/MP4 is supported on Firefox for Android
  (caniuse MediaSource Extensions: ✅), so this is the *only* option that would make vigilkit
  itself play on Firefox for Android.
- Verdict: technically feasible (vigilkit's demuxers are already ~80% of the way), but it buys a
  full second decode architecture for a shrinking, CI-untestable population, at the expense of
  P0/P1 features. Not justified in 2026.

### Option C — Hybrid: native HLS on iOS + floor elsewhere

- What: on iOS, hand the m3u8 to a plain `<video src>` (native HLS, zero code); floor everywhere
  else.
- Cost: ~zero code; but only applies to **HLS sources** — vigilkit's FLV-over-WS and HTTP-FLV
  paths have no native equivalent, and the app loses vigilkit's ABR / plugin / low-latency
  features.
- Relevance: the actual iOS WebCodecs gap is iOS < 16.4 — a sliver that is also covered by
  Option A's documented `<video>` escape hatch. iOS 16.4+ already has WebCodecs video, so the
  hybrid adds nothing for the 93.6% WebCodecs population.
- Verdict: keep it as a **documented application pattern** under Option A, not a core feature.

## 5. Industry pattern

- **hls.js** is MSE-only: "only compatible with browsers supporting MediaSource extensions (MSE)
  API with 'video/MP4'"; it falls back to native HLS on Apple via
  `video.canPlayType('application/vnd.apple.mpegurl')`; and states plainly: "When a platform has
  neither MediaSource nor native HLS support, the browser cannot play HLS."
  [github.com/video-dev/hls.js](https://github.com/video-dev/hls.js/)
- **Shaka Player** runs a `MediaSourceEngine` plus a `TransmuxerEngine` that transmuxes MPEG-TS →
  fMP4 (optionally in a worker) before appending to `SourceBuffer`; on Apple it historically used
  native `src=` HLS (`useNativeHlsOnSafari`), and now prefers MSE HLS when unencrypted, keeping
  `src=` only for FairPlay / AirPlay cases.
  [MediaSourceEngine docs](https://shaka-project.github.io/shaka-player/docs/api/lib_media_media_source_engine.js.html),
  [Transmuxing in Worker](https://shaka-project.github.io/shaka-player/docs/api/tutorial-transmuxing-in-worker.html)
- **video.js / dash.js** are `<video>` + MSE based; neither is WebCodecs-first.
- Takeaway: **MSE-first is the industry default; WebCodecs-first is the exception.** vigilkit is
  deliberately WebCodecs-first for low latency and frame-level control. Following the industry
  pattern would mean *replacing* vigilkit's core with an MSE architecture — not "adding a
  fallback". The pragmatic industry answer to "no supported API" is exactly Option A: declare
  support, and let the application choose a different player for legacy browsers.

## 6. Market reality (2026)

- **Firefox for Android** (the only current WebCodecs-less browser with any real share) is
  **0.67% of mobile browsers** and **0% of WebCodecs API usage** (the hardware supports
  AV1/H.264 — the gap is the API, not the silicon).
  [StatCounter mobile share, July 2026](https://gs.statcounter.com/browser-market-share/mobile/),
  [webcodecsfundamentals.org codec dataset](https://webcodecsfundamentals.org/datasets/codec-analysis-2026/)
- **iOS < 16.4** (no WebCodecs at all): iOS 26 = 62.6% and iOS 18 = 10.6% of iOS (StatCounter,
  July 2026), every other version < 4%; Statista (June 2026): iOS 26 = 69.69%, iOS 18 = 17.97%,
  all others < 4% each. Even iOS 17.4 is 0.21% in the US (Jan 2026). iOS < 16.4 is a
  low-single-digit sliver of iOS — well under 0.5% of global web traffic.
  [StatCounter iOS share](https://gs.statcounter.com/os-version-market-share/ios),
  [Statista](https://www.statista.com/statistics/1118925/mobile-apple-ios-version-share-worldwide/)
- **Surveillance viewing is desktop-heavy.** Hikvision's no-plugin browser matrix is
  Chrome / Edge-on-PC first (older matrix: Chrome 45+ / Firefox 52+ / Safari 11+), and
  HikCentral Professional web access lists Chrome / Firefox / Safari on desktop — i.e. the
  browsers surveillance dashboards actually run are Windows Chrome / Edge, which are
  WebCodecs-capable at 94+.
  [Hikvision browser & plugin support](https://supportusa.hikvision.com/support/solutions/articles/17000107875-browser-and-plugin-support-of-hikvision-products)
- Combined: the WebCodecs-less audience an MSE fallback would serve is well under 1% of web
  traffic, and even that sliver is mostly *not* the desktop-heavy surveillance-dashboard market
  vigilkit targets.

## 7. Accepted trade-offs

1. No vigilkit playback on Firefox for Android until Mozilla ships WebCodecs (bug 1934008).
   Applications needing that market use MSE-based players (hls.js) or native HLS — the documented
   escape hatch.
2. iOS < 16.4 and pre-WebCodecs desktop get the same `<video>` treatment.
3. Safari / iOS 16.4–25.x: video plays (H.264 via WebCodecs, HEVC via libde265 WASM), **audio
   does not** (no WebCodecs `AudioDecoder` until Safari 26) — documented as a known limitation.
4. The README's "AAC audio Safari 16.4+" row is corrected to "Safari 26+" in the appended note;
   the legacy capability table is left untouched by this decision (minimal edit).

## 8. Follow-up items (small, non-blocking)

- [ ] Capability gate: in `CodecRoutingDecoder.configure`, when `globalThis.VideoDecoder` is
      missing, route to `fail()` and surface **`UNSUPPORTED`** ("WebCodecs is required") instead
      of today's `DECODE: decoder configure failed`. Do the same for the audio branch on
      Safari < 26 (surface `UNSUPPORTED`; keep video-only playback working).
- [ ] Add a `createPlayer`-level capability helper (e.g. `isWebCodecsSupported()`) to the plugin
      SDK so applications can feature-detect before constructing a player.
- [ ] Revisit when: (a) Mozilla ships WebCodecs on Android (bug 1934008) — add Firefox for
      Android to the supported table; or (b) a customer contract requires MSE fallback — re-open
      Option B with the fMP4-reuse analysis in §4.

## 9. Supported-browsers table (README)

Copy this block into the browser-support section of both `README.md` and `README.zh-CN.md`:

```markdown
**Supported-browser floor (WebCodecs required).** vigilkit's decode pipeline requires WebCodecs `VideoDecoder`. Officially supported: Chrome / Edge 94+, Firefox 130+ (desktop), Safari / iOS 16.4+ for H.264 video (HEVC hardware decode 17.4+; AAC audio via WebCodecs needs Safari 26+, where WebCodecs audio codecs landed), Samsung Internet 17.0+. **Not supported:** Firefox for Android (WebCodecs still absent — [Mozilla bug 1934008](https://bugzilla.mozilla.org/show_bug.cgi?id=1934008)), iOS Safari < 16.4, and any browser below the versions above. On unsupported browsers playback fails; applications that must serve legacy browsers should point a plain `<video>` element at a natively playable stream (e.g. HLS on iOS) or embed an MSE-based player (hls.js) alongside vigilkit. Full decision and data: [docs/no-webcodecs-fallback.md](docs/no-webcodecs-fallback.md).
```

## 10. References

1. MDN Browser Compat Data — VideoDecoder (chrome 94; firefox 130; **firefox_android false**; safari 16.4): https://github.com/mdn/browser-compat-data/blob/main/api/VideoDecoder.json
2. MDN Browser Compat Data — AudioDecoder (**safari 26**): https://github.com/mdn/browser-compat-data/blob/main/api/AudioDecoder.json
3. caniuse — WebCodecs API (93.6% usage; Safari 16.4–18.7 "partial", note "Video-only support"; Firefox for Android ❌): https://caniuse.com/webcodecs
4. caniuse — VideoDecoder API: https://caniuse.com/mdn-api_videodecoder
5. Mozilla bug 1934008 — Ship Web Codecs on Android: https://bugzilla.mozilla.org/show_bug.cgi?id=1934008
6. Web Features explorer — WebCodecs ("Baseline availability blocked since September 2025 by Firefox"): https://web-platform-dx.github.io/web-features-explorer/features/webcodecs/
7. WebKit — WebKit Features in Safari 17.4 (HEVC in WebCodecs): https://webkit.org/blog/15063/webkit-features-in-safari-17-4/
8. StatCounter — Browser Market Share, July 2026: https://gs.statcounter.com/browser-market-share/all
9. StatCounter — Mobile Browser Market Share, July 2026 (Firefox mobile 0.67%): https://gs.statcounter.com/browser-market-share/mobile/
10. StatCounter — iOS Version Market Share, July 2026: https://gs.statcounter.com/os-version-market-share/ios
11. Statista — Apple iOS version share worldwide, June 2026 (iOS 26: 69.69%, iOS 18: 17.97%, others < 4%): https://www.statista.com/statistics/1118925/mobile-apple-ios-version-share-worldwide/
12. webcodecsfundamentals.org — AV1/H265 support in 2026 dataset (Firefox Android 0% = API gap; AV1+HEVC 99.73% sessions): https://webcodecsfundamentals.org/datasets/codec-analysis-2026/
13. hls.js (MSE-only; native HLS fallback): https://github.com/video-dev/hls.js/
14. Shaka Player — MediaSourceEngine / transmux-in-worker: https://shaka-project.github.io/shaka-player/docs/api/tutorial-transmuxing-in-worker.html
15. caniuse — MediaSource Extensions (Firefox for Android ✅): https://caniuse.com/mediasource
16. Hikvision — Browser and Plugin Support of Hikvision Products (no-plugin Chrome/Edge PC-first): https://supportusa.hikvision.com/support/solutions/articles/17000107875-browser-and-plugin-support-of-hikvision-products

Repo evidence (internal): `packages/core/src/decoder-chain.ts:51-78,154-221`,
`packages/core/src/decoder.ts:36-40`, `packages/core/src/audio-decoder.ts:12-16,60-75`,
`packages/plugin-sdk/src/types.ts:30-47`, `packages/media-utils/src/avc.ts:18-89`,
`packages/plugins/hls/src/ts/es.ts:30-44`.