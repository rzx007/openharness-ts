# 设计：Coordinator agent 加载与 prompt 还原（C.4）

> 状态：✅ 已完成（C.4 + agent 级字段运行时生效）。R1–R3 全部实现并通过类型检查；CLI 接线已补齐；agent 级字段（tools/disallowedTools/maxTurns/effort/permissionMode）已在 spawn worker 时实际传给子进程。

## 范围

- **R1 用户 agent 加载器**：`~/.openharness/agents/*.md`（YAML frontmatter +
  正文为 system prompt）→ `AgentDefinition`；`getAllAgentDefinitions()` 三源
  合并，同名后者覆盖：**builtin < user < plugin**（对齐 Python merge order）。
- **R2 plugin agents**：plugins 包加载 `<plugin>/agents/**/*.md` + manifest
  `agents` 路径；agent 名带插件前缀 `plugin:ns:name`；接进合并链与 Agent 工具。
- **R3 coordinator mode 还原**：`get_coordinator_system_prompt` 完整移植、
  `match_session_mode`、`get_coordinator_tools`、`get_coordinator_user_context`
  （scratchpad / worker-tools 注入）。

**已实现（后续补充）**：`tools`/`disallowedTools`/`maxTurns`/`effort`/`permissionMode` 五个字段在 spawn worker 时经 `TeammateSpawnConfig` → `buildTeammateCommand` → CLI argv 实际传给子进程，bootstrap 应用（见下方"agent 级字段运行时生效"小节）。

**仍留待**：agent 级 `hooks`/`mcpServers` 的运行时生效（需 env var 传 JSON，再在 worker 侧解析注册，较复杂）；`memory`/`isolation` 的行为接线（字段已解析，接线待后续）。

## 关键决策

- **引入 `yaml` 依赖**（npm `yaml`，进 catalog）：frontmatter 的 hooks/
  mcpServers 是嵌套结构，行级解析不够；Python 也用 PyYAML。YAML 解析失败回退
  行级 `key: value`（对齐 Python 的 fallback）。
- **frontmatter 字段全集**（驼峰/下划线双形态容错，对齐 Python docstring）：
  name/description（必填，缺省文件名/`Agent: <name>`）、tools/disallowedTools、
  model（"inherit" 归一）、effort（low/medium/high 或正整数）、permissionMode、
  maxTurns、skills、mcpServers、hooks、color（白名单）、background、
  initialPrompt、memory、isolation、omitClaudeMd、criticalSystemReminder、
  requiredMcpServers、permissions、subagent_type（缺省 name）。
  非法枚举值静默置 null（Python 是 logger.debug，TS 无 logger 基建）。
- **坏文件容错**：单个 .md 解析抛错 → 跳过该文件不拖垮整体（对齐 Python）。
- **AgentDefinition 接口扩展**：在现有 TS 接口上补缺失字段（全部可选），
  内置定义不动。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 非法枚举值 | logger.debug | 静默忽略 | TS 无 logger 基建 |
| plugin agents 命名 | `plugin:ns:name`（loader.py） | 同 | 对齐 |
| getAllAgentDefinitions 的 plugin 段 | 函数内 lazy import load_plugins（每次全量重扫盘） | 注入式：`getAllAgentDefinitions(pluginAgents?)`，由 CLI 接线处传入已加载的插件 agents | 避免循环依赖与重复扫盘；TS 的插件在启动时已加载（C.1 缓存） |
| permission_mode 枚举 | acceptEdits/bypassPermissions/plan/dontAsk/default（Claude Code 名） | 同字面量保留 | schema 兼容；TS 运行时映射留 swarm 接线 |
| 插件 agent 的 hooks/mcpServers/omitClaudeMd | _load_single_agent_file 硬编码置空 | 同样置空（build 后剥除） | 信任面：插件不得自挂 hook/MCP/抑制 CLAUDE.md |
| coordinator system prompt | f-string 模板（工具名/能力句插值） | 静态富版本 + 简单模式字符串替换（防回归断言钉住） | TS prompt 已是全量；simple 分支按需换 §3 |
| 非字符串 frontmatter name | str() 强转 | 回退文件名 | 边缘差异，记录备查 |

## 测试

- R1：frontmatter 全字段解析（含嵌套 hooks/mcpServers）、YAML 失败回退行级、
  非法枚举置 null、缺 name 用文件名、坏文件跳过、merge 顺序覆盖。
- R2：plugin agents 目录递归 + 命名空间、manifest agents 路径形态、
  enabled 过滤、合并链 plugin 覆盖 user。
- R3：coordinator prompt 关键段落断言、match_session_mode 各分支、
  coordinator tools 列表、user context 含 scratchpad/worker-tools。

每轮 `pnpm check-types` + `pnpm test` 全绿。

## CLI 接线（C.4 补充）

R3 函数本身在 `@openharness/coordinator` 包里实现后，还需三处 CLI 接线：

### 1. session_mode 存储

`SessionSnapshotPayload` 新增 `session_mode?: string` 字段；`saveSessionSnapshot` 的 `options.sessionMode` 在 coordinator 模式下传 `"coordinator"`，会话文件写入后可被恢复端识别。

### 2. matchSessionMode 在会话恢复时调用

`loadSessionAndResume`（`main.ts`）恢复快照后调用 `matchSessionMode(payload.session_mode)`：若快照中有 `session_mode: "coordinator"` 则设置 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量并向用户打印提示；若模式不匹配当前环境则警告——对齐 Python `match_session_mode` 行为。

### 3. setAllowedTools 在 coordinator 模式启动时调用

`QueryEngine` 新增 `setAllowedTools(tools: string[] | null): void`，在 `submitMessage` 时按白名单过滤 `toolRegistry.getAll()`。

REPL / BackendHost 启动时（`registerPluginHooks` 之后）：

```typescript
if (isCoordinatorMode()) {
  bundle.queryEngine.setAllowedTools(getCoordinatorTools());
  // getCoordinatorTools() = ["Agent", "SendMessage", "TaskStop"]
}
```

这样 coordinator 只能调用 swarm 工具，无法直接操作文件/运行 shell——对齐 Python coordinator 的工具隔离。

## agent 级字段运行时生效

`AgentDefinition` 里的约束字段现在会随 spawn 实际传给 worker 子进程。完整链路：

```
agent.md frontmatter
  tools: [Read, Write]
  disallowedTools: [Bash]
  maxTurns: 5
  effort: high
  permissionMode: plan

↓ packages/tools/src/agent/index.ts（Agent 工具）
  agentDef → TeammateSpawnConfig.{allowedTools, disallowedTools, maxTurns, effort, permissionMode}

↓ apps/cli/src/teammate.ts（buildTeammateCommand）
  argv: [..., "--allowed-tools", "Read,Write",
               "--disallowed-tools", "Bash",
               "--max-turns", "5",
               "--effort", "high",
               "--permission-mode", "plan"]

↓ apps/cli/src/commands/main.ts（buildCliOverrides → bootstrap）
  PermissionChecker 工具白/黑名单 + queryEngine maxTurns + effort 注入
```

### 各字段说明

| 字段 | CLI 参数 | bootstrap 应用点 |
|------|----------|-----------------|
| `tools` | `--allowed-tools A,B` | `bootstrap` 构建 `toolRegistry` 时过滤，只保留白名单工具 |
| `disallowedTools` | `--disallowed-tools X` | `bootstrap` 构建 `toolRegistry` 时排除黑名单工具 |
| `maxTurns` | `--max-turns N` | `buildCliOverrides` → `settings.maxTurns` → `QueryEngine.setMaxTurns` |
| `effort` | `--effort high` | `buildCliOverrides` → `settings.effort` → API 调用时 reasoning effort |
| `permissionMode` | `--permission-mode plan` | `buildCliOverrides` → `PermissionChecker.mode`（Agent 工具传入值 > agentDef 值 > "default"） |

### permissionMode 优先级

Agent 工具调用时 `input.permissionMode`（运行时显式指定）> `agentDef.permissionMode`（agent.md 定义）> 默认 `"default"`，允许调用方按需覆盖。

### 仍留待（hooks/mcpServers）

`hooks` 和 `mcpServers` 是嵌套对象，无法直接序列化成 CLI 参数，需要通过环境变量传 JSON 并在 worker 侧解析注册，留待后续实现。
