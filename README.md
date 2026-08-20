# OpenHarness-ts

OpenHarness 是一个开源 AI Agent 框架，提供类 Claude Code 的交互式编码助手体验。本项目是其 TypeScript 复刻实现，核心 harness（引擎 / 工具 / 权限 / 会话 / TUI）已可用，仍在持续向 Python 原版 v0.1.9 对齐中。

## 特性

> ⚠️ 本项目仍在复刻中。下表标注各能力相对 Python 原版 **v0.1.9** 的**真实状态**：✅ 基本对齐 · 🟡 可用但简化 · 🟠 骨架/部分 · 🔴 未实现。完整差距清单与补齐路线见 [PLAN-REMAINING.md](PLAN-REMAINING.md)。
>
> **易漂移数字以代码/单测为准**：基础工具数 → `packages/tools` `createDefaultToolRegistry()`；daemon 按 host capability 注入 `TerminalOpen`、5 个 `Job*` 和 5 个 `Schedule*` 工具；Provider 数 → `packages/api` `PROVIDERS`；默认 `model` / `maxTurns` → `packages/core` `DEFAULT_SETTINGS`。programmatic 入口见 [docs/agent-sdk.md](docs/agent-sdk.md)，当前架构以 [docs/daemon-application-architecture.md](docs/daemon-application-architecture.md) 和 [docs/agent-framework-capability-boundary.md](docs/agent-framework-capability-boundary.md) 为准，跨层终态与失败规则见 [docs/agent-lifecycle-contract.md](docs/agent-lifecycle-contract.md)。

- ✅ **多模型支持** — 21 个 Provider 自动检测（`packages/api` `PROVIDERS`；Anthropic 原生 + OpenAI 兼容 + Codex 订阅），含 `<think>` 块过滤、图片/vision 传递、gpt-5/o 系列 token 字段适配。🟡 暂缺 Copilot 订阅；CLI/`settings.effort` 已有，模型原生 reasoning tokens 仍简化
- ✅ **工具能力** — 基础 registry 提供文件 / Bash / Web / Grep / MCP / TaskCreate / Agent / Workflow / 媒体与元工具；runtime host 按能力注入 `JobList/Read/Wait/Send/Cancel`、`TerminalOpen` 和 5 个 `Schedule*` 工具。bash/grep/glob 健壮性已对齐 v0.1.8（超时保留输出、进程组杀除、gitignore/超长行处理）
- ✅ **多 Agent 编排** — 内置 7 agent + 用户/插件自定义 agent（`~/.openharness-ts/agents/*.md`），以及统一 Jobs 控制、`Workflow` DAG、sequential/parallel/pipeline、retry、预算、timeline、reconcile/cancel、TUI follow-up 执行和 `ohs workflow` 管理命令。daemon/TUI/print 主路径使用 daemon 内 child session；task、child session 与 child run 的关联通过 daemon 事件持久化，跨客户端可重放。
- ✅ **MCP 协议** — stdio + HTTP(streamable)/SSE 传输连接外部 MCP Server，支持 headers/env 静态鉴权、`McpAuth` 配置 Bearer/Header/env 后重连、失败隔离；MCP OAuth 流程待补
- ✅ **权限系统** — default / plan / full_auto + 工具黑白名单、路径规则、命令拒绝；swarm worker 只读自动放行 + 写操作转 leader 集中裁决；TUI 下 Edit/Write 改文件前显示 unified diff 预览，可本次/整个会话批准
- ✅ **Hook 生命周期** — 10 类事件、priority 排序、command/http/prompt/agent 四种类型、matcher 过滤、`$ARGUMENTS` 注入+shell 转义
- ✅ **会话持久化** — TUI / 用户 print / 跨端主线使用 daemon `SessionStore`；单会话通过原子 snapshot + SSE 恢复。daemon 内 `Agent` 使用同一 store 持久化 child session、task 与 child run 的关联；重启会保留审计记录，并将失去进程所有权的 run/task/workflow 明确标记为中断，不会伪造自动续跑。TUI 可用 `/resume` 明确重放某次中断 run 的原始 prompt。
- ✅ **插件系统** — Claude Code 布局兼容：skills/commands/hooks/MCP/agents/tools_dir 六类贡献加载（`/插件:命令` 斜杠路由）、项目插件信任门控、卸载路径防护；`tools_dir` 支持动态 import 插件工具
- ✅ **Channels Agent 桥接** — `MessageBus` 双队列 + `ChannelManager`（fail-closed ACL 集中过滤）+ `ChannelBridge` 接 `OpenHarnessAgent`；`ohs channels serve` 长驻模式跑通飞书对话（文本 + @bot 过滤）。Telegram/Discord/Slack、媒体、长消息分片待补。详见 [docs/channels-flow.md](docs/channels-flow.md)
- ✅ **TUI 前端** — opentui + React 19 终端 UI（Bun 运行时）：经 `@openharness/client` attach daemon，Markdown 渲染 + 代码块语法高亮、output style 热切换（minimal 极简工具行）、tool 行分组折叠、Edit/Write 权限框 unified diff 预览（`[y]`本次/`[a]`整个会话/`[n]`拒绝）。统一 Jobs Panel 展示和控制 Terminal、后台 shell、child Agent、dream 与 Workflow；Workflow Steps 在所选 Workflow Job 的详情中展示，不再保留独立的后台 Task/Swarm/Workflow Runs 执行面板
- 🟢 **Daemon Application** — 主线具备 `ohs serve` / `ohs daemon start/status/stop`、Hono HTTP API、durable session/transcript、SSE、单 session 串行 run lane、持久化 PermissionBroker、child durable projection 和共享 `@openharness/client` reducer。`DaemonApplication` 集中组装 durable 应用，HTTP server 只负责 transport；`AgentPool` 按 session 缓存真实 `OpenHarnessAgent`。权威导览见 [docs/daemon-application-architecture.md](docs/daemon-application-architecture.md)，framework 见 [docs/agent-runtime-framework-architecture.md](docs/agent-runtime-framework-architecture.md)，客户端同步见 [docs/client-sync-flow.md](docs/client-sync-flow.md)。
- ✅ **Terminal** — daemon 统一持有终端 runtime，Desktop 右侧 Panel 与 Agent 连接同一个终端；支持多终端、输出快照恢复、右键菜单、每项目默认 shell、REST/SSE 传输、对话卡片挂接和沙箱终端 MVP。模型用 `TerminalOpen` 创建持久终端，后续统一通过 `JobList/Read/Wait/Send/Cancel` 观察和控制。完整功能、权限和生命周期见 [docs/desktop-terminal-pty-design.md](docs/desktop-terminal-pty-design.md)。
- ✅ **记忆体系** — 四层：工具输出预算 / 每轮 checkpoint / 持久记忆（`/remember` LLM 提取 + personalization 环境事实抽取自动注入 prompt）/ `/dream` 梦境整合（备份+锁+回滚）。详见 [docs/memory-system.md](docs/memory-system.md)
- 🟡 **可用但仍在收口** — `sandbox`（Bash / MCP stdio / hooks / LSP 等进程入口走 SRT/Docker；Docker active 时 Read/Write/Edit/Glob/Grep 进入容器文件操作；Docker 整棵进程停止和真实 E2E 已补，CI 中 Docker 实跑仍待接入）
- 🔴 **尚未复刻** — `ohmo`（个人助理 + 多渠道网关）
- ⛔ **不在复刻范围** — `autopilot`（仓库级自动驾驶 + dashboard）

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 10
- Bun >= 1.0（CLI 通过 Bun 构建/运行）

### 安装

```bash
git clone https://github.com/rzx007/openharness-ts.git
cd OpenHarness-ts
pnpm install
```

### 构建

```bash
pnpm build
```

### 测试

```bash
pnpm test
```

### 运行

```bash
# 设置 API Key（按所用 Provider 选择，见下方“配置”）
export ANTHROPIC_API_KEY="sk-ant-..."

# CLI 安装后提供两个等价命令：ohs 与 openharness

# 单次执行（headless：attach/启动 daemon，经 Session API）
ohs "explain this codebase"
ohs -p "explain this codebase"

# 交互式 TUI（默认；attach/启动 daemon，需安装 Bun）
ohs
ohs --tui

# TUI 带初始提示
ohs --tui "explain this project"
```

### 开发阶段运行

```bash
# 方式一：pnpm link --global（推荐，需先 build）
pnpm build
cd apps/cli
pnpm link --global
openharness "hello"        # 任意目录可用（ohs 等价）
openharness --tui
# 取消链接：pnpm unlink --global

# 方式二：Bun 直跑源码（改代码立刻生效，无需 build）
bun apps/cli/src/index.ts "hello"
bun apps/cli/src/index.ts --tui

# 方式三：Bun watch（自动重载源码）
pnpm --filter @rzx/ohs dev   # = bun --watch src/index.ts
```

开发阶段建议用 **方式二**（Bun 直跑源码，改了代码立刻生效），稳定后用方式一。

### 常用开发命令

```bash
# monorepo 根目录命令（走 turbo）
pnpm dev           # 启动所有 workspace 的 dev 任务；CLI/frontend 都是 Bun watch
pnpm build         # 构建所有 workspace；CLI/frontend 会输出 dist
pnpm test          # 跑所有 workspace 测试
pnpm check-types   # 跑 TypeScript 类型检查
pnpm lint          # 跑所有 workspace lint 任务（如果对应包定义了 lint）
pnpm clean         # 清理各 workspace 的构建产物

# 只跑某个包
pnpm --filter @rzx/ohs build
pnpm --filter @rzx/ohs test
pnpm --filter @openharness/frontend dev
pnpm --filter @openharness/tools test

# 发布 npm CLI（只发布 @rzx/ohs，不发布整个 workspace）
pnpm release:cli:plan      # 查看本地版本、npm 最新版本和自动计算出的下一版本
pnpm release:cli:dry       # 根目录发布预演：自动版本管理 + build + publish --dry-run
pnpm release:cli           # 根目录正式发布；首发用本地版本，后续自动 patch
pnpm release:cli -- minor  # 显式发 minor 版本，也支持 major、patch、0.2.0

# 本地调试 CLI 源码（不需要先 build）
bun apps/cli/src/index.ts --dry-run
bun apps/cli/src/index.ts "hello"
bun apps/cli/src/index.ts --tui
```

### CLI 常用参数

```bash
ohs [options] [prompt]

Options:
  --model <model>              模型名称（默认 minimax/minimax-m2.5:free）
  --provider <provider>        强制指定 provider
  --permission-mode <mode>     权限模式: default | plan | full_auto
  --max-turns <n>              最大 agent 轮次（默认 50）
  --system-prompt <prompt>     自定义 system prompt
  --api-key <key>              API Key
  --base-url <url>             API Base URL
  --api-format <format>        API 格式: anthropic | openai
  --allowed-tools <list>       工具白名单（逗号分隔）
  --disallowed-tools <list>    工具黑名单（逗号分隔）
  --mcp-config <path>          MCP 服务器配置文件
  --theme <theme>              终端主题
  --effort <level>             推理强度: low | medium | high
  --tui                        显式启动 TUI/daemon（无 prompt 时默认已是 TUI；需 Bun）
  --verbose                    详细输出
  --continue                   （暂不可用）旧项目级快照续聊；请用 TUI /sessions
  --resume <session>           （暂不可用）旧项目级快照恢复；会话切换请用 TUI /sessions，中断 run 重放请用 TUI /resume
  -p, --print                  经 daemon Session API 打印响应后退出（有 prompt 时默认即 print）
  -n, --name <name>            命名会话
  --output-format <format>     输出格式: text | json | stream-json
  --append-system-prompt <p>   追加到默认 system prompt
  --cwd <dir>                  工作目录
  --bare                       跳过 hooks/plugins/MCP 加载
  -d, --debug                  调试模式
  --dangerously-skip-permissions  跳过所有权限检查
  --dry-run                    预览解析后的运行时配置(不调模型)
```

### 子命令

```bash
# 首次配置 / 健康检查
ohs setup
ohs doctor
ohs version

# Auth / Provider / Model
ohs auth login <provider> <api-key>
ohs auth login codex
ohs auth status
ohs auth logout <provider>

ohs provider list
ohs provider use <name> [-m <model>]
ohs provider add <name> -k <key> [-m <model>] [-b <base-url>] [--use]
ohs provider edit <name> [-k <key>] [-m <model>] [-b <base-url>]
ohs provider remove <name>

# Sandbox
ohs sandbox on                         # project-local Docker sandbox, network=bridge, reuse=on
ohs sandbox on --net none              # offline sandbox
ohs sandbox on --no-reuse              # temporary container per session
ohs sandbox on --global                # write global user config instead of project config
ohs sandbox on --backend srt           # use Anthropic Sandbox Runtime
ohs sandbox on --net proxy --proxy http://host.docker.internal:7890
ohs sandbox off
ohs sandbox clean                       # remove current project reusable container
ohs sandbox rebuild                     # recreate reusable container after config changes
ohs sandbox status                      # show config scope, reusable container, image, and config hash
ohs sandbox doctor                      # status plus backend availability checks

# MCP server 配置（写入 settings.mcpServers）
ohs mcp list
ohs mcp add <name> <command> [args...] [-e KEY=VALUE ...]
ohs mcp remove <name>

# 插件
ohs plugin list
ohs plugin install <path-or-package>
ohs plugin uninstall <name>

# 已安排任务
# 在 Agent 对话中描述任务内容、时间和项目；Desktop 的【已安排】用于暂停、继续、立即运行、删除和查看历史。
# 任务由主 daemon 托管并保存到 SQLite；支持一次性时间和 RRULE 重复规则。

# Workflow run 管理（持久化到项目 .openharness/workflows）
ohs workflow list [--status running,failed] [--limit 10] [--needs-reconciliation]
ohs workflow status [runId] [--no-events]
ohs workflow validate --spec <path>
ohs workflow template [research-implement-verify|parallel-review|safe-write]
ohs workflow reconcile [runId] [--action-ids <ids>] [--budget-preset <preset>]
ohs workflow cancel [runId] [--reason <reason>]

# Channels 长驻桥接（当前实现：feishu）
ohs channels status
ohs channels serve

# Daemon / shared session runtime（TUI/Web/Desktop 的共同后端）
ohs serve --host 127.0.0.1 --port 0 --register
ohs daemon start
ohs daemon status
ohs daemon stop
# 开启或关闭登录启动与崩溃恢复，同时写入 settings.json
ohs daemon install
ohs daemon uninstall

# 配置
ohs config show
ohs config set <key> <value>
ohs config set daemon.autoStart true|false
```

Auth、provider、model 的关系和本地存储规则见 [docs/auth-provider-model.md](docs/auth-provider-model.md)。
Workflow CLI 和 TUI `/workflow` 面板的完整用法见 [docs/workflow-cli.md](docs/workflow-cli.md)。
`ohs provider use <name>` 默认只切换供应商；要同时切模型请加 `-m/--model`，例如 `ohs provider use deepseek -m deepseek-chat`。

TUI 内斜杠命令走 daemon command catalog + client-local UI + template expand；共享呈现/派发在 `@openharness/client` `dispatchSessionCommand`（TUI 适配层 `sessionSlashCommands.ts`）。流程见 [docs/slash-commands-flow.md](docs/slash-commands-flow.md)，清单见 [docs/slash-commands.md](docs/slash-commands.md)；运行时以 TUI `/help` 与 `GET /commands` 为准。

### TUI、Web、Desktop 的共享会话

默认 `ohs`（与 `ohs --tui`）会连接已有 daemon；没有可用/stale daemon 时会启动一个。后续 Web、Desktop 或 remote attach 客户端都应通过 `@openharness/client` 连接同一个 daemon，而不是各自启动 agent runtime。

`~/.openharness-ts/settings.json` 的 `daemon.autoStart` 控制本地 daemon 是否在登录后自动启动并在异常退出后恢复，默认关闭。`ohs daemon install/uninstall` 是修改该开关并立即应用的便捷命令。完整说明见 [docs/daemon-system-service.md](docs/daemon-system-service.md)。

远程 attach 使用显式 URL + bearer token，不读取本机 daemon registry；浏览器还必须命中 daemon 的精确 `--allow-origin` 白名单。部署与 SDK 示例见 [docs/remote-attach.md](docs/remote-attach.md)。

一次模型交互会被服务端保存为按顺序排列的 canonical message parts：

| Part                       | 含义                        |
| -------------------------- | --------------------------- |
| user text                  | 用户提交的文本              |
| assistant text / reasoning | 可持续追加的模型输出        |
| tool call                  | 工具名和输入参数            |
| tool result                | 工具输出或错误              |
| error / log                | 本次 run 的可展示错误或日志 |

每个 part 都带稳定 ID、顺序和 `pending/running/completed/failed` 状态。客户端 attach 单个 session 时先读取原子 snapshot，再从 snapshot cursor 订阅 SSE 增量，因此切换客户端、重启 TUI 或中途进入会话都能恢复同一份文本和工具状态。

默认用户数据目录是 `~/.openharness-ts/`；旧 `~/.openharness/` 不读取、不迁移。仓库内的 `.openharness/` 仍是项目级配置目录，两者用途不同。

历史迁移材料保留在 `docs/superpowers/` 供追溯；其中带“归档”标题的文件描述已经退场的 Ink、BackendHost 或 OHJSON 方案，不能作为当前实现依据。

---

## 项目结构

```
OpenHarness-ts/
├── apps/
│   ├── cli/                  # CLI 应用（Commander.js）
│   ├── frontend/             # TUI 前端（opentui + React 19）
│   └── mcp-feishu/           # 飞书 MCP 辅助入口（独立源码目录）
├── packages/
│   ├── core/                 # 核心引擎（QueryEngine、类型、配置）
│   ├── api/                  # API Provider 抽象层
│   ├── client/               # daemon HTTP/SSE typed client + event reducer（TUI/Web/Desktop 共用）
│   ├── tools/                # 工具 registry（基础 33；daemon 全 capability 为 44）
│   ├── server/               # daemon HTTP server、run engine、permission broker
│   ├── services/             # 服务层（Compact、Session、Scheduled recurrence、Task、LSP）
│   ├── coordinator/          # 多 Agent 编排器
│   ├── mcp/                  # MCP 协议客户端
│   ├── channels/             # 通信通道（Stdio、HTTP、飞书）
│   ├── hooks/                # Hook 生命周期系统
│   ├── prompts/              # System Prompt 构建
│   ├── permissions/          # 权限检查器
│   ├── bridge/               # 多进程会话桥接
│   ├── swarm/                # 多 Agent 团队管理
│   ├── memory/               # 持久化记忆存储
│   ├── commands/             # CommandRegistry 库；TUI 不跑 CLI 旧 builtin 表
│   ├── auth/                 # 认证流程（API Key、OAuth Device Code）
│   ├── skills/               # Skill 加载与管理
│   ├── plugins/              # 插件系统
│   ├── personalization/      # 环境事实抽取（local_rules 注入 prompt）
│   ├── utils/                # 共享工具函数
│   ├── themes/               # 终端主题（5 内置主题）
│   ├── output-styles/        # 输出格式化
│   ├── keybindings/          # 键盘快捷键
│   ├── vim/                  # Vim 模态编辑
│   ├── sandbox/              # 沙箱执行（SRT/Docker MVP）
│   └── voice/                # 语音输入（placeholder）
├── turbo.json                # Turborepo 配置
├── vitest.config.ts          # 测试配置
└── pnpm-workspace.yaml       # pnpm monorepo 工作区
```

---

## 架构

### 架构图

当前主线采用 daemon/session runtime。TUI 不再经过 BackendHost/OHJSON，也不为每个会话派生后端进程。本机入口通过私有 registry 发现 daemon；远程入口只接受显式 URL 与 bearer token，二者最终连接同一个 Session API。完整启动链路见 [docs/tui-flow.md](docs/tui-flow.md)，远程部署见 [docs/remote-attach.md](docs/remote-attach.md)。

```text
┌─────────────────────────────────────────────────────────────────────┐
│                              客户端入口                             │
│  ┌───────────────────────┐    ┌──────────────────────────────────┐ │
│  │ 本机 CLI / TUI / print │    │ 远程 TUI / Web / Desktop         │ │
│  │ `ohs` / `ohs --tui`   │    │ 显式 daemon URL + bearer token   │ │
│  │ 私有本机 registry     │    │ 不读取、不复制本机 registry      │ │
│  └───────────┬───────────┘    └───────────────┬──────────────────┘ │
│              │ 启动或复用本机 daemon           │ HTTP action + SSE  │
│              └───────────────┬────────────────┘                    │
│                              ▼                                     │
│                 ┌─────────────────────────────┐                    │
│                 │ `ohs serve` / daemon        │                    │
│                 │ Hono transport                │                    │
│                 │ DaemonApplication             │                    │
│                 │ SessionStore · RunEngine      │                    │
│                 │ PermissionBroker/Controller  │                    │
│                 └──────────────┬──────────────┘                    │
│                                │ AgentPool.acquireSession(id)      │
│                 ┌──────────────▼──────────────┐                    │
│                 │ `AgentPool`                   │                    │
│                 │ `OpenHarnessAgent`             │                    │
│                 │ `AgentSession` → QueryEngine  │                    │
│                 └──────────────┬──────────────┘                    │
└────────────────────────────────┼────────────────────────────────────┘
                         │
┌────────────────────────┼───────────────────────────────────────────┐
│                    Core Engine                                      │
│                        │                                            │
│  ┌─────────────────────▼──────────────────────────────────────┐    │
│  │                    QueryEngine                              │    │
│  │                                                             │    │
│  │  ┌───────────┐  ┌────────────┐  ┌───────────────────────┐  │    │
│  │  │ API Client│  │ Tool       │  │ Permission            │  │    │
│  │  │ (stream)  │  │ Registry   │  │ Checker               │  │    │
│  │  └─────┬─────┘  └─────┬──────┘  └───────────┬───────────┘  │    │
│  │        │              │                     │               │    │
│  │  ┌─────▼──────────────▼─────────────────────▼──────────┐   │    │
│  │  │              Agentic Loop (max 50 turns)             │   │    │
│  │  │                                                      │   │    │
│  │  │  1. Stream from API ──► 2. Parse tool_use blocks     │   │    │
│  │  │  3. Check permissions  ► 4. Execute tools            │   │    │
│  │  │  5. Append results  ───► 6. Auto-compact if needed   │   │    │
│  │  │  7. Loop back to 1    ◄── (repeat until no tool_use) │   │    │
│  │  └──────────────────────────────────────────────────────┘   │    │
│  │                                                             │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │    │
│  │  │ Compact      │  │ CostTracker  │  │ Hook Executor    │  │    │
│  │  │ Service      │  │              │  │                  │  │    │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    API Provider Layer                               │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Provider Registry (PROVIDERS, 21)                            │ │
│  │                                                                │ │
│  │  ┌──────────────┐  ┌──────────────────┐  ┌────────────────┐  │ │
│  │  │ Anthropic    │  │ OpenAI Compat    │  │ Auto Detect    │  │ │
│  │  │ SDK Client   │  │ SDK Client       │  │ apiKey/URL/    │  │ │
│  │  │              │  │                  │  │ model keywords │  │ │
│  │  └──────────────┘  └──────────────────┘  └────────────────┘  │ │
│  │                                                                │ │
│  │  Providers: OpenAI • DeepSeek • Gemini • Qwen • GLM • Groq  │ │
│  │  Mistral • Bedrock • VertexAI • Moonshot • SiliconFlow • …   │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Tool Layer (createDefaultToolRegistry)           │
│                                                                     │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │
│  │ Bash    │ │ Read     │ │ Write    │ │ Edit      │ │ Glob    │ │
│  ├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤ ├─────────┤ │
│  │ Grep    │ │ WebFetch │ │WebSearch │ │ Notebook  │ │ LSP     │ │
│  ├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤ ├─────────┤ │
│  │ Agent   │ │ Job×5    │ │TaskCreate│ │ Workflow  │ │Schedule×5│ │
│  ├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤ ├─────────┤ │
│  │ MCP×4   │ │ Image×2  │ │ Skill    │ │ TodoWrite │ │ …      │ │
│  └─────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Service Layer                                    │
│                                                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ Compact      │ │ SessionStore │ │ Scheduled    │ │ Task      │ │
│  │ Service      │ │ parts/events │ │ Scheduler    │ │ Manager   │ │
│  │ (LLM摘要)   │ │ (daemon)     │ │ (RRULE计算)  │ │ (生命周期)│ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └───────────┘ │
│  ┌──────────────┐ ┌──────────────┐                                │
│  │ Memory       │ │ LSP Client   │                                │
│  │ (加权搜索)   │ │              │                                │
│  └──────────────┘ └──────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Extension Layer                                  │
│                                                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ MCP Client   │ │ Channels     │ │ Coordinator  │ │ Plugins   │ │
│  │ stdio/HTTP/  │ │ Stdio/HTTP/  │ │ (多Agent     │ │ (动态加载)│ │
│  │ SSE          │ │ Feishu       │ │  编排)       │ │           │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └───────────┘ │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐               │
│  │ Skills       │ │ Swarm/Team   │ │ Bridge       │               │
│  │ (Markdown)   │ │ (多Agent团队)│ │ (会话桥接)   │               │
│  └──────────────┘ └──────────────┘ └──────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 模块说明

### 核心引擎（Core）

| 模块             | 说明                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QueryEngine`    | Agent 循环核心：提交消息 → 流式调用 API → 解析工具调用 → 权限检查 → 执行工具 → 循环直到完成                                                                        |
| `CompactService` | 上下文管理：token 估算 + 自动摘要（LLM 生成 `<analysis>/<summary>`），连续失败 3 次自动退回。详见 [docs/compact-service-design.md](docs/compact-service-design.md) |
| `CostTracker`    | 费用追踪：记录 input/output/cache token 用量和估算成本                                                                                                             |
| `ToolRegistry`   | 工具注册中心：按名称查找、批量注册、可过滤                                                                                                                         |
| `RuntimeBuilder` | 运行时组装：Builder 模式将 API Client、工具、权限、Hook 组装为 `RuntimeBundle`                                                                                     |
| `Settings`       | 配置管理：默认值 < 配置文件 < 环境变量 < CLI 参数，四层优先级                                                                                                      |

### API 层

| 模块                     | 说明                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `AnthropicClient`        | Anthropic 原生 SDK 客户端，流式聚合 `input_json_delta`，429/5xx 指数退避重试                 |
| `OpenAICompatibleClient` | OpenAI 兼容客户端，支持 reasoning_content（o1/o3 系列），Kimi workaround                     |
| `Provider Registry`      | 21 个 Provider（`PROVIDERS`）自动检测：apiKey 前缀 → baseURL 关键字 → model 关键字，三级匹配 |
| `detectProvider()`       | 从 `(model, apiKey, baseURL)` 三元组自动推断 Provider 和 BackendType                         |

### 工具层（基础 registry；host 按能力注入 Jobs / Terminal / Scheduled Tasks）

| 分类           | 工具                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **文件操作**   | `Bash`（命令执行）、`Read`（文件读取）、`Write`（文件写入）、`Edit`（精确字符串替换）、`Glob`（文件模式匹配）、`NotebookEdit`（Jupyter 编辑） |
| **搜索**       | `Grep`（ripgrep 优先 + JS fallback）、`Lsp`（LSP 集成）                                                                                       |
| **Web**        | `WebFetch`（URL 抓取 + HTML→Text）、`WebSearch`（DuckDuckGo HTML 搜索）                                                                       |
| **后台工作**   | `TaskCreate`（只创建后台 shell）、`JobList/Read/Wait/Send/Cancel`（统一控制 Terminal、shell、Agent、Workflow）                                |
| **Agent/团队** | `Agent`（创建 daemon child session 并返回 `jobId`）、`Workflow`（硬调度 DAG）、`TeamCreate/Delete`（团队管理）                                |
| **调度**       | `ScheduleCreate/Update/Delete/List/RunNow`（创建和管理运行 Agent 的已安排任务；仅 daemon/host 注入 schedules capability 后注册）              |
| **MCP**        | `McpToolCall/ListMcpResources/ReadMcpResource/McpAuth`（4 个 MCP 工具；`McpAuth` 是静态 Bearer/Header/env 配置，不是 OAuth flow）             |
| **媒体/通道**  | `ImageToText`（视觉 fallback）、`ImageGeneration`（DALL-E 兼容）、`FeishuPush`                                                                |
| **元工具**     | `TodoWrite、Config、Sleep、Skill、ToolSearch、AskUser、Brief、EnterPlanMode、ExitPlanMode、EnterWorktree、ExitWorktree`                       |

### 服务层

| 模块                       | 说明                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompactService`           | LLM 驱动的对话摘要：当 token 接近阈值时自动触发，结构化 `<analysis>/<summary>` 输出。详见 [docs/compact-service-design.md](docs/compact-service-design.md)                                                                                   |
| session snapshot functions | print/worker 项目级快照：按项目分目录（cwd 哈希）、latest/id 双写、load 侧 tool_use/result 配对修复、tool_metadata 白名单、transcript.md 导出；不参与 daemon/TUI 状态。详见 [docs/session-storage-design.md](docs/session-storage-design.md) |
| `SessionStore`             | daemon 主线会话存储：session/input/message/canonical message part/event/run/task/permission request；支持单会话原子 snapshot + SSE cursor，使用 daemon 独占的 SQLite 数据库与迁移文件                                                        |
| `ScheduledTaskService`     | 已安排任务：一次性时间 / RRULE 计算、Agent 执行、重叠与错过策略、运行历史和未读结果                                                                                                                                                          |
| `TaskManager`              | 进程内执行器：创建/查询/停止/输出与 stdin/callback；跨端可恢复的生命周期由 `SessionStore` task 投影持久化                                                                                                                                    |
| `MemoryManager`            | 四层记忆体系的持久层：frontmatter + 加权搜索 + MEMORY.md 索引；配套 `/remember`（LLM 提取持久记忆）、`/dream`（梦境整合）、会话 checkpoint 与环境事实抽取。详见 [docs/memory-system.md](docs/memory-system.md)                               |
| `LspClient`                | LSP 客户端：与 Language Server Protocol 通信                                                                                                                                                                                                 |

### 扩展层

| 模块                    | 说明                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Coordinator`           | 多 Agent 编排：内置/用户/插件 Agent 定义 + coordinator prompt；硬调度器（`Workflow` / DAG / 持久化恢复 / timeline / budget / reconcile / cancel）。详见 [docs/coordinator-hard-scheduler-flow.md](docs/coordinator-hard-scheduler-flow.md)                                                                               |
| `McpClientManager`      | MCP 协议客户端：stdio + HTTP/SSE 传输连接外部 MCP Server，headers/env 静态鉴权，动态获取工具和资源；`McpAuth` 可保存 Bearer/Header/env 并重连 live server，MCP OAuth 待补                                                                                                                                                |
| `ChannelAdapter`        | 通信通道：`StdioAdapter`（标准输入输出）、`HttpAdapter`（HTTP Webhook）、`FeishuAdapter`（飞书机器人）                                                                                                                                                                                                                   |
| `HookExecutor`          | Hook 系统：10 类事件（`session_start/end`、`pre/post_tool_use`、`pre/post_compact`、`user_prompt_submit`、`notification`、`stop`、`subagent_stop`），支持 command/http/prompt/agent 四种类型、priority、matcher、`$ARGUMENTS`                                                                                            |
| `Swarm`                 | 多 Agent 团队：framework 创建并执行 child agent，daemon 投影 parent task、child session 与 child run。详见 [docs/agent-child-session-flow.md](docs/agent-child-session-flow.md)                                                                                                                                          |
| `PluginLoader`          | 插件系统（Claude Code 布局兼容）：双源发现 + 项目插件信任门控；skills/commands/hooks/MCP/agents/tools_dir 六类贡献注册（`/plugin:cmd` 斜杠命令、`${CLAUDE_PLUGIN_ROOT}`、`.mcp.json`、动态工具 import）；卸载路径穿越防护。详见 [docs/plugins-contributions-design.md](docs/plugins-contributions-design.md)             |
| `SkillRegistry`         | Skill 管理：Markdown + frontmatter 解析（user-invocable/disable-model-invocation/model/argument-hint）；内置 bundled skills（commit/review/test/plan/debug）；三源加载 bundled<user<project；daemon catalog 将 user-invocable skill 暴露为 template 斜杠（`POST /sessions/:id/commands` 展开后 admit）；model 可见性过滤 |
| `BridgeManager`         | 会话桥接：多进程间共享会话状态                                                                                                                                                                                                                                                                                           |
| `PermissionChecker`     | 权限系统：`default / plan / full_auto` 三种模式 + 工具黑白名单 + 路径规则 + 命令拒绝                                                                                                                                                                                                                                     |
| `DaemonApplication`     | daemon durable application composition：store recovery、run engine、Agent loader/pool、permission、task、projection 与四类 session services                                                                                                                                                                              |
| `OpenHarnessHttpServer` | daemon HTTP/SSE transport：Hono 路由、bearer token、CORS、listener、SSE client lifecycle；通过单个 `DaemonApplication` 调用应用能力                                                                                                                                                                                      |
| `OpenHarnessClient`     | 跨端客户端 SDK：typed API、SSE 解析、session snapshot+live 合并、按 session bucket 的 event reducer。详见 [docs/client-sync-flow.md](docs/client-sync-flow.md)                                                                                                                                                           |

### UI 层

| 模块                | 说明                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI`               | Commander.js 命令行：主命令 + auth/mcp/plugin/channels/workflow/sandbox/daemon/serve/config 子命令；已安排任务通过 Agent 对话创建并由 Desktop 管理                           |
| `TUI Frontend`      | 默认交互面：opentui + React 19（Bun）。`ohs` / `ohs --tui` 经 `useServerSync` attach daemon，消费 `@openharness/client` reducer。流程见 [docs/tui-flow.md](docs/tui-flow.md) |
| `Print`             | 用户 headless：ensure daemon → `@openharness/client` admitPrompt + SSE 渲染 stdout                                                                                           |
| `Task worker`       | 历史内部实现，不属于 daemon/TUI/print 产品链路，也不作为兼容承诺；主路径的 `Agent` 为 daemon child session                                                                   |
| `ThemeManager`      | 主题系统：default / dark / minimal / cyberpunk / solarized 5 个内置主题                                                                                                      |
| `VimModeHandler`    | Vim 模态编辑：normal / insert / visual / command 模式切换                                                                                                                    |
| `KeyBindingManager` | 快捷键管理：模式感知的按键绑定解析                                                                                                                                           |

---

## 运行流程

### 启动流程

```
用户输入
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│  CLI 解析 (Commander.js)                                 │
│  解析 flags: --model, --api-key, --permission-mode, ...  │
└──────────────────────────┬───────────────────────────────┘
                           │
           ┌───────────────┼──────────────────────────┐
           ▼               ▼                          ▼
     ohs / --tui        --print / prompt      --task-worker（deprecated）
   (daemon 客户端,默认)   (daemon 客户端,单次)     (compatibility fallback)
           │               │                          │
           └───────────────┤                          ▼
                           │                 历史 task worker
                           ▼
┌──────────────────────────────────────────────────────────┐
│  ensure / attach daemon                                  │
│  ├─ 读取 daemon registry + GET /health                   │
│  ├─ 无可用/stale daemon 时 spawn `ohs serve --register`  │
│  ├─ TUI: spawn Bun frontend                              │
│  └─ print: @openharness/client + SSE stdout              │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  @openharness/client                                     │
│  TUI: snapshot/actions + SSE live events                 │
│  print: admitPrompt + SSE stdout，run idle 后退出         │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  ohs serve / daemon                                      │
│  Hono transport → DaemonApplication                      │
│  SessionStore · SessionRunEngine · AgentPool             │
│  PermissionBroker · PermissionController                 │
│  Agent → child session（daemon 当前主路径）                │
└──────────────────────────┬───────────────────────────────┘
                           │ AgentPool.acquireSession(sessionId)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  @openharness/agent-runtime                              │
│  OpenHarnessAgent → AgentSession → QueryEngine          │
│  → QueryEngine / tools / hooks / MCP                    │
└──────────────────────────────────────────────────────────┘
```

### Agent 循环（核心运行流程）

```
submitMessage(userInput)
         │
         ▼
┌─────────────────────────┐
│ 1. 追加 UserMessage     │
│ 2. 触发 session_start   │
│    Hook                 │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│          Agentic Loop (最多 maxTurns 轮)         │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ Step A: Auto Compact                     │   │
│  │ ├─ 估算当前 messages 总 token 数           │   │
│  │ ├─ 如果接近阈值(maxTokens - 33k buffer)   │   │
│  │ │   └─ LLM 生成摘要替换旧消息              │   │
│  │ └─ 如果 LLM 摘要连续失败 3 次              │   │
│  │     └─ 退回 microCompact(裁剪工具输出)     │   │
│  └──────────────────┬───────────────────────┘   │
│                     ▼                            │
│  ┌──────────────────────────────────────────┐   │
│  │ Step B: Stream API Call                  │   │
│  │ ├─ 转换 messages → Provider 格式          │   │
│  │ ├─ 流式调用 Anthropic/OpenAI API          │   │
│  │ ├─ 累加 text_delta → 文本输出             │   │
│  │ └─ 聚合 input_json_delta → tool_use blocks│   │
│  └──────────────────┬───────────────────────┘   │
│                     ▼                            │
│              ┌──────────────┐                    │
│              │ 有 tool_use? │                    │
│              └──┬───────┬───┘                    │
│                 │       │                        │
│              否 │       │ 是                     │
│                 │       ▼                        │
│                 │  ┌────────────────────────┐   │
│                 │  │ Step C: Permission     │   │
│                 │  │ 检查每个工具调用权限      │   │
│                 │  │ ├─ full_auto: 全部允许   │   │
│                 │  │ ├─ 黑名单: 直接拒绝      │   │
│                 │  │ └─ default: 交互确认     │   │
│                 │  └──────────┬─────────────┘   │
│                 │             ▼                   │
│                 │  ┌────────────────────────┐   │
│                 │  │ Step D: Execute Tools  │   │
│                 │  │ Promise.all() 并行执行  │   │
│                 │  │ ├─ Bash: child_process │   │
│                 │  │ ├─ Read/Write: fs      │   │
│                 │  │ ├─ WebSearch: HTTP     │   │
│                 │  │ ├─ MCP: stdio/HTTP/SSE │   │
│                 │  │ └─ Agent: child session│   │
│                 │  │    （daemon 主路径；   │   │
│                 │  │     worker 仅兼容）    │   │
│                 │  └──────────┬─────────────┘   │
│                 │             ▼                   │
│                 │  ┌────────────────────────┐   │
│                 │  │ Step E: Append Results │   │
│                 │  │ 工具结果转为             │   │
│                 │  │ ToolResultMessage       │   │
│                 │  │ content: ContentBlock[] │   │
│                 │  └──────────┬─────────────┘   │
│                 │             │                   │
│                 │             └──► 回到 Step A    │
│                 ▼                                │
│          输出 CompleteEvent                      │
│          (stopReason: "end_turn")                │
└─────────────────────────────────────────────────┘
         │
         ▼
  触发 session_end Hook
  返回所有 StreamEvent
```

### 会话恢复流程

用户 print（daemon Session API；旧项目级 `--continue`/`--resume` 尚未迁移）：

```
ohs -p "…" / ohs "…"
       │
       ▼
  ensureLocalDaemon → OpenHarnessClient
  createSession → syncEvents → admitPrompt → 渲染 stdout → run idle 退出
  （传 --continue/--resume 会明确报错）

# Agent child session 进入 daemon store；deprecated --task-worker fallback 仍用项目级快照
```

TUI / Web / Desktop（daemon 权威状态）：

```
ohs --tui  (或其它 client attach)
       │
       ▼
  @openharness/client
       │
       ├─ GET /sessions/:id/state   → 原子 snapshot
       │    (session / inputs / messages / parts / runs / permissions)
       └─ GET /events/stream?cursor=… → SSE live delta
       │
       ▼
  client reducer 归并 transcript
  （不扫描 runtime.*，不走项目级 JSON snapshot）
```

---

## 技术栈

| 层              | 技术                                                        |
| --------------- | ----------------------------------------------------------- |
| 语言            | TypeScript 5.7+（ESM）                                      |
| 构建            | Turborepo（任务编排）+ Bun（CLI 打包，`apps/cli/build.ts`） |
| 测试            | Vitest                                                      |
| 包管理          | pnpm 10（monorepo）                                         |
| CLI             | Commander.js                                                |
| API             | @anthropic-ai/sdk, openai                                   |
| MCP             | @modelcontextprotocol/sdk                                   |
| 飞书            | @larksuiteoapi/node-sdk                                     |
| TUI             | opentui + React 19（Bun 运行时）                            |
| Schema          | Zod                                                         |
| Scheduled Tasks | 一次性时间与 RRULE 解析，由 daemon 触发 Agent 运行          |

## 配置

配置文件路径：`~/.openharness-ts/settings.json`（首次运行无需手动创建，使用默认值即可）

Sandbox 推荐用子命令切换，不必手写配置：

```bash
ohs sandbox on      # 默认写入项目配置：Docker + bridge 网络 + 复用容器
ohs sandbox off
ohs sandbox clean
ohs sandbox rebuild
ohs sandbox status
```

```json
{
  "provider": "openrouter",
  "model": "minimax/minimax-m2.5:free",
  "apiFormat": "openai",
  "maxTurns": 50,
  "effort": "medium",
  "permission": {
    "mode": "default",
    "allowedTools": [],
    "deniedTools": [],
    "pathRules": [],
    "deniedCommands": []
  },
  "memory": {
    "enabled": true,
    "maxFiles": 5,
    "maxEntrypointLines": 200
  },
  "mcpServers": {
    "my-stdio-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "my-http-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

> MCP 传输自动推断：有 `command` 走 stdio、有 `url` 走 HTTP（streamable）；也可用 `type` 显式指定 `stdio` / `http` / `sse`。HTTP/SSE 用 `headers` 鉴权。

### 设置 API Key

**方式一：CLI（推荐）—— 存进 `~/.openharness-ts/credentials.json`，无需手改文件**

```bash
ohs setup                                   # 交互向导：选 provider → 输 key → 选 model
# 或非交互直接配：
ohs provider add deepseek -k sk-xxxx --use --model deepseek-chat
ohs provider list                           # 查看 provider + key 来源，标注 active
ohs doctor                                  # 验证 key 来源
ohs --dry-run                               # 预览解析后的运行时配置(不调模型)
```

**方式二：环境变量**

**Linux / macOS：**

```bash
# 当前会话
export ANTHROPIC_API_KEY="sk-ant-..."

# 持久化（写入 shell 配置文件）
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

**Windows PowerShell：**

```powershell
# 当前会话
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 持久化（写入用户环境变量）
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")

# 持久化后重启终端生效，或立即生效：
$env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
```

**Windows CMD：**

```cmd
:: 当前会话
set ANTHROPIC_API_KEY=sk-ant-...

:: 持久化（系统环境变量）
setx ANTHROPIC_API_KEY "sk-ant-..."
```

也可以通过 `settings.json` 或 `--api-key` 参数传入，优先级：CLI 参数 > 环境变量 > 配置文件 > 默认值。

### 环境变量

| 变量                     | 说明                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | Anthropic API Key                                                           |
| `OPENAI_API_KEY`         | OpenAI API Key                                                              |
| `OPENROUTER_API_KEY`     | OpenRouter API Key                                                          |
| `DEEPSEEK_API_KEY`       | DeepSeek API Key                                                            |
| `GEMINI_API_KEY`         | Gemini API Key                                                              |
| `DASHSCOPE_API_KEY`      | DashScope/Qwen API Key                                                      |
| `MOONSHOT_API_KEY`       | Moonshot/Kimi API Key                                                       |
| `MINIMAX_API_KEY`        | MiniMax API Key                                                             |
| `ZHIPUAI_API_KEY`        | 智谱 AI（GLM）API Key                                                       |
| `OPENHARNESS_CONFIG_DIR` | 自定义 settings/credentials/plugins/data 等目录（默认 `~/.openharness-ts`） |
| `OPENHARNESS_MODEL`      | 默认模型名称                                                                |
| `OPENHARNESS_BASE_URL`   | 通用 API Base URL 覆盖（**所有 provider**）                                 |
| `OPENHARNESS_API_FORMAT` | API 格式（anthropic / openai）                                              |
| `OPENHARNESS_MAX_TOKENS` | 最大输出 token 数                                                           |
| `OPENHARNESS_MAX_TURNS`  | 最大 agent 轮次                                                             |

> ⚠️ `ANTHROPIC_BASE_URL` 仅 Anthropic provider 生效（由 Anthropic SDK 自行读取），**不会**影响 deepseek/openrouter 等其它 provider——要全局覆盖 baseURL 请用 `OPENHARNESS_BASE_URL`。

---

## Provider 配置示例

### DeepSeek

DeepSeek 使用 OpenAI 兼容格式，框架会根据 `provider: deepseek`、`deepseek` 模型关键字或 `deepseek` base URL 关键字自动检测。模型名由上游/API 网关决定，代码侧只负责 provider 识别与 OpenAI 兼容请求格式。

**方式一：CLI（推荐）**

```bash
ohs provider add deepseek -k sk-xxxxxxxx --use --model deepseek-chat
```

**方式二：环境变量**

```bash
export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxx"
```

**方式三：settings.json**

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiFormat": "openai",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxxxxxxxxxxxxxxx"
}
```

**方式四：CLI 参数**

```bash
ohs --model deepseek-chat \
   --api-format openai \
   --base-url https://api.deepseek.com/v1 \
   --api-key sk-xxxxxxxxxxxxxxxx \
   "解释这个项目"
```

**常见模型示例：** `deepseek-chat`、`deepseek-reasoner`。代码不校验模型清单，实际可用模型以你接入的上游/API 网关为准。

---

### 智谱 AI（GLM / ChatGLM）

智谱 AI 使用 OpenAI 兼容格式，框架会根据 `bigmodel.cn` base URL 或 `glm` 模型关键字自动检测。

**方式一：环境变量（推荐）**

```bash
export ZHIPUAI_API_KEY="xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx"
```

**方式二：settings.json**

```json
{
  "provider": "zhipu",
  "model": "glm-4-plus",
  "apiFormat": "openai",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx"
}
```

**方式三：CLI 参数**

```bash
ohs --model glm-4-plus \
   --api-format openai \
   --base-url https://open.bigmodel.cn/api/paas/v4 \
   --api-key "xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx" \
   "帮我写一个快速排序"
```

**常见模型示例：**

| 模型          | 说明                         |
| ------------- | ---------------------------- |
| `glm-4-plus`  | GLM-4 增强版，综合能力最强   |
| `glm-4`       | GLM-4 标准版                 |
| `glm-4-flash` | GLM-4 快速版，低延迟低成本   |
| `glm-4-long`  | GLM-4 长上下文版（128K）     |
| `glm-4-air`   | GLM-4 轻量版                 |
| `glm-4-airx`  | GLM-4 轻量增强版             |
| `glm-4v`      | GLM-4 视觉版（支持图片输入） |
| `glm-3-turbo` | GLM-3 快速版                 |

---

### 自动检测规则

框架支持三级自动检测，无需手动指定 provider：

| 检测级别        | 规则                    | 示例                                         |
| --------------- | ----------------------- | -------------------------------------------- |
| API Key 前缀    | 匹配 `sk-` 后的特征字符 | Anthropic: `sk-ant-`                         |
| Base URL 关键字 | 匹配域名关键词          | DeepSeek: `deepseek.com`，GLM: `bigmodel.cn` |
| 模型名称关键字  | 匹配模型名前缀/关键词   | DeepSeek: `deepseek-`_，GLM: `glm-`_         |

因此在设置好对应环境变量后，通常只需指定 `--model` 即可：

```bash
# DeepSeek — 自动检测（DEEPSEEK_API_KEY 已设置）
ohs --model deepseek-chat "hello"

# GLM — 自动检测（ZHIPUAI_API_KEY 已设置）
ohs --model glm-4-plus "hello"
```

## License

MIT
