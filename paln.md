# OpenHarness TypeScript 实现计划

## 状态标记说明

| 标记 | 含义 |
|---|---|
| ✅ | 已完成（build + tests 通过） |
| 🟡 | 部分完成（build 通过，测试不足） |
| 🔲 | 待实现 / 占位 |

---

## 目录

### 功能模块（packages/*）
| 包 | 功能 | 主要文件 | 状态 |
|---|---|---|---|
| `api` | LLM Provider | `src/providers/*.ts` | ✅ |
| `auth` | API Key 认证管理 | `src/index.ts` | ✅ |
| `bridge` | Session 桥接管理 | `src/index.ts` | ✅ |
| `channels` | EventBus 渠道 | `src/index.ts` | ✅ |
| `commands` | 斜杠命令注册表 | `src/index.ts` | ✅ |
| `keybindings` | 键盘快捷键管理 | `src/index.ts` | ✅ |
| `memory` | 对话记忆管理 | `src/index.ts` | ✅ |
| `output-styles` | 输出样式加载 | `src/loader.ts` | ✅ |
| `permissions` | 权限模式 + 拒绝规则 | `src/index.ts`, `src/rules.ts` | ✅ |
| `plugins` | Plugin 加载/安装 | `src/index.ts` | ✅ |
| `prompts` | Prompt 模板管理 | `src/index.ts` | ✅ |
| `services` | CronScheduler/SessionStorage | `src/cron*.ts`, `src/session*.ts` | 🟡 |
| `skills` | Skill 加载/解析 | `src/index.ts` | ✅ |
| `swarm` | Agent 分布式协作 | `src/index.ts`, `src/registry.ts` | ✅ |
| `themes` | 终端主题加载 | `src/index.ts` | ✅ |
| `utils` | 路径/文件/JSON 工具 | `src/index.ts` | ✅ |
| `vim` | Vim 模式引擎 | `src/index.ts`, `src/modes.ts` | ✅ |

### 核心引擎
| 包 | 功能 | 主要文件 | 状态 |
|---|---|---|---|
| `core` | QueryEngine/Settings/ToolRegistry | `src/engine/*.ts`, `src/config/*.ts` | ✅ |
| `hooks` | Hook 钩子执行器 | `src/index.ts` | ✅ |

### 工具系统
| 包 | 功能 | 主要文件 | 状态 |
|---|---|---|---|
| `tools` | 工具注册表 (15 tools) | `src/registry.ts`, `src/*/*.ts` | ✅ |

> 工具列表 (`src/*/*.ts`):
> - Shell: `Bash`
> - File: `Read`, `Write`, `Edit`, `Glob`
> - Search: `Grep`
> - Web: `WebFetch`, `WebSearch`
> - Meta: `TodoWrite`, `Config`, `Sleep`, `Skill`, `ToolSearch`, `AskUser`, `Brief`

### 集成层
| 包 | 功能 | 主要文件 | 状态 |
|---|---|---|---|
| `mcp` | MCP 客户端 (stdio) | `src/index.ts` | ✅ |
| `coordinator` | Agent 协调器 | `src/index.ts` | 🟡 |
| `sandbox` | 沙箱执行 | `src/index.ts` | 🔲 |
| `voice` | 语音输入输出 | `src/index.ts` | 🔲 |

### 应用层
| 包 | 功能 | 主要文件 | 状态 |
|---|---|---|---|
| `cli` | 主 CLI 入口 | `src/index.ts` | 🟡 |

---

## 当前进度

- **已完成**: 20 packages (build + tests)
- **部分完成**: 3 packages (build passed)
- **待实现**: 2 packages (sandbox, voice)

---

## 原则

1. **每步完成 = tsup build 通过 + vitest 测试通过**
2. **sandbox、voice 标记 `// FUTURE`**，其余全部实现
3. **每步可独立验证**，不依赖后续步骤

---

## Phase 1: 基础模块完善（9 个 COMPLETE 包补测试 + 6 个 PARTIAL 包补逻辑+测试）

### Step 1.0: Vitest 测试基础设施 ✅
- [x] 根目录添加 vitest.config.ts
- [x] 验证 monorepo pnpm test 可用

### Step 1.1: @openharness/utils 测试 ✅ (22 tests)
- [x] 编写测试覆盖所有 8 个工具函数
- [x] pnpm build + pnpm test 通过

### Step 1.2: @openharness/bridge 测试 ✅ (7 tests)
- [x] BridgeManager CRUD 测试
- [x] pnpm build + pnpm test 通过

### Step 1.3: @openharness/commands 测试 ✅ (9 tests)
- [x] CommandRegistry 测试
- [x] pnpm build + pnpm test 通过

### Step 1.4: @openharness/keybindings 测试 ✅ (8 tests)
- [x] KeyBindingManager 测试
- [x] pnpm build + pnpm test 通过

### Step 1.5: @openharness/memory 测试 ✅ (11 tests)
- [x] MemoryManager 测试
- [x] pnpm build + pnpm test 通过

### Step 1.6: @openharness/output-styles 测试 ✅ (6 tests)
- [x] OutputStyleLoader 测试
- [x] pnpm build + pnpm test 通过

### Step 1.7: @openharness/permissions 测试 ✅ (12 tests)
- [x] PermissionChecker 测试
- [x] pnpm build + pnpm test 通过

### Step 1.8: @openharness/prompts 测试 ✅ (5 tests)
- [x] buildSystemPrompt / discoverClaudeMd 测试
- [x] pnpm build + pnpm test 通过

### Step 1.9: @openharness/swarm 测试 ✅ (14 tests)
- [x] TeamRegistry + Mailbox 测试
- [x] pnpm build + pnpm test 通过

### Step 1.10: @openharness/themes 测试 ✅ (10 tests)
- [x] ThemeManager + 5 个主题定义测试
- [x] pnpm build + pnpm test 通过

### Step 1.11: @openharness/vim 测试 ✅ (14 tests)
- [x] VimModeHandler 状态机测试
- [x] pnpm build + pnpm test 通过

### Step 1.12: @openharness/skills 补全+测试 ✅ (19 tests)
- [x] 实现 readFile + discoverMarkdownFiles 真实 FS 操作 + frontmatter 解析
- [x] 测试
- [x] pnpm build + pnpm test 通过

### Step 1.13: @openharness/plugins 补全+测试 ✅ (14 tests)
- [x] 实现 resolveManifest 读取 plugin.json、发现/安装/卸载
- [x] 测试
- [x] pnpm build + pnpm test 通过

### Step 1.14: @openharness/auth 补全+测试 ✅ (11 tests)
- [x] 实现 DeviceCodeFlow 真实 OAuth 流程 + CredentialStorage 持久化
- [x] 测试
- [x] pnpm build + pnpm test 通过

### Step 1.15: @openharness/channels 补全+测试 ✅ (7 tests)
- [x] 完善 EventBus 测试
- [x] pnpm build + pnpm test 通过

### Step 1.16: @openharness/services 补全+测试 ✅ (20 tests)
- [x] CompactService + SessionStorage + CronScheduler + estimateTokens + LspClient + OAuthFlow 测试
- [x] pnpm build + pnpm test 通过

---

**Phase 1 完成统计: 16 个步骤全部完成，189 个测试通过，26/26 build 通过**

---

## Phase 2: 核心引擎 + 工具体系 ✅

| 步骤 | 模块 | 工作 | 状态 |
|---|---|---|---|
| 2.1 | `hooks` | 补全 executeCommand (spawn) + executeHttp (fetch)，register 改 last-writer-wins | ✅ 10 tests |
| 2.2 | `tools` | createDefaultToolRegistry 注册全部 8 个工具 | ✅ 4 tests |
| 2.3 | `api` | 添加 copilot provider，清理 unused imports | ✅ 9 tests |
| 2.4 | `core` QueryEngine | 测试覆盖（text_delta / tool_use / permission deny） | ✅ 4 tests |
| 2.5 | `core` CompactService | autoCompact 分层压缩 + microCompact + estimateTokens | ✅ 5 tests |
| 2.6 | `core` Settings | saveSettings + loadSettings env 过滤 undefined | ✅ 2 tests |
| 2.7 | `core` ToolRegistry | register/get/getAll/has 测试 | ✅ 2 tests |

**修复记录**:
- `core/tsup.config.ts`: `bundle: false` → `bundle: true`（解决 dist 子模块缺失问题）
- `core/config/settings.ts`: `loadFromEnv()` 过滤 undefined 值（解决 env 覆盖默认值）
- `vitest.config.ts`: 添加 `@openharness/*` → source 的 resolve alias

**Phase 2 完成统计: 20 个测试套件，217 个测试通过，26/26 build 通过**

---

## Phase 3: API + MCP + 工具补全 ✅

| 步骤 | 模块 | 工作 | 状态 |
|---|---|---|---|
| 3.1 | `api` registry | 重写为 Python ProviderSpec 模式，21 个 providers，三级检测（key→url→model） | ✅ 29 tests |
| 3.2 | `api` openai | 增强消息转换（toolUses）、流式 tool_calls 聚合、usage 事件、finish_reason 映射 | ✅ |
| 3.3 | `api` copilot | 实现 CopilotClient：包装 OpenAICompatibleClient + Copilot headers/baseURL + auth 加载 | ✅ |
| 3.4 | `mcp` | 实现真实 stdio 传输（@modelcontextprotocol/sdk），工具发现/调用/资源读取 | ✅ 12 tests |
| 3.5 | `tools` 辅助 | 补全 todo_write, config, sleep, skill, tool_search, ask_user, brief 工具 | ✅ 12 tests |

**Phase 3 完成统计: 5/5 核心步骤完成，build 26/26 通过**

---

## Phase 4: 编排 + 高级工具（待实施）

依赖 coordinator/swarm/tasks 基础设施，需先完成 Phase 5-6 的基础设施层。

| 步骤 | 模块 | 工具 | 说明 |
|---|---|---|---|
| 4.1 | `tools` task | task_create/get/list/output/stop | 依赖 TaskManager |
| 4.2 | `tools` plan_mode | enter/exit_plan_mode | 切换 permission mode |
| 4.3 | `tools` worktree | enter/exit_worktree | git worktree 管理 |
| 4.4 | `tools` notebook | notebook_edit | Jupyter cell 编辑 |
| 4.5 | `tools` agent | agent, send_message | 依赖 coordinator/swarm |
| 4.6 | `tools` team | team_create, team_delete | 依赖 TeamRegistry |
| 4.7 | `tools` cron | cron_create/delete/list/toggle, remote_trigger | 依赖 CronScheduler |
| 4.8 | `tools` MCP | mcp_tool, mcp_auth, list_mcp_resources, read_mcp_resource | 依赖 McpClientManager |
| 4.9 | `tools` lsp | lsp | 依赖 LspClient 服务 |
| 4.10 | `tools` update | task_update_tool | 任务属性更新 |

---

## Phase 5: 基础设施层（待实施）

需要先于 Phase 4 的依赖模块。

| 步骤 | 模块 | 说明 |
|---|---|---|
| 5.1 | `coordinator` | Agent 定义 + 系统提示词 + TeamRegistry |
| 5.2 | `swarm` 真实实现 | SubprocessBackend + Mailbox + spawn |
| 5.3 | `services` TaskManager | 后台任务管理器 |
| 5.4 | `services` CronScheduler | 定时任务调度 |
| 5.5 | `services` LspClient | 代码智能服务 |
| 5.6 | `hooks` loader + hot_reload | Hook 加载器 |

---

## Phase 6: CLI + 集成（待实施）

| 步骤 | 模块 | 说明 |
|---|---|---|
| 6.1 | `cli` | Typer/Commander CLI 命令注册（20+ 子命令） |
| 6.2 | `bridge` | Session 真实实现 |
| 6.3 | `channels` | 10 个渠道实现 |
| 6.4 | `memory` | 持久化记忆管理 |
| 6.5 | `auth` | DeviceCodeFlow 真实 OAuth |
| 6.6 | 集成测试 | 端到端 Agent Loop |
