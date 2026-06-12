# 参考：斜杠命令与内置工具

> 本文是统一清单（随特性合并更新）。运行时权威来源：REPL 内 `/help`
> 列全部命令（CommandRegistry 自动生成）；工具以 `ToolRegistry.getAll()` 为准。
> 各命令的设计取舍见对应 `docs/*-design.md`。

## 斜杠命令（41 个内置）

注册处：`apps/cli/src/commands/slash-commands.ts`。除内置外，user-invocable
skill 动态注册为 `/<skill>`（E.5），插件命令注册为 `/插件名:命令`（C.1）。
内置命令优先于同名 skill。

### 会话

| 命令 | 用法 / 说明 |
|---|---|
| `/clear` | 清空对话历史 |
| `/new` | 开新对话（清空历史并回到首页，对齐 opencode） |
| `/compact` | 摘要压缩上下文 |
| `/resume` | `latest \| <session-id>` 恢复历史会话（新存储优先，显式 id 回退 legacy） |
| `/rewind` | 撤销最近 N 轮（默认 1） |
| `/session` | 当前会话信息 |
| `/export` | 导出对话为 Markdown 文件 |
| `/context` | 显示当前发送给模型的 system prompt |
| `/stats` | 会话统计：messages/estimated_tokens/tools/memory/tasks/output_style（差异：memory 报会话内条目数，Python 报文件数） |
| `/cost` | 估算成本拆解 |
| `/usage` | token 用量统计 |
| `/turns` | 设置最大 agentic 轮数（1-512） |

### 模型与 Provider

| 命令 | 用法 / 说明 |
|---|---|
| `/model` | 查看/切换模型 |
| `/provider` | 查看/切换 API provider（`auto` 自动探测） |
| `/effort` | 推理力度 `low \| medium \| high` |
| `/fast` | fast 模式 `on \| off \| toggle` |
| `/auth` | 凭证管理 `login \| logout \| status` |

### 记忆

| 命令 | 用法 / 说明 |
|---|---|
| `/memory` | 项目记忆 `list \| show ID \| add CONTENT \| remove ID` |
| `/remember` | 立刻从本会话提取持久记忆（LLM 提议 + 签名去重） |
| `/dream` | 记忆梦境整合：后台子进程重组 memory 目录（`--preview` 只提方案；锁/备份/回滚见 [memory-system.md](memory-system.md)） |

### 插件与扩展

| 命令 | 用法 / 说明 |
|---|---|
| `/plugin` | `list \| enable NAME \| disable NAME`，启停持久化 settings.plugins（install/uninstall 不做——无插件市场） |
| `/reload-plugins` | 重新发现并注册插件贡献（先清后注册，disable 立即生效） |
| `/skills` | `list \| SKILL_NAME` 列出/查看 skill |
| `/mcp` | MCP 服务器连接状态 |
| `/hooks` | 已配置 hooks |

### Agent / Swarm

| 命令 | 用法 / 说明 |
|---|---|
| `/agents` | agent/teammate 任务视图（对齐 Python `/subagents` 的任务语义） |
| `/subagents` | 三源（builtin/user/plugin）agent 人格定义列表（差异：Python 此名为任务视图，TS 由 `/agents` 覆盖） |
| `/tasks` | 后台任务 `list \| show ID \| stop ID \| run CMD` |

### 配置与外观

| 命令 | 用法 / 说明 |
|---|---|
| `/config` | `show \| set KEY VALUE` |
| `/permissions` | 权限模式 `default \| plan \| full_auto` |
| `/plan` | plan 模式 `on \| off` |
| `/output-style` | 输出样式 `show \| list \| NAME`（default/minimal/codex + 用户自定义，REPL/TUI 热切换） |
| `/theme` | 主题 `show \| list \| set NAME` |

### 工程

| 命令 | 用法 / 说明 |
|---|---|
| `/init` | 初始化 OpenHarness 项目文件 |
| `/commit` | git status 或 stage-all + 提交（带 MSG） |
| `/diff` | git diff（`--stat` 或完整） |
| `/branch` | `show \| list` 分支 |

### 其他

| 命令 | 用法 / 说明 |
|---|---|
| `/help` | 列出全部可用命令 |
| `/status` | 会话状态总览 |
| `/doctor` | 环境诊断 |
| `/version` | 版本信息 |
| `/exit` | 退出 REPL |

### 留待（按需，Python 有 TS 未做）

`/keybindings` `/vim` `/passes` `/release-notes` `/login` `/logout` 等低频项，
见 PLAN-REMAINING E.2。

## 内置工具（41 个）

注册处：`packages/tools/src/`（按目录分组），运行时 MCP 服务器工具另行注入
（`mcp__server__tool` 命名）。

### 文件（file/）

| 工具 | 说明 |
|---|---|
| `Read` | 读文件（行号格式，支持 offset/limit） |
| `Write` | 写/覆盖文件 |
| `Edit` | 精确字符串替换（TUI 下 unified diff 预览 + 权限确认） |
| `Glob` | 文件名模式匹配 |

### 搜索（search/）

| 工具 | 说明 |
|---|---|
| `Grep` | 内容正则搜索（ripgrep 语义） |
| `Lsp` | 符号查询（当前为正则近似实现，真 AST 留待） |

### Shell（shell/）

| 工具 | 说明 |
|---|---|
| `Bash` | 执行 shell 命令（权限门控、超时、后台模式） |

### Agent / Swarm（agent/）

| 工具 | 说明 |
|---|---|
| `Agent` | 派发子代理执行任务 |
| `TeamCreate` / `TeamDelete` | 创建/解散 swarm 团队（`~/.openharness/teams/<team>/`，team.json 生命周期） |
| `SendMessage` | 给 teammate 发消息（文件邮箱 + TaskManager 懒重启，见 [swarm-task-worker-design.md](swarm-task-worker-design.md)） |

### 后台任务（task/）

| 工具 | 说明 |
|---|---|
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | 任务 CRUD |
| `TaskOutput` / `TaskStop` | 读输出 / 停止 |
| `TaskWait` | 等待任务完成（swarm teammate 协作的等待原语） |

### 计划与工作区（mode/）

| 工具 | 说明 |
|---|---|
| `EnterPlanMode` / `ExitPlanMode` | 进出 plan 模式 |
| `EnterWorktree` / `ExitWorktree` | 进出隔离 git worktree |

### MCP（mcp/）

| 工具 | 说明 |
|---|---|
| `McpToolCall` | 调用 MCP 服务器工具 |
| `McpAuth` | MCP OAuth 认证 |
| `ListMcpResources` / `ReadMcpResource` | MCP 资源列举/读取 |

### 定时（schedule/）

| 工具 | 说明 |
|---|---|
| `CronCreate` / `CronList` / `CronToggle` / `CronDelete` | cron 定时任务管理 |
| `RemoteTrigger` | 远程触发 |

### Web（web/）

| 工具 | 说明 |
|---|---|
| `WebFetch` | 抓取 URL 内容 |
| `WebSearch` | 网络搜索 |

### 笔记本（notebook/）

| 工具 | 说明 |
|---|---|
| `NotebookEdit` | 编辑 Jupyter notebook 单元 |

### 元工具（meta/）

| 工具 | 说明 |
|---|---|
| `TodoWrite` | 任务清单跟踪 |
| `Skill` | 调用 skill |
| `ToolSearch` | 搜索/加载延迟工具 |
| `AskUser` | 向用户提问 |
| `Config` | 读写配置 |
| `Brief` | 会话简报 |
| `Sleep` | 等待 |
