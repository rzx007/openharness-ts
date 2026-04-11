# OpenHarness TypeScript 实现计划

## 状态标记说明

| 标记 | 含义 |
|---|---|
| ✅ | 已完成（对标 Python，功能完整） |
| 🟡 | 部分完成（对标 Python，功能部分实现） |
| 🔲 | 待实现 / 占位（Python 有，TS 无） |

---

## 模块对照表

### Python → TypeScript 对应

| Python 模块 | TS 包 | 功能 | 状态 | 说明 |
|---|---|---|---|---|
| `openharness.api` | `@openharness/api` | LLM Provider (21 providers) | ✅ | 21 providers |
| `openharness.auth` | `@openharness/auth` | API Key | ✅ | |
| `openharness.bridge` | `@openharness/bridge` | Session | ✅ | |
| `openharness.channels` | `@openharness/channels` | EventBus | ✅ | |
| `openharness.commands` | `@openharness/commands` | 斜杠命令 | ✅ | |
| `openharness.keybindings` | `@openharness/keybindings` | 快捷键 | ✅ | |
| `openharness.memory` | `@openharness/memory` | 记忆 | ✅ | |
| `openharness.output_styles` | `@openharness/output-styles` | 样式 | ✅ | |
| `openharness.permissions` | `@openharness/permissions` | 权限 | ✅ | |
| `openharness.plugins` | `@openharness/plugins` | Plugin | ✅ | |
| `openharness.prompts` | `@openharness/prompts` | Prompt | ✅ | |
| `openharness.config` | `@openharness/core` | Settings | ✅ | |
| `openharness.engine` | `@openharness/core` | QueryEngine | ✅ | |
| `openharness.hooks` | `@openharness/hooks` | Hooks | ✅ | |
| `openharness.mcp` | `@openharness/mcp` | MCP | ✅ | |
| `openharness.skills` | `@openharness/skills` | Skills | ✅ | |
| `openharness.swarm` | `@openharness/swarm` | Swarm | ✅ | |
| `openharness.themes` | `@openharness/themes` | 主题 | ✅ | |
| `openharness.tools` | `@openharness/tools` | 工具 | ✅ | 15 工具 |
| `openharness.types` | `@openharness/core` | 类型 | ✅ | |
| `openharness.utils` | `@openharness/utils` | 工具函数 | ✅ | |
| `openharness.vim` | `@openharness/vim` | Vim | ✅ | |
| `openharness.platforms` | `@openharness/utils` | 平台检测 | ✅ | detectPlatform |
| `openharness.coordinator` | `@openharness/coordinator` | 协调器 | ✅ | AgentDefinition + TeamRegistry |
| `openharness.services` | `@openharness/services` | 服务 | ✅ | TaskManager + Cron + LSP + Compact |
| `openharness.tasks` | `@openharness/services` | TaskManager | ✅ | createShellTask/createAgentTask |
| `openharness.sandbox` | `@openharness/sandbox` | 沙箱 | 🔲 | FUTURE 占位 |
| `openharness.voice` | `@openharness/voice` | 语音 | 🔲 | FUTURE 占位 |
| `openharness.state` | `@openharness/core` | 状态 | ✅ | AppStateStore |
| `openharness.ui` | - | TUI | 🔲 | React/Ink 待实现 |
| `openharness.cli` | `@openharness/cli` | CLI | ✅ | REPL + print + backend |

### Python services 子模块

| Python | TS | 状态 |
|---|---|---|
| `cron.py` | `services/cron*.ts` | 🟡 stub |
| `cron_scheduler.py` | `services/cron*.ts` | 🟡 stub |
| `session_storage.py` | `services/session*.ts` | 🟡 stub |
| `token_estimation.py` | `services/tokens.ts` | 🟡 stub |

### Python coordinator 子模块

| Python | TS | 状态 |
|---|---|---|
| `agent_definitions.py` | - | 🟡 stub |
| `coordinator_mode.py` | - | 🟡 stub |

---

## 当前进度

- **已完成**: 20+ packages (对标 Python，功能完整)
- **部分完成**: 3 packages (coordinator, services, cli)
- **未实现**: 4 模块
- **核心测试**: 80+ tests 通过

### 核心包测试数
| 包 | 测试数 |
|---|---|
| `@openharness/api` | 29 |
| `@openharness/core` | 13 |
| `@openharness/mcp` | 12 |
| `@openharness/tools` | 16 |
| `@openharness/hooks` | 10 |

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

## Phase 4: 编排 + 高级工具 ✅

| 步骤 | 模块 | 工具 | 状态 |
|---|---|---|---|
| 4.1 | `tools` task | TaskCreate/Get/List/Output/Stop | ✅ |
| 4.2 | `tools` plan_mode | EnterPlanMode/ExitPlanMode | ✅ |
| 4.3 | `tools` worktree | EnterWorktree/ExitWorktree | ✅ |
| 4.4 | `tools` notebook | NotebookEdit | ✅ |
| 4.5 | `tools` agent | Agent/SendMessage | ✅ |
| 4.6 | `tools` team | TeamCreate/TeamDelete | ✅ |
| 4.7 | `tools` cron | CronCreate/Delete/List/Toggle | ✅ |
| 4.8 | `tools` MCP | McpToolCall/ListMcpResources/ReadMcpResource | ✅ |
| 4.9 | `tools` lsp | Lsp | ✅ |

**Phase 4 完成: 37 个工具注册，build 26/26 通过**

---

## Phase 5: 基础设施层 ✅

| 步骤 | 模块 | 说明 | 状态 |
|---|---|---|---|
| 5.1 | `coordinator` | AgentDefinition 完整模型 + 4 个内置定义 + TeamRegistry + getAgentDefinition | ✅ 13 tests |
| 5.2 | `swarm` | BackendRegistry + TeammateSpawnConfig/Message/Result 类型 + SpawnResult | ✅ 20 tests |
| 5.3 | `services` TaskManager | 后台任务管理器（createShellTask/createAgentTask/list/stop/output） | ✅ 28 tests |
| 5.4 | `services` CronScheduler | 增强 cron 表达式解析 + validateCronExpression + removeJob/listJobs | ✅ |
| 5.5 | `services` LspClient | 增加 documentSymbols/workspaceSymbolSearch/findReferences/goToDefinition | ✅ |
| 5.6 | `hooks` loader | HookLoader（loadFromConfig/loadFromDirectory + watch 热重载） | ✅ |

**Phase 5 完成统计: 6/6 步骤完成，build 26/26 通过，22 个包测试全部通过**

---

## Phase 6: CLI + 集成 ✅

| 步骤 | 模块 | 说明 | 状态 |
|---|---|---|---|
| 6.1 | `cli` | Commander.js 20+ 子命令：auth(login/status/logout/copilot-login/copilot-logout), mcp(list/add/remove), plugin(list/install/uninstall), cron(start/stop/status/list/toggle/history/logs), config, version, doctor | ✅ |
| 6.2 | `bridge` | BridgeManager 增加持久化（loadFromFile/saveToFile/loadPersistedSessions/deleteSession） | ✅ |
| 6.3 | `channels` | 新增 StdioAdapter + HttpAdapter，channels tsup 改 bundle:true | ✅ |
| 6.4 | `memory` | MemoryManager 增加文件持久化（saveToFile/loadFromFile） | ✅ |
| 6.5 | `auth` | DeviceCodeFlow 真实实现（device code + polling + token exchange + refresh），测试 mock fetch | ✅ 10 tests |
| 6.6 | 集成测试 | core 集成测试 11 cases + CLI renderer 测试 10 cases | ✅ |

**Phase 6 完成统计: 6/6 步骤完成，build 26/26 通过，22 包 + CLI 测试全部通过**

---

## Phase 7: CLI 集成 + Agent Loop ✅

| 步骤 | 模块 | 说明 | 状态 |
|---|---|---|---|
| 7.1 | `cli` runtime | Runtime bootstrap（provider 检测 → API client → tools → permissions → hooks → QueryEngine） | ✅ |
| 7.2 | `cli` renderer | EventRenderer — StreamEvent → 终端输出（text/tool/usage/error） | ✅ 10 tests |
| 7.3 | `cli` main | Print Mode + REPL (readline) + Backend Host (ProtocolHost) | ✅ |
| 7.4 | `core` integration | Agent Loop 集成测试（11 cases: 单轮/多轮/并行工具/权限拒绝/未知工具/错误捕获/链式调用/maxTurns/历史记录） | ✅ 11 tests |
| 7.5 | sandbox/voice | 占位测试 | ✅ 3+5 tests |

**Phase 7 完成统计: build 26/26 通过，51/51 tasks 通过**
