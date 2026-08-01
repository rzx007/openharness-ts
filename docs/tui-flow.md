# TUI 启动链路

当前 `ohs --tui` 只有 daemon/client 主线，不再保留旧 TUI 后端/OHJSON 兼容路径。

```text
ohs --tui [flags] ["initial prompt"]
  -> apps/cli/src/index.ts
  -> mainAction()
  -> runTuiMode()
  -> readDaemonRegistry()
  -> probe registry PID + authenticated GET /health
  -> 若 daemon 不可达，清理 stale registry
  -> 若 daemon 早于当前 CLI 构建或版本不同，停止 stale daemon
  -> 若没有 ready daemon，spawn:
       node <cli-entry> serve --register --host 127.0.0.1 --port 0
  -> 等待 registry 写入 url / pid / token / storePath / version / startedAt
  -> spawn:
       bun apps/frontend/dist/index.js
     env:
       OPENHARNESS_FRONTEND_CONFIG={
         daemon:{url,token,cwd,model},
         initial_prompt,
         theme,
         version
       }
  -> apps/frontend/src/index.tsx
  -> App
  -> useServerSync
  -> @openharness/client
  -> session snapshot + SSE live events
  -> OpenHarnessHttpServer
  -> SessionStore + SessionRunCoordinator + PermissionBroker
  -> CliSessionRuntime
  -> bootstrap() + QueryEngine + tools
```

## CLI 启动器

`apps/cli/src/index.ts` 只暴露 `--tui` 作为 TUI 入口。`mainAction()` 处理 `--cwd`、加载 settings 后进入 `runTuiMode()`。

`runTuiMode()` 负责：

- 检查 Bun runtime。
- 读取 daemon registry。
- 同时校验 registry PID、带 bearer token 的 `/health`、release version 和 daemon 启动时间。
- daemon 早于当前 CLI 构建或 release version 不一致时标记为 `stale` 并自动退场。
- registry 不存在、不可达或 stale 时，启动 `ohs serve --register`。
- 将 daemon `url/token/cwd/model` 写入 `OPENHARNESS_FRONTEND_CONFIG`。
- 以 `stdio: inherit` 启动 opentui 前端。

## Daemon

`ohs serve --register` 会创建 `OpenHarnessHttpServer`：

- `GET /health`
- `GET /sessions`
- `POST /sessions`
- `GET /sessions/:sessionId`
- `GET /sessions/:sessionId/state`
- `GET /sessions/:sessionId/messages`
- `GET /sessions/:sessionId/parts`
- `POST /sessions/:sessionId/prompts`
- `POST /sessions/:sessionId/interrupt`
- `GET /permissions`
- `POST /permissions/:requestId/reply`
- `GET /events`
- `GET /events/stream`

服务启动后写 registry，供 TUI、Web、Desktop 或 remote attach 客户端复用。唯一的默认 store 是 `~/.openharness-ts/data/session-runtime/sessions.json`；旧 `~/.openharness` 不读取、不迁移，也不存在并行的版本化 store。

## 前端

`apps/frontend/src/index.tsx` 只解析 daemon 配置并渲染 `App`。`App` 只使用 `useServerSync()`。

`useServerSync()` 负责：

- 创建 `OpenHarnessClient`。
- `health()` 探活。
- `listSessions({ cwd })`，没有 session 时 `createSession()`。
- 对活跃 session 调用 `syncEvents()`，先读取原子 HTTP snapshot，再从 snapshot cursor 接 SSE live。
- 把 reducer state 映射为 transcript/status/modal。
- 用户输入通过 `admitPrompt()` 提交。
- `/sessions` 列表切换 session。
- `/new [title]` 创建并切换 session。
- `/resume <id>` 切换到指定 session。
- 权限弹框通过 `replyPermission()` 持久化回复。
- Esc interrupt 通过 `interruptSession()`。

Ctrl+C 由 `App` 请求 `renderer.destroy()`；进程只在 OpenTUI `onDestroy` 回调触发后退出，确保 raw mode、光标和 alternate screen 已经恢复。

## Runtime

prompt 进入 server 后：

1. `SessionStore.admitPrompt()` 持久化输入。
2. `SessionStore.createRun()` 创建 run。
3. `SessionRunCoordinator.enqueue()` 保证同 session 串行、不同 session 并发。
4. `CliSessionRuntime` 复用 `bootstrap()` / `QueryEngine` 执行。
5. QueryEngine stream event 被翻译成 durable `session.message.created`、`session.message.part.updated`、`session.message.part.delta`。
6. daemon 通过 SSE 推给所有 attach 客户端。

## 约束

- TUI 不拥有 agent runtime。
- TUI 不直接读写 session store。
- TUI 不 spawn per-session backend。
- 可恢复状态以 daemon canonical session state（messages + parts + runs + permissions）为准。
