# 权限（Permission）流程

当前权限确认只有 daemon/client 主线。TUI 不通过 BackendHost/OHJSON 弹权限框，也不持有本地 permission Promise。

```text
QueryEngine
  -> PermissionChecker.checkTool()
  -> decision === "ask"
  -> CliSessionRuntime permissionPrompt
  -> SessionRuntimeHooks.askPermission()
  -> PermissionBroker
  -> SessionStore.createPermissionRequest(status:"pending")
  -> append event: permission.asked
  -> wait for reply

TUI / Web / Desktop
  -> @openharness/client syncEvents()
  -> receive permission.asked by replay or SSE
  -> render permission modal
  -> POST /permissions/:requestId/reply

PermissionBroker
  -> SessionStore.replyPermission()
  -> append event: permission.replied
  -> resolve waiting run
  -> QueryEngine continues or denies tool call
```

## 决策层

权限仍分两层：

| 层 | 组件 | 产物 |
|---|---|---|
| 规则层 | `PermissionChecker.checkTool(name, input)` | `{ action: "allow" | "deny" | "ask", reason }` |
| 确认层 | `PermissionBroker` + attach 客户端 | persisted request + persisted reply |

`checkTool` 只给出规则决策；需要用户确认时，由 daemon 持久化 request，并通过 event stream 通知所有 attach 客户端。

## HTTP API

客户端读取与回复权限：

```text
GET  /permissions?sessionId=<id>&status=pending
POST /permissions/:requestId/reply
```

reply body：

```json
{
  "status": "approved",
  "decision": "once",
  "clientId": "tui"
}
```

`status` 可为 `"approved"` 或 `"denied"`。
`decision` 可为 `"once"` 或 `"session"`；`"session"` 会让同一 session 内同工具后续 ask 复用批准。

## 客户端职责

TUI 的 `useServerSync()` 从 reducer state 中找当前 session 的 pending permission：

- `permission.asked` 出现时展示 modal。
- 用户批准/拒绝后调用 `client.replyPermission()`。
- 客户端断开不影响 request 存活。
- 另一个客户端稍后 attach 后仍可 replay 到 pending request 并回复。

## 后续

Edit/Write diff preview 应进入 persisted permission request payload，而不是走 TUI 专属协议。
