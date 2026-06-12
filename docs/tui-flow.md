# TUI 运行流程

`ohs --tui` 如何启动 opentui + React 19 终端 UI，以及 **BackendHost**（`ohs --backend-only`）
如何通过 **OHJSON 行协议** 与前端通信。权限弹框、SwarmPanel 等能力都建立在这条链上。

## 三进程模型

TUI **不是**单进程：启动器、前端、后端是三个独立进程。

```
用户: ohs --tui [flags] ["initial prompt"]
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│ 进程 A · 启动器（ohs --tui，runTuiMode）                  │
│  · 拼 backend_command = [node, ohs, --backend-only, …]   │
│  · spawn 进程 B，env: OPENHARNESS_FRONTEND_CONFIG          │
│  · stdio: inherit（终端交给 opentui）                       │
│  · 等 B 退出 → process.exit(code)                         │
└──────────────────────────┬───────────────────────────────┘
                           │ spawn
                           ▼
┌──────────────────────────────────────────────────────────┐
│ 进程 B · TUI 前端（apps/frontend/src/index.tsx · opentui + React 19，Bun 运行时）│
│  · useBackendSession mount → spawn 进程 C                 │
│  · C.stdout → 读 OHJSON 事件 → 更新 React 状态           │
│  · C.stdin  ← 写 JSON 请求（submit_line / permission_…） │
│  · stderr inherit；自身 stdio inherit 终端用于渲染 UI      │
└──────────────────────────┬───────────────────────────────┘
                           │ spawn(stdio: pipe,pipe,inherit)
                           ▼
┌──────────────────────────────────────────────────────────┐
│ 进程 C · BackendHost（ohs --backend-only，runBackendHost） │
│  · bootstrap() → QueryEngine + permissionPrompt(TUI弹框) │
│  · stdout emit OHJSON 事件；stdin readline 收前端请求     │
│  · 不直接画终端 UI                                       │
└──────────────────────────────────────────────────────────┘
```

**和 REPL / `--print` 的区别**：BackendHost 把流式输出转成结构化事件给 opentui 渲染；
REPL 用 readline + EventRenderer 直接写终端。

---

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| CLI 入口 / 模式分发 | `apps/cli/src/index.ts` + `commands/main.ts` | `--tui` → `runTuiMode`；`--backend-only` → `runBackendHost` |
| `runTuiMode` | `apps/cli/src/commands/main.ts` | 拼 `backend_command`，spawn 前端，传 `OPENHARNESS_FRONTEND_CONFIG` |
| 前端入口 | `apps/frontend/src/index.tsx` | 解析 env 配置，`render(<App />)`；由 Bun 运行（CLI 通过 `resolveBun` 检测 Bun 路径，找不到时友好报错） |
| `useBackendSession` | `apps/frontend/src/hooks/useBackendSession.ts` | spawn backend、解析 OHJSON、发请求、30fps assistant delta 缓冲 |
| `App` + 组件 | `apps/frontend/src/App.tsx` 等 | ConversationView / ModalHost / PromptInput / SwarmPanel … |
| `runBackendHost` | `apps/cli/src/commands/main.ts` | bootstrap、请求循环、emit 事件、TUI 权限 `askPermission` |
| OHJSON 协议 | `packages/core/src/protocol/protocol-host.ts`（参考） | 行前缀 `OHJSON:` + JSON |
| 权限 TUI 链路 | 见 [permission-flow.md](./permission-flow.md) | checkTool → ask → modal_request → permission_response |

---

## 启动流程（Step 1–4）

```
ohs --tui -m gpt-4 --permission-mode default
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│ Step 1 · mainAction                                      │
│ loadSettings → dry-run? → backendOnly? → tui? → …        │
│ --tui 分支 → runTuiMode（本进程不进入 runBackendHost）    │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2 · runTuiMode                                      │
│ args = [cliPath, "--backend-only", …透传 flags…]        │
│ frontendConfig = { backend_command, initial_prompt, theme }│
│ TTY 时清屏 \x1b[2J\x1b[3J\x1b[H                         │
│ spawn(bun, apps/frontend/dist/index.js)                   │
│   bun 路径由 resolveBun() 检测，缺失时抛出友好错误        │
│   env.OPENHARNESS_FRONTEND_CONFIG = JSON.stringify(…)    │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3 · 前端 index.tsx + useBackendSession              │
│ 解析 OPENHARNESS_FRONTEND_CONFIG → backend_command       │
│ spawn(backend_command[0], args…)                         │
│   stdio: [pipe, pipe, inherit]                           │
│ readline 监听 C.stdout 每行 OHJSON:…                     │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 4 · runBackendHost（进程 C）                        │
│ bootstrap({ permissionPrompt: askPermission })           │
│ emit { type: "ready", state, commands, … }               │
│ readline(stdin) 循环处理 FrontendRequest                 │
│ 收到 ready 后前端 setReady(true)，显示 PromptInput       │
│ 若有 initial_prompt → 自动 submit_line                   │
└──────────────────────────────────────────────────────────┘
```

### CLI flags 透传

`runTuiMode` 会把下列选项写入 `backend_command`（BackendHost 子进程 argv）：

`-m` / `--provider` / `--permission-mode` / `--max-turns` / `-s` / `--api-key` /
`--base-url` / `--api-format` / `--theme` / `--cwd` / `--effort` /
`--dangerously-skip-permissions` / `--allowed-tools` / `--disallowed-tools` / `--bare`

`theme` 同时进 `frontendConfig` 供 opentui 主题，不进 backend argv。

---

## OHJSON 协议

**传输**：一行一条消息；backend → frontend 带前缀，frontend → backend 纯 JSON。

| 方向 | 格式 | 示例 |
|------|------|------|
| Backend → Frontend | `OHJSON:{...}\n` | `OHJSON:{"type":"ready","state":{...}}` |
| Frontend → Backend | `{...}\n`（无前缀） | `{"type":"submit_line","line":"hello"}` |

非 `OHJSON:` 开头的 backend stdout 行会被前端当作 `{ role: "log" }` 写入 transcript。

### 前端 → 后端（FrontendRequest）

| type | 用途 |
|------|------|
| `submit_line` | 用户输入或 initial_prompt |
| `permission_response` | ModalHost 权限确认（含 `scope: once \| session`） |
| `question_response` | 问题模态回答 |
| `list_sessions` | `/resume` 等触发会话列表 |
| `shutdown` | Ctrl+C / 退出 |

### 后端 → 前端（部分 BackendEvent）

| type | 用途 |
|------|------|
| `ready` | 连接就绪，带 state / commands / tasks |
| `assistant_delta` / `assistant_complete` | 流式助手输出（前端 30fps 合并 delta） |
| `transcript_item` | 用户/系统/工具消息 |
| `tool_started` / `tool_completed` | 工具调用展示 |
| `modal_request` | 权限 / 问题 / 选择器 |
| `line_complete` | 本轮结束（清 busy） |
| `clear_transcript` | `/clear` |
| `todo_update` / `plan_mode_change` | TodoPanel / 计划模式 |
| `swarm_status` | SwarmPanel teammate 列表（见 [swarm-subprocess-flow.md](./swarm-subprocess-flow.md)） |
| `shutdown` / `error` | 结束或错误 |

`emit` 使用 writeLock 串行写 stdout，避免并发事件乱序。

---

## 一轮对话时序（简化）

```
用户 Enter
    │
    ▼
前端 sendRequest({ type:"submit_line", line:"…" })  →  C.stdin
    │
    ▼
BackendHost: processLineForHost → QueryEngine.submitMessage
    │
    ├─ emit assistant_delta (多次)  →  B 合并缓冲 → ConversationView
    ├─ emit tool_started / tool_completed
    ├─ 若 checkTool→ask: emit modal_request(permission)
    │       → B ModalHost → permission_response → C 继续执行工具
    └─ emit assistant_complete / line_complete  →  B setBusy(false)
```

斜杠命令、`/<skill>` 用户技能在后端 **本地路由**（`runHostSlashCommand` /
`matchUserInvocableSkill`），不发给模型；行为对齐 REPL。

---

## 其他入口

| 方式 | 说明 |
|------|------|
| `ohs --backend-only` | 单独跑 BackendHost（调试协议 / 无 TUI 前端） |
| 前端 dev + `OPENHARNESS_BACKEND_COMMAND` | 不经过 `runTuiMode`，前端自行 spawn backend |
| `ohs --tui "prompt"` | `initial_prompt` 在 ready 后自动 `submit_line` |

---

## 关键点

- **三进程**：`--tui` 进程只是启动器；BackendHost 在 **前端 spawn 的子进程** 里。
- **stdio 分工**：A/B inherit 终端画 UI；B↔C 用 pipe 传协议；C stderr inherit。
- **权限**：BackendHost 注入 `askPermission` → `modal_request`；详见 [permission-flow.md](./permission-flow.md)。
- **SwarmPanel**：仅 BackendHost 订阅 `getTaskManager()` 的 agent 任务并 emit `swarm_status`；REPL 无此事件。
- **busy 锁**：BackendHost 单会话 busy，并发 `submit_line` 返回 error。

## 使用示例

```bash
# 标准 TUI
ohs --tui

# 带初始 prompt + 模型
ohs --tui -m anthropic/claude-sonnet-4 "explain this repo"

# 仅调试 backend（需另开终端或用脚本往 stdin 写 JSON）
ohs --backend-only --permission-mode default
```
