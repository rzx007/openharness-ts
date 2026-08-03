# @openharness/client

连接 OpenHarness daemon（`ohs serve`）的共享客户端 SDK。面向 TUI / Web / Desktop：typed HTTP API、SSE 事件流、事件 reducer、snapshot + live 同步。

客户端只负责展示与控制，不拥有 agent runtime。

```text
TUI / Web / Desktop
        |
        | @openharness/client
        | HTTP actions + SSE events
        v
ohs serve / daemon
```

## 职责

| 模块 | 作用 |
|------|------|
| `client.ts` | `OpenHarnessClient`：包装 server REST + `/events/stream` SSE |
| `reducer.ts` | `applySessionSnapshot` / `applyEvent`：快照水合后归并实时事件 |
| `sync.ts` | `syncEvents`：会话先读取原子 snapshot，再从 snapshot cursor 接 SSE live |
| `types.ts` | 请求/响应与客户端聚合状态类型 |

约束：

- UI 不直接读 daemon 内部 store 文件
- 可恢复状态来自 HTTP snapshot + SSE live
- 多端 attach 同一 daemon 时，用同一套 reducer 收敛状态

## 使用

```ts
import {
  OpenHarnessClient,
  syncEvents,
} from "@openharness/client";

const client = new OpenHarnessClient({
  baseUrl: "http://127.0.0.1:12345",
  token: registry.token,
});

await client.health();
const session = await client.createSession({ cwd: process.cwd() });
await client.admitPrompt(session.id, { content: "hello" });

for await (const update of syncEvents(client, { sessionId: session.id })) {
  // update.source: "snapshot" | "live"
  // update.state: OpenHarnessClientState
  console.log(update.event?.type ?? "snapshot", update.state.lastSeq);
}
```

当前主要消费者：

- `apps/frontend` 的 `useServerSync`（TUI）
- `apps/cli` 的 `print-session.ts`（用户 headless print）

## API 一览

| 方法 | HTTP |
|------|------|
| `health()` | `GET /health` |
| `listSessions()` | `GET /sessions` |
| `createSession()` | `POST /sessions` |
| `getSession(id)` | `GET /sessions/:id` |
| `getSessionState(id)` | `GET /sessions/:id/state` |
| `listMessages(id)` | `GET /sessions/:id/messages` |
| `admitPrompt(id, input)` | `POST /sessions/:id/prompts` |
| `interruptSession(id)` | `POST /sessions/:id/interrupt` |
| `listEvents()` | `GET /events` |
| `streamEvents()` | `GET /events/stream` |
| `listPermissions()` | `GET /permissions` |
| `replyPermission(id, input)` | `POST /permissions/:id/reply` |

## 相关文档

- [docs/client-sync-flow.md](../../docs/client-sync-flow.md)
- [docs/daemon-session-runtime-design.md](../../docs/daemon-session-runtime-design.md)

## 测试

```bash
pnpm --filter @openharness/client test
pnpm --filter @openharness/client check-types
```
