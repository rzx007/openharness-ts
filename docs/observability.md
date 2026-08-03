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

Task 16B 在此约定上增加 `/health` 运行快照和受保护的 metrics/debug 接口；Task 16C 使用同一 trace 断言 daemon 重启、SSE 重连、权限、恢复与并发 session 的端到端行为。
