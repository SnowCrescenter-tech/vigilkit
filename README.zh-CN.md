# vigilkit

<!-- 徽章行：发布时在此处替换为真实的 shields.io 徽章（CI 状态、许可证、npm 版本）。 -->
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![CI](https://img.shields.io/badge/CI-passing-brightgreen.svg)](https://github.com/vigilkit/vigilkit/actions)
[![npm](https://img.shields.io/badge/npm-vigilkit-blue.svg)](https://www.npmjs.com/package/vigilkit)

**状态：v0.1 完成。单元测试、e2e 与许可证扫描全部通过。**

vigilkit 是一个开源（Apache-2.0）、WebCodecs 优先、插件化的 Web 视频播放器 SDK，面向安防监控与 IoT 视频场景。核心引擎零第三方运行时依赖。微内核将 transport 插件与 demuxer 插件串接成一条解码管线：H.264 帧由浏览器原生 WebCodecs 硬件解码器解码，通过 WebGL2 渲染，并提供 canvas2d 作为回退方案。全部代码在浏览器中运行，专为低延迟、多路并发的安防监控与 IoT 大屏而设计。

## 零遥测

**vigilkit 不收集任何遥测数据。无分析、无跟踪、无使用计数、无信标。** 所有代码都在浏览器中运行，vigilkit 除了连接应用要求它连接的流地址外，不会发起任何网络请求。不存在 vigilkit 运营的服务器，没有回传端点，没有任何数据离开你的页面。

## Open-core / 商业模式

- 核心引擎（`vigilkit`）、plugin SDK 与标准插件集**永久以 Apache-2.0 开源**。本项目永远不会给核心功能设置付费墙。
- 唯一的商业面是一组闭源的企业级附加功能（多路布局、录像回放、加密流、云台控制）以及海康威视、大华、宇视三大安防平台的厂商私有协议定制。
- 社区可以自由贡献通用与长尾协议插件（HLS、WHEP、MQTT 等）。三大厂商插件由核心团队开发，具体边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 架构

vigilkit 是一个微内核。引擎本身不感知任何传输方式或封装格式，插件通过 plugin SDK 提供这些能力，引擎负责时序与渲染路径。

```
   url ──► transport 插件 ──► demuxer 插件 ──► jitter buffer
           (ws / wss / ...)     (flv / ...)          │
                                                     ▼
                                           WebCodecs 解码器
                                                (H.264)
                                                     │
                                                     ▼
                                             渲染 surface
                                    (WebGL2 + canvas2d 回退)
```

| 包 | 说明 |
| --- | --- |
| `vigilkit` | 核心微内核引擎：AV 同步、jitter buffer、解码调度。零第三方运行时依赖。 |
| `@vigilkit/plugin-sdk` | 插件契约类型与插件注册表。 |
| `@vigilkit/plugin-flv` | FLV demuxer 插件（H.264/AAC）。 |
| `@vigilkit/plugin-ws` | WebSocket transport 插件（`ws` / `wss`）。 |
| `@vigilkit/renderer` | WebGL2 与 Canvas2D `VideoFrame` 渲染器。 |
| `@vigilkit/example-basic` | 私有示例应用：WS-FLV 播放，供 e2e 套件使用。 |

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

## 浏览器支持（v0.1）

| 能力 | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| WebCodecs H.264 解码 | 94+ | 130+ | 16.4+ |
| WebGL2 `VideoFrame` 渲染 | 支持 | 支持 | 支持 |
| Canvas2d 回退 | 支持 | 支持 | 支持 |
| HEVC（H.265）解码 | 仅硬件解码 | v0.1 不支持（WASM 软解已规划） | 17.4+ 硬件 |
| WebGPU 零拷贝后端 | v0.2+（规划中） | v0.2+（规划中） | v0.2+（规划中） |

## 路线图

- **v0.2**：WebGPU 零拷贝渲染后端；HLS 与 WHEP 插件；HEVC WASM 软解（隔离的 LGPL 模块），让 Firefox 也能播放 HEVC。
- **v1.0**：API 冻结、plugin SDK 稳定版、双语文档。

## 测试

```sh
pnpm test            # 全部包共 130 个单元测试
pnpm test:e2e        # 针对 basic 示例的 Playwright e2e
node scripts/check-licenses.mjs --ci   # 许可证扫描，结论必须保持 PASS
```

首次运行 e2e 前先执行 `pnpm exec playwright install chromium`。e2e 套件基于已提交的测试样本复现 QA：一段 FFmpeg FATE FLV 样例（`examples/basic/fixtures/`，sha256 锁定）。v0.1 e2e 实测：WS-FLV 在 headless Chromium 中播放，解码 203 帧、约 34 fps、0 错误，断开时干净清理。

`pnpm notices` 会根据已安装的依赖树重新生成 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 参与贡献

插件编写指南、商业边界与工程规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

vigilkit 采用 [Apache License 2.0](LICENSE) 许可。核心引擎与标准插件永久开源；企业级附加功能与厂商协议定制是唯一的商业面。
