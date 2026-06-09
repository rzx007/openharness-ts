# 设计：Swarm teammate 完成等待 + TUI 状态显示

> 状态：已批准，待实现。建立在 D.1（subprocess 派发后端）之上。

## 目标

干掉 leader 拿 teammate 结果时的 **Sleep 盲轮询**：spawn 后用一个显式 `TaskWait`
工具阻塞取结果；并 emit `swarm_status` 事件点亮前端已就绪的 SwarmPanel。

交互模型 = **派发 + 显式 join/wait 工具**（不做异步通知注入 QueryEngine 循环）。

## 复用的现成基建

- `TaskManager`（B.3）：completion listener + 子进程执行 + 输出落盘。
- coordinator：`<task-notification>` XML 格式（formatTaskNotification）。
- 前端 SwarmPanel + useBackendSession 的 `swarm_status` 消费——已完整就绪，后端从未 emit。

## 组件

### a) `TaskManager.awaitTask(taskId, opts?)` — packages/services
核心原语，建在现有 completion listener 上。
- 签名：`awaitTask(taskId: string, opts?: { timeoutMs?: number }): Promise<{ status: TaskStatus; output: string; exitCode?: number; timedOut?: boolean }>`
- 任务已终态（completed/failed/stopped）→ 立即返回当前 `readTaskOutput`。
- 否则注册一次性 completion listener（按 taskId 过滤），完成时 resolve；用完注销。
- 超时（默认无超时或由调用方传入）→ resolve `{ timedOut: true, status: 'running', output: 当前输出 }`，不 reject。
- 未知 taskId → 抛错。

### b) `TaskWait` 工具 — packages/tools（注册进默认工具集）
- 入参：`{ taskIds: string[] }`（也接受单个字符串 `taskId`）+ `{ timeoutSeconds?: number = 300 }`。
- 对每个 taskId 调 `awaitTask`（Promise.all 并行等），把结果汇总成**可读文本**返回给 LLM：每个 teammate 一段「task_id (status): 输出尾部」。超时的明确标注「未在 N 秒内完成，可继续 TaskWait 或 TaskStop」。
- 价值：LLM 一次调用拿到结果，不再 Sleep 轮询；支持「spawn 多个 → 一次 TaskWait 全等」。

### c) Agent / coordinator prompt 微调 — packages/coordinator
在相关 agent / coordinator system prompt 加一句：spawn 子 agent 后用 `TaskWait(task_id)`
取结果，**不要**用 Sleep 轮询。

### d) `swarm_status` 事件 — apps/cli backend host
- 给 `TaskManager` 补一个**状态变更 listener**（与 completion listener 对称的小改动）：
  `registerTaskListener(fn: (task: TaskInfo, event: 'created'|'updated'|'completed') => void): () => void`。
- backend host（runBackendHost）订阅它，对 **agent 型任务**把 `TaskInfo` 映射成
  `SwarmTeammateSnapshot`，emit `swarm_status`（teammate 列表 + 状态 spawned/running/completed/failed）；完成时附一条 notification。
- 映射逻辑（TaskInfo → SwarmTeammateSnapshot + 事件）抽成**可测纯函数**。

## 数据流

```
LLM: Agent{Explore}            → taskId=task_1            (D.1, 立即返回)
LLM: TaskWait{taskIds:[task_1]} → awaitTask 阻塞 → "task_1 (completed): <输出>"
        │
        └─(并行) TaskManager 状态变更 → backend emit swarm_status → SwarmPanel
```

## 错误处理

- `awaitTask` 超时 → 返回 `timedOut`，`TaskWait` 文本提示可继续等或 `TaskStop`。
- teammate 失败（非 0 退出）→ status `failed` + 输出（含错误）。
- 多 teammate 部分失败 → 各自报告，不整体失败。
- TaskWait 收到未知 taskId → 该项报错，其余正常。

## 测试

- `awaitTask`：已完成立即返回 / 运行中完成时 resolve / 超时返回 timedOut（用快速退出的 `node -e` fixture）。
- `TaskWait`：单 / 多 taskId、超时、失败任务、未知 taskId。
- `swarm_status` 映射：纯函数断言 created/completed 时产出正确的 SwarmTeammateSnapshot + 事件。

## 范围外（保持最小）

- 不做异步通知自动注入 QueryEngine 循环（方案 3）。
- 不做 worktree 隔离 / 文件邮箱 / 多轮 `sendMessage`（仍抛错）。
