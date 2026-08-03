# 可观测性与排障

本文件定义 daemon 主路径的第一阶段可观测性约定。目标不是记录用户内容，而是在多客户端、多 session 并发时把一次操作可靠地串起来。

## Trace ID

`traceId` 是一次 prompt/run 的关联 ID，格式为 UUID 或客户端传入的安全标识。HTTP 客户端可通过请求头 `x-openharness-trace-id` 提供它；daemon 会在每个响应中返回同名 header。

```text
TUI / print / Web 请求
  -> x-openharness-trace-id
  -> POST /sessions/:id/prompts
  -> input.metadata.traceId
  -> run.metadata.traceId
  -> runtime / tool / permission / task 日志
```

未提供 header 时，daemon 会生成一个新的 ID。child session 内部提交的 prompt 同样会生成并持久化自己的 trace；task 绑定到 child run 后使用该 run 的 trace。

稳定 request ID 的重试不会因 trace 不同而被判定为不同 prompt；idempotency 比较会忽略 `metadata.traceId`，首次准入记录仍是权威值。

## 结构化日志

`@openharness/server` 导出 `StructuredLogger`。默认 daemon 输出 JSON Lines；宿主可以在创建 `OpenHarnessHttpServer` 时传入 `logger`，转发到文件、Desktop 日志窗口或远程日志系统。

当前事件包括：

- `http.request.completed`
- `session.run.started`、`session.run.completed`、`session.run.interrupted`、`session.run.failed`
- `session.tool.started`、`session.tool.completed`
- `permission.requested`、`permission.auto_approved`、`permission.replied`、`permission.expired`
- `session.task.created`、`session.task.bound`、`session.task.completed`

公共字段为 `level`、`event`、`traceId`，并按事件附带 `sessionId`、`runId`、`requestId`、`taskId`、`toolName`、HTTP 状态和耗时。

日志禁止写入 prompt 原文、模型输出、工具参数、工具结果、bearer token、API key 或 permission payload。排障需要内容时，应在受认证保护的 Session API 中按 session/run 查询持久化记录，而不是扩大日志采集范围。

## 后续阶段

## 运行快照

`GET /health` 与 `GET /debug/runtime` 都需要 daemon bearer token。前者适合 CLI、远程 attach 和存活探测，返回版本、启动时间、运行时长、session 总数以及内存 coordinator 的 active/queued run 数量。

`GET /debug/runtime` 用于人工诊断，额外返回 session/run/task/permission 的状态计数、SSE attach 数、warm runtime 数和 coordinator 队列计数。它不返回 store 路径、session 内容、工具参数/结果或认证信息，因此可以作为未来 Desktop/Web 状态页的只读数据源。

## 端到端保障

Task 16C 已覆盖一个跨 daemon 重启的真实恢复场景：旧 run 保持 `interrupted`，新 daemon 的 SSE 可从 cursor 回放旧事件；使用同一 `traceId` 的显式恢复会等待持久化 permission reply；另一个 session 即使使用不同 trace，也可以在前者等待授权时独立完成。该用例同时断言 run、permission 和结构化日志仍可按 trace 关联。
