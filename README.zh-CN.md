# vigilkit

<!-- 徽章行：发布时在此处替换为真实的 shields.io 徽章（CI 状态、许可证、npm 版本）。 -->
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/vigilkit/vigilkit/actions)
[![npm](https://img.shields.io/badge/npm-vigilkit-blue.svg)](https://www.npmjs.com/package/vigilkit)

**状态：v0.2 完成。HLS 播放、HEVC 软解与 WebGPU 渲染器均已实现并通过验证。单元测试、e2e 与许可证扫描全部通过。**

vigilkit 是一个开源（Apache-2.0）、WebCodecs 优先、插件化的 Web 视频播放器 SDK，面向安防监控与 IoT 视频场景。核心引擎零第三方运行时依赖。微内核将 transport 插件、source 插件与 demuxer 插件串接成一条解码管线：H.264 帧由浏览器原生 WebCodecs 硬件解码器解码，再通过 WebGPU（零拷贝 `importExternalTexture`）、WebGL2 或 canvas2d 渲染，按浏览器能力自动选择。HEVC 在支持硬件解码的浏览器里走 WebCodecs，其余场景回退到 WASM 软解，这正是 Firefox 播放 HEVC 的方式。全部代码在浏览器中运行，专为低延迟、多路并发的安防监控与 IoT 大屏而设计。

## 零遥测

**vigilkit 不收集任何遥测数据。无分析、无跟踪、无使用计数、无信标。** 所有代码都在浏览器中运行，vigilkit 除了连接应用要求它连接的流地址外，不会发起任何网络请求。不存在 vigilkit 运营的服务器，没有回传端点，没有任何数据离开你的页面。

## Open-core / 商业模式

- 核心引擎（`vigilkit`）、plugin SDK 与标准插件集**永久以 Apache-2.0 开源**。本项目永远不会给核心功能设置付费墙。
- 唯一的商业面是一组闭源的企业级附加功能（多路布局、录像回放、加密流、云台控制）以及海康威视、大华、宇视三大安防平台的厂商私有协议定制。
- 社区可以自由贡献通用与长尾协议插件（WHEP、MQTT 等），HLS 已以 source 插件形式随 v0.2 交付。三大厂商插件由核心团队开发，具体边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 架构

vigilkit 是一个微内核。引擎本身不感知任何传输方式或封装格式，插件通过 plugin SDK 提供这些能力，引擎负责时序与渲染路径。

source 插件产出 `MediaSource`，负责解封装整个容器（HLS、HTTP-FLV 等）；transport 插件把原始字节交给 demuxer 插件（WS-FLV）；两者最终发出相同的 demuxer 事件流。引擎通过 codec-routing 解码器调度编码帧：优先 WebCodecs，浏览器无法解码时回退到软解（例如 HEVC 走 libde265 WASM）：

```
   url ──► source 插件 ──► media source / demuxer ──► jitter buffer
           (hls / flv / ...)   (m3u8+TS / flv / ...)        │
                                                            ▼
                                                  codec-routing 解码器
                                          WebCodecs 优先 ──► 软解回退
                                          (H.264 / HEVC 硬件)  (libde265 WASM)
                                                            │
                                                            ▼
                                                      渲染 surface
                                          WebGPU / WebGL2 / canvas2d（自动）
```

| 包 | 说明 |
| --- | --- |
| `vigilkit` | 核心微内核引擎：AV 同步、jitter buffer、解码调度、`CodecRoutingDecoder`（WebCodecs 优先、异步 `isConfigSupported` 探测、缓冲解码、软解回退、`forceSoft` 选项）、source 插件分支、`PlayerOptions.softDecoder` / `sourceOptions`。零第三方运行时依赖。 |
| `@vigilkit/plugin-sdk` | 插件契约类型（transport、demuxer、source）与插件注册表。 |
| `@vigilkit/media-utils` | 面向 demuxer 插件的共享 byte-reader / NALU / AVC 辅助工具（FLV 与 HLS 均构建其上）。 |
| `@vigilkit/plugin-flv` | FLV demuxer 插件（H.264/AAC），已重构到 `media-utils` 之上。 |
| `@vigilkit/plugin-ws` | WebSocket transport 插件（`ws` / `wss`）。 |
| `@vigilkit/plugin-hls` | HLS source 插件：m3u8 解析、MPEG-TS 解封装、H.264 → AVCC + avcC description、ADTS 音频（只解封装不解码）、VOD + 直播重载 + ABR 变体选择、PTS 不连续偏移。 |
| `@vigilkit/plugin-hevc-wasm` | LGPL-3.0 libde265 适配器，实现核心的 `VideoCodecDecoder` 接口；sha256 锁定的产物加载器 + `wasmBinary` 注入；I420 → `VideoFrame`，带 canvas RGBA 回退。 |
| `@vigilkit/renderer` | `createRendererAsync(canvas, {prefer})`，WebGPU → WebGL2 → canvas2d 依次回退；`WebGPURenderer` 零拷贝 `importExternalTexture`。 |
| `@vigilkit/example-basic` | 私有示例应用：FLV / HLS / HEVC 三种演示模式，供 e2e 套件使用。 |

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

示例应用支持三种演示模式，通过 URL 的 `source` 查询参数选择：

| 模式 | 地址 | 播放内容 |
| --- | --- | --- |
| FLV（默认） | `?source=flv` | WS-FLV，走引擎管线 |
| HLS | `?source=hls` | 经 source 插件播放 HLS m3u8 + MPEG-TS |
| HEVC | `?source=hevc` | 经 libde265 WASM 软解播放 HEVC（Firefox 可用） |

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
});
// 将 { softDecoder } 传给 createPlayer，Firefox 即可软解 HEVC
```

## HEVC 支持

HEVC（H.265）有两条解码路径，由 `CodecRoutingDecoder` 自动选择：

1. **WebCodecs 硬件解码**：在浏览器提供硬件解码能力时使用（Chrome 107+、Safari 17.4+）。零拷贝、无额外下载。
2. **libde265 WASM 软解**：其余场景全部走这条路径。这是 v0.2 针对 Firefox 的核心能力，因为 Firefox 完全没有 HEVC WebCodecs。`@vigilkit/plugin-hevc-wasm` 是围绕 LGPL-3.0 libde265 解码器的 Apache-2.0 适配层，以**物理隔离的 vendored 产物**形式随包分发（绝不是 npm 依赖，也不与任何包的 JavaScript 链接）。wasm 二进制经过 sha256 锁定，加载时校验（`libde265.wasm` sha256 `440c6bbc…`）；LGPL 源码提供声明见 [vendor README](examples/basic/vendor/README.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

即使存在硬件解码，也可通过 `forceSoft: true`（外加 `softDecoder` 工厂）强制走软解。默认策略是 WebCodecs 优先，配以异步 `isConfigSupported` 探测。

**已知限制：** HEVC 演示的 worker 路径（`?source=hevc&worker=1`）在部分 headless Chromium 中可能卡死（worker 内的原生 wasm 自旋不返回、不发任何消息）。主线程解码是默认且经过测试的可靠路径；worker 路径仍处于实验阶段。

## 浏览器支持（v0.2）

| 能力 | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| WebCodecs H.264 解码 | 94+ | 130+ | 16.4+ |
| HLS（m3u8 + MPEG-TS） | 支持 `fetch` 即可用（需 CORS） | 支持 `fetch` 即可用（需 CORS） | 支持 `fetch` 即可用（需 CORS） |
| HEVC（H.265）解码 | 107+ 硬件 | **libde265 WASM 软解** | 17.4+ 硬件 |
| WebGL2 `VideoFrame` 渲染 | 支持 | 支持 | 支持 |
| WebGPU 零拷贝渲染 | 113+ | 144+（仅 Windows） | 26+ |
| Canvas2d 回退 | 支持 | 支持 | 支持 |

WebGPU 通过 `createRendererAsync(canvas, { prefer })` 优雅回退到 WebGL2，再回退到 canvas2d。

## 路线图

- **v0.1** ✅：微内核 + FLV/WS 插件 + WebGL2 渲染 + H.264。
- **v0.2** ✅：WebGPU 零拷贝渲染后端；HLS source 插件；HEVC WASM 软解（隔离的 LGPL 模块），让 Firefox 也能播放 HEVC。
- **v0.3**：真实 HEVC 引擎源接入；真 GPU 上的 WebGPU e2e；滑动窗口直播 HLS；AES-128 HLS；worker 路径专项排查。
- **v1.0**：API 冻结、plugin SDK 稳定版、双语文档。

## 测试

```sh
pnpm test            # 9 个包共 257 个单元测试
pnpm test:e2e        # 针对 basic 示例的 Playwright e2e（4 个用例：FLV x2、HLS、HEVC）
node scripts/check-licenses.mjs --ci   # 许可证扫描，结论必须保持 PASS
```

首次运行 e2e 前先执行 `pnpm exec playwright install chromium`。e2e 套件基于已提交的测试样本复现 QA：FFmpeg FATE FLV 样例（`examples/basic/fixtures/`，sha256 锁定）与 FFmpeg FATE HEVC 样例（`examples/basic/hevc-fixtures/paired_fields.hevc`）。v0.2 e2e 实测：HLS 在 headless Chromium 中播放（551 ms 达首帧可播）；HEVC 软解在主线程路径约 1.1 s 出帧（worker 路径经 `?worker=1` 实验性启用，headless 下 renderMode 回退到 webgl2）；v0.1 的 WS-FLV 用例保持通过（203 帧、约 34 fps、0 错误）。HEVC Node smoke 测试（`pnpm --filter @vigilkit/plugin-hevc-wasm smoke`）用真实 `paired_fields.hevc` 样本解出 2 帧。

`pnpm notices` 会根据已安装的依赖树重新生成 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 参与贡献

插件编写指南、商业边界与工程规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

vigilkit 采用 [Apache License 2.0](LICENSE) 许可。核心引擎与标准插件永久开源；企业级附加功能与厂商协议定制是唯一的商业面。用于 HEVC 软解的 vendored libde265 WASM 产物为 LGPL-3.0 且物理隔离，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
