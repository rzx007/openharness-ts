# 待修复 Bug 存档

> 记录于 2026-06-15，来源：全量代码审计（8 维度双轮并行 Workflow）。
> 已修复项见 git commit `5713cc4`、`8115ba0`。

---

## 🔴 High

### ~~H-1 task-worker 不读邮箱，shutdown 协议形同虚设~~ ✅ 已修复（commit `15f18fe`）
**文件**：`apps/cli/src/commands/main.ts` — `runTaskWorker()`  
**描述**：`runTaskWorker` 采用"读一行 stdin → 跑一轮 → 退出"模型，完全不轮询自己的
`TeammateMailbox`。leader 通过 mailbox 发送的 `shutdown` 类型消息永远堆积在收件箱
无人读取，实际终止路径只有 `TaskRunner.stopTask`（OS 信号）。`mailbox.ts` 中设计的
`createShutdownRequest`/`createIdleNotification` 工厂函数在 worker 侧是死代码。  
**修复思路**：在 `runTaskWorker` 的每轮 stdin 读取前（或任务结束后），检查一次自己的
mailbox，若有 `shutdown` 消息则上报 idle 并提前退出。

---

## 🟡 Medium

### ~~M-1 executeTools results 数组有 undefined 槽~~ ✅ 已修复
**文件**：`packages/core/src/engine/query-engine.ts:279`  
**描述**：`results` 初始化为 `new Array(toolUses.length)` 的稀疏数组。若某个 toolUse
既不进 `deny/ask` 分支也不进 `executable`（理论上不应发生，但 hook 逻辑变化时可能触发），
对应 `results[i]` 保持 `undefined`。调用方 `for (const result of results)` 不检查会
NPE。  
**修复**：初始化为 `results.fill(null)` 并在调用方 filter，或在 for 循环末尾断言
`results[i] !== undefined`。

### ~~M-2 bash 超时后 partial output 有竞态~~ ✅ 已修复（grace timer 前先 pause 流）
**文件**：`packages/tools/src/shell/bash.ts`  
**描述**：超时后 kill 进程时，stdout pipe buffer 中可能还有数据尚未触发 `data` 事件，
这部分数据在 kill 后丢失，截断位置不确定。大输出场景下问题更明显。  
**修复**：kill 前先 `pause()` stream，收完剩余 data 事件再 kill；或用 `drain` promise。

### ~~M-3 ImageToText/ImageGeneration 每次调用读磁盘~~ ✅ 已修复（模块级 settings 缓存）
**文件**：`packages/tools/src/media/image-to-text.ts:56`、`image-generation.ts:49`  
**描述**：每次 `execute` 都调 `loadSettings()`（读 `~/.openharness/settings.json`）。
高频调用下造成大量磁盘 I/O；若 settings 在两次调用间被修改，工具行为会不一致。  
**修复**：在工具注册时注入 `settings` 或 `apiClient`，而非运行时读盘。参考其他工具
通过 `ToolContext` 获取配置的模式。

### ~~M-4 ToolRegistry 工具名冲突时静默覆盖~~ ✅ 已修复（冲突时 console.warn）
**文件**：`packages/core/src/tools/registry.ts`  
**描述**：`register()` 在工具名已存在时直接覆盖，无任何警告日志。两个 MCP server 暴
露同名工具，或 MCP 工具与内置工具同名时，后注册的静默替换前者。  
**修复**：冲突时 `console.warn` 记录被覆盖的工具名和来源，方便用户排查意外替换。

### ~~M-5 ChannelBridge engine 报错时截断消息行为不明确~~ ✅ 已正确实现（catch 清空 parts 并发错误文案）
**文件**：`packages/channels/src/bridge.ts`  
**描述**：`handleInbound` 调用 `engine.submitMessage` 并聚合输出发 outbound。若
`submitMessage` 在中途抛错（如 `MaxTurnsExceeded`），已聚合的部分文本是否发出取决于
实现。用户可能收到截断消息而无任何错误提示。  
**修复**：在 catch 里明确发送一条错误消息给用户（"抱歉，处理出错：…"），而非静默截断。

### ~~M-6 REPL Ctrl+C 和正常退出可能双写 session 快照~~ ✅ 已修复（saveOnce flag）
**文件**：`apps/cli/src/commands/main.ts`  
**描述**：`rl.on('close')` 触发保存，同时正常退出时可能也有保存逻辑。Ctrl+C 后进程
如果未立即退出，两次保存可能以不完整状态覆盖第一次。  
**修复**：用一个 `saved` flag 保证只保存一次，`close` 事件和 exit 事件共享该 flag。

### M-7 loadSessionById messages 类型不安全
**文件**：`apps/cli/src/commands/main.ts:236`  
**描述**：`loadSessionById` 返回的 `payload.messages` 被 cast 为 `any` 后传给
`queryEngine.loadMessages`。历史文件被手动编辑时，格式错误数据会静默传入，在后续
API 调用时收到 400。  
**修复**：用 zod 或手写 type guard 校验 messages 结构，无效条目跳过或报错。

### M-8 McpToolCall (context as any).mcpManager 类型不安全
**文件**：`packages/tools/src/mcp/index.ts`  
**描述**：`McpToolCall` 通过 `(context as any).mcpManager` 获取 manager。若
`setMcpManager` 未被调用（如直接使用 bootstrap 但没有接线），mcpManager 为
undefined，工具抛 `Cannot read property of undefined`，错误信息对用户不友好。  
**修复**：加非 null 断言，manager 为 undefined 时返回友好错误文本而非让 JS 抛错。

### M-9 SubprocessBackend spawn 失败时 agentTasks 脏条目
**文件**：`packages/swarm/src/subprocess.ts`  
**描述**：`createAgentTask` 成功写入 `agentTasks` 映射后，若后续 `registerTeammate`
hook 失败，映射里留有已不存在进程的 agentId。后续 `terminate(agentId)` 会尝试
stopTask，stopTask 对已结束任务是 no-op，影响有限，但状态不干净。  
**修复**：`registerTeammate` 失败时从 `agentTasks` 删除对应条目并 stopTask。

### M-10 TaskManager writeToTask 懒复活有竞态
**文件**：`packages/services/src/tasks/index.ts`  
**描述**：`writeToTask` 检测到旧进程已退出后重启子进程。若旧进程处于僵尸状态（已
退出但 `exitCode` 还没更新），可能同时有两个进程在运行，都接收同一行输入。窗口极
短但在高并发 `sendMessage` 场景下理论上存在。  
**修复**：对同一 agentId 的写操作加串行锁（类似 MemoryManager 的 writeQueue 模式）。

### M-11 CronScheduler 系统休眠唤醒后任务风暴
**文件**：`packages/services/src/tasks/index.ts`  
**描述**：`CronScheduler` 用 `setTimeout` 调度。系统休眠期间 `setTimeout` 暂停，
唤醒后若时间已过，积压任务会立刻全部触发，可能造成任务风暴。  
**已知限制**：Python 原版 `asyncio.sleep` 有相同问题。可记录为已知行为，或在
触发时检查距上次实际运行的时间，超过 N 分钟则跳过本次。

### ~~M-12 plugin 路径穿越防护在 Windows symlink 跨盘符下可能失效~~ ✅ 已验证 + 补测试
**文件**：`packages/plugins/src/discovery.ts`  
**描述**：`discoverMarkdownFiles` 用 `resolve + sep` 校验路径，symlink 指向另一
盘符（如 `D:` → `C:`）时，resolve 后的路径前缀不同，防护会正确拒绝。需确认
跨盘符 symlink 场景是否有测试覆盖（当前没有）。  
**修复**：补充 Windows 跨盘符 symlink 的单元测试，确认防护有效。

---

## ⚪ Low

### L-1 allowedTools/disallowedTools 逗号分隔（当前安全，未来风险）
**文件**：`apps/cli/src/teammate.ts:54-55`  
**描述**：工具名 join(',') 传 argv，CLI 侧 split(',') 解析。当前内置工具名均不含
逗号，安全。若未来 plugin/user agent 工具名含逗号，黑白名单会静默解析错误。  
**修复**：长期建议改为 JSON 序列化；短期可在 join 前断言工具名不含逗号并报错。

### L-2 permission-sync 锁文件进程崩溃不自动清理
**文件**：`packages/swarm/src/lockfile.ts`  
**描述**：文件锁不含 PID，持有锁的进程崩溃后锁文件残留，下次启动可能永久死锁。  
**修复**：锁文件写入当前 PID，启动时检查 PID 是否存活，死进程的锁自动释放。

### L-3 fileEditTool 多匹配时静默选第一个
**文件**：`packages/tools/src/file/edit.ts`  
**描述**：已有 `occurrences > 1 && !replaceAll` 时报错提示的逻辑，但提示信息只说
"Found N matches，use replace_all"，没有显示匹配位置，用户无法快速定位。  
**改进**：在错误消息中附上每处匹配的行号，方便用户确认意图。

### L-4 session cwd hash MD5 前 8 位碰撞概率
**文件**：`packages/services/src/session/storage.ts`  
**描述**：8 位 hex = 32 位空间，约 65536 个不同 cwd 有 50% 碰撞概率。单用户实际
使用几乎不可能碰撞，无需修改。记录为已知限制。

### L-5 processLineForHost 内 buildStatePayload 不传 mcpManager
**文件**：`apps/cli/src/commands/main.ts`  
**描述**：有两处 `buildStatePayload(settings)` 调用不传 mcpManager，导致前端
`mcp_connected`/`mcp_failed` 始终为 0，即使 MCP 服务器已连接。代码注释已标注此
问题。影响：前端状态栏 MCP 连接数显示错误。  
**修复**：将 mcpManager 传入 buildStatePayload，或在合适时机补一次完整的 state
推送。

---

*最后更新：2026-06-16*
