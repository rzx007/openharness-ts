# OpenHarness TypeScript — 补全计划

基于全面审计（对比 Python 源码），Phase 1-7 已完成基础迁移，以下是剩余差距的补全计划。

## 原则

1. **每步完成 = `pnpm build` 通过 + `pnpm test` 通过**
2. 按 **影响面从广到窄** 排序：先修引擎核心，再修工具，最后修 CLI 细节
3. 每步可独立验证，不依赖后续步骤
4. 标记 `// FUTURE` 的：sandbox、voice、React/Ink TUI、Channel 集成（Telegram/Discord 等）

---

## Phase 8: 引擎核心修复（关键）

### 8.1 API 客户端 retry + 错误翻译

**问题**: 三个 API 客户端（Anthropic/OpenAI/Copilot）零重试，429/500 瞬间报错；`retryWithBackoff` 已 import 但未使用。

**工作**:
- Anthropic 客户端：包裹 `streamMessage` 逻辑，用 `retryWithBackoff`（429/500/502/503/529 重试，指数退避）
- OpenAI 客户端：同上（429/500/502/503），移除死代码常量，实际调用 `retryWithBackoff`
- Copilot 客户端：同上
- 错误翻译：catch SDK 错误，包装为 `AuthenticationFailure` / `RateLimitFailure` / `RequestFailure`
- 增强 `retryWithBackoff`：支持 Retry-After header、区分 retryable vs non-retryable

**文件**: `packages/api/src/providers/anthropic.ts`, `openai.ts`, `copilot.ts`, `packages/core/src/utils/retry.ts`

### 8.2 Anthropic 流式 tool_use 输入聚合

**问题**: Anthropic 客户端只读 `content_block_start` 的 input（始终 `{}`），未处理 `input_json_delta` 事件，导致工具调用参数永远为空。

**工作**:
- 在流式循环中跟踪当前 tool_use block，累加 `input_json_delta` 的 `partial_json`
- 在 `content_block_stop` 时解析完整 JSON 为 tool input
- `tool_use_start` 事件延后到参数完整后再 yield（或在 end 时 yield 完整 input）

**文件**: `packages/api/src/providers/anthropic.ts`

### 8.3 Hooks 阻塞能力

**问题**: TS hooks 返回 `void`（fire-and-forget），无法阻止工具执行。Python hooks 返回 `AggregatedHookResult.blocked`。

**工作**:
- `IHookExecutor.execute()` 返回类型改为 `Promise<HookResult>`
- `HookResult` 增加 `blocked: boolean` + `reason?: string`
- `HookExecutor` 的 `executeSingle()` 返回执行结果，command/http hook 解析输出决定是否 block
- `QueryEngine.executeTools()` 检查 `blocked`，若为 true 则跳过工具执行
- 更新所有 mock 和测试

**文件**: `packages/core/src/types/hooks.ts`, `packages/hooks/src/index.ts`, `packages/core/src/engine/query-engine.ts`

### 8.4 工具并行执行

**问题**: TS 用 `for...of` 串行执行工具；Python 用 `asyncio.gather` 并行。

**工作**:
- `executeTools()` 改为 `Promise.all()` 并行执行所有 tool_use
- 保持权限检查和 hook 的顺序（先全部 check，再并行 exec）

**文件**: `packages/core/src/engine/query-engine.ts`

### 8.5 Permission "ask" 交互确认

**问题**: `action: "ask"` 无 UI 升级路径，等同 deny。

**工作**:
- `QueryEngine` 构造函数增加可选 `permissionPrompt` 回调：`(tool, reason) => Promise<boolean>`
- 当 `decision.action === "ask"` 时，调用 `permissionPrompt`，用户确认则 allow，否则 deny
- CLI REPL 中实现 readline 确认提示
- Print mode / backend host 中默认 deny

**文件**: `packages/core/src/engine/query-engine.ts`, `packages/core/src/types/runtime.ts`, `apps/cli/src/commands/main.ts`

### 8.6 QueryEngine 运行时方法补全

**问题**: 缺 `clear()`, `setSystemPrompt()`, `setModel()`, `setMaxTurns()`, `loadMessages()`, `continuePending()`, `hasPendingContinuation()`。

**工作**:
- 添加所有方法到 `QueryEngine` 类
- 更新 `IQueryEngine` 接口
- `continuePending()` 恢复上次中断的工具执行循环
- MaxTurns 超限时抛 `MaxTurnsExceeded` 异常（而非静默退出）

**文件**: `packages/core/src/engine/query-engine.ts`, `packages/core/src/types/runtime.ts`

### 8.7 CostTracker 实现

**问题**: 只有 `ICostTracker` 接口，无具体实现，未接入 QueryEngine。

**工作**:
- 实现 `CostTracker` 类：`add(snapshot)`, `total`, `reset()`
- `QueryEngine` 持有 `CostTracker` 实例，每轮累加 usage
- `totalUsage` 公开属性

**文件**: `packages/core/src/types/usage.ts`, 新建 `packages/core/src/engine/cost-tracker.ts`, `packages/core/src/engine/query-engine.ts`

---

## Phase 9: Settings + Prompts 补全

### 9.1 Settings 字段补全

**问题**: 缺 `base_url`, `max_tokens`, `effort`, `passes`, `fast_mode`, `vim_mode`, `verbose` 等字段。Permissions 简化为单一 mode。

**工作**:
- 扩展 `Settings` 接口：添加 `baseUrl?`, `maxTokens?`, `effort?`, `passes?`, `fastMode?`, `vimMode?`, `verbose?`, `systemPrompt?`
- 扩展 permissions：`allowedTools?: string[]`, `deniedTools?: string[]`, `pathRules?: PathRule[]`, `deniedCommands?: string[]`
- 更新 `loadSettings()` 环境变量读取
- 更新 CLI overrides 传递
- 所有新字段有默认值

**文件**: `packages/core/src/types/settings.ts`, `packages/core/src/config/settings.ts`

### 9.2 Prompts 增强

**问题**: 无环境自动检测、无 CLAUDE.md 目录树遍历、无 skills/issues/memory 集成。

**工作**:
- 环境自动检测：OS、arch、shell、git branch、hostname（自动填充 PromptContext）
- CLAUDE.md 发现：向上遍历目录树，检查 `CLAUDE.md` + `.claude/CLAUDE.md` + `.claude/rules/*.md`
- `buildRuntimeSystemPrompt()`: 拼接 base prompt + environment + skills + CLAUDE.md + memory + effort settings
- 默认系统 prompt 模板（对标 Python 的 55 行 base prompt）

**文件**: `packages/prompts/src/index.ts`

### 9.3 PermissionChecker 增强

**问题**: 只有 mode 级别控制，无工具黑白名单、无路径规则、无命令拒绝模式。

**工作**:
- `PermissionChecker` 构造函数接受完整配置：mode + allowedTools + deniedTools + pathRules + deniedCommands
- `checkTool()` 实现：先检查工具黑白名单 → 再检查路径/命令规则 → 最后 fallback to mode
- 为 Bash 工具传递 `command` 字段，为文件工具传递 `path` 字段

**文件**: `packages/permissions/src/index.ts`, `packages/core/src/engine/query-engine.ts`

---

## Phase 10: 工具修复 + 补全

### 10.1 WebSearch 真实实现

**问题**: 返回固定字符串 stub。

**工作**:
- 实现 DuckDuckGo HTML 搜索（对标 Python 的 `_ddg_search`）
- 解析搜索结果：title + URL + snippet
- 支持 `max_results` 参数

**文件**: `packages/tools/src/web/search.ts`

### 10.2 Grep 增强

**问题**: 只返回文件路径，无行号、无匹配内容、无大小写切换。

**工作**:
- 返回 `file:line:content` 格式
- 支持 `caseSensitive` 参数
- 支持 `include` glob 过滤
- 支持 `limit` 参数

**文件**: `packages/tools/src/search/grep.ts`

### 10.3 WebFetch 增强

**问题**: 无 HTML→text 转换、无 `max_chars` 截断。

**工作**:
- 简易 HTML→text：去除 tags，保留文本内容
- `maxChars` 参数截断
- content-type 检测

**文件**: `packages/tools/src/web/fetch.ts`

### 10.4 缺失工具实现

**问题**: 缺 `task_update`, `mcp_auth`, `remote_trigger` 三个工具。

**工作**:
- `TaskUpdate`: 更新任务 description/progress/statusNote
- `McpAuth`: 配置 MCP server auth（bearer/header/env），触发 reconnect
- `RemoteTrigger`: 立即执行已注册的 cron job，捕获输出

**文件**: `packages/tools/src/task/index.ts`, `packages/tools/src/mcp/index.ts`, `packages/tools/src/schedule/index.ts`

### 10.5 Cron 工具修复

**问题**: CronCreate/Delete/List/Toggle 四个工具全是 stub，不操作真实数据。

**工作**:
- 注入 `CronScheduler` 实例到工具 execute context
- CronCreate: 调用 `scheduler.addJob()`
- CronDelete: 调用 `scheduler.removeJob()`
- CronList: 调用 `scheduler.listJobs()`
- CronToggle: 调用 `scheduler.toggleJob()`

**文件**: `packages/tools/src/schedule/index.ts`

---

## Phase 11: CLI + REPL 增强

### 11.1 斜杠命令系统接入

**问题**: `@openharness/commands` 包存在但零命令注册，REPL 只认 exit/quit。

**工作**:
- 注册内置命令：`/help`, `/model`, `/clear`, `/compact`, `/session`, `/exit`
- REPL 主循环中调用 `CommandRegistry.execute(line)`
- 命令处理器访问 QueryEngine（clear/compact/model 切换）

**文件**: `apps/cli/src/commands/main.ts`, 新建 `apps/cli/src/commands/registry.ts`

### 11.2 Session 持久化 + Continue/Resume

**问题**: `--continue`/`--resume`/`--name` flags 存在但未接入；BridgeManager 不存消息历史。

**工作**:
- `BridgeManager` 扩展：存储 messages + model + systemPrompt + usage
- `mainAction` 读取 `--continue` → 加载最近 session → `engine.loadMessages()`
- `mainAction` 读取 `--resume` → 按 ID 加载 session
- `mainAction` 读取 `--name` → 命名 session
- REPL 退出时自动保存 session

**文件**: `packages/bridge/src/index.ts`, `apps/cli/src/commands/main.ts`

### 11.3 Auth 子命令补全

**问题**: auth login/status/logout 多数是 stub。

**工作**:
- `auth login`: 多 provider 选择器 + 对应认证流程
- `auth status`: 逐 provider 显示配置状态/来源
- `auth logout`: 实际清除 credentials
- `auth switch`: 切换 active provider（新增子命令）

**文件**: `apps/cli/src/commands/auth.ts`

### 11.4 Cron CLI 修复

**问题**: 7 个 cron 子命令全是 stub。

**工作**:
- `cron start/stop`: 启停 CronScheduler（in-process）
- `cron status`: 显示 scheduler 状态 + job 列表
- `cron list`: 列出所有 jobs + schedule + enabled
- `cron toggle`: 启禁用指定 job
- `cron history/logs`: 读取执行历史

**文件**: `apps/cli/src/commands/cron.ts`

### 11.5 CLI flags 补全

**问题**: `--effort`, `--mcp-config`, `--theme` 未接入；缺 `--output-format`, `--append-system-prompt`, `--bare`。

**工作**:
- `--effort`: 传入 Settings 并注入 system prompt
- `--mcp-config`: 读取指定 MCP 配置文件
- `--output-format`: text/json/stream-json（print mode）
- `--append-system-prompt`: 追加到默认 prompt
- `--bare`: 跳过 hooks/plugins/MCP 加载

**文件**: `apps/cli/src/index.ts`, `apps/cli/src/commands/main.ts`, `apps/cli/src/runtime.ts`

---

## Phase 12: 服务层增强

### 12.1 CompactService LLM 摘要

**问题**: 只有简单 token 裁剪，无 LLM 结构化总结。

**工作**:
- 注入 `StreamingMessageClient` 到 CompactService
- 实现 `llmCompact()`: 用 LLM 生成 `<analysis>/<summary>` 结构化摘要
- 模型感知上下文窗口阈值
- 连续失败计数（最多 3 次后退回 microCompact）

**文件**: `packages/core/src/engine/compact-service.ts`

### 12.2 Session 存储持久化

**问题**: 服务层 SessionStorage 纯内存。

**工作**:
- 文件存储：`.openharness/sessions/<id>.json`
- `saveSessionSnapshot()` / `loadSessionSnapshot()` / `listSessionSnapshots()`
- 按 cwd SHA1 分目录

**文件**: `packages/services/src/session/index.ts`（新建或扩展）

### 12.3 Cron 真实调度

**问题**: cron 表达式解析只支持分钟级，无真实调度。

**工作**:
- 集成 `cron` 或 `node-cron` npm 包
- 完整 5 字段 cron 表达式解析
- `nextRunTime()` 计算
- 执行历史 JSONL 记录

**文件**: `packages/services/src/cron/index.ts`

### 12.4 Memory 增强

**问题**: 纯内存 Map，无文件存储、无系统 prompt 集成。

**工作**:
- 默认文件存储：`.openharness/memory/` 目录
- `addMemoryEntry()` 创建 .md + 更新 index
- 搜索增加 metadata 权重（2x）+ 内容（1x）
- 系统 prompt 注入相关 memory

**文件**: `packages/memory/src/index.ts`

### 12.5 Coordinator 编排逻辑

**问题**: 无系统 prompt、无模式检测、无 XML 任务通知。

**工作**:
- 实现 coordinator system prompt（~250 行，对标 Python）
- `isCoordinatorMode()` 环境变量检测
- `formatTaskNotification()` / `parseTaskNotification()` XML 格式
- 补全 3 个内置 agent：`statusline-setup`, `claude-code-guide`, `verification`
- YAML frontmatter agent 定义加载

**文件**: `packages/coordinator/src/index.ts`, `packages/coordinator/src/agent-definitions.ts`

---

## Phase 13: API 层完善

### 13.1 OpenAI reasoning_content 处理

**问题**: 思考模型（DeepSeek-R1、Kimi k2.5）多轮工具调用会断裂。

**工作**:
- 流式循环中累加 `reasoning_content` delta
- 转发 assistant message 时回放 reasoning_content
- 多轮 tool call 场景下保持 reasoning 一致性

**文件**: `packages/api/src/providers/openai.ts`

### 13.2 Copilot OAuth Device Flow

**问题**: 无法从 TS 端完成 GitHub Copilot 认证。

**工作**:
- 实现 `requestDeviceCode()`: POST to `https://github.com/login/device/code`
- 实现 `pollForAccessToken()`: POST to `https://github.com/login/oauth/access_token`
- Token 持久化：保存到 `~/.openharness/copilot-token.json`，权限 0600
- GitHub Enterprise URL 支持

**文件**: `packages/api/src/providers/copilot.ts`, `packages/auth/src/index.ts`

---

## 执行顺序建议

```
Phase 8  (引擎核心)     → 最高优先，影响所有上层功能
Phase 9  (Settings)     → 依赖 Phase 8 的接口变更
Phase 10 (工具修复)     → 依赖 Phase 9 的 Settings 扩展
Phase 11 (CLI)          → 依赖 Phase 10 的工具完善
Phase 12 (服务层)       → 可与 Phase 10-11 部分并行
Phase 13 (API 完善)     → 可与 Phase 11-12 并行
```

## 不在范围内（FUTURE）

- Sandbox 真实实现（Docker/gVisor）
- Voice 真实实现（STT/TTS）
- React/Ink TUI 前端
- Channel 集成（Telegram/Discord/WhatsApp/飞书/钉钉等）
- LSP hover 真实实现（需 language server）
