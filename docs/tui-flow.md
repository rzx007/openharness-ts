# TUI 启动链路

默认 `ohs`（无 prompt）与显式 `ohs --tui` 均走 daemon/client 主线；不再保留旧 TUI 后端/OHJSON，也不再提供进程内 REPL 交互入口。

```text
ohs | ohs --tui [flags] ["initial prompt"]
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
  -> SessionStore + SessionRunEngine + PermissionBroker
  -> CliSessionRuntime
  -> bootstrap() + QueryEngine + tools
```

## CLI 启动器

`mainAction()` 在无 prompt 时默认进入 `runTuiMode()`；`--tui` 为显式别名。带 prompt 且未加 `--tui` 时走 print（同样 ensure daemon + Session API，见 [daemon-session-runtime-design.md](./daemon-session-runtime-design.md)「Print Session API」）。CLI 的 `--continue` / `--resume` 仍暂不可用；daemon 会话在 TUI 内用 `/sessions` 切换，用 `/resume` 明确重放中断 run。

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
- `GET /tasks?sessionId=...`
- `GET /sessions/:sessionId/messages`
- `GET /sessions/:sessionId/parts`
- `POST /sessions/:sessionId/prompts`
- `POST /sessions/:sessionId/interrupt`
- `GET /permissions`
- `POST /permissions/:requestId/reply`
- `GET /events`
- `GET /events/stream`

服务启动后仅为本机发现写入私有 registry，供本机 `ohs`、`ohs --tui` 与 print 入口复用。Web、Desktop 或另一台机器上的远程客户端绝不读取或复制该文件，而是使用显式 daemon URL 与 bearer token 连接。唯一的默认 store 是 `~/.openharness-ts/data/session-runtime/sessions.db`；它由 daemon 独占写入。旧 `~/.openharness` 与既有 JSON store 都不读取、不迁移，也不存在并行的版本化 store。

## 远程 TUI 入口

传入 `--daemon-url` 和 `--daemon-token` 时，`runTuiMode()` 跳过本机 registry、探活和 daemon 派生，直接将这组显式连接信息写入 `OPENHARNESS_FRONTEND_CONFIG`。前端仍通过同一个 `useServerSync()` 与 `@openharness/client` 进入 snapshot + SSE 链路，因此本机与远程 TUI 的会话行为一致。

远程 daemon 绑定非 loopback 地址时必须显式设置 `--token`；浏览器客户端还必须命中精确的 `--allow-origin` 白名单。部署示例与安全边界见 [remote-attach.md](./remote-attach.md)。

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
- `/resume` 列出当前 session 可安全重放的中断 run；`/resume <runId>` 创建一个带恢复溯源的新 input/run，重放该 run 的原始 prompt。它不继续旧 provider stream，也不自动恢复 workflow/child task。
- 权限弹框通过 `replyPermission()` 持久化回复。
- Esc interrupt 通过 `interruptSession()`。

Ctrl+C 由 `App` 请求 `renderer.destroy()`；进程只在 OpenTUI `onDestroy` 回调触发后退出，确保 raw mode、光标和 alternate screen 已经恢复。

## Runtime

Windows 上 TUI 运行在 Bun 和 OpenTUI 原生 DLL 组合中。启动器会在加载 OpenTUI 之前拒绝低于 Bun `1.3.12` 的版本，避免原生运行时崩溃表现为无上下文的段错误。建议先执行 `bun upgrade` 再运行 `ohs`；该检查只影响 Windows TUI，不影响 daemon HTTP 服务。

prompt 进入 server 后：

1. `SessionStore.admitPrompt()` 持久化输入。
2. `SessionStore.createRun()` 创建 run。
3. `SessionRunEngine.admitPrompt()` 负责 prompt 准入、steer 和中断语义，内部通过 `SessionRunCoordinator.enqueue()` 保证同 session 串行、不同 session 并发。
4. `CliSessionRuntime` 复用 `bootstrap()` / `QueryEngine` 执行。
5. QueryEngine stream event 被翻译成 durable `session.message.created`、`session.message.part.updated`、`session.message.part.delta`。
6. daemon 通过 SSE 推给所有 attach 客户端。

## 约束

- TUI 不拥有 agent runtime。
- TUI 不直接读写 session store。
- TUI 不 spawn per-session backend。
- 可恢复状态以 daemon canonical session state（messages + parts + runs + tasks + permissions）为准；TaskManager 的进程句柄和 callback 不属于可恢复状态。
