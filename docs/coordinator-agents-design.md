# 设计：Coordinator agent 加载与 prompt 还原（C.4）

> 状态：已批准。移植 Python `coordinator/agent_definitions.py`（975 行）的加载段
> 与 `coordinator_mode.py`（520 行）的 prompt/上下文段。同时收口 C.1 留下的
> plugin agents 尾巴。

## 范围

- **R1 用户 agent 加载器**：`~/.openharness/agents/*.md`（YAML frontmatter +
  正文为 system prompt）→ `AgentDefinition`；`getAllAgentDefinitions()` 三源
  合并，同名后者覆盖：**builtin < user < plugin**（对齐 Python merge order）。
- **R2 plugin agents**：plugins 包加载 `<plugin>/agents/**/*.md` + manifest
  `agents` 路径；agent 名带插件前缀 `plugin:ns:name`；接进合并链与 Agent 工具。
- **R3 coordinator mode 还原**：`get_coordinator_system_prompt` 完整移植、
  `match_session_mode`、`get_coordinator_tools`、`get_coordinator_user_context`
  （scratchpad / worker-tools 注入）。

**范围外**：agent 级 hooks/mcpServers 的运行时生效（字段解析保留，spawn 接线
属 swarm 后续）；`effort`/`memory`/`isolation` 的行为接线（同上，只存字段）。

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

## 测试

- R1：frontmatter 全字段解析（含嵌套 hooks/mcpServers）、YAML 失败回退行级、
  非法枚举置 null、缺 name 用文件名、坏文件跳过、merge 顺序覆盖。
- R2：plugin agents 目录递归 + 命名空间、manifest agents 路径形态、
  enabled 过滤、合并链 plugin 覆盖 user。
- R3：coordinator prompt 关键段落断言、match_session_mode 各分支、
  coordinator tools 列表、user context 含 scratchpad/worker-tools。

每轮 `pnpm check-types` + `pnpm test` 全绿。
