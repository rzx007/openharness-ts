# Client Sync Flow

> 状态：当前 TUI、Web、Desktop 共用客户端同步的权威说明。最后核对：2026-08-23。

客户端只负责发动作、接事实和渲染，不拥有 Agent Runtime，也不直接读 daemon 的 SQLite。

```text
TUI / Web / Desktop / IDE
  -> @openharness/client 发 HTTP action
  -> daemon 准入并持久化
  -> snapshot + SSE event
  -> 同一个 reducer 收敛为界面状态
```

Bot 不走浏览器 reducer，但同样必须进入 daemon 的 Session/Input/Run；见 [Channels Flow](./channels-flow.md)。

## 公共包分工

```text
packages/client/src
  transport/http-client.ts       typed HTTP API、协议检查、SSE 解析
  state/reducer.ts               snapshot/event -> client state
  state/sync.ts                  首次同步、回放、断线重连
  commands/session-commands.ts   不依赖 React 的命令分发
  types/index.ts                 对上层产品公开的类型
```

上层产品可以保存当前路由、选中项和可丢弃的展示缓存；不能保存第二份 Session、Run、Permission 或 Workflow 权威状态。

## 一次 attach 怎样完成

有明确 sessionId 时，`syncEvents()` 按以下顺序工作：

1. 调用 `GET /sessions/:sessionId/state` 取得一个原子 snapshot。
2. 一次装入 Session、Input、Message、Part、Run、Run Attempt、Task、Permission 和 snapshot cursor。
3. 从该 cursor 打开 `GET /events/stream`。
4. 对后续 SSE 逐条执行同一个 reducer。
5. 连接中断后，从最后成功应用的 cursor 重连；服务端回放缺失事件，再进入 live。

snapshot 解决“首屏必须从完整状态开始”，cursor 解决“snapshot 之后不能漏事件”。客户端不能先订阅 live 再分别请求十几类列表拼状态。

全局 dashboard 没有指定 sessionId 时，可以使用 `GET /events` 回放后再接 SSE。

## 客户端状态

每个 session bucket 当前包含：

```ts
type SessionBucket = {
  session?: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  partsByMessageId: Record<string, SessionMessagePartRecord[]>;
  runs: Record<string, SessionRunRecord>;
  attempts: Record<string, SessionRunAttemptRecord>;
  tasks: Record<string, SessionExecutionRecord>;
  permissions: Record<string, PermissionRequestRecord>;
};
```

顶层 `OpenHarnessClientState` 还保存 session 列表、`eventsBySeq`、`transientCursor` 和 `lastSeq`。TUI transcript 只从 Message + Part 派生，不扫描 `runtime.*` 日志猜文本。

## Reducer 处理的事件

| 事件 | 状态变化 |
|---|---|
| `session.created`、`session.updated`、`session.archived` | 新增、更新或归档 Session |
| `session.input.admitted` | 写入 Input |
| `session.message.created` | 写入 Message 外壳 |
| `session.transcript.replaced` | rewind 等操作后整体替换 transcript |
| `session.message.part.updated` | 写入 Part 权威快照 |
| `session.message.part.delta` | 给 text/reasoning Part 追加临时增量 |
| `session.run.created`、`session.run.updated` | 写入 Run |
| `session.run_attempt.created`、`session.run_attempt.updated` | 写入 Run Attempt |
| `session.task.created`、`session.task.updated` | 写入 Task/Session Execution |
| `permission.asked`、`permission.replied` | 写入 Permission Request |

durable event 按 `seq` 去重；message、input 和 part 按各自 `seq` 排序。`session.message.part.delta` 是临时流式事件，不放进 durable `eventsBySeq`，但用 `transientCursor` 防止重连后重复追加。

每条事件必须使用当前 `SESSION_EVENT_SCHEMA_VERSION`。客户端看到未知版本会抛出 `UnsupportedSessionEventSchemaVersionError`，并且不推进 cursor。升级协议时应同步升级客户端和服务端，不跳过未知事件继续运行。

## Prompt 提交与安全重试

可靠客户端在第一次发送前调用 `createPromptRequestId()`，并把同一个 `id` 保留到传输结果明确为止。相同 ID、相同内容的重试只返回第一次准入结果；相同 ID 配不同 content、delivery 或 metadata 返回 `409`。

`OpenHarnessClient.admitPrompt()` 在调用方没有给 ID 时会生成一个。直接调用 HTTP 时 body `id` 也是可选的，由服务端生成；这种写法适合不需要恢复“响应是否丢失”的简单调用。如果调用方要求可靠重试，就必须自己提供并保存 ID。这是当前协议本身的行为，不是旧字段兼容路径。

## Permission

Permission 已持久化，UI 不需要把一个本地 Promise 当作事实：

1. 从 bucket 中读取 `status === "pending"` 的请求。
2. 展示确认界面。
3. 调用 `POST /permissions/:requestId/reply`。
4. 等待 `permission.replied` 更新所有已 attach 客户端。

因此 TUI 退出后，可以由 Desktop 或 Web 回答同一条 pending Permission。

## Jobs 为什么单独刷新

Jobs 是对 Terminal、shell、Agent、dream、Workflow 等长期工作的统一观察视图。当前 Session SSE reducer 不处理 Job 事件；TUI 在以下时机调用 Jobs HTTP API 读取 producer 的权威快照：

- 激活 session；
- 打开 Jobs Panel 或手动刷新；
- 成功创建 background shell；
- 完成 send/cancel 等控制动作；
- 主 Run 进入终态。

这个 `JobRemoteState` 是可丢弃的 UI 缓存，不写回 SessionStore。刷新失败会保留已有列表并显示辅助错误，不会结束 Agent Run。这里没有所谓 phase 1/phase 2 承诺；如果以后增加 Job SSE，必须先扩展协议版本、client reducer 和契约测试。

## 当前传输边界

- 动作使用 HTTP，事实流使用 SSE；目前没有 WebSocket 双向协议。
- TUI 通过 `apps/frontend/src/hooks/useServerSync.ts` 接线，但同步语义属于 `@openharness/client`，不能复制到 React hook。
- 浏览器构建不能依赖 Node polyfill。
- 斜杠命令走 `dispatchSessionCommand`，不直接绑 TUI 组件。
- `delivery: "steer"` 的 durable 准入和 replacement run 由 daemon 负责，客户端只提交动作并接收结果。

公开方法、错误形状和精确协议版本见 [Protocol Contract](./protocol-contract.md)，测试入口见 [契约与测试索引](./contract-test-index.md)。
