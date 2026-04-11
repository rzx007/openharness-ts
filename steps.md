审计非常详细了。基于完整的对比结果，我来更新实现计划，确保 **最终目标是对标 Python 版本的完整功能**（sandbox、voice 除外）。

---

# 更新后的分阶段实现计划（对标 Python 版本）

## 原则

1. **每步完成 = tsup build 通过 + vitest 测试通过**
2. **sandbox、voice 标记 `// FUTURE`**，其余全部实现
3. **每步可独立验证**，不依赖后续步骤

---

## Phase 1: 基础模块完善（9 个 COMPLETE 包补测试 + 6 个 PARTIAL 包补逻辑+测试）

> 这些模块不依赖核心引擎，可独立验证。

| 步骤 | 模块 | 工作 |
|---|---|---|
| 1.1 | `utils` | 补测试 |
| 1.2 | `themes` | 补测试 |
| 1.3 | `vim` | 补测试 |
| 1.4 | `memory` | 补测试；Python 对标：后续 Phase 需增加文件持久化和 CJK 搜索 |
| 1.5 | `permissions` | 补测试 |
| 1.6 | `commands` | 补测试 |
| 1.7 | `keybindings` | 补测试 |
| 1.8 | `bridge` | 补测试 |
| 1.9 | `swarm` | 补测试 |
| 1.10 | `output-styles` | 补测试 |
| 1.11 | `prompts` | 补测试 |
| 1.12 | `skills` | **实现** readFile + discoverMarkdownFiles 真实 FS 操作 |
| 1.13 | `plugins` | **实现** resolveManifest 读取 plugin.json、发现/安装/卸载 |
| 1.14 | `auth` | **实现** DeviceCodeFlow 真实 OAuth 流程 + CredentialStorage 持久化 |
| 1.15 | `channels` | **完善** EventBus → MessageBus（异步队列+路由） |
| 1.16 | `services` | **实现** CronScheduler 用 cron-parser + SessionStorage 文件持久化 + OAuth token exchange |

---

## Phase 2: 核心引擎 + 工具体系

> 目标：Agent Loop 跑通——prompt → LLM → tool_call → result → complete

| 步骤 | 模块 | 工作 |
|---|---|---|
| 2.1 | `hooks` | **实现** executeCommand（spawn 子进程 + env 注入）+ executeHttp（fetch）+ prompt hook（LLM 验证）+ agent hook + matcher + 测试 |
| 2.2 | `tools` | **实现** createDefaultToolRegistry 注册所有已实现工具 + **新增** 13 个缺失工具：ask_user_question, skill, config, brief, sleep, todo_write, tool_search, enter/exit_plan_mode, remote_trigger, web_search + 测试 |
| 2.3 | `api` | **修复** registry.ts require → dynamic import + **新增** 更多 Provider（DashScope, Bedrock 等）+ 测试（mock stream） |
| 2.4 | `core` QueryEngine | **完善** auto-compact 集成 + 并行工具执行 + input validation + is_read_only 权限检查 + maxTurns 异常 + 测试 |
| 2.5 | `core` CompactService | **实现** 双层压缩：microcompact（清除旧工具结果）+ LLM summarization + 测试 |
| 2.6 | `core` Settings | **扩展** Settings 类型对标 Python 20+ 字段 + save_settings 持久化 + 测试 |
| 2.7 | **集成测试** | Mock API client 端到端跑通 Agent Loop |

---

## Phase 3: MCP 集成

| 步骤 | 模块 | 工作 |
|---|---|---|
| 3.1 | `mcp` | **实现** stdio 传输层 + discoverTools + callTool + 连接生命周期 + 测试 |
| 3.2 | `tools/mcp` | **新增** mcp_tool adapter（动态包装 MCP server tools → ToolRegistry）+ list_mcp_resources + read_mcp_resource + mcp_auth + 测试 |

---

## Phase 4: Slash 命令系统

> Python 版有 57 个命令。TS 版当前 0 个 handler。

| 步骤 | 模块 | 工作 |
|---|---|---|
| 4.1 | `commands` | **实现** 第一批命令（help, exit, clear, version, status, usage, cost, model, config, login, logout, theme）+ 测试 |
| 4.2 | `commands` | **实现** 第二批命令（compact, summary, memory, resume, export, share, copy, rewind, files, init, doctor）+ 测试 |
| 4.3 | `commands` | **实现** 第三批命令（skills, plugins, mcp, hooks, permissions, plan, fast, effort, passes, turns, continue, tasks, agents）+ 测试 |

---

## Phase 5: 多 Agent 系统（Swarm）

| 步骤 | 模块 | 工作 |
|---|---|---|
| 5.1 | `swarm` | **实现** in-process backend（同进程派生 Agent）+ 测试 |
| 5.2 | `swarm` | **实现** subprocess backend（`oh agent` 子进程 IPC）+ 测试 |
| 5.3 | `swarm` | **实现** worktree（git worktree 创建/清理）+ permission_sync + lockfile + 测试 |
| 5.4 | `tools` | **新增** agent_tool, send_message_tool, team_create_tool, team_delete_tool + 测试 |
| 5.5 | `coordinator` | **实现** 多 Agent 协调逻辑（sequential/parallel/pipeline）+ 测试 |

---

## Phase 6: 后台服务完善

| 步骤 | 模块 | 工作 |
|---|---|---|
| 6.1 | `services/cron` | **实现** Cron daemon（后台进程、PID 管理、croniter 解析、执行历史）+ 测试 |
| 6.2 | `services/session` | **实现** 文件持久化（JSON 快照、latest.json、tagged snapshots、markdown 导出、restore）+ 测试 |
| 6.3 | `services/lsp` | **实现** LSP 客户端协议（连接、初始化、diagnostics/references/definitions）+ 测试 |
| 6.4 | `services/compact` | **完善** LLM summarization prompt（`<analysis>`/`<summary>` 结构化提示）+ 测试 |
| 6.5 | `tools` | **新增** cron_create/delete/list/toggle + task_create/get/list/stop/output/update + lsp_tool + notebook_edit + 测试 |

---

## Phase 7: Memory 深度实现

| 步骤 | 模块 | 工作 |
|---|---|---|
| 7.1 | `memory` | **实现** 文件持久化（.openharness/memory/、MEMORY.md 入口、slug 文件名）+ 测试 |
| 7.2 | `memory` | **实现** 分词搜索（ASCII 3+ 字符 + 汉字 U+4E00-U+9FFF）+ metadata 加权评分 + 测试 |
| 7.3 | `memory` | **实现** scan_memory_files（YAML frontmatter 解析）+ 测试 |

---

## Phase 8: Auth 深度实现

| 步骤 | 模块 | 工作 |
|---|---|---|
| 8.1 | `auth` | **实现** AuthManager 自动检测 6 个 Provider + provider 切换 + status 追踪 + 测试 |
| 8.2 | `auth` | **实现** BrowserFlow（打开浏览器 + 粘贴 token）+ 测试 |
| 8.3 | `auth` | **实现** CredentialStorage（文件持久化 per provider）+ 测试 |

---

## Phase 9: Bridge & Channels

| 步骤 | 模块 | 工作 |
|---|---|---|
| 9.1 | `bridge` | **实现** BridgeManager（subprocess spawn、output capture、stop）+ WorkSecret + 测试 |
| 9.2 | `channels` | **实现** ChannelManager（配置驱动初始化）+ MessageBus（异步队列路由）+ 测试 |
| 9.3 | `channels/impl` | **实现** Slack adapter（webhook/bot）+ 测试 |
| 9.4 | `channels/impl` | **实现** Telegram + Discord + 其他 adapter（按需）+ 测试 |

---

## Phase 10: UI & Frontend

| 步骤 | 模块 | 工作 |
|---|---|---|
| 10.1 | `core/protocol` | **实现** 完整 BackendEvent（16 种事件类型）+ FrontendRequest（5 种请求类型）+ 测试 |
| 10.2 | `core/backend-host` | **实现** ReactBackendHost（stdin/stdout JSON-lines、权限弹窗、问题弹窗、session 列表、busy lock、swarm status）+ 测试 |
| 10.3 | `frontend` | **实现** useBackendSession（spawn 后端进程 + JSON-lines 通信）+ 测试 |
| 10.4 | `frontend` | **完善** 组件（ConversationView、CommandPicker、PermissionDialog、ModalHost、SelectModal、SwarmPanel、TodoPanel、ToolCallDisplay、WelcomeBanner）+ 测试 |
| 10.5 | `cli` | **实现** mainAction（print mode + interactive REPL + backend-only mode）+ 所有子命令 + 测试 |

---

## Phase 11: Prompts 完善

| 步骤 | 模块 | 工作 |
|---|---|---|
| 11.1 | `prompts` | **实现** 55 行基础系统提示词 + 运行时组装（base + env + CLAUDE.md + memory + issue context）+ 测试 |
| 11.2 | `prompts` | **完善** CLAUDE.md 发现（向上遍历父目录 + `.claude/` + `.claude/rules/*.md`）+ 测试 |
| 11.3 | `prompts` | **实现** EnvironmentInfo 自动检测（OS、arch、shell、git branch、hostname）+ 测试 |

---

## Phase 12: 最终集成 + 清理

| 步骤 | 工作 |
|---|---|
| 12.1 | 端到端测试：CLI 启动 → prompt → Agent Loop → tool 调用 → 结果返回 |
| 12.2 | 端到端测试：TUI 启动 → 后端通信 → 权限弹窗 → 命令执行 |
| 12.3 | sandbox/voice 标记 `// FUTURE` + 文档说明 |
| 12.4 | CI 配置：build + test + lint 自动化 |

---

## 统计

| 阶段 | 步骤数 | 核心工作 |
|---|---|---|
| Phase 1 | 16 | 基础模块补齐 |
| Phase 2 | 7 | 核心引擎串联 |
| Phase 3 | 2 | MCP 集成 |
| Phase 4 | 3 | 57 个命令 |
| Phase 5 | 5 | 多 Agent |
| Phase 6 | 5 | 后台服务 |
| Phase 7 | 3 | Memory 深度 |
| Phase 8 | 3 | Auth 深度 |
| Phase 9 | 4 | Bridge & Channels |
| Phase 10 | 5 | UI & Frontend |
| Phase 11 | 3 | Prompts 完善 |
| Phase 12 | 4 | 最终集成 |
| **总计** | **60 步** | |

这个计划确保了 **除 sandbox 和 voice 外，所有 Python 版功能都有对应实现**。每步都有明确的交付物和测试验证。
