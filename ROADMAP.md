# vigilkit Roadmap（v0.4+，Momus 评审修订版）

> 基线：v0.3 已发布（2026-08-12）—— 8 包在 npm：7×0.1.0 + @vigilkit/plugin-hevc-wasm@0.1.1。
> 规模：361 单测 + 8 e2e（chromium+firefox）全绿。功能：HLS/WHEP/FLV/WS 插件、WebCodecs 硬解 + libde265 HEVC 软解、WebGPU/WebGL2/canvas2d 渲染、音频播放 + audio-master 同步、rAF pump。
> 本版已按 Momus 计划评审修订：方向判定「正确，需调整」—— 关键修订：新增 stall/QoS 为 P0、P0-4 降级、P1 重划分、验收标准全部可测化、增加时间维度与维护者带宽约束。

---

## 约束（不可动摇）

- 核心 + 标准插件 Apache-2.0 永久开源；商业面 = 企业级附加功能 + 海康/大华/宇视定制插件（v1 开源引流策略）
- 零第三方运行时依赖（营销点）；HEVC 硬解优先 + LGPL 软解文档化；RTSP = 服务端中继客户端架构
- **单一维护者带宽是硬约束**：P0 精简为 3 项，估算 3-4 个月；不设时间轴的版本号是空承诺

---

## P0 —— v0.4（3-4 个月，技术完整性）

| # | 项 | 验收标准（全部可测） | 说明 |
|---|---|---|---|
| 1 | **引擎级 HEVC 集成**：FLV H.265（Enhanced-RTMP 封装，FourCC hvc1）demux + TS-HEVC demux → 走 `softDecoder` 管线 | createPlayer + flvDemuxerPlugin + softDecoderFactory 播放已提交的 codecId=12 fixture → state=playing、≥30 framesDecoded、0 errors（chromium + firefox；firefox 走 libde265）| 已验证无引擎依赖（CodecRoutingDecoder/softDecoder 已就绪，只缺 demux）。注意 FLV H.265 是 Enhanced-RTMP 盒式封装，非 AVC 路径的简单扩展。fixture 来源需确定（FATE 或手编码，无 ffmpeg）|
| 2 | **stall/QoS 检测**（新增，Momus P0 判定）| jitter-buffer 空转 + 帧节拍看门狗 → 触发 `STALLED`/`NETWORK`/`TIMEOUT` 错误（`MediaErrorCode` 扩展）；`PlayerStats` 增 `stalledCount`/`rebufferMs`/`currentBufferMs` | 安防丢包网络第一大生产问题：静默卡死。现有错误码无网络停滞类（types.ts:1-3）|
| 3 | **采样级 A/V 漂移校正** | (a) 单测：合成时钟 + 漂移音源模拟 10 分钟时间线 → 校正后偏移 < 50ms；(b) 集成：`PlayerStats.avOffsetMs` 暴露，3 分钟已提交 fixture（chromium 断言 \|offset\| < 50ms；firefox/headless AudioContext 限制文档化）；10 分钟主张降为手动 QA 流程 | 原标准「10 分钟 e2e」不可执行：无偏移测量面、无 10 分钟 fixture、headless AudioContext 可能不启动（basic.spec.ts 已证）|
| 4 | **多路并发性能基线**（4/9/16 路）| benchmark 页播放 4/9/16 路 1080p H.264 FLV fixture；`performance.measureUserAgentSpecificMemory`（chromium）断言每路内存 < 100MB、总量 ≤ 1.5GB、每路解码 fps ≥ 下限、0 stall 事件；数字发布到基准页 + 预算文档 | **前置依赖：worker 死锁修复（原 P2-15 提到 P1）** —— 16 路软解在主线程不可调度。X 必须定义，否则不可执行 |

## P1 —— v0.5（生态 + 补齐，4-6 个月）

| # | 项 | 验收标准 | 说明 |
|---|---|---|---|
| 5 | **WHEP insertable-streams 编码路径** + MediaMTX 对接 | docker MediaMTX（compose 暴露 8889 端口）+ 页内 WHIP 发布端（Playwright fake-camera + --use-fake-ui-for-media-stream）→ 播放 state=playing、≥N 帧、0 errors。**Chromium-only，明确文档化**（RTCRtpScriptTransform 无 FF/Safari 支持）| 隐藏依赖必须言明：WebRTC 音频（Opus）无路径（whep-source.ts:143 仅视频段），SDP→AudioDecoderConfig 转换不存在；若音频出界必须明说 |
| 6 | **AV1/H.264 WASM 软解**（dav1d / OpenH264，复用 hevc-wasm 隔离模式）| 每包 smoke 双路径（node + browser）≥1 帧；**体积预算**：每个 wasm ≤ 1MB gzipped + 懒加载（首次遇 codec 才 fetch）；**OpenH264 仅用 Cisco 官方二进制，禁止重编译**（Cisco 专利授权仅覆盖其实现）| 从 P0 降级：WebCodecs H.264 已覆盖桌面三浏览器；Firefox Android 无 e2e 手段（见风险 3）|
| 7 | **HLS 直播补全**：段修剪（内存）+ AES-128（#EXT-X-KEY）| live 10 分钟 e2e：内存稳定（无无限增长）、加密流可播 | 滑动窗口 50% 已存在（live reload + mediaSequence 跟踪，缺修剪与 KEY 解析）|
| 8 | **海康 / 大华 / 宇视插件**（商业面引流）| 海康 ISAPI-digest 认证 + WS-FLV/HTTP-FLV 发现 → 复用现有 FLV/WS 插件面；真实相机手动 QA 流程文档化（CI 无法测硬件）| 比想象可做：现代海康/大华 Web 访问 = ISAPI 认证层 + 现有协议面。建议先海康 |
| 9 | **no-WebCodecs 回退策略**（决策项）| README + 文档声明支持底线：WebCodecs 缺失（iOS <17.4、Firefox Android）→ `<video>`/MSE 元素回退 或 明确「不支持」清单 | 「全格式覆盖」无底线则不可达成 |

## P2 —— 质量 + 长尾（v0.6+）

| # | 项 | 说明 |
|---|---|---|
| 10 | worker wasm 死锁根因（原 P2-15 **提前**，P0-4 前置依赖） | 换 libde265 版本/构建参数；失败则记录已知问题文档 |
| 11 | demuxer fuzz（结构化随机字节） | 媒体解析器行业标准 |
| 12 | 音频编码广度：G.711/G.726/PCM + Opus（WebCodecs AudioDecoder 不覆盖 G.711 → 软音频路径或明确 video-only 姿态） | GB28181/RTSP 中继相机常见 G.711 |
| 13 | DASH/CMAF、MoQ/WebTransport、GB28181（SIP+PS demux） | 各为独立多周项目；MoQ 是移动 IETF draft |
| 14 | WS 重连/退避策略（transport-pipeline 现无） | 安防 WS 断流常态 |
| 15 | npm provenance（--provenance + OIDC）+ SBOM 生成（接 check-licenses） | 供应链信任；release.yml 启用前 |
| 16 | typedoc API 文档 + 错误码全表 | 消费者排障 |
| 17 | Safari e2e（macOS runner）、WebGPU 真机验证、多路网格/OSD | 平台矩阵补全 + 护城河可视化 |
| 18 | MQTT 插件（IoT）、文档站、Discussions、生产案例 | 社区运营（MQTT 降自 P1） |

## 快速胜利（P1 前顺手做，各 ≤ 1 天）

- README「npm install」发布包安装片段（现只文档化 monorepo 开发流）
- release.yml 配 NPM_TOKEN 后启用（用户操作）
- docker-compose.yml 暴露 WHEP 8889 端口
- e2e 过期 KNOWN-DEFECT 注释修复（已随本版修订提交）

## 版本策略

- **0.1.x**：修复性维护（当前基线；后续 bugfix 同步 bump）
- **0.2.0**：P0（stall/QoS + 引擎 HEVC + A/V 校正 + 多路基线）完成 —— 兑现「createPlayer 播 HEVC」
- **1.0.0**：P1 完成 + API 冻结 + 稳定插件 SDK

## 风险（评审确认需言明）

1. **维护者带宽**：P0 全做 = 3-4 个月 solo；P0 已精简为 3 项，若带宽不足 P0-4（多路）可移 P1
2. **P1 不是一次发布**：DASH+MoQ+GB28181+3 厂商插件 = 4-5 个发布的工作量；已按此重划分
3. **Firefox Android 不可测**：Playwright 无 headless Firefox-Android；「Firefox 走 libde265」只能在桌面 Firefox e2e 验证，移动端需真机手动流程
4. **WASM 体积**：libde265 352KB；dav1d+OpenH264 将把「全格式」推到 ~3MB —— 已有懒加载 + 每包预算约束（P1-6）
5. **MediaMTX e2e flakiness**：docker+WebRTC+fake-camera 是最易碎 CI 拓扑 —— 需重试策略 / PR 与 nightly 分离 / docker 缺失时跳过
6. **专利边界**：OpenH264 仅 Cisco 官方二进制有效（P1-6 已约束）；HEVC 硬解优先立场不变
