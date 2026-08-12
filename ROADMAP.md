# vigilkit Roadmap（v0.4+）

> 基线：v0.3 已发布（2026-08-12）—— 8 包在 npm：7×0.1.0 + @vigilkit/plugin-hevc-wasm@0.1.1。
> 规模：361 单测 + 8 e2e（chromium+firefox）全绿。功能：HLS/WHEP/FLV/WS 插件、WebCodecs 硬解 + libde265 HEVC 软解、WebGPU/WebGL2/canvas2d 渲染、音频播放 + audio-master 同步、rAF pump。

---

## P0 —— 技术完整性（v0.4，先把「播放器」补成「播放器」）

| # | 项 | 为什么 | 验收 |
|---|---|---|---|
| 1 | **引擎级 HEVC 集成**：FLV H.265（codecId 12）demux + TS-HEVC demux → 走 `softDecoder` 管线 | 目前 `softDecoder` 选项无源可用（v0.3 最大遗留）；补全后 createPlayer 端到端播 HEVC | FLV(H.265) 与 TS(HEVC) fixture 通过引擎播放；Firefox 走 libde265 |
| 2 | **采样级 A/V 漂移校正** | 当前 audio-master 是基础版（无样本精确对齐）；长流漂移会累积 | 10 分钟流 A/V 偏移 < 50ms（e2e 可测） |
| 3 | **WHEP insertable-streams 编码路径** + MediaMTX 真实对接 | 直通帧路径不能进 `softDecoder`/录制；编码路径解锁转码/后处理 | 对接 docker MediaMTX 的 WHEP e2e |
| 4 | **AV1/H.264 WASM 软解**（dav1d / OpenH264，隔离模块复用 hevc-wasm 模式） | Firefox Android 无 WebCodecs、Safari 无硬解 AV1 设备；「全格式覆盖」最后一块 | dav1d smoke 解码 ≥1 帧；OpenH264 smoke |
| 5 | **多路并发性能基线**（4/9/16 路） | 安防核心场景；当前无内存/CPU 数据 | benchmark 页面 + 每路内存 < X MB 预算文档 |

## P1 —— 生态扩展（v0.5）

| # | 项 | 说明 |
|---|---|---|
| 6 | HLS AES-128 + 滑动窗口直播 + DASH/CMAF | 直播/加密场景；DASH 复用 media-utils |
| 7 | 海康 / 大华 / 宇视私有协议插件 | 商业面（v1 开源流量引擎，已定策略）；0x48 0x4B = 海康帧头（报告已修正） |
| 8 | WHEP/WHIP 对端 + WebTransport/MoQ 插件 | 低延迟矩阵补全；MoQ 对接 moq-dev 生态 |
| 9 | MQTT 插件（IoT）、GB28181 适配 | 长尾协议，社区贡献欢迎区 |
| 10 | WebGPU 多路网格 / OSD 叠加 / 滤镜 | 差异化护城河可视化（importExternalTexture 复用） |

## P2 —— 工程质量（贯穿）

| # | 项 | 说明 |
|---|---|---|
| 11 | **Demuxer fuzz 测试**（结构化随机字节） | 媒体解析器行业标准；mpegts.js/hls.js 都有 |
| 12 | **API 参考文档**（typedoc）+ 错误码表 | 消费者排障；`MediaErrorCode` 全量文档化 |
| 13 | **发布自动化启用**：配 `NPM_TOKEN` secret、release.yml 启用、changelog、版本策略（0.1.x 维护 vs 0.2.0） | 用户操作项：GitHub Secrets 添加 token |
| 14 | **跨浏览器矩阵**：Safari（macOS runner）、WebGPU 真机验证 | 软解在 Safari 的验证 |
| 15 | worker wasm 死锁根因排查（headless Chromium dedicated worker） | 换 libde265 版本或构建参数；记录为已知问题文档 |

## P3 —— 社区/运营

| # | 项 | 说明 |
|---|---|---|
| 16 | 独立 examples 仓库 + playground + 文档站 | README 已双语文档；站点化是自然下一步 |
| 17 | GitHub Discussions、issue 模板、贡献者激励 | 开源采纳飞轮 |
| 18 | 首个真实生产案例（dogfooding） | README 引用；信任状 |

---

## 版本策略建议

- **0.1.x**：修复性维护（当前 8 包基线；hevc-wasm 已 0.1.1，后续 bugfix 同步 bump）
- **0.2.0**：P0 全部完成时发布（含引擎 HEVC 集成，补齐「createPlayer 播 HEVC」承诺）
- **1.0.0**：P1 完成 + API 冻结 + 稳定插件 SDK

## 风险与依赖

- **商业面时间点**：海康/大华插件（P1-7）建议与 0.2.0 并行启动 —— 它是流量引擎，越早开源越早建立心智
- **WHEP e2e 依赖 docker**：MediaMTX 无自发布器（需 WHIP 发布端），CI 里用 Playwright fake-camera + docker 方案（P0-3 包含）
- **Firefox Android**：无 WebCodecs → 优先级 P0-4（AV1/H.264 软解）直接决定该平台可用性
