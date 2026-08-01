# Daemon Session Runtime 设计

> 状态：主线架构。Task 0-9 已落地 daemon/client、TUI attach 与 durable message-part 基础版。
> 日期：2026-07-31。
> 决策：默认 `ohs --tui` 已迁到 daemon attach 路径：`--tui -> frontend -> @openharness/client -> ohs serve`。TUI 的旧 frontend-owned backend/OHJSON 兼容路径已退场。目标架构是类似 opencode 的 daemon/server，具备持久化 session，以及可 attach 的客户端。

## 1. 目标

OpenHarness 应通过一套共享的 runtime 模型，同时支持 TUI、Web、Desktop、远程 attach，以及跨客户端恢复：

```text
clients
  TUI / Web / Desktop / remote attach
        |
        | HTTP snapshot/actions + SSE live SDK
        v
ohs serve / daemon
  Session API
  Event stream
  Permission broker
  Session run coordinator
  Durable session store
        |
        v
Agent runtime per session
```

Daemon 是产品核心。客户端是持久化 session 状态上的视图/控制器，而不是 runtime 进程的所有者。

## 2. 非目标

- 将 OHJSON 作为长期客户端协议。
- 继续把 `BackendHost` 作为主要执行容器。
- 把旧 TUI 派生多个 per-session backend 子进程当作最终的多 session 方案。
- 继续把 `latest.json + session-<id>.json` 作为权威 session 数据库。
- 支持崩溃后任意进行中的 provider 调用精确续传。当前必须持久化已准入的输入和已提交的事件，然后恢复到清晰状态；精确的 provider 流续传是后续工作。

## 3. 核心决策

### 3.1 Session 是并发键

一个 session 最多只能有一条活跃的 run lane。不同 session 可以并发运行。

```text
session A: idle -> running -> pending follow-up -> idle
session B: idle -> running ----------------------> idle
```

这与 opencode 的 `SessionRunCoordinator` 一致：相同 key 串行；不同 key 并行。

### 3.2 Prompt 准入是持久化的

提交 prompt 拆成两步：

1. 将用户输入准入到持久化存储。
2. 唤醒 session runner。

如果 daemon 在准入之后、执行之前崩溃，该 prompt 仍然可见且可恢复。下次 resume 可按策略执行待处理输入，或将其标记为中断。

### 3.3 事件是客户端真相源

客户端先从持久化状态 hydrate，再订阅事件。每一个 UI 可见的变化都必须表示为带有稳定 cursor 的事件。

示例：

- `session.created`
- `session.updated`
- `session.status`
- `session.message.created`
- `session.message.part.updated`
- `session.message.part.delta`
- `session.run.created`
- `session.run.updated`
- `permission.asked`
- `permission.replied`
- `question.asked`
- `question.replied`
- `todo.updated`
- `run.started`
- `run.completed`
- `run.failed`

### 3.4 Runtime 状态显式化，而非进程全局

Daemon 可能托管来自多个目录的 session。Runtime 代码不得依赖 `process.cwd()` 作为 session 位置。每个 session runtime 都接收显式的 `location`：

```ts
type SessionLocation = {
  cwd: string;
  workspaceId?: string;
};
```

工具应使用 `ToolContext.cwd`。Sandbox、task、memory、MCP 和 workflow 状态在适用处必须按 session 或 location 键控。

## 4. 包结构

```text
packages/server
  HTTP API、SSE/WebSocket 事件、daemon 注册
  路由层采用 Hono；底层 Node listener 只是 adapter，不在业务路由中手写 node:http。

packages/services/src/session-runtime
  持久化存储、事件日志、session/input/message/run/permission request

packages/client
  TUI/Web/Desktop 共享的 typed HTTP API、SSE parser、message-part reducer、session snapshot+live sync

packages/core
  QueryEngine 以及 provider/tool 循环

apps/cli
  `ohs serve`、daemon start/status/stop、TUI attach

apps/frontend
  TUI 客户端，不再直接拥有 BackendHost

apps/web / apps/desktop
  未来客户端，使用同一套 SDK
```

`packages/session` 可作为后续包拆分方向。当前实现位于 `packages/services/src/session-runtime`，公开边界通过 `@openharness/services` 导出。

### 4.1 当前实现状态

已完成：

- `packages/services/src/session-runtime`：唯一的文件 adapter 版 `SessionStore`，支持 session/input/message/part/event/run/permission request。
- `packages/server`：Hono HTTP server，bearer token，SSE 事件流，daemon registry，`ohs serve` 与 `ohs daemon start/status/stop`。
- `SessionRunCoordinator`：同 session 串行、不同 session 并发、queued run interrupt、wake merge 计数。
- `SessionRuntime` 注入：daemon 可通过 CLI runtime factory 复用现有 `bootstrap` / `QueryEngine`。
- `PermissionBroker`：权限请求持久化、`permission.asked/replied`、`POST /permissions/:requestId/reply`、session 级 approval 复用。
- `packages/client`：typed API client、SSE parser、按 session bucket 的 message-part reducer、session snapshot+live 合并。

仍待完成：

- SQLite adapter 与迁移。
- `delivery: "steer"` 真正注入运行中的 run。
- 继续审计 CLI/历史命令中的 `process.cwd()`；runtime/tool 主路径已接收显式 `cwd` 并传到 `ToolContext`。
- Workflow 工具事件已通过 runtime event sink 写入 session event stream；前端可基于 `workflow.*` 事件做实时视图。
- Daemon session runtime 已按 session/location 创建 MCP manager，并随 runtime 生命周期关闭。
- 更深层的 provider/tool/sandbox cancellation。
- TUI 主路径已迁到 daemon client。
- Web/Desktop/remote attach 的认证与部署策略。

## 5. 持久化存储

目标权威存储使用 SQLite。当前基础版先用文件 adapter 固化数据与事件语义。print/REPL 的项目级 JSON snapshot 是独立功能，不是 daemon store 的旧版本、迁移源或恢复后门。

### 5.1 表结构

```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE session_input (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  delivery TEXT NOT NULL,
  content_json TEXT NOT NULL,
  promoted_message_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  tool_uses_json TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE TABLE session_event (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(seq)
);

CREATE TABLE session_run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE permission_request (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  run_id TEXT,
  tool_name TEXT NOT NULL,
  reason TEXT,
  input_json TEXT NOT NULL,
  preview_json TEXT,
  status TEXT NOT NULL,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
```

### 5.2 Cursor 语义

`session_event.seq` 是全局单调递增的 cursor。API 支持：

- 从 `after=<seq>` 回放
- 按 `sessionId` 过滤回放
- 面向仪表盘的全局客户端同步

SQLite adapter 可为每个已提交事件使用一次事务。

## 6. HTTP API

初始 API 面：

```text
GET    /health
GET    /sessions?cwd=&limit=&includeArchived=
POST   /sessions
GET    /sessions/:sessionId
GET    /sessions/:sessionId/state
DELETE /sessions/:sessionId

GET    /sessions/:sessionId/messages?limit=&cursor=
GET    /sessions/:sessionId/parts?limit=&cursor=&messageId=
POST   /sessions/:sessionId/prompts
POST   /sessions/:sessionId/interrupt

GET    /events?cursor=&afterSeq=&sessionId=&limit=
GET    /events/stream?cursor=&afterSeq=&sessionId=

GET    /permissions?sessionId=&status=&toolName=&limit=
POST   /permissions/:requestId/reply
```

当前事件流使用 SSE。`GET /health` 只返回存活状态与可选 release version；session 数据结构没有并行协议版本。CLI 用 registry 的 release version 与启动时间识别 stale daemon。WebSocket 可后续加入，以支持更低延迟的双向控制。

规划中但尚未实现的 API：

```text
PATCH  /sessions/:sessionId
POST   /sessions/:sessionId/resume
GET    /tasks?sessionId=
POST   /tasks/:taskId/stop
```

## 7. Client SDK 类型

所有面向客户端的事件都包含信封：

```ts
type ServerEvent<TType extends string = string, TPayload = unknown> = {
  id: string;
  seq: number;
  type: TType;
  sessionId?: string;
  createdAt: number;
  payload: TPayload;
};
```

示例：

```ts
type MessagePartDelta = ServerEvent<
  "message.part.delta",
  {
    message_id: string;
    part_id: string;
    delta: string;
  }
>;

type PermissionAsked = ServerEvent<
  "permission.asked",
  {
    request_id: string;
    tool_name: string;
    reason?: string;
    input: Record<string, unknown>;
    preview?: {
      diff?: string;
      diff_path?: string;
    };
  }
>;
```

客户端 store 应按 session 组织：

```ts
type ClientState = {
  sessions: Record<string, SessionRecord>;
  sessionOrder: string[];
  buckets: Record<string, {
    session?: SessionRecord;
    inputs: SessionInputRecord[];
    messages: SessionMessageRecord[];
    runs: Record<string, SessionRunRecord>;
    permissions: Record<string, PermissionRequestRecord>;
  }>;
  eventsBySeq: Record<number, SessionEventRecord>;
  lastSeq: number;
};
```

已实现的包是 `@openharness/client`，详见 [client-sync-flow.md](./client-sync-flow.md)。

## 8. Session Runtime

创建一个 session runtime 所有者，封装当前的 `RuntimeBundle` 与 `QueryEngine`。

```ts
type SessionRuntime = {
  sessionId: string;
  location: SessionLocation;
  settings: Settings;
  bundle: RuntimeBundle;
  submit(inputId: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
};
```

Runtime 必须：

- 每次 run 前加载持久化消息
- 通过 store 追加已提交消息，而不是只写 `QueryEngine.messages`
- 将流式 delta 发布为事件
- 持久化 run 状态
- 通过 `PermissionBroker` 请求权限
- 在已提交的 turn 之后保存 memory
- 被驱逐时关闭 bundle 资源

## 9. Run Coordinator

Coordinator 持有内存 map：

```ts
Map<sessionId, {
  active?: RunHandle;
  pendingWake?: boolean;
  pendingRun?: boolean;
  interruptSeq?: number;
}>
```

规则：

- `wake(sessionId)` 在空闲时启动一次 run。
- 运行中再次 `wake(sessionId)` 会合并为一次 follow-up。
- `run(sessionId)` 加入或调度显式的 run 语义。
- `interrupt(sessionId)` 中止当前活跃 run，并抑制更早的建议性 wake。
- 不同 session ID 可以并发运行。

## 10. Permission Broker

权限提示必须变为持久化的，并且可路由到客户端。

流程：

1. QueryEngine 向 broker 请求工具决策。
2. Broker 写入 `permission_request`。
3. Broker 发出 `permission.asked`。
4. 某个已授权客户端回复。
5. Broker 存储回复并发出 `permission.replied`。
6. QueryEngine 继续执行。

若无客户端 attach，请求保持 pending。策略可决定无头 session 是失败关闭、超时自动拒绝，还是允许只读工具。

Session 作用域的批准应按 `(sessionId, toolName)` 键控，并持久化为策略状态，而不是进程本地集合。

## 11. QueryEngine 变更

当前 `QueryEngine` 可复用，已完成显式 `cwd` 注入；仍需要以下变更：

- 在 options/tool context 中接受显式 `cwd`（已完成）
- 暴露 step 级回调，或发出结构化 runtime 事件
- 允许通过 run abort signal 取消 provider 流与工具执行
- 停止只突变私有内存中的 `messages`；session runtime 应能持久化已提交消息
- 让 `session_start` / `session_end` hook 按每次持久化 run 执行一次，而不是按每次临时客户端进程执行一次

当前通过包装 `submitMessage()`，把 yield 出的流事件翻译为持久化 message-part 事件；后续应继续让消息提交和事务边界显式化。

## 12. 客户端迁移

### 12.1 TUI

TUI 使用 `useServerSync`：

- 连接到 daemon 传输层
- 加载 sessions 与当前路由
- 对活跃 session 先读取 `/sessions/:id/state`，再从 snapshot cursor 订阅 `/events/stream`
- 按 `sessionId` 维护状态桶
- prompt 通过 `POST /sessions/:id/prompts` 发送
- 权限对话框通过 `POST /permissions/:id/reply` 回复

TUI 路由切换的是 session，而不是切换 backend 进程。

### 12.2 Web/Desktop

Web 与 Desktop 使用与 TUI 相同的 SDK/store。Desktop 可嵌入或自动启动 daemon；Web 可通过带 token 认证的 daemon URL attach。

## 13. Daemon 生命周期

CLI 命令：

```text
ohs serve --host 127.0.0.1 --port 0 --register
ohs daemon start
ohs daemon status
ohs daemon stop
ohs attach [url]
ohs --tui        # 启动/attach daemon，然后启动 TUI 客户端
```

注册文件：

```json
{
  "version": "x.y.z",
  "url": "http://127.0.0.1:NNNN",
  "pid": 12345,
  "token": "random bearer token",
  "storePath": "...",
  "startedAt": 1234567890
}
```

本地 daemon 使用随机 bearer token；后续需补齐跨平台的 registry 文件权限收紧。

## 14. 迁移计划

### Phase 0：移除主线遗留路径

- `BackendHost` / OHJSON host 协议已从当前主线删除。
- 当前主线不保留旧数据结构或客户端协议的兼容分支。

### Phase 1：存储与事件日志

- 增加基于 SQLite 的 session store。
- 增加 session 事件表以及事件追加/回放辅助函数。
- 增加从现有 JSON 快照的导入。

### Phase 2：Server 骨架

- 增加 `packages/server`。
- 增加 `ohs serve`、daemon 注册、health、sessions、messages、events。
- `ohs --tui` 通过 daemon attach 信息启动客户端。

### Phase 3：Session runtime

- 将执行所有权迁移到 server-owned `SessionRuntime`。
- 增加 `SessionRunCoordinator`。
- 通过 server API 为一个 session 运行 prompt。

### Phase 4：Permission broker

- 持久化权限请求/回复。
- 广播权限事件。
- 将客户端回复路由回活跃 run。

### Phase 5：TUI 客户端

- 构建共享 SDK/store 包。
- 用 server sync 接管 TUI 数据流。
- 从事件桶渲染多个 session。
- 从主路径移除由 frontend 拥有的 BackendHost 派生。
- 恢复 slash command 可用性：
  - TUI/Web/Desktop 保留各自的 client-local UI 命令。
  - server 暴露按 location/cwd 作用域的 command catalog 与必要的 session command API。
  - user-invocable skill / template command 采用 opencode 风格展开为 prompt，而不是由客户端直接拥有 runtime。

### Phase 6：Web/Desktop/远程 attach

- 增加 Web/Desktop 客户端。
- 强化远程认证与传输。

## 15. 风险

- `process.cwd()` 在 CLI/历史命令中仍使用广泛；runtime/tool 主路径已开始显式传递 `cwd`。
- sandbox 已按 session/location 作用域；task manager 与 swarm backend registry 已按 `sessionId + location/cwd` 作用域，避免同 cwd 多 session 共享 task runner、task list、wait/stop/output 状态。
- MCP 首版采用 session/location 作用域；后续可为纯静态无认证服务器引入 daemon/project 共享池。
- slash command 不能简单复用旧 REPL registry；需要先区分 client-local、server/session API、runtime/template、REPL-only，否则会把 `BackendHost` 形态重新引入 server。
- 长时间运行的工具调用需要可靠的取消与所有权清理。
- 若策略不明确，权限提示可能导致无头 run 死锁。
- token delta 带来的事件量可能快速增长；可能需要批处理或部分 delta 压缩。

## 16. 验收标准

- 两个 session 可在同一个 daemon 中并发运行。
- 第二个客户端可以 attach，并看到当前 session 状态，而无需重启 run。
- 同一 session 的 prompt 提交按策略串行或排队。
- 权限请求在客户端断开后仍然存活，并可被之后 attach 的客户端回答。
- 重启 daemon 会保留 sessions、messages 与已提交事件。
- TUI 主路径不再派生 per-session backend。
- Web/Desktop 可使用同一 API，无需 TUI 专用协议分支。
