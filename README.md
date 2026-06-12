# OpenHarness-ts

OpenHarness 是一个开源 AI Agent 框架，提供类 Claude Code 的交互式编码助手体验。本项目是其 TypeScript 复刻实现，核心 harness（引擎 / 工具 / 权限 / 会话 / TUI）已可用，仍在持续向 Python 原版 v0.1.9 对齐中。

## 特性

> ⚠️ 本项目仍在复刻中。下表标注各能力相对 Python 原版 **v0.1.9** 的**真实状态**：✅ 基本对齐 · 🟡 可用但简化 · 🟠 骨架/部分 · 🔴 未实现。完整差距清单与补齐路线见 [PLAN-REMAINING.md](PLAN-REMAINING.md)。

- ✅ **多模型支持** — 20 个 Provider 自动检测（Anthropic 原生 + OpenAI 兼容），含 `<think>` 块过滤、图片/vision 传递、gpt-5/o 系列 token 字段适配。🟡 暂缺 Codex/Copilot 订阅、reasoning effort
- 🟡 **内置工具（41）** — 文件 / Bash / Web / Grep / Cron / MCP / Task / Agent / TaskWait 等齐全，bash/grep/glob 健壮性已对齐 v0.1.8（超时保留输出、进程组杀除、gitignore/超长行处理）；暂无图片类工具
- 🟡 **多 Agent 编排** — `agent` 工具可真实派发子进程 teammate：独立 git worktree 隔离、只读工具自动放行、`TaskWait` 阻塞取结果、TUI 显示 teammate 状态；Coordinator 7 个 agent + XML 任务通知就绪。暂缺写操作转 leader 审批、多轮 worker、sequential/parallel/pipeline 调度
- ✅ **MCP 协议** — stdio + HTTP(streamable)/SSE 传输连接外部 MCP Server，支持 headers 鉴权、失败隔离；MCP OAuth 流程待补
- ✅ **权限系统** — default / plan / full_auto + 工具黑白名单、路径规则、命令拒绝；swarm worker 只读工具自动放行；TUI 下 Edit/Write 改文件前显示 unified diff 预览，可本次/整个会话批准
- ✅ **Hook 生命周期** — 10 类事件、priority 排序、command/http/prompt/agent 四种类型、matcher 过滤、`$ARGUMENTS` 注入+shell 转义
- 🟡 **会话持久化** — Session 存储 / `--continue` / `--resume` / Cron（均为基础版）
- 🟠 **插件系统** — 可读 `plugin.json`；工具自动发现与 commands/agents/hooks 贡献加载待补
- 🟠 **Channel 适配器** — Stdio / HTTP / 飞书（基础）；Telegram/Discord/Slack 等多通道、附件、群组路由待补
- 🟡 **TUI 前端** — React/Ink 终端 UI，助手消息 Markdown 渲染（标题/列表/代码块高亮/表格）、SwarmPanel 显示子 agent 状态、启动清屏、Edit/Write 权限框 unified diff 预览（`[y]`本次/`[a]`整个会话/`[n]`拒绝）；语法高亮、output style 待补
- 🔴 **尚未复刻** — `personalization`（环境事实抽取）、`ohmo`（个人助理 + 多渠道网关）、`sandbox`（Docker 隔离，当前为占位）
- ⛔ **不在复刻范围** — `autopilot`（仓库级自动驾驶 + dashboard）

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 10
- Bun >= 1.0（CLI 通过 Bun 构建/运行）

### 安装

```bash
git clone <repo-url> OpenHarness-ts
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

### 运行·

```bash
# 设置 API Key（按所用 Provider 选择，见下方“配置”）
export ANTHROPIC_API_KEY="sk-ant-..."

# CLI 安装后提供两个等价命令：ohs 与 openharness

# 单次执行
ohs "explain this codebase"

# 交互式 REPL
ohs

# 启动 TUI（React/Ink 终端 UI）
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
pnpm --filter @openharness/cli dev   # = bun --watch src/index.ts
```

开发阶段建议用 **方式二**（Bun 直跑源码，改了代码立刻生效），稳定后用方式一。

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
  --tui                        启动 React/Ink TUI 界面
  --backend-only               以 TUI 后端模式运行（内部使用）
  --verbose                    详细输出
  --continue                   继续上次会话
  --resume <session>           恢复指定会话
  -p, --print                  打印响应后退出（非交互）
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
ohs setup                     # 交互式首次配置向导(选 provider→输 key→选 model)
ohs provider list             # 列出 provider + key 来源,标注 active
ohs provider use <name> [-m]  # 切换 active provider(写 settings)
ohs provider add <name> -k <key> [--use]   # 存 key 到 credentials
ohs provider remove <name>    # 删 provider 的 key
ohs doctor                    # 检查环境/配置/key 来源
ohs auth | mcp | plugin | cron | config | version
```

---

## 项目结构

```
OpenHarness-ts/
├── apps/
│   ├── cli/                  # CLI 应用（Commander.js）
│   └── frontend/             # TUI 前端（React + Ink）
├── packages/
│   ├── core/                 # 核心引擎（QueryEngine、类型、配置）
│   ├── api/                  # API Provider 抽象层
│   ├── tools/                # 41 内置工具实现
│   ├── services/             # 服务层（Compact、Session、Cron、Task、LSP、OAuth）
│   ├── coordinator/          # 多 Agent 编排器
│   ├── mcp/                  # MCP 协议客户端
│   ├── channels/             # 通信通道（Stdio、HTTP、飞书）
│   ├── hooks/                # Hook 生命周期系统
│   ├── prompts/              # System Prompt 构建
│   ├── permissions/          # 权限检查器
│   ├── bridge/               # 多进程会话桥接
│   ├── swarm/                # 多 Agent 团队管理
│   ├── memory/               # 持久化记忆存储
│   ├── commands/             # 斜杠命令注册
│   ├── auth/                 # 认证流程（API Key、OAuth Device Code）
│   ├── skills/               # Skill 加载与管理
│   ├── plugins/              # 插件系统
│   ├── utils/                # 共享工具函数
│   ├── themes/               # 终端主题（5 内置主题）
│   ├── output-styles/        # 输出格式化
│   ├── keybindings/          # 键盘快捷键
│   ├── vim/                  # Vim 模态编辑
│   ├── sandbox/              # 沙箱执行（placeholder）
│   └── voice/                # 语音输入（placeholder）
├── turbo.json                # Turborepo 配置
├── vitest.config.ts          # 测试配置
└── pnpm-workspace.yaml       # pnpm monorepo 工作区
```

---

## 架构

### 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User Interface                            │
│  ┌────────────────────┐  ┌──────────────────────────────────────┐  │
│  │   CLI (ohs)        │  │   TUI Frontend (React/Ink)          │  │
│  │   Commander.js     │  │   ConversationView / StatusBar /    │  │
│  │   REPL / Print     │  │   PromptInput / ModalHost / Picker  │  │
│  └────────┬───────────┘  └──────────────┬───────────────────────┘  │
│           │               OHJSON:      │ spawn                    │
│           │               protocol     ▼                          │
│           │          ┌──────────────────────┐                      │
│           │          │  BackendHost         │                      │
│           │          │  (--backend-only)    │                      │
│           │          └────────┬─────────────┘                      │
│           │                   │                                    │
│           │   ┌───────────────▼──────────────┐                    │
│           └──►│  Runtime Bootstrap           │                    │
│               └────────┬─────────────────────┘                    │
└────────────────────────┼───────────────────────────────────────────┘
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
│  │  Provider Registry (20+ providers)                            │ │
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
│                    Tool Layer (41 tools)                            │
│                                                                     │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │
│  │ Bash    │ │ Read     │ │ Write    │ │ Edit      │ │ Glob    │ │
│  ├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤ ├─────────┤ │
│  │ Grep    │ │ WebFetch │ │WebSearch │ │ Notebook  │ │ LSP     │ │
│  ├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤ ├─────────┤ │
│  │ Agent   │ │SendMessage│ │TaskCreate│ │TaskUpdate │ │ Cron×5  │ │
│  ├─────────┤ ├──────────┤ ├──────────┤ ├───────────┤ ├─────────┤ │
│  │ MCP×4   │ │ Skill    │ │ Config   │ │ TodoWrite │ │ …      │ │
│  └─────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Service Layer                                    │
│                                                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ Compact      │ │ Session      │ │ Cron         │ │ Task      │ │
│  │ Service      │ │ Storage      │ │ Scheduler    │ │ Manager   │ │
│  │ (LLM摘要)   │ │ (文件持久化) │ │ (cron解析)   │ │ (生命周期)│ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └───────────┘ │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐               │
│  │ Memory       │ │ LSP Client   │ │ OAuth Flow   │               │
│  │ (加权搜索)   │ │              │ │              │               │
│  └──────────────┘ └──────────────┘ └──────────────┘               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Extension Layer                                  │
│                                                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ MCP Client   │ │ Channels     │ │ Coordinator  │ │ Plugins   │ │
│  │ (stdio)      │ │ Stdio/HTTP/  │ │ (多Agent     │ │ (动态加载)│ │
│  │              │ │ Feishu       │ │  编排)       │ │           │ │
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


| 模块               | 说明                                                                |
| ---------------- | ----------------------------------------------------------------- |
| `QueryEngine`    | Agent 循环核心：提交消息 → 流式调用 API → 解析工具调用 → 权限检查 → 执行工具 → 循环直到完成        |
| `CompactService` | 上下文管理：token 估算 + 自动摘要（LLM 生成 `<analysis>/<summary>`），连续失败 3 次自动退回 |
| `CostTracker`    | 费用追踪：记录 input/output/cache token 用量和估算成本                          |
| `ToolRegistry`   | 工具注册中心：按名称查找、批量注册、可过滤                                             |
| `RuntimeBuilder` | 运行时组装：Builder 模式将 API Client、工具、权限、Hook 组装为 `RuntimeBundle`       |
| `Settings`       | 配置管理：默认值 < 配置文件 < 环境变量 < CLI 参数，四层优先级                             |


### API 层


| 模块                       | 说明                                                          |
| ------------------------ | ----------------------------------------------------------- |
| `AnthropicClient`        | Anthropic 原生 SDK 客户端，流式聚合 `input_json_delta`，429/5xx 指数退避重试 |
| `OpenAICompatibleClient` | OpenAI 兼容客户端，支持 reasoning_content（o1/o3 系列），Kimi workaround |
| `Provider Registry`      | 20+ Provider 自动检测：apiKey 前缀 → baseURL 关键字 → model 关键字，三级匹配  |
| `detectProvider()`       | 从 `(model, apiKey, baseURL)` 三元组自动推断 Provider 和 BackendType |


### 工具层（40 Tools）


| 分类           | 工具                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **文件操作**     | `Bash`（命令执行）、`Read`（文件读取）、`Write`（文件写入）、`Edit`（精确字符串替换）、`Glob`（文件模式匹配）、`NotebookEdit`（Jupyter 编辑）             |
| **搜索**       | `Grep`（ripgrep 优先 + JS fallback）、`LspTool`（LSP 集成）                                                            |
| **Web**      | `WebFetch`（URL 抓取 + HTML→Text）、`WebSearch`（DuckDuckGo HTML 搜索）                                                |
| **任务管理**     | `TaskCreate/Get/List/Output/Stop/Update`（6 个任务生命周期工具）                                                         |
| **Agent/团队** | `Agent`（子 Agent 派发）、`SendMessage`（Agent 间通信）、`TeamCreate/Delete`（团队管理）                                        |
| **调度**       | `CronCreate/Delete/List/Toggle/RemoteTrigger`（5 个 Cron 工具）                                                    |
| **MCP**      | `McpToolCall/ListMcpResources/ReadMcpResource/McpAuth`（4 个 MCP 工具）                                            |
| **元工具**      | `TodoWrite、Config、Sleep、Skill、ToolSearch、AskUser、Brief、EnterPlanMode、ExitPlanMode、EnterWorktree、ExitWorktree` |


### 服务层


| 模块               | 说明                                                          |
| ---------------- | ----------------------------------------------------------- |
| `CompactService` | LLM 驱动的对话摘要：当 token 接近阈值时自动触发，结构化 `<analysis>/<summary>` 输出 |
| `SessionStorage` | 会话持久化：JSON 文件存储，支持 `--continue` / `--resume` 恢复             |
| `CronScheduler`  | 定时任务：cron 表达式解析 + `computeNextRunTime` + 执行历史记录             |
| `TaskManager`    | 任务管理：创建/查询/停止/输出，文件持久化                                      |
| `MemoryManager`  | 四层记忆体系的持久层：frontmatter + 加权搜索 + MEMORY.md 索引；配套 `/remember`（LLM 提取持久记忆）、`/dream`（梦境整合）、会话 checkpoint 与环境事实抽取。详见 [docs/memory-system.md](docs/memory-system.md) |
| `LspClient`      | LSP 客户端：与 Language Server Protocol 通信                       |
| `OAuthFlow`      | OAuth 认证：Device Code Flow + token 刷新                        |


### 扩展层


| 模块                   | 说明                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Coordinator`        | 多 Agent 编排：7 个内置 Agent 定义 + system prompt + sequential/parallel/pipeline 模式                                 |
| `McpClientManager`   | MCP 协议客户端：stdio 传输连接外部 MCP Server，动态获取工具和资源                                                                 |
| `ChannelAdapter`     | 通信通道：`StdioAdapter`（标准输入输出）、`HttpAdapter`（HTTP Webhook）、`FeishuAdapter`（飞书机器人）                              |
| `HookExecutor`       | Hook 系统：`pre_tool_use / post_tool_use / session_start / session_end` 四种事件，支持 command/http/prompt/agent 四种类型 |
| `Swarm` | 多 Agent 团队：subprocess 后端把子代理派发为 `ohs --print` 子进程、git worktree 隔离、只读工具自动放行；文件邮箱（原子写+文件锁）、team.json 持久化（随会话退出清理）、权限同步（worker 写操作经 pending/resolved 文件流转 leader checker 自动裁决）。详见 [docs/swarm-file-infra-design.md](docs/swarm-file-infra-design.md) |
| `PluginLoader`       | 插件系统（Claude Code 布局兼容）：双源发现 + 项目插件信任门控；skills/commands/hooks/MCP 四类贡献注册（`/plugin:cmd` 斜杠命令、`${CLAUDE_PLUGIN_ROOT}`、`.mcp.json`）；卸载路径穿越防护。详见 [docs/plugins-contributions-design.md](docs/plugins-contributions-design.md) |
| `SkillRegistry`      | Skill 管理：Markdown + frontmatter 解析（user-invocable/disable-model-invocation/model/argument-hint）；内置 bundled skills（commit/review/test/plan/debug）；三源加载 bundled<user<project；user-invocable skill 可作 `/<skill>` 斜杠命令；model 可见性过滤 |
| `BridgeManager`      | 会话桥接：多进程间共享会话状态                                                                                             |
| `PermissionChecker`  | 权限系统：`default / plan / full_auto` 三种模式 + 工具黑白名单 + 路径规则 + 命令拒绝                                               |


### UI 层


| 模块                  | 说明                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLI`               | Commander.js 命令行：主命令 + auth/mcp/plugin/cron/config 子命令，20+ CLI flags                                                                                                                                               |
| `REPL`              | 交互式循环：`>` 提示符，35 个斜杠命令（`/help, /model, /provider, /clear, /compact, /permissions, /plan, /resume, /memory, /mcp, /skills, /agents, /output-style` 等）；支持输出样式 `default/minimal/codex`（`minimal` 极简纯文本渲染） |
| `TUI Frontend`      | React/Ink 终端 UI：ConversationView + StatusBar + PromptInput + ModalHost（权限/问题/MCP认证）+ CommandPicker + TodoPanel + SwarmPanel。`ohs --tui` spawn 前端，前端再 spawn `--backend-only` 子进程，OHJSON 协议通信，30fps delta 缓冲。流程见 [docs/tui-flow.md](docs/tui-flow.md) |
| `BackendHost`       | 后端协议实现：处理 5 种请求（submit_line / permission_response / question_response / list_sessions / shutdown），发出结构化事件（assistant_delta / tool_started / modal_request / swarm_status 等）。详见 [docs/tui-flow.md](docs/tui-flow.md) |
| `ThemeManager`      | 主题系统：default / dark / minimal / cyberpunk / solarized 5 个内置主题                                                                                                                                                      |
| `VimModeHandler`    | Vim 模态编辑：normal / insert / visual / command 模式切换                                                                                                                                                                   |
| `KeyBindingManager` | 快捷键管理：模式感知的按键绑定解析                                                                                                                                                                                                  |


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
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Runtime Bootstrap (bootstrap())                         │
│                                                          │
│  1. resolveApiClient()                                   │
│     ├─ --provider 强制指定?                               │
│     ├─ detectProvider(model, apiKey, baseURL)            │
│     │   三级检测: apiKey前缀 → baseURL关键字 → model关键字  │
│     ├─ detectProviderFromEnv(env)                        │
│     └─ 创建 AnthropicClient 或 OpenAICompatibleClient    │
│                                                          │
│  2. createDefaultToolRegistry()                          │
│     ├─ 注册 40 个内置工具                                  │
│     ├─ 过滤 --allowed-tools 白名单                        │
│     └─ 过滤 --disallowed-tools 黑名单                     │
│                                                          │
│  3. createPermissionChecker()                            │
│     ├─ --dangerously-skip-permissions → full_auto        │
│     └─ --permission-mode 或 settings 默认值              │
│                                                          │
│  4. new HookExecutor()                                   │
│                                                          │
│  5. buildRuntimeSystemPrompt()                           │
│     ├─ 基础 system prompt（身份 + 行为准则）               │
│     ├─ 环境信息注入（OS、Shell、Git、CWD）                 │
│     └─ 自定义 --system-prompt / --append-system-prompt    │
│                                                          │
│  6. new QueryEngine(client, tools, perm, hooks, opts)    │
│                                                          │
│  7. RuntimeBuilder.assemble() → RuntimeBundle            │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        --backend-only   --print      REPL (默认)
        (启动后端服务)   (单次执行)   (交互式循环)
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
│                 │  │ ├─ MCP: stdio 传输     │   │
│                 │  │ └─ Agent: 子 QueryEngine│   │
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

```
ohs --continue         ohs --resume <id>
       │                      │
       ▼                      ▼
  加载最新 session       加载指定 session
       │                      │
       └──────────┬───────────┘
                  ▼
  SessionStorage.load(id)
  ├─ 读取 ~/.openharness/data/sessions/<id>.json
  ├─ 反序列化为 Message[]
  └─ queryEngine.loadMessages(messages)
                  │
                  ▼
  继续对话（保留历史上下文）
```

---

## 技术栈


| 层      | 技术                                               |
| ------ | ------------------------------------------------ |
| 语言     | TypeScript 5.7+（ESM）                             |
| 构建     | Turborepo（任务编排）+ Bun（CLI 打包，`apps/cli/build.ts`） |
| 测试     | Vitest                                           |
| 包管理    | pnpm 10（monorepo）                                |
| CLI    | Commander.js                                     |
| API    | @anthropic-ai/sdk, openai                        |
| MCP    | @modelcontextprotocol/sdk                        |
| 飞书     | @larksuiteoapi/node-sdk                          |
| TUI    | React + Ink                                      |
| Schema | Zod                                              |
| Cron   | cron-parser                                      |


## 配置

配置文件路径：`~/.openharness/settings.json`（首次运行无需手动创建，使用默认值即可）

```json
{
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

**方式一：CLI（推荐）—— 存进 `~/.openharness/credentials.json`，无需手改文件**

```bash
ohs setup                                   # 交互向导：选 provider → 输 key → 选 model
# 或非交互直接配：
ohs provider add deepseek -k sk-xxxx --use --model deepseek-v4-flash
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


| 变量                       | 说明                           |
| ------------------------ | ---------------------------- |
| `ANTHROPIC_API_KEY`      | Anthropic API Key            |
| `OPENAI_API_KEY`         | OpenAI API Key               |
| `DEEPSEEK_API_KEY`       | DeepSeek API Key             |
| `ZHIPU_API_KEY`          | 智谱 AI（GLM）API Key            |
| `OPENHARNESS_CONFIG_DIR` | 自定义配置目录（默认 `~/.openharness`） |
| `OPENHARNESS_MODEL`      | 默认模型名称                       |
| `OPENHARNESS_BASE_URL`   | 通用 API Base URL 覆盖（**所有 provider**）  |
| `OPENHARNESS_API_FORMAT` | API 格式（anthropic / openai）   |

> ⚠️ `ANTHROPIC_BASE_URL` 仅 Anthropic provider 生效（由 Anthropic SDK 自行读取），**不会**影响 deepseek/openrouter 等其它 provider——要全局覆盖 baseURL 请用 `OPENHARNESS_BASE_URL`。


---

## Provider 配置示例

### DeepSeek

DeepSeek 使用 OpenAI 兼容格式，框架会根据 `provider: deepseek` 或 `deepseek` 模型/域名关键字自动检测。当前模型：`deepseek-v4-flash`、`deepseek-v4-pro`（旧名 `deepseek-chat`/`deepseek-reasoner` 将于 2026-07 弃用）。

**方式一：CLI（推荐）**

```bash
ohs provider add deepseek -k sk-xxxxxxxx --use --model deepseek-v4-flash
```

**方式二：环境变量**

```bash
export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxx"
```

**方式二：settings.json**

```json
{
  "model": "deepseek-chat",
  "apiFormat": "openai",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-xxxxxxxxxxxxxxxx"
}
```

**方式三：CLI 参数**

```bash
ohs --model deepseek-chat \
   --api-format openai \
   --base-url https://api.deepseek.com \
   --api-key sk-xxxxxxxxxxxxxxxx \
   "解释这个项目"
```

**可用模型：** `deepseek-chat`（DeepSeek-V3）、`deepseek-reasoner`（DeepSeek-R1，支持 reasoning_content）

---

### 智谱 AI（GLM / ChatGLM）

智谱 AI 使用 OpenAI 兼容格式，框架会根据 `bigmodel.cn` base URL 或 `glm` 模型关键字自动检测。

**方式一：环境变量（推荐）**

```bash
export ZHIPU_API_KEY="xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx"
```

**方式二：settings.json**

```json
{
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

**可用模型：**


| 模型            | 说明                |
| ------------- | ----------------- |
| `glm-4-plus`  | GLM-4 增强版，综合能力最强  |
| `glm-4`       | GLM-4 标准版         |
| `glm-4-flash` | GLM-4 快速版，低延迟低成本  |
| `glm-4-long`  | GLM-4 长上下文版（128K） |
| `glm-4-air`   | GLM-4 轻量版         |
| `glm-4-airx`  | GLM-4 轻量增强版       |
| `glm-4v`      | GLM-4 视觉版（支持图片输入） |
| `glm-3-turbo` | GLM-3 快速版         |


---

### 自动检测规则

框架支持三级自动检测，无需手动指定 provider：


| 检测级别         | 规则              | 示例                                          |
| ------------ | --------------- | ------------------------------------------- |
| API Key 前缀   | 匹配 `sk-` 后的特征字符 | Anthropic: `sk-ant-`                        |
| Base URL 关键字 | 匹配域名关键词         | DeepSeek: `deepseek.com`，GLM: `bigmodel.cn` |
| 模型名称关键字      | 匹配模型名前缀/关键词     | DeepSeek: `deepseek-`*，GLM: `glm-`*         |


因此在设置好对应环境变量后，通常只需指定 `--model` 即可：

```bash
# DeepSeek — 自动检测（DEEPSEEK_API_KEY 已设置）
ohs --model deepseek-chat "hello"

# GLM — 自动检测（ZHIPU_API_KEY 已设置）
ohs --model glm-4-plus "hello"
```

## License

MIT