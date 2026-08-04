# Daemon Session Runtime 设计

> 状态：主线架构。Task 0-9 已落地 daemon/client、TUI attach 与 durable message-part 基础版。
> 日期：2026-07-31。
> 决策：默认 `ohs`（与显式 `ohs --tui`）走 daemon attach：`CLI -> frontend -> @openharness/client -> ohs serve`。用户 headless print（`ohs "prompt"` / `-p`）同样走 Session API 客户端。daemon 内 `Agent` 通过 child session 执行；`--task-worker` / swarm subprocess 已从运行时代码退场，不再作为兼容 fallback。进程内 REPL 已移除，TUI 的旧 BackendHost/OHJSON 路径已退场。

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

### 3.1.1 Session 生命周期屏障

Session 状态只能是 `idle`、`running`、`closing` 或 `archived`。`DELETE /sessions/:id`
会先把 session 移为 `closing`，以 `409` 拒绝新的 prompt 与影响 runtime 的设置变更；随后中断并等待活跃或排队工作结束、关闭 runtime，最后才写入 `archived`。daemon 重启时会先将遗留 run 标记为 interrupted，并完成所有已持久化的 `closing` session，因此未完成的归档不会重新变为可写。

`running` 由该 session 全部 pending/running run 推导得出。因此中断一个排队 run 不会让无关的活跃 run 显示为空闲。session run 活跃期间，影响 runtime 的 session metadata 和 daemon 设置一律拒绝写入；调用方应在 run 进入终态后重试，而不是在仍运行的 runtime 下方直接关闭或替换配置。

### 3.1.2 Daemon 重启恢复必须显式化

Daemon 重启恢复的是持久记录，不是旧进程本身。它会把遗留 session run 标记为
`interrupted`，完成已持久化但停在 `closing` 的归档，并保留 parent/child session、消息、
canonical parts、权限和事件历史供用户审计。

workflow snapshot 位于项目目录，因此 server 只会收口仍为 `running` 且有持久化
`workflow.workflow_started` 事件证明归属于当前 daemon session 的 run。该 snapshot 会进入终态：
运行中的 task 标为 `killed`，未启动 task 标为 `skipped`；session 事件流追加带有
`recoveredAfterDaemonRestart: true` 的 `workflow.workflow_cancelled`。同项目中没有该
session 所有权事件的 workflow 不会被修改。归属的 snapshot 若损坏，只会记录
`workflow.workflow_recovery_failed`，不会阻止 daemon 为其它 session 提供服务。重启不会悄悄恢复
provider stream、TaskManager task 或 child session，因为这些进程内所有权已经消失；后续工作必须由用户显式重新发起。

### 3.2 Prompt 准入是持久化的

提交 prompt 拆成两步：

1. 将用户输入准入到持久化存储。
2. 唤醒 session runner。

如果 daemon 在准入之后、执行之前崩溃，该 prompt 仍然可见；daemon 重启会把未完成 run 标为 `interrupted`。它不会自动重跑，用户只能通过显式恢复操作创建新的 input/run 来重放原始 prompt。

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

- `packages/services/src/session-runtime`：唯一的 SQLite `SessionStore`，支持 session/input/message/part/event/run/task/permission request。
- SQLite 持久化与迁移：Drizzle 定义 schema，Drizzle Kit 管理迁移文件，daemon 通过 `better-sqlite3` 独占打开数据库。
- `packages/server`：Hono HTTP server，bearer token，SSE 事件流，daemon registry，`ohs serve` 与 `ohs daemon start/status/stop`。
- `SessionRunCoordinator`：同 session 串行、不同 session 并发、queued run interrupt、wake merge 计数；`delivery: "steer"` 对 active run 走 `mergeWake`，无 active run 时退化为 queue。
- `SessionRuntime` 注入：daemon 可通过 CLI runtime factory 复用现有 `bootstrap` / `QueryEngine`；interrupt/`AbortSignal` 贯穿 QueryEngine、provider，以及 Bash/Web/Image/Feishu 工具主路径；`TaskWait` 收到父 session abort 后会请求停止其等待的 child task。`ToolContext.abortSignal` 是单次工具调用和 timeout 的信号，`runAbortSignal` 是 session run 所有权信号，供 detached workflow 等跨工具调用工作使用。
- `PermissionBroker`：权限请求持久化、`permission.asked/replied`、`POST /permissions/:requestId/reply`、session 级 approval 复用。
- `packages/client`：typed API client、SSE parser、按 session bucket 的 message-part reducer、session snapshot+live 合并；SSE 断流后按 `lastSeq` 指数退避重连，session 路径遇 seq 空洞会 re-snapshot。
- CLI/TUI 将 `permissionMode` / `maxTurns` 等写入 session metadata，供 daemon runtime warm 读取。
- sandbox active session 按 `sessionId + cwd` 隔离（无 sessionId 的兼容路径仍可为 cwd-only）。

仍待完成：

- 继续审计 CLI/历史命令中的 `process.cwd()`；runtime/tool 主路径已接收显式 `cwd` 并传到 `ToolContext`。
- Workflow 工具事件已通过 runtime event sink 写入 session event stream；前端可基于 `workflow.*` 事件做实时视图。detached workflow 绑定 parent run：parent interrupt 会停止已登记的 child task、写入 cancelled terminal snapshot，并拒绝晚到 scheduler 回写。daemon 重启会依据 `workflow.workflow_started` 所记的 session 所有权收口仍在运行的 snapshot，不会自动重跑已丢失内存所有权的 child task。
- Daemon session runtime 已按 session/location 创建 MCP manager，并随 runtime 生命周期关闭。
- 自定义 plugin 工具必须协作式消费 `ToolContext.abortSignal`；宿主无法强制终止任意 in-process plugin。MCP tool/resource 请求已使用 SDK request signal 取消。
- TUI 主路径已迁到 daemon client。
- Slash command：catalog、template expand，以及 `/model` `/config` `/provider` `/mcp` `/tasks` `/memory` `/auth` `/context` `/stats` `/agents` `/compact` `/remember` `/dream` `/profile` `/doctor` `/effort` `/fast` `/turns` `/usage` `/cost` `/export` `/output-style` `/help` `/status` `/version` 已落地；`/tasks run`、部分 REPL-only 命令仍待。
- 远程连接的基础安全策略已落地：远程客户端使用显式 URL + bearer token，非 loopback daemon 强制显式 token，浏览器仅允许精确 `--allow-origin` 白名单。完整部署说明见 [remote-attach.md](./remote-attach.md)。仍待完成的是正式 Web/Desktop 应用、TLS/反向代理部署基线、用户身份与多租户授权等生产化能力。

## 5. 持久化存储

权威存储已切换为 SQLite。`@openharness/services` 中的 [schema.ts](../packages/services/src/session-runtime/schema.ts) 是类型化 schema，[0000_session_runtime.sql](../packages/services/src/session-runtime/migrations/0000_session_runtime.sql) 是首个已提交迁移；daemon 在开放 HTTP 前以 Drizzle migrator 执行所有未应用迁移，再通过 `better-sqlite3` 独占写入 `~/.openharness-ts/data/session-runtime/sessions.db`。print 的项目级 JSON snapshot 是独立功能，不是 daemon store 的旧版本、迁移源或恢复后门。

`0000` 是幂等 bootstrap migration：它也能接管本项目开发期已经由同构 SQLite schema 创建、但尚未写入 Drizzle 迁移记录的数据库；不会读取 JSON，也不会改变既有会话行。

### 5.1 当前表结构

- `session`：会话本体及归档状态。
- `session_input`、`session_message`、`session_message_part`：输入、消息 shell 与 canonical message parts。
- `session_run`、`session_task`：回合与 parent/child task 生命周期。
- `permission_request`：跨客户端可回复的权限请求。
- `session_event`：全局单调 cursor 的 SSE 回放日志。

结构化字段保存为 JSON 列，排序字段以 `(session_id, seq)` 约束；完整列和索引以迁移文件为准。旧 `~/.openharness` 和任何 JSON session store 一律不读取、不导入。

### 5.2 Cursor 语义

`session_event.seq` 是全局单调递增的 cursor。API 支持：

- 从 `after=<seq>` 回放
- 按 `sessionId` 过滤回放
- 面向仪表盘的全局客户端同步

SQLite Store 为每次领域变更使用一次事务：规范化状态和对应 event 要么一起可见，要么都不写入。

## 6. HTTP API

初始 API 面：

```text
GET    /health
GET    /commands?cwd=
GET    /settings
PATCH  /settings
GET    /providers
GET    /memory?cwd=
GET    /memory/:entryId?cwd=
POST   /memory
DELETE /memory/:entryId?cwd=
GET    /auth
POST   /auth/login
POST   /auth/logout
GET    /context?cwd=
POST   /dream
GET    /profile
POST   /profile/init
GET    /output-styles
POST   /project/init
GET    /plugins?cwd=
POST   /plugins/:name/enable
POST   /plugins/:name/disable
POST   /plugins/reload
GET    /agent-personas
GET    /hooks?cwd=&sessionId=
GET    /git/diff?cwd=&full=
GET    /git/branch?cwd=&list=
GET    /git/status?cwd=
POST   /git/commit
GET    /tasks?sessionId=&cwd=&status=
POST   /tasks
GET    /tasks/:taskId?sessionId=&cwd=
POST   /tasks/:taskId/stop?sessionId=&cwd=
GET    /sessions?cwd=&limit=&includeArchived=
POST   /sessions
GET    /sessions/:sessionId
PATCH  /sessions/:sessionId
GET    /sessions/:sessionId/state
GET    /sessions/:sessionId/mcp
GET    /sessions/:sessionId/usage
POST   /sessions/:sessionId/export
POST   /sessions/:sessionId/compact
POST   /sessions/:sessionId/rewind
POST   /sessions/:sessionId/remember
DELETE /sessions/:sessionId

GET    /sessions/:sessionId/messages?limit=&cursor=
GET    /sessions/:sessionId/parts?limit=&cursor=&messageId=
POST   /sessions/:sessionId/prompts
POST   /sessions/:sessionId/commands
POST   /sessions/:sessionId/interrupt
POST   /sessions/:sessionId/runs/:runId/resume

GET    /events?cursor=&afterSeq=&sessionId=&limit=
GET    /events/stream?cursor=&afterSeq=&sessionId=

GET    /permissions?sessionId=&status=&toolName=&limit=
POST   /permissions/:requestId/reply
```

Slash command 边界：

- `GET /commands` 只返回 cwd 作用域的 **catalog 元数据**（builtin session 命令 + skill/template），不是通用执行器。
- `POST /sessions/:id/commands` 只用于 **template/skill 展开 → 正常 admitPrompt**。
- `/model` 等状态变更走资源 API（如 `PATCH /sessions/:id`），不走通用 `runCommand`。
- 客户端本地 UI 命令（`/new`、`/sessions`、`/theme`、`/permissions` 等）不进 server registry。
- 未知 `/...` 必须失败关闭，不得当普通 prompt 发给模型。
- 跨端呈现/派发：`@openharness/client` `dispatchSessionCommand`（流程见 [slash-commands-flow.md](./slash-commands-flow.md)）。

入口边界：

- **用户 headless print**（`ohs "prompt"` / `ohs -p`）：ensure daemon → `@openharness/client` → `createSession` + `admitPrompt` + SSE；无 TTY 时 permission 自动 deny（或 `--dangerously-skip-permissions` 时 approve）。详见下文「Print Session API」。
- **daemon/TUI/print 内的 `Agent`**：本轮迁移目标为 daemon 内 child session + PermissionBroker；迁移完成前不得把目标状态描述为已全部落地。
- **内部 `--task-worker` / `--swarm-worker`**：已退场。当前 CLI 不再暴露这些 flag，runtime 也不再注册 subprocess swarm backend。
- 交互产品入口只有 TUI/daemon。旧 REPL registry 已拆除。
- print 的旧项目级 `--continue` / `--resume` **尚未**迁到 daemon store；传这些 flag 会明确报错。

资源 API 风险说明：

- `/commit`（`POST /git/commit`）会 `git add -A` 后提交；多客户端并发时可能互相踩工作树。无参 `/commit` 仅 `git status --short`。
- 会导致 runtime reload 的资源写操作在对应 session 有 active/queued run 时返回 `409`，且不会先写入后关闭 runtime。memory/reload-plugin 按 cwd 隔离；settings/auth/profile/plugin enable|disable 为 daemon 全局 barrier。空闲后 `/reload-plugins` / plugin enable|disable 通过关闭 runtime 生效，下次 warm 再发现插件；不是进程内热替换 hooks/skills。
- Daemon 启动时对磁盘上遗留的 `pending`/`running` run 和 task 分别调用 `interruptActiveRuns` / `interruptActiveSessionTasks`，避免客户端永久 busy；完成 `closing` 归档；再仅收口被 session event 证明归属本 daemon 的 running workflow snapshot。sessions/messages/parts/events、task 投影与 child session 经 `sessions.db` 跨重启保留；旧 JSON store 不是迁移源；无所有权事件的项目 workflow 不会被 daemon 改写。

当前事件流使用 SSE。`GET /health` 只返回存活状态与可选 release version；session 数据结构没有并行协议版本。CLI 用 registry 的 release version 与启动时间识别 stale daemon。WebSocket 可后续加入，以支持更低延迟的双向控制。

恢复 API 语义：

- `POST /sessions/:sessionId/runs/:runId/resume` 只接受该 session 中状态为 `interrupted` 且关联原始 prompt 的 run。
- 服务端保留 source run 的 `interrupted` 状态，复制其原始 prompt 并创建带 `recovery.sourceRunId` / `recovery.sourceInputId` 溯源的新 input/run；不会伪造 provider stream 续传。
- 请求使用稳定 `id` 时可安全重试：同一 id 返回同一个恢复 input/run，不会重复执行；同一 source run 的其它恢复请求返回 `409`。
- session 有活跃或排队 run、原始 prompt 已不可用，或 source run 不是 `interrupted` 时返回 `409`。workflow、失去内存所有权的 child task 等没有 prompt-backed run 的工作只保留审计，不提供伪恢复。

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

正式的 Web 与 Desktop 应用尚未落地；它们必须使用与 TUI 相同的 `@openharness/client`、snapshot + SSE reducer 和 Session API。当前已可通过显式 daemon URL + bearer token attach；Desktop 可嵌入或自动启动本机 daemon，Web 可连接带 token 认证且满足 CORS 白名单的 daemon。远程连接不能读取或复制本机 daemon registry。

## 13. Daemon 生命周期

CLI 命令：

```text
ohs serve --host 127.0.0.1 --port 0 --register
ohs daemon start
ohs daemon status
ohs daemon stop
ohs attach [url]
ohs              # 默认：启动/attach daemon，然后启动 TUI 客户端
ohs --tui        # 显式同上（进程内 REPL 入口已移除）
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

本地 daemon 使用随机 bearer token，registry 仅用于本机发现；远程客户端必须使用显式 URL + token。后续需补齐跨平台的 registry 文件权限收紧。

## 14. 迁移计划

### Phase 0：移除主线遗留路径

- `BackendHost` / OHJSON host 协议已从当前主线删除。
- 当前主线不保留旧数据结构或客户端协议的兼容分支。

### Phase 1：存储与事件日志

- 已完成：增加基于 SQLite 的 session store。
- 已完成：增加 session 事件表以及事件追加/回放辅助函数。
- 不增加从现有 JSON 快照的导入；旧数据结构不属于当前主线。

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

### Phase 6：Web/Desktop/远程连接

- 已完成远程连接基线：显式 URL + bearer token、非 loopback bind 强制 token、浏览器精确 CORS origin 白名单，以及 TUI 的 `--daemon-url` / `--daemon-token`。
- 待实现正式的 Web/Desktop 客户端。
- 待补齐 TLS/反向代理部署基线、用户身份与更细粒度授权，避免把共享 bearer token 当作最终多用户方案。

## 14.1 Print Session API（用户 headless）

```text
ohs "prompt" | ohs -p "prompt"
  -> ensureLocalDaemon()   # 与 TUI 共用 registry / spawn serve
  -> OpenHarnessClient.createSession({ cwd, model })
  -> syncEvents(sessionId) 先订阅
  -> admitPrompt(content)
  -> 渲染 session.message.part.* 到 stdout
  -> pending permission: auto-deny（或 --dangerously-skip-permissions → approve）
  -> 无 active/pending run 后退出
```

Follow-up：`CliSessionRuntime` end-of-turn memory / personalization 应在 daemon 侧统一执行，print 客户端不重复写项目级 snapshot。

## 14.2 第二阶段：task / subagent → child session（已落地）

对齐 opencode TaskTool：daemon/TUI/print 主路径中的 `Agent` 在 daemon 内创建并运行 child session，不再派生 `--task-worker` 子进程。

当前主流程的独立说明见 [`agent-child-session-flow.md`](./agent-child-session-flow.md)。

```text
Agent tool (in daemon CliSessionRuntime)
  -> store.createSession({ parentId })
  -> 同进程 admitPrompt / SessionRuntime on child
  -> 权限从 parent 派生；事件进同一 SessionStore
```

| 现状 | 目标 |
|------|------|
| `SubprocessBackend` + `ohs --task-worker` | daemon 内 child session |
| 文件 mailbox / permission-sync | session 事件 + PermissionBroker |
| 项目级 worker snapshot | daemon `SessionStore` |

迁移边界：

- **新主路径**：从 daemon session 发起的 `Agent` 调用创建带 `parentId` 的 child session，由同一 daemon 的 `SessionRuntime` 执行；TUI、用户 print 和其它 Session API 客户端共享这条路径。
- **状态与权限**：child 的消息、run、事件和权限请求进入同一 `SessionStore` / `PermissionBroker`，客户端可按 session 关系观察与裁决。
- **任务投影**：parent session 的 task 通过 `SessionTaskRecord` 持久化，记录 task ID、child session ID 和当前 run ID；TaskManager 仅保留执行中的回调、stdin 与进程句柄。
- **重启边界**：daemon 启动会将未终态 task 写为 `interrupted`。child 的消息/run 仍可审计，具备原始 prompt 的中断 run 可用 `/resume` 显式创建新 run；不会自动复活 callback、子进程或 child runtime。

## 15. 风险

- `process.cwd()` 在 CLI/历史命令中仍使用广泛；runtime/tool 主路径已开始显式传递 `cwd`。
- sandbox 已按 session/location 作用域；task manager 与 swarm backend registry 已按 `sessionId + location/cwd` 作用域，避免同 cwd 多 session 共享 task runner、task list、wait/stop/output 状态；对外可恢复的 task 生命周期以 `SessionStore` 的 task 投影为准。
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
