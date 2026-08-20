# Client Sync Flow

> 状态（2026-08-20）：TUI 默认通过 `useServerSync` attach 到 daemon；`@openharness/client` 是 TUI、Web、Desktop 共享 daemon API、SSE 事件流和 message-part reducer 的公共层。已经启动的长期工作通过 Jobs 查询和控制；phase 1 的 Jobs 缓存按需刷新，规范化 Job SSE 留到 phase 2。

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
    | SessionStore + SessionRunEngine + PermissionBroker
    v
AgentPool / OpenHarnessAgent / QueryEngine
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
  transport/http-client.ts        # OpenHarnessClient：typed HTTP API + SSE parser
  state/reducer.ts                 # applyEvent/applyEvents：事件归并为 client state
  state/sync.ts                    # hydrateState/syncEvents：snapshot/replay + live 合并
  commands/session-commands.ts     # dispatchSessionCommand：斜杠呈现/派发（无 React）
  types/index.ts                   # 面向客户端的 public types
  index.ts                         # public exports
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
| `listJobs(options)` | `GET /jobs`；按 session、kind、status、时间和窗口列出统一快照 |
| `readJob(id, options)` / `waitJob(id, options)` | `GET /jobs/:jobId` / `POST /jobs/:jobId/wait` |
| `sendJob(id, input)` / `cancelJob(id, input)` | `POST /jobs/:jobId/input` / `POST /jobs/:jobId/cancel` |
| `createBackgroundShell(input)` | `POST /background-shells`；只负责创建 shell，返回 `{ jobId, snapshot }` |
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
  transientCursor: number;
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

## Cursor 与重连语义

daemon 事件序列是全局递增的。因此按 `sessionId` 过滤的事件流天然会因其它 session 的事件而出现序号空洞；这不是丢包，不能因此触发 session snapshot。连接断开后，客户端携带已应用的最大全局 cursor 重连。服务端会回放该 cursor 之后匹配的事件，也接受标准 SSE 客户端的 `Last-Event-ID`，并在空闲时发送 keepalive 注释。

调用方复用 `input.id` 时，prompt 准入是幂等的。首次发送前应调用 `createPromptRequestId()`，若传输结果不明则保留同一 id 重试；省略时 `OpenHarnessClient.admitPrompt` 也会自动生成。若使用相同 id 但 content、delivery 或 metadata 不同，服务端返回 `409`，而不会创建第二个 run。

## Snapshot 与实时事件

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
- 激活 session 时调用 `listJobs({ sessionId, includeFinished: true, limit: 100 })`，把结果放进可丢弃的 `JobRemoteState`，再由 `JobsPanel` 展示。
- 打开 Jobs Panel、按 `r`、成功执行 `/background`、完成控制动作和主 run 进入终态时复用同一条 Jobs 刷新路径；选择某一项时用 `readJob` 读取输出和 producer detail。
- Jobs/MCP/detail 请求失败属于辅助 UI 错误：已有 Jobs 会作为缓存保留并显示错误，不会清掉或结束当前 Agent run。

OHJSON TUI 层与 per-session BackendHost 已从主线删除。

`JobRemoteState` 不写进 SessionStore，也不进入当前 message/run SSE reducer。phase 1 依靠上述刷新点获取 producer 的权威快照；`session.job.created/updated` 这类规范化 Job SSE 是 phase 2 工作。

## 尚未完成

- store 已迁到 daemon 独占的 SQLite；客户端只通过 Session API 与 SSE cursor 同步，绝不直接读取数据库。
- WebSocket 双向协议暂不做；当前 HTTP action + SSE event 已覆盖基础 attach 与恢复。

已覆盖的运行语义：`delivery: "steer"` 先进入 `SessionRunEngine`；目标 session 有活跃 lane 时由 `SessionRunCoordinator` 路由到 framework-owned `AgentRunHandle.steer()`，handle 尚未注册时先在 lane 内按 FIFO 暂存。run 已停止接收 steer 时，engine 为该 durable input 创建 replacement run；没有活跃 run 时直接按普通 prompt 建立新 run。CLI 也会在启动本机 TUI 前按 release version 与构建时间淘汰 stale daemon；这属于本机进程生命周期，不进入 client API 或 session 数据结构。
