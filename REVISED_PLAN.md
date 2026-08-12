# 修订版立项方案 —— 开源 Web 音视频播放器 SDK

> 基于《bg-report.md》可行性报告 + 2026-08 生态/浏览器能力/许可证三项深度调研后的修正版。
> 状态：待用户选定项目名后生效。

---

## 1. 项目定位

**一句话**：Apache-2.0 许可、WebCodecs 硬解优先、插件化传输协议的开源 Web 音视频播放器 SDK，面向安防监控 / IoT / 智慧城市场景。

**战略定位**：
- v1 全开源（核心 + 通用协议插件 + 三大厂商协议插件），目标是**社区采纳与心智份额**，不设付费墙；
- 商业后移：收入来自**企业级附加功能**（多路并发优化、录像回放、加密流、云台联动）与**定制适配**（长尾私有协议、场景化交付），v2+ 启动；
- 差异化护城河：**WebGPU 零拷贝渲染层**（当前唯一无人占据的维度）+ **全开放插件生态**（无人以宽松许可做全）。

## 2. 项目命名（已确认：**vigilkit**）

- **含义**：vigil = 守夜/警戒，「守夜人套件」，安防意象与项目定位完全咬合；3 音节、中英文皆易读易记；
- **npm 裸名**：✅ 可用（2026-08-12 验证）；
- **注册清单（立项即办）**：
  1. npm 包名：`vigilkit`（核心包）+ `@vigilkit/plugin-*` 系列；
  2. GitHub org：`vigilkit`（若被占则 `vigilkit-org`，发布前实测）；
  3. 商标：中国 + 国际（尼斯分类第 9/42 类：软件/开发服务）注册检索与申请；
  4. 域名：vigilkit.dev / vigilkit.io（备用）。

> 落选：vidlens、streamkit（撞 Twitch 概念）、eyekit、vigilview；已排除：vskit（npm 被占 + Vskit.tv 短视频平台商标冲突）、watchkit（Apple 商标）、camkit（npm 被占）。

## 3. 技术方案（修正版）

### 3.1 总体架构：组装式，非自研

只自研「差异化」部分，其余全部复用许可干净的现成组件：

| 层 | 方案 | 复用组件（许可证） |
|---|---|---|
| 传输客户端 | 插件化，不内置 | mpegts.js (Apache-2.0)、mqtt.js (MIT)、WHEP(原生 RTCPeerConnection) |
| 解封装 | 复用现成 | mp4box.js (BSD-3)、jmuxer (MIT)、mediabunny (MPL-2.0) |
| HLS | 复用/移植 | hls.js (Apache-2.0) |
| 硬解码 | WebCodecs（浏览器原生） | — |
| 软解码 AV1/H.264 | 现成 WASM | dav1d (BSD-2)、OpenH264 (BSD-2+Cisco 专利授权) |
| 软解码兜底 | 现成 WASM | libav.js (LGPL-2.1，无 GPL 组件)、minimp3 (CC0) |
| 软解码 HEVC | 隔离模块 | libde265 (LGPL-3.0) 或自建 LGPL FFmpeg |
| 渲染 | WebGL2 基线 + WebGPU 增强 | 原生 API |
| 服务端中继（配套） | 文档化对接，不内嵌 | MediaMTX / go2rtc / ZLMediaKit（全 MIT） |

**自研范围（护城河）**：
1. 微内核引擎 + 插件 SDK（AV 同步、jitter buffer、解码管线调度）；
2. WebGPU 零拷贝渲染后端（渐进增强层）；
3. 海康/大华/宇视私有协议插件（**从零自研，禁止复制厂商 SDK 或 GPL 逆向项目代码**）。

### 3.2 解码引擎：双引擎，HEVC 软解为强制组件

- 硬解优先：H.264（≈100% 覆盖）、HEVC（Chrome 107+ / Edge / Safari 17.4+，OS 级硬件解码）；
- **Firefox 无任何 HEVC 能力**（WebCodecs 与 `<video>` 皆无）→ WASM 软解 HEVC 是**关键路径组件**，非可选兜底；
- 所有浏览器 HEVC WebCodecs 均为纯硬件（无软解），Chrome Windows 无 GPU 时 `isConfigSupported()` 返回 false（Chrome 109+ 可靠）；
- Firefox Android 无 WebCodecs → MSE/`<video>` 兜底路径保留。

### 3.3 渲染：WebGL2 为基线，WebGPU 为渐进增强

- **基线**：WebGL2 `texImage2D(VideoFrame)`（覆盖 Chrome/Edge/Firefox 130+/Safari 16.4+）；
- **增强**：WebGPU `importExternalTexture`（Chrome 113+ / Safari 26+ / Firefox 144+ 仅 Windows）；
- 原报告性能基准表（45ms/2ms 等）无来源，**废弃**；发布前自建基准页面（WebGL2 vs WebGPU 实测对比），用真实数据作卖点；
- `importExternalTexture` 生命周期语义差异（VideoFrame vs HTMLVideoElement 源）需在渲染层封装统一。

### 3.4 传输：RTSP 采用服务端中继架构（修正原报告误解）

- 浏览器无法直连 RTSP；插件形态 = **中继协议客户端**：
  - 主路径：WHEP/WebRTC 拉流（低延迟事实标准，MediaMTX/go2rtc/ZLMediaKit 均支持）；
  - 兼容路径：WebSocket FLV/TS/裸流（mpegts.js / ZLMediaKit WS-FLV）；
  - 前沿路径：WebTransport/MoQ（draft 未冻结，作为可选插件，参考 moq-js Apache-2.0）；
- 海康私有帧头为 `0x48 0x4B`（ASCII "HK"）—— 原报告误标为大华，**修正**；大华走其原生 RTSP-over-WebSocket 特性或标准 RTSP 中继。

### 3.5 浏览器支持基线（2026-08 实测矩阵）

| 能力 | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| WebCodecs | 94+ | 130+（Android 无） | 16.4+（26+ 完整） |
| HEVC WebCodecs 解码 | 107+（纯硬件） | ❌ 无 | 17.4+（硬件） |
| WebGPU | 113+（Linux 144+） | 141+ Win / 145+ macOS-AS | 26+ |
| WebTransport | 97+ | 114+ | 26.4+ |
| MSE | 通用 | 通用 | 通用；iOS 需 ManagedMediaSource |

## 4. 开源 / 商业边界

| 范围 | 策略 |
|---|---|
| 核心内核 + 插件 SDK | Apache-2.0 永久开源 |
| 通用协议插件（HLS/FLV/WS/WHEP/MoQ） | 开源，欢迎社区贡献 |
| **海康/大华/宇视插件** | **v1 开源（流量引擎），单插件本身不收钱** |
| 企业级附加功能 | v2+ 闭源增值（多路并发、录像回放、加密流、云台联动、批量适配） |
| 定制开发 | 长尾私有协议适配、场景化交付（现成现金流，随时可启动） |
| 社区治理 | CONTRIBUTING.md 写明边界：长尾协议欢迎社区贡献，三大厂商归核心团队，避免社区免费写掉商业插件 |

## 5. 许可证合规红线（机器守卫，非人肉）

| 组件 | 许可证 | 处理 |
|---|---|---|
| `@ffmpeg/core` (npm) | GPL-2.0-or-later | ❌ 禁止，仅可自建 LGPL FFmpeg |
| h265webjs / Jessibuca / x264 / x265 | GPL | ❌ 禁止 |
| fdk-aac | 专有 | ❌ 禁止 |
| mediabunny | MPL-2.0 | ⚠️ 文件级 copyleft，保留文件头 + NOTICE |
| libde265 | LGPL-3.0（非 2.1） | ⚠️ 独立 WASM 模块 + 源码提供 + 可重链接 |
| libav.js | LGPL-2.1 | ⚠️ 独立 WASM 模块，随包提供源码 |
| HEVC 专利池 | 非代码问题 | ⚠️ 文档明示：HEVC 建议走硬件解码，软解商用由使用方自评估 |
| dav1d / OpenH264 / minimp3 / mp4box.js / mpegts.js / hls.js / mqtt.js | BSD/CC0/Apache/MIT | ✅ 直接引入 |

**合规机制**：CI 集成 license-checker，任何 PR 引入 GPL/AGPL/专有依赖直接失败；THIRD-PARTY-NOTICES 自动生成；README 明示「零遥测、零埋点」。

## 6. 里程碑路线图

| 版本 | 内容 | 验收标准 |
|---|---|---|
| v0.1 | 微内核 + FLV/WS 插件 + WebGL2 渲染 + H.264 | 最小可播：WS-FLV 拉流 1080p 流畅 |
| v0.2 | HLS 插件 + HEVC 软解（WASM 隔离模块） | Firefox 可播 HEVC；HLS 全端可用 |
| v0.3 | 海康/大华/宇视插件 + WHEP + WebGPU 后端 | 三厂商实流可播；WebGPU 基准数据发布 |
| v1.0 | API 冻结 + 插件 SDK 稳定版 + 双语文档 + 案例 | SemVer 1.0；社区贡献流程可用 |

## 7. 发布检查清单

### P0（发布前必须）

- [ ] 项目命名确认 + npm/GitHub/商标登记
- [ ] 跨浏览器 CI 矩阵：Chrome/Edge/Firefox/Safari × {WebCodecs, MSE, WebGPU} × {H.264, HEVC, AV1}，每 PR 必跑
- [ ] 许可证合规 CI（红线自动化）
- [ ] 一键部署示例：docker-compose（MediaMTX 中继 + 示例页面）
- [ ] 多路并发性能预算文档化：4/9/16 路同屏、每路内存 < X MB、掉帧率 < Y%
- [ ] README 商业模式透明声明 + 零遥测声明

### P1（发布后 90 天）

- [ ] 真实生产案例（dogfooding）写入 README
- [ ] 中文社区冷启动（掘金/公众号/B 站教程）+ 国际投稿（Hacker News / video-dev）
- [ ] SBOM 产物 + 政企供应链合规材料
- [ ] 合成测试流本地体验包（FFmpeg 生成彩条/公开测试流；**不做公网真实摄像头 demo，规避隐私合规风险**）

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 窗口收窄（movi-player/flow-player/Nimio 已占子集） | v1 尽快落地 WebGPU 渲染 + 三厂商插件，占据唯一真空维度 |
| 维护负担（浏览器矩阵年年变） | CI 自动化矩阵 + 明确维护承诺（发布 = 三年承诺） |
| 社区免费写掉商业插件 | CONTRIBUTING.md 边界 + 核心团队主导三大厂商插件 |
| HEVC 专利 | 硬解优先 + 软解责任文档化 |
| 品牌混淆 | 立项即定名，注册 npm/GitHub org/商标 |

---

*本文档为立项依据。命名选定后更新 §2 并创建正式仓库。*
