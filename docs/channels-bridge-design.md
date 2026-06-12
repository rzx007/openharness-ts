# 设计：D.2 Channels 基座 + 飞书基础版接线

> 状态：已批准（用户裁决：**微信不做**——Python v0.1.9 本就无微信通道，
> 最接近的 mochat 是 Mochat 平台的 Socket.IO 桥；飞书做**基础版接线**，
> 媒体/卡片/分片等 1342 行全功能留待）。

## 背景

Python 侧 `channels/` 是四件套：`MessageBus`（inbound/outbound 双异步队列）、
`BaseChannel`（统一 ACL + `_handle_message` 入站汇聚）、`ChannelManager`
（按 config 启停通道 + 出站分发循环）、`ChannelBridge`（消费 inbound →
`engine.submit_message()` 聚合 `AssistantTextDelta` → 发布 outbound）。
值得注意：Python 的 ChannelManager/Bridge 只在 channels 模块内被引用——
与 swarm 三件套一样是**未接线的库**，真正消费方是 ohmo/dashboard（不移植）。
TS 按既例做**移植 + 自有接线**（CLI 长驻模式）。

TS 现状：`packages/channels/` 仅有 `ChannelAdapter` 接口 + stdio/http/feishu
三个 adapter + 通用 `EventBus`，无 bus/manager/bridge，无 CLI 入口。

## R1 — MessageBus + ACL

- `bus/events.ts`：`InboundMessage`（channel/senderId/chatId/content/timestamp/
  media/metadata/sessionKeyOverride + `sessionKey` 派生 = override ??
  `${channel}:${chatId}`）、`OutboundMessage`（channel/chatId/content/replyTo/
  media/metadata）。字段 camelCase（TS 惯例），语义一一对应 Python。
- `bus/queue.ts`：`MessageBus`——`publishInbound/consumeInbound/
  publishOutbound/consumeOutbound` + `inboundSize/outboundSize`。
  TS 无 asyncio.Queue，自实现 promise 队列：消费者先到则挂起 resolver，
  生产者先到则缓冲；FIFO。`consume*` 接受可选 `AbortSignal`（替代 Python
  `wait_for(timeout=1)` 轮询——TS 用 signal 优雅退出，差异记录）。
- `acl.ts`：`isAllowed(senderId, allowFrom)`——**空列表全拒**（fail-closed，
  与 Python 一致）、`"*"` 全放、整串匹配或 `senderId.split("|")` 任一段命中。

## R2 — ChannelManager + ChannelBridge

- `manager.ts`：构造 `(adapters: ChannelAdapter[], bus, opts)`。
  与 Python 差异：Python manager 内部 `_init_channels` 按 config 硬编码
  11 个通道的 import；TS 改为**外部注入 adapter 实例**（依赖倒置，CLI 侧
  组装），manager 只管启停/路由。
  - `startAll()`：逐 adapter `connect()`（单个失败记 `lastError` 不拖垮
    整体）+ 启动出站分发循环；adapter `onMessage` → ACL 过滤（**集中在
    manager**，不信任 adapter 自带过滤；per-channel `allowFrom` 由 opts
    传入）→ `bus.publishInbound`。
  - 出站循环：`consumeOutbound` → 按 `msg.channel` 找 adapter →
    `adapter.send`（错误记日志不中断循环）；`_progress`/`_tool_hint`
    元数据门控对齐 Python（`sendProgress`/`sendToolHints` 开关）。
  - `stopAll()`：abort 分发循环 + 逐 adapter `disconnect()`。
  - `getStatus()`：`{ name: { running, lastError? } }`。
- `bridge.ts`：`ChannelBridge({ engine, bus })`。`start()` 起后台循环：
  `consumeInbound` → `engine.submitMessage(content)` 聚合 `text_delta` →
  非空则 `publishOutbound`（metadata 带 `_session_key`）；引擎抛错回复
  `[Error: failed to process your message]`（对齐 Python 文案）。顺序处理
  （一次一条，与 Python 同——并发会话隔离留待）。
- 适配既有 `ChannelAdapter` 接口：入站 `ChannelMessage` → `InboundMessage`
  的字段映射在 manager 完成（`sender`→senderId、`replyTo ?? sender`→chatId）；
  出站反向映射后调 `adapter.send`。

## R3 — CLI 接线（TS 自有）

- settings 增 `channels` 段：`{ sendProgress?, sendToolHints?, feishu?: {
  enabled, appId, appSecret, encryptKey?, verificationToken?, allowFrom,
  replyAtBotNames? } }`。
- `ohs channels` 子命令（长驻）：加载 settings → 构建引擎（复用 backendOnly
  的 bundle 组装路径）→ 按 enabled 组装 adapters → bus/manager/bridge 启动 →
  SIGINT/SIGTERM 优雅停（bridge.stop → manager.stopAll）。
- 飞书 adapter 调整：**去掉 adapter 内置 allowFrom 过滤**（上移 manager，
  语义从"空=全放"对齐为 Python 的"空=全拒"——安全修正）；@bot 过滤、
  mention 清洗、回复目标启发（`oc_` 前缀→chat_id）保持现状。
- 启动安全提示：通道 `allowFrom` 为空时打告警（对齐 Python
  `_validate_allow_from`）。

## 与 Python v0.1.9 差异

| 项 | Python | TS | 理由 |
|---|---|---|---|
| 微信 | 无 | 不做 | 用户裁决；Python 本就没有 |
| 通道范围 | 11 个 | 飞书基础版（+既有 stdio/http） | 用户裁决；telegram/discord 等留待 |
| manager 初始化 | 内部按 config import 11 通道 | 外部注入 adapter 实例 | 依赖倒置，免大 switch；组装在 CLI |
| ACL 位置 | BaseChannel | manager 集中 | adapter 保持薄；统一 fail-closed |
| 飞书空 allowFrom | 全拒 | 原为全放，**对齐为全拒** | 安全修正 |
| 队列退出 | wait_for 1s 轮询 | AbortSignal | TS 惯例，免空转 |
| 接线 | 库（ohmo 消费） | `ohs channels` 长驻模式 | 按 swarm 既例移植+接线 |
| 媒体下载目录 | resolve_channel_media_dir | 留待 | 基础版仅文本 |
| 飞书消息去重 / bot 消息跳过 | _processed_message_ids + sender_type 过滤 | 留待 | 基础版；WS 重投与 bot 互怼风险已知（审查 S3 记录） |
| 停止打断 in-flight | task.cancel 可打断处理中消息 | bridge.stop 只断挂起消费，处理中等其完成 | serve 模式二次 Ctrl+C 强退兜底 |

## 测试

- R1：bus FIFO/挂起消费者/abort；ACL 三语义（空拒/通配/分段）。
- R2：mock adapter + mock engine——入站经 ACL 进 bus、bridge 聚合回复出站、
  分发路由按 channel、单 adapter 失败不拖垮、progress 门控。
- R3：settings 解析 + adapter 组装纯函数单测；飞书真连接走手测
  （需真实 appId/appSecret，不进 CI）。
