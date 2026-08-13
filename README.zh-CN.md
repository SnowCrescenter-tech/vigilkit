# vigilkit

<!-- 徽章行：发布时在此处替换为真实的 shields.io 徽章（CI 状态、许可证、npm 版本）。 -->
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/vigilkit/vigilkit/actions)
[![npm](https://img.shields.io/badge/npm-vigilkit-blue.svg)](https://www.npmjs.com/package/vigilkit)

**状态：v0.3 完成。rAF 播放泵、带 WebAudio sink 的 AAC 音频播放与 audio-master 音视频同步、WHEP（WebRTC）source 插件均已实现并通过验证。单元测试、e2e（chromium + firefox）与许可证扫描全部通过。**

vigilkit 是一个开源（Apache-2.0）、WebCodecs 优先、插件化的 Web 视频播放器 SDK，面向安防监控与 IoT 视频场景。核心引擎零第三方运行时依赖。微内核将 transport 插件、source 插件与 demuxer 插件串接成一条解码管线：H.264 帧由浏览器原生 WebCodecs 硬件解码器解码，再通过 WebGPU（零拷贝 `importExternalTexture`）、WebGL2 或 canvas2d 渲染，按浏览器能力自动选择。HEVC 在支持硬件解码的浏览器里走 WebCodecs，其余场景回退到 WASM 软解，这正是 Firefox 播放 HEVC 的方式。AAC 音频经 WebCodecs `AudioDecoder` 解码后，在 WebAudio sink 上按预定时序播放，并做 audio-master 音视频同步；WHEP source 插件以直接帧的形式接入 WebRTC 出流。全部代码在浏览器中运行，专为低延迟、多路并发的安防监控与 IoT 大屏而设计。

## 从 npm 安装

所有包均已发布到 npm。安装核心引擎与你需要的插件：

```sh
npm install vigilkit @vigilkit/plugin-flv @vigilkit/plugin-ws @vigilkit/renderer
# 或使用 pnpm add / yarn add
```

基本用法：

```ts
import { createPlayer } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { createRenderer } from '@vigilkit/renderer';

const player = createPlayer({
  url: 'ws://your-server/live',
  demuxer: 'flv',
  plugins: [wsTransportPlugin(), flvDemuxerPlugin()],
  renderer: createRenderer(canvas), // 一个 <canvas> 元素
});

player.play();
```

> **注意：** 所有包均为 **ESM-only**。工具链（打包器、开发服务器）需要 Node.js 20+；浏览器需要 WebCodecs 以及 WebGPU、WebGL2 或 canvas2d 用于渲染。

## 零遥测

**vigilkit 不收集任何遥测数据。无分析、无跟踪、无使用计数、无信标。** 所有代码都在浏览器中运行，vigilkit 除了连接应用要求它连接的流地址外，不会发起任何网络请求。不存在 vigilkit 运营的服务器，没有回传端点，没有任何数据离开你的页面。

## Open-core / 商业模式

- 核心引擎（`vigilkit`）、plugin SDK 与标准插件集**永久以 Apache-2.0 开源**。本项目永远不会给核心功能设置付费墙。
- 唯一的商业面是一组闭源的企业级附加功能（多路布局、录像回放、加密流、云台控制）以及海康威视、大华、宇视三大安防平台的厂商私有协议定制。
- 社区可以自由贡献通用与长尾协议插件（WHEP、MQTT 等），HLS 与 WHEP 均已以 source 插件形式交付。三大厂商插件由核心团队开发，具体边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 架构

vigilkit 是一个微内核。引擎本身不感知任何传输方式或封装格式，插件通过 plugin SDK 提供这些能力，引擎负责时序与渲染路径。

source 插件产出 `MediaSource`，负责解封装整个容器（HLS、HTTP-FLV、WHEP）；transport 插件把原始字节交给 demuxer 插件（WS-FLV）；两者最终发出相同的 demuxer 事件流。引擎通过 codec-routing 解码器调度编码帧：优先 WebCodecs，浏览器无法解码时回退到软解（例如 HEVC 走 libde265 WASM）；音频块则进入并行的 WebAudio 分支：

```
   url ──► source 插件 ──► media source / demuxer ──► jitter buffer
           (hls / flv / whep)  (m3u8+TS / flv / ...)        │
                                                            ▼
                                                  codec-routing 解码器
                                          WebCodecs 优先 ──► 软解回退
                                          (H.264 / HEVC 硬件)  (libde265 WASM)
                                                            │
                                                            ▼
                                                      master clock
                                           (audio-master；wall-clock 回退)
                                                            │
                                        ┌────────────────────┘
                                        ▼
                          renderer surface         audio 分支
               WebGPU / WebGL2 / canvas2d    AudioDecoder → WebAudio sink
                         (自动)              (提前 250 ms 调度)
```

播放泵以 rAF 为驱动：浏览器中 `requestAnimationFrame` 是主驱动，在没有 rAF 的运行时（Node、worker）回退到 `setInterval(30ms)`，页面隐藏时切换到 250ms 间隔，让解码与背压继续排空而不浪费电量。驱动可通过 `PlayerOptions.pump`（`requestFrame` / `cancelFrame`）注入。

WHEP 是上述管线的例外：它以 `frame` 事件直接投递已解码的 `VideoFrame`，完全绕过编码解码链（见 [WHEP（WebRTC）](#whepwebrtc)）。

| 包 | 说明 |
| --- | --- |
| `vigilkit` | 核心微内核引擎：AV 同步、jitter buffer、解码调度、`CodecRoutingDecoder`（WebCodecs 优先、异步 `isConfigSupported` 探测、缓冲解码、软解回退、`forceSoft` 选项）、source 插件分支、rAF 播放泵（`PlayerOptions.pump`）、音频管线（`AudioDecoderWrapper` → WebAudio sink、`PlayerOptions.audio`、audio-master `MasterClock`）、面向 WHEP 类 source 的直接帧路径、`PlayerOptions.softDecoder` / `sourceOptions`。零第三方运行时依赖。 |
| `@vigilkit/plugin-sdk` | 插件契约类型（transport、demuxer、source）与插件注册表。 |
| `@vigilkit/media-utils` | 面向 demuxer 插件的共享 byte-reader / NALU / AVC 辅助工具（FLV 与 HLS 均构建其上）。 |
| `@vigilkit/plugin-flv` | FLV demuxer 插件（H.264/AAC），已重构到 `media-utils` 之上；AAC 序列头 → `audio-config`（ASC）+ 原始 AAC 块。 |
| `@vigilkit/plugin-ws` | WebSocket transport 插件（`ws` / `wss`）。 |
| `@vigilkit/plugin-hls` | HLS source 插件：m3u8 解析、MPEG-TS 解封装、H.264 → AVCC + avcC description、AAC 经首个 ADTS 帧生成 `audio-config`（剥离 ADTS 头，投递原始 AAC 载荷）、VOD + 直播重载 + ABR 变体选择、PTS 不连续偏移。 |
| `@vigilkit/plugin-hevc-wasm` | LGPL-3.0 libde265 适配器，实现核心的 `VideoCodecDecoder` 接口；sha256 锁定的产物加载器 + `wasmBinary` 注入；I420 → `VideoFrame`，带 canvas RGBA 回退。 |
| `@vigilkit/plugin-whep` | WHEP（WebRTC-HTTP Egress Protocol）media source 插件：POST offer / PATCH answer + trickle ICE，以直接 `frame` 事件投递已解码的 `VideoFrame`（绕过编码解码链）。 |
| `@vigilkit/renderer` | `createRendererAsync(canvas, {prefer})`，WebGPU → WebGL2 → canvas2d 依次回退；`WebGPURenderer` 零拷贝 `importExternalTexture`。 |
| `@vigilkit/example-basic` | 私有示例应用：FLV / HLS / HEVC / WHEP 四种演示模式，供 e2e 套件使用。 |

## 快速开始

前置要求：Node.js 20+ 与 pnpm 9+。

```sh
pnpm install
pnpm --filter @vigilkit/example-basic build
pnpm --filter @vigilkit/example-basic serve
```

打开 <http://localhost:8080>。如果 8080 端口被占用，指定其他端口并访问对应地址：

```sh
pnpm --filter @vigilkit/example-basic serve -- --port 9000
```

示例应用支持四种演示模式，通过 URL 的 `source` 查询参数选择：

| 模式 | 地址 | 播放内容 |
| --- | --- | --- |
| FLV（默认） | `?source=flv` | WS-FLV，走引擎管线 |
| HLS | `?source=hls` | 经 source 插件播放 HLS m3u8 + MPEG-TS |
| HEVC | `?source=hevc` | 经 libde265 WASM 软解播放 HEVC（Firefox 可用） |
| WHEP | `?source=whep&endpoint=<resource-url>` | 经 WHEP source 插件播放 WebRTC 出流（需要 WHEP 服务器，例如 MediaMTX） |

基本用法：

```ts
import { createPlayer } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { createRenderer } from '@vigilkit/renderer';

const player = createPlayer({
  url: 'ws://your-server/live',
  demuxer: 'flv',
  plugins: [wsTransportPlugin(), flvDemuxerPlugin()],
  renderer: createRenderer(canvas), // 一个 <canvas> 元素
});

player.play();
```

在没有原生 HEVC WebCodecs 的浏览器（Firefox）中播放 HEVC，注册软解工厂即可：

```ts
import { createHevcSoftFactory } from '@vigilkit/plugin-hevc-wasm';

const softDecoder = await createHevcSoftFactory({
  esmUrl: '/vendor/libde265-esm.js',
  wasmUrl: '/vendor/libde265.wasm',
  sha256: '440c6bbc60af222e72141583ce583423b0b8dd3fe0b53e823fa2e99988eca5b8',
  esmSha256: '3d431114c87569ff71b3a8f434c3a67ba8239fbef18cea80e2f22e5049d7b0ab',
});
// 将 { softDecoder } 传给 createPlayer，Firefox 即可软解 HEVC
```

> **HEVC 说明：** `softDecoder` / `forceSoft` 选项已在引擎的 `CodecRoutingDecoder`
> 中端到端打通，但尚无随包交付的 source/demuxer 插件产出 `hvc1/hev1` 配置。
> HEVC 演示（`?source=hevc`）在 **`createPlayer` 之外** 解码：它把样本直接喂给
> `HevcSoftDecoder`。FLV H.265 与 TS-HEVC 解封装（引擎 source 接入）是 v0.4
> 路线图上的事项。

## HEVC 支持

HEVC（H.265）有两条解码路径，由 `CodecRoutingDecoder` 自动选择：

1. **WebCodecs 硬件解码**：在浏览器提供硬件解码能力时使用（Chrome 107+、Safari 17.4+）。零拷贝、无额外下载。
2. **libde265 WASM 软解**：其余场景全部走这条路径。这是针对 Firefox 的核心能力，因为 Firefox 完全没有 HEVC WebCodecs。`@vigilkit/plugin-hevc-wasm` 是围绕 LGPL-3.0 libde265 解码器的 Apache-2.0 适配层，以**物理隔离的 vendored 产物**形式随包分发（绝不是 npm 依赖，也不与任何包的 JavaScript 链接）。wasm 二进制经过 sha256 锁定，加载时校验（`libde265.wasm` sha256 `440c6bbc…`）；LGPL 源码提供声明见 [vendor README](examples/basic/vendor/README.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

即使存在硬件解码，也可通过 `forceSoft: true`（外加 `softDecoder` 工厂）强制走软解。默认策略是 WebCodecs 优先，配以异步 `isConfigSupported` 探测。

**已知限制：** HEVC 演示的 worker 路径（`?source=hevc&worker=1`）在部分 headless Chromium 中可能卡死（worker 内的原生 wasm 自旋不返回、不发任何消息）。主线程解码是默认且经过测试的可靠路径；worker 路径仍处于实验阶段。

## 音频播放

AAC 音频经 WebCodecs `AudioDecoder` 解码后，在 WebAudio sink（`AudioOutput`）上按序调度：每个解码出的 `AudioData` 提前 `AudioContext` 时钟 250 ms 排队，调度保持单调，尽可能减少卡顿与爆音。

`MasterClock` 在音频 sink 处于运行状态时以音频媒体时间为播放时间轴，调度器与渲染器跟随音频时间，从而保证音画同步（audio-master）。当 `AudioContext` 被挂起（例如自动播放策略拒绝）或没有音频在播时，主时钟回退到 wall clock，直到音频恢复。

- 用 `PlayerOptions.audio` 开启或关闭该管线（默认 `true`）。设为 `audio: false` 时不创建解码器与上下文，引擎仅播放视频。
- 音频解码进度通过 `PlayerStats.audioFramesDecoded` 上报。
- 两个已交付的 demuxer 都接入了 AAC：FLV 从 AAC 序列头（AudioSpecificConfig）发出 `audio-config`，HLS 从首个 ADTS 帧推导同样的配置。音频块携带原始 AAC 载荷（HLS 中剥离了 ADTS 头）。

**音视频同步范围：** 当前实现是基础的 audio-master 同步，没有采样级漂移校正；长时间播放的音画漂移是 v0.4 路线图上的事项。

## WHEP（WebRTC）

`@vigilkit/plugin-whep` source 插件实现了 WebRTC-HTTP Egress Protocol（WHEP，draft-ietf-wish-whep）。它向 WHEP 资源 URL POST SDP offer，采纳服务器的 answer（若是 406 反建议则经 PATCH 应答），通过 PATCH 逐条上报 ICE candidate，再把收到的媒体轨道交给 `MediaStreamTrackProcessor`，其产出的已解码 `VideoFrame` 以直接 `frame` 事件流入引擎：

```ts
import { createPlayer } from 'vigilkit';
import { createRenderer } from '@vigilkit/renderer';
import { whepSourcePlugin } from '@vigilkit/plugin-whep';

const player = createPlayer({
  url: '<whep-resource-url>',
  demuxer: 'whep',
  plugins: [whepSourcePlugin()],
  renderer: createRenderer(canvas),
});

player.play();
```

在示例应用中用 `?source=whep&endpoint=<resource-url>` 体验。

**设计说明：** WHEP 投递的是已解码的 `VideoFrame`，因此该插件完全绕过编码解码链（无 codec-routing，无 jitter-buffer 调度）。引擎直接渲染每一帧；未挂渲染器时则自行关闭。计划在 v0.4 提供 insertable-streams 路径，把编码后的 WebRTC 数据包接入引擎的 WebCodecs 解码链。

**用 MediaMTX 手动测试**（不假设任何公网 WHEP 服务器）：

```sh
docker run -p 8889:8889 -p 8554:8554 bluenviron/mediamtx
```

之后 MediaMTX 会在 `http://localhost:8889/<stream>/whep` 提供 WHEP 资源。注意 MediaMTX 是转发服务器而非信号源：它需要先有推流端（OBS、ffmpeg 或 WHIP 客户端）向它推送，资源才会返回媒体。

## 浏览器支持（v0.3）

| 能力 | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| WebCodecs H.264 解码 | 94+ | 130+ | 16.4+ |
| HLS（m3u8 + MPEG-TS） | 支持 `fetch` 即可用（需 CORS） | 支持 `fetch` 即可用（需 CORS） | 支持 `fetch` 即可用（需 CORS） |
| AAC 音频（WebAudio sink） | 94+ | 130+ | 16.4+ |
| HEVC（H.265）解码 | 107+ 硬件 | **libde265 WASM 软解** | 17.4+ 硬件 |
| WebGL2 `VideoFrame` 渲染 | 支持 | 支持 | 支持 |
| WebGPU 零拷贝渲染 | 113+ | 144+（仅 Windows） | 26+ |
| Canvas2d 回退 | 支持 | 支持 | 支持 |

WebGPU 通过 `createRendererAsync(canvas, { prefer })` 优雅回退到 WebGL2，再回退到 canvas2d。e2e 套件对每个用例同时跑 chromium 与 firefox；headless Firefox 没有 WebGPU 适配器，在 WebGL2 也不可用时 `renderMode` 可能回退到 canvas2d。

## 路线图

- **v0.1** ✅：微内核 + FLV/WS 插件 + WebGL2 渲染 + H.264。
- **v0.2** ✅：WebGPU 零拷贝渲染后端；HLS source 插件；HEVC WASM 软解（隔离的 LGPL 模块），让 Firefox 也能播放 HEVC。
- **v0.3** ✅：rAF 驱动的播放泵（含隐藏页回退）；WebAudio sink + audio-master 音视频同步的 AAC 音频播放；WHEP（WebRTC）source 插件；Firefox e2e 覆盖；发布工具链（publish-all / verify-pack / release workflow）。
- **v0.4**：insertable-streams WHEP 编码路径；采样级音视频同步；FLV H.265 / TS-HEVC 引擎接入；真 GPU 上的 WebGPU e2e；worker 卡死专项排查；DASH source 插件。
- **v1.0**：API 冻结、plugin SDK 稳定版、双语文档。

## 测试

```sh
pnpm test            # 10 个包共 361 个单元测试
pnpm test:e2e        # Playwright e2e：4 个用例 × chromium + firefox = 8 次运行（FLV x2、HLS、HEVC）
node scripts/check-licenses.mjs --ci   # 许可证扫描，结论必须保持 PASS
```

首次运行 e2e 前先执行 `pnpm exec playwright install chromium firefox`。e2e 套件基于已提交的测试样本复现 QA：FFmpeg FATE FLV 样例（`examples/basic/fixtures/`，sha256 锁定）与 FFmpeg FATE HEVC 样例（`examples/basic/hevc-fixtures/paired_fields.hevc`）。v0.2 的 e2e 实测仍然成立：HLS 在 headless Chromium 中播放（551 ms 达首帧可播）；HEVC 软解在主线程路径约 1.1 s 出帧（worker 路径经 `?worker=1` 实验性启用，headless 下 renderMode 回退到 webgl2）；v0.1 的 WS-FLV 用例保持通过（203 帧、约 34 fps、0 错误）。HEVC Node smoke 测试（`pnpm --filter @vigilkit/plugin-hevc-wasm smoke`）用真实 `paired_fields.hevc` 样本解出 2 帧。

发布工具链速览：`scripts/publish-all.mjs` 按依赖顺序发布 8 个可发布包（`--dry-run` 只打印计划不发布，`--only <name>` 可在失败后续跑）；`scripts/verify-pack.mjs` 对每个包实际打 tar 包并断言 dist 入口、tarball 内无 `node_modules`、`workspace:` 协议已解析，全部通过才会触达 registry；`.github/workflows/release.yml` 把两者接入手动触发的 `workflow_dispatch` 发布流程，需要 `NPM_TOKEN` 仓库密钥。

`pnpm notices` 会根据已安装的依赖树重新生成 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 参与贡献

插件编写指南、商业边界与工程规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

vigilkit 采用 [Apache License 2.0](LICENSE) 许可。核心引擎与标准插件永久开源；企业级附加功能与厂商协议定制是唯一的商业面。用于 HEVC 软解的 vendored libde265 WASM 产物为 LGPL-3.0 且物理隔离，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
