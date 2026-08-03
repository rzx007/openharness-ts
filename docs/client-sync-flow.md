# Client Sync Flow

> 状态：Task 9 后，TUI 默认已经通过 `useServerSync` attach 到 daemon；`@openharness/client` 是 TUI、Web、Desktop 共享 daemon API、SSE 事件流和 message-part reducer 的公共层。

## 目标

客户端只负责展示和控制，不拥有 agent runtime。所有端都通过同一套协议 attach 到 daemon：

```text
TUI / Web / Desktop
    |
    | @openharness/client
    | HTTP actions + SSE events
    v
ohs serve / daemon
    |
    | SessionStore + RunCoordinator + PermissionBroker
    v
SessionRuntime / QueryEngine
```

这层的长期约束：

- UI 不直接读取 daemon 内部 store 文件。
- UI 不再 spawn per-session backend 作为主路径。
- 单 session attach 先读取原子 HTTP snapshot，再从 snapshot cursor 消费 SSE live event。
- 多个客户端 attach 同一个 daemon 时，状态由同一个 reducer 收敛。
- 斜杠命令呈现/派发走 `dispatchSessionCommand`（见 [slash-commands-flow.md](./slash-commands-flow.md)），不绑 TUI React。

## 包结构

```text
packages/client/src
  client.ts            # OpenHarnessClient：typed HTTP API + SSE parser
  reducer.ts           # applyEvent/applyEvents：事件归并为 client state
  sync.ts              # hydrateState/syncEvents：snapshot/replay + live 合并
  session-commands.ts  # dispatchSessionCommand：斜杠呈现/派发（无 React）
  types.ts             # 面向客户端的 public types
  index.ts             # public exports
```

## API Client

`OpenHarnessClient` 封装 daemon HTTP API：

```ts
const client = new OpenHarnessClient({
  baseUrl: "http://127.0.0.1:12345",
  token: registry.token,
});

await client.health();
const sessions = await client.listSessions();
const session = await client.createSession({ cwd, model, title });
const state = await client.getSessionState(session.id);
const messages = await client.listMessages(session.id);
const parts = await client.listMessageParts(session.id);
const prompt = await client.admitPrompt(session.id, { content: "hello" });
const pending = await client.listPermissions({ sessionId: session.id, status: "pending" });
await client.replyPermission(pending[0].id, {
  status: "approved",
  decision: "once",
  clientId: "tui",
});
```

当前封装的方法：

| 方法 | HTTP |
|---|---|
| `health()` | `GET /health`；确认 daemon 可达 |
| `listSessions()` | `GET /sessions` |
| `createSession()` | `POST /sessions` |
| `getSession(id)` | `GET /sessions/:sessionId` |
| `getSessionState(id)` | `GET /sessions/:sessionId/state`；原子 attach snapshot + cursor |
| `listMessages(id)` | `GET /sessions/:sessionId/messages` |
| `listMessageParts(id)` | `GET /sessions/:sessionId/parts` |
| `admitPrompt(id, input)` | `POST /sessions/:sessionId/prompts` |
| `interruptSession(id)` | `POST /sessions/:sessionId/interrupt` |
| `listEvents()` | `GET /events` |
| `streamEvents()` | `GET /events/stream` |
| `listPermissions()` | `GET /permissions` |
| `replyPermission(id, input)` | `POST /permissions/:requestId/reply` |
| `createTask(input)` | `POST /tasks`（`/tasks run`） |
| `initProject({ cwd })` | `POST /project/init` |
| `listPlugins({ cwd })` / `enablePlugin` / `disablePlugin` | `/plugins` |
| `reloadPlugins({ cwd })` | `POST /plugins/reload` |
| `listHooks({ cwd, sessionId? })` | `GET /hooks` |
| `listAgentPersonas()` | `GET /agent-personas` |
| `getGitDiff` / `getGitBranch` / `getGitStatus` / `gitCommit` | `/git/*` |
| `rewindSession(id, { count? })` | `POST /sessions/:id/rewind` |

## Event Reducer

客户端状态按 session 分桶：

```ts
type OpenHarnessClientState = {
  sessions: Record<string, SessionRecord>;
  sessionOrder: string[];
  buckets: Record<string, {
    session?: SessionRecord;
    inputs: SessionInputRecord[];
    messages: SessionMessageRecord[];
    partsByMessageId: Record<string, SessionMessagePartRecord[]>;
    runs: Record<string, SessionRunRecord>;
    permissions: Record<string, PermissionRequestRecord>;
  }>;
  eventsBySeq: Record<number, SessionEventRecord>;
  lastSeq: number;
};
```

已处理的事件：

| Event type | Reducer 行为 |
|---|---|
| `session.created` | upsert session，更新 sessionOrder |
| `session.archived` | 标记 session archived |
| `session.input.admitted` | 追加/更新 input，按 `seq` 排序 |
| `session.message.created` | 追加/更新 message shell，按 `seq` 排序 |
| `session.message.part.updated` | upsert message part authoritative snapshot |
| `session.message.part.delta` | 向 text/reasoning part 追加流式增量 |
| `session.run.created` | upsert run |
| `session.run.updated` | upsert run |
| `permission.asked` | upsert permission request |
| `permission.replied` | upsert permission request |

Reducer 用 `event.seq` 去重。即使 SSE live 与 replay 重叠，重复事件也不会二次写入。message/input/part 会按自身 `seq` 排序，因此乱序事件最终可收敛。TUI transcript 只从 message + parts selector 派生，不扫描 `runtime.*`。

## Cursor and retry semantics

The daemon event sequence is global. A stream filtered by `sessionId` therefore naturally
contains gaps created by events for other sessions; those gaps are not packet loss and must not
trigger a session snapshot. On a disconnect, the client reconnects with the highest applied global
cursor. The server replays matching events after that cursor, also accepting `Last-Event-ID` for
standard SSE clients, and sends keepalive comments while idle.

Prompt admission is idempotent when the caller reuses `input.id`. Use
`createPromptRequestId()` before the first send and retain that id if the transport outcome is
unknown; `OpenHarnessClient.admitPrompt` also generates one when omitted. Reusing an id with different content,
delivery, or metadata returns `409` rather than creating a second run.

## Snapshot + Live

推荐客户端启动流程：

```ts
for await (const update of syncEvents(client, { sessionId, cursor })) {
  render(update.state);
}
```

`syncEvents` 行为：

1. 有 `sessionId` 时先调用 `GET /sessions/:sessionId/state`。
2. 用 snapshot 一次 hydrate session、inputs、messages、parts、runs、permissions。
3. 用 snapshot 的全局 cursor 打开 `GET /events/stream`，不会漏掉 snapshot 之后的事件。
4. 对 live SSE 继续 apply；重复 seq 被 reducer 抑制。

无 `sessionId` 的全局 dashboard 同步仍可使用 `GET /events` replay + SSE；TUI 会话页不再依赖全量 event log 才能恢复历史消息。

如果 UI 需要先画首屏，也可以直接：

```ts
const state = hydrateState(await client.listEvents({ sessionId }));
```

## Permission UI

daemon 权限请求已经持久化。客户端不需要持有本地 Promise，只需要：

1. 从 reducer state 读 `bucket.permissions` 中 `status === "pending"` 的请求。
2. 展示权限 UI。
3. 用户确认后调用 `replyPermission`。
4. 等待 `permission.replied` 事件更新 UI。

这允许客户端断开、重启、换端后继续回答之前 pending 的权限请求。

## TUI 接线

HTTP/SSE 细节收口在 TUI hook：

```text
apps/frontend/src/hooks/useServerSync.ts
```

职责：

- 读取 daemon registry 或接收显式 daemon URL/token。
- 创建 `OpenHarnessClient`。
- `syncEvents()` 驱动 React state。
- 暴露 `sendPrompt(sessionId, content)`、`replyPermission(...)`、`interruptSession(sessionId)`。
- 将 active session 从 UI route/state 映射到 `state.buckets[activeSessionId]`。

OHJSON TUI 层与 per-session BackendHost 已从主线删除。

## 尚未完成

- `delivery: "steer"` 还没有真正注入活跃 run，只是 API/store/coordinator 的前置能力。
- CLI 根据 release version 与构建时间识别 stale daemon，并在启动 TUI 前替换为当前构建；该判断不进入 client API 或 session 数据结构。
- store 仍是文件 adapter，SQLite adapter 是下一阶段持久化重点。
- WebSocket 双向协议暂不做；当前 HTTP action + SSE event 已覆盖基础 attach 与恢复。
