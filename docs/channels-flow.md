# Channels 调用链

Channels 把远程聊天通道接到本地 `QueryEngine`：通道消息进引擎，模型回复再发回通道。

当前 CLI 真正接线的是 **飞书基础版**（`FeishuAdapter`）。库里还有 `StdioAdapter` / `HttpAdapter`，但 `ohs channels serve` 暂未组装它们。

设计细节见 [`channels-bridge-design.md`](./channels-bridge-design.md)。

## 核心模型：长驻桥接 + 双队列

分两阶段：

1. **启动**：读 settings → 组装 adapter → `bootstrap` 引擎 → 起 MessageBus / Manager / Bridge。
2. **运行**：入站 adapter → ACL → inbound 队列 → Bridge → `submitMessage` → outbound 队列 → adapter.send。

```text
┌─ 启动（一次）─────────────────────────────────────────┐
│ ohs channels serve                                     │
│   loadSettings → assembleChannelAdapters(feishu)       │
│   bootstrap(QueryEngine) → MessageBus                  │
│   ChannelBridge.start() + ChannelManager.startAll()    │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 每条通道消息 ─────────────────────────────────────────┐
│ Feishu WS → FeishuAdapter                              │
│   → ChannelManager ACL（fail-closed）                  │
│   → MessageBus.inbound                                 │
│   → ChannelBridge → engine.submitMessage()             │
│   → 聚合 text_delta → MessageBus.outbound              │
│   → ChannelManager.dispatch → adapter.send()           │
└────────────────────────────────────────────────────────┘
```

另有一条**出站捷径**（不经 serve）：REPL/TUI 里模型可调 `FeishuPush` 工具，直接按 `allowFrom` 映射往飞书发文本。

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| CLI 入口 | `apps/cli/src/commands/channels.ts` | `ohs channels serve/status`；组装 adapter、bootstrap、启停 |
| MessageBus | `packages/channels/src/bus/queue.ts` | inbound/outbound 双异步 FIFO；会话键 `channel:chatId` |
| ACL | `packages/channels/src/bus/acl.ts` | `isAllowed`：空拒 / `*` 全放 / 分段匹配 |
| ChannelManager | `packages/channels/src/manager.ts` | 启停 adapter、入站 ACL、出站分发循环 |
| ChannelBridge | `packages/channels/src/bridge.ts` | 消费 inbound → `submitMessage` → 发布 outbound |
| FeishuAdapter | `packages/channels/src/impl/feishu.ts` | 飞书 WS 收消息、文本发送、@bot / 去重 |
| FeishuPush 工具 | `packages/tools/src/channels/feishu-push.ts` | REPL 侧主动推送到 allowFrom 目标 |
| Settings | `packages/core/src/types/settings.ts` | `ChannelsConfig` / `FeishuChannelSettings` |
| 权限 | `apps/cli/src/commands/channels.ts` + `@openharness/permissions` | serve 无头模式自动放行只读工具集 |

## A. 启动阶段

```text
ohs channels serve
  └─ runChannelsServe()                            # apps/cli/src/commands/channels.ts
       ├─ loadSettings()
       ├─ assembleChannelAdapters(settings.channels)
       │    └─ feishu.enabled + appId/appSecret
       │         → new FeishuAdapter(...)
       │         → allowFrom["feishu"] = Object.values(feishu.allowFrom)
       ├─ bootstrap({ autoApproveTools: READ_ONLY_TOOLS, ... })
       │    └─ QueryEngine / ToolRegistry / skills …
       ├─ new MessageBus()
       ├─ new ChannelManager(adapters, bus, { allowFrom, sendProgress, sendToolHints })
       ├─ new ChannelBridge({ engine, bus })
       ├─ bridge.start()                           # 消费 inbound 循环
       └─ manager.startAll()                       # connect adapters + 出站循环
```

子命令：

```bash
ohs channels serve     # 长驻桥接；Ctrl+C 优雅停，再按一次强制退出
ohs channels status    # 查看 feishu enabled / allowFrom
```

配置示例（`~/.openharness/settings.json`）：

```json
{
  "channels": {
    "sendProgress": true,
    "sendToolHints": true,
    "feishu": {
      "enabled": true,
      "appId": "...",
      "appSecret": "...",
      "encryptKey": "",
      "verificationToken": "",
      "allowFrom": {
        "个人": "ou_xxx",
        "工作群": "oc_xxx"
      },
      "replyAtBotNames": ["OpenHarness"]
    }
  }
}
```

`startAll` 要点：

- `allowFrom` 为空或缺省 → 告警 + **全拒**（fail-closed）。
- 单 adapter `connect()` 失败只记 `lastError`，不拖垮其他通道。
- 全部失败则 `bridge.stop` + `manager.stopAll` 后退出。
- 出站分发循环与 adapter 连接同时启动；用 `AbortSignal` 退出（非轮询）。

## B. 入站：通道 → 引擎

### B1. FeishuAdapter 收消息

```text
飞书 im.message.receive_v1
  └─ FeishuAdapter._handleEvent()
       ├─ sender_type === "bot" → 跳过
       ├─ message_id 60s 去重
       ├─ 解析 content.text
       ├─ 群聊：若配置了 replyAtBotNames，须 @bot 才处理
       ├─ 清洗 mention 占位符
       └─ handler(ChannelMessage)
            sender / content / replyTo(群=chat_id，私聊=open_id)
```

### B2. Manager ACL → inbound

```text
ChannelManager.handleInbound(channel, msg)
  ├─ isAllowed(msg.sender, allowFrom[channel])
  │    空/缺失 → 拒
  │    "*" → 放
  │    整串或 sender.split("|") 任一段命中 → 放
  └─ bus.publishInbound({
       channel, senderId, chatId: replyTo ?? sender,
       content, media: [], metadata: { _message_id }
     })
```

队列满（默认 1000）时丢弃并打 warn，避免内存爆。

### B3. Bridge → QueryEngine

```text
ChannelBridge.loop
  └─ bus.consumeInbound(signal)
       └─ handle(msg)
            ├─ for await engine.submitMessage(msg.content)
            │    只聚合 type === "text_delta"
            ├─ 引擎抛错 → 回复 "[Error: failed to process your message]"
            └─ 非空 reply → bus.publishOutbound({
                 channel, chatId, content,
                 metadata: { _session_key: "channel:chatId" }
               })
```

要点：

- **顺序处理**（一次一条）；并发多会话隔离留待。
- 工具调用过程不原样透传通道；只回最终文本聚合结果。
- `bridge.stop` 只打断挂起消费，**不取消**正在跑的 `submitMessage`；二次 Ctrl+C 强退。

## C. 出站：引擎 → 通道

```text
ChannelManager.dispatchOutbound
  └─ bus.consumeOutbound(signal)
       ├─ metadata._progress / _tool_hint
       │    受 sendProgress / sendToolHints 门控
       ├─ adapters.get(msg.channel)
       └─ adapter.send({ content, replyTo: chatId, ... })
            Feishu: oc_ 前缀 → chat_id，否则 open_id
```

发送失败只记 warning，不中断出站循环。

## D. 无头权限

`channels serve` 无人确认权限弹窗。启动时把 `READ_ONLY_TOOLS` 注入 `autoApproveTools`，让“看”可用、“写/Bash”仍走拒绝。

```text
bootstrap({
  cliOverrides: { autoApproveTools: [...READ_ONLY_TOOLS] }
})
```

设计意图曾剔除 `WebFetch` / `WebSearch`（防“读本地 → 外带”）；若需收紧，可在 serve 组装处再 filter，或用 `settings.permission.deniedTools` / 收窄 `autoApproveTools`。

`full_auto` 对远程通道等于任意命令执行，不建议。

## E. FeishuPush（主动推送捷径）

不依赖 `channels serve`。模型在 REPL/TUI 里调工具：

```text
FeishuPush({ target: "工作群", message: "..." })
  └─ settings.channels.feishu.appId/appSecret
  └─ allowFrom[target] → chat_id
  └─ tenant_access_token → im/v1/messages
```

| 项 | serve 桥接 | FeishuPush |
|----|------------|------------|
| 方向 | 双向（收消息 → 回复） | 仅出站推送 |
| 进程 | `ohs channels serve` 长驻 | 普通 CLI/TUI 会话内 |
| 目标 | 回复入站 chatId | `allowFrom` 的 name→id 映射 |
| 引擎 | 每条入站都 `submitMessage` | 由当前会话模型决定何时推 |

## F. ACL 与会话键

| 规则 | 行为 |
|------|------|
| `allowFrom` 空 / 未配置 | 全拒 + 启动告警 |
| `allowFrom` 含 `"*"` | 全放 |
| name→id 映射 | serve：values 作白名单；FeishuPush：按 name 查 id |
| `senderId` 含 `\|` | 任一段命中即放行 |

会话键：

```text
sessionKey = sessionKeyOverride ?? `${channel}:${chatId}`
```

群聊 `chatId` 为飞书 `chat_id`（常 `oc_` 开头）；私聊多为 sender `open_id`。

## G. 状态与退出

`ohs channels status`：

```text
feishu: enabled (allowFrom: 个人(ou_xxx), 工作群(oc_xxx))
# 或
feishu: enabled (allowFrom empty — ALL DENIED)
```

serve 启动日志示例：

```text
[channels] feishu: running
[channels] 桥接已就绪，Ctrl+C 退出。
```

退出：

1. 第一次 SIGINT/SIGTERM → `bridge.stop` → `manager.stopAll`（disconnect WS）
2. 第二次 → `process.exit(130)` 强制退出
