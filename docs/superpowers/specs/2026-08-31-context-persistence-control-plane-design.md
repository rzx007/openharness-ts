# Context Persistence 统一持久化控制层设计

日期：2026-08-31

状态：已确认，可进入实现计划

## 结论

OpenHarness 将用统一的 `ContextPersistenceService` 接管所有由对话产生、需要跨轮次或跨会话生效的上下文。Agent 只表达“记住、查询、修改、忘记”这些语义，不知道也不选择 Markdown 文件或目录。底层继续使用 Markdown，但只有服务负责定位、解析、校验和落盘。

本设计采用一次性切换，不兼容旧结构：

- 不读取或写入 `USER.md`。
- 不读取或写入 `local_rules/facts.json`、`local_rules/rules.md`。
- 不读取或写入 Markdown Project Memory 和 `MEMORY.md`。
- 不保留新旧双写、回退读取或旧 `/memory` HTTP 契约。
- 旧文件不自动删除，避免静默销毁用户数据；切换后它们只是未使用的遗留文件，可由用户自行归档或删除。

`SOUL.md` 不属于记忆，继续作为 Agent 身份配置存在，但只能由专门的身份配置服务管理；通用记忆能力永远不能修改它。Session Memory checkpoint 继续作为 compact 的内部连续性状态，不进入长期上下文服务。

这里所说的“统一 `rules.md`”是统一它承载的语义，不是继续保留这个文件作为第二份数据源。原来应该写入 `rules.md` 的项目规则改写为 `kind = "project_rule"` 的托管 Markdown entry；需要给用户查看时，由 `/context/preview` 和桌面 Context 面板即时生成可读投影。磁盘上已有的 `rules.md` 不再读取，新系统也不再生成同名文件。

## 已确认的交互规则

1. 用户明确要求“记住”，并且系统对类型、作用域和含义判断为高置信度时，立即写入。
2. 写入后只做自然语言确认，例如“记住了，这会作为当前项目规则生效”。
3. 不展示撤销胶囊，不弹二次确认。
4. 作用域不清、与已有内容冲突、涉及敏感信息或置信度不足时才询问。
5. 凭据、令牌、密码、私钥等秘密永不持久化，即使用户确认也拒绝。
6. 自动提取只允许高置信度、非敏感、作用域明确的环境事实直接生效；其他自动发现内容进入候选区，不打断当前任务。
7. 用户可以随时询问“你记得什么”、修改一条上下文或要求忘记。

## 目标

- 让“记住”成为受控的产品能力，而不是文件编辑行为。
- 统一用户偏好、项目规则、项目知识和环境事实的写入、查询、冲突、审计和删除。
- 把作用域作为数据模型的一部分，阻止跨项目污染。
- 让每条持久上下文都可解释：谁提出、从哪次会话产生、为什么生效、何时更新。
- 保证下一轮对话立即读到刚写入的数据，不依赖重启 Agent。
- 为 CLI、桌面端、Agent 工具和自动提取提供同一服务。
- 删除旧的直接文件写入捷径和 `isMemoryWriteToolCall` 旁路。

## 非目标

- 不把聊天全文当作长期记忆保存；完整会话历史继续由 SessionStore 负责。
- 不把 Session Memory checkpoint 合并进长期上下文。
- 不让自然语言“记住”修改 `SOUL.md`、`AGENTS.md` 或 `CLAUDE.md`。
- 不引入向量数据库、外部 Embedding 服务或云端同步。
- 不在每条消息旁显示记忆胶囊。
- 不自动迁移旧 Markdown 数据。
- 不把所有 Prompt 来源都塞进 Context Markdown；技能、项目指令、运行设置和凭据保持各自边界。

## 主流方案带来的设计取舍

这套设计不是把某一个产品照搬过来，而是取它们已经验证过的共同边界：

- Claude Code、OpenCode 一类工具把仓库指令文件当作开发者维护的静态规则，而不是让普通“记住”请求任意改文件。因此 `AGENTS.md/CLAUDE.md` 继续独立，`project_rule` 只保存对话产生的个人项目规则。
- ChatGPT Memory、Letta、Mem0 一类长期记忆方案都强调语义操作、作用域和可管理记录。对应到 OpenHarness，就是 Remember/Recall/Update/Forget 工具、user/project/machine scope，以及可查询的 active/candidate entry。
- LangGraph 一类 Agent runtime 明确区分线程 checkpoint 和跨线程 store。对应到 OpenHarness，就是 Session Memory 继续只服务 compact，Context Persistence 才负责跨会话信息。
- 主流系统对自动写入都需要更严格的门槛和用户管理入口。因此本设计只让高置信度、非敏感、作用域明确的环境事实自动提交，其余自动发现进入候选；显式请求则在冲突、敏感或含糊时询问。

这些共同模式解释了为什么不能继续让 Agent 自己猜 `USER.md`、`rules.md`、`MEMORY.md` 或其他路径：路径只是旧实现细节，用户表达的是“记住什么、在哪个范围生效、何时更新或忘记”。

对人类可编辑 Markdown 的进一步调研也直接影响了物理布局：Claude Code 使用全局/项目主文件，并在内容变大时按 `testing.md`、`api-design.md` 等主题拆分；OpenCode 以全局和项目 `AGENTS.md` 聚合规则；Cursor 的全局规则是聚合文本，项目规则才按关注点拆分；OpenClaw 用 `USER.md`、`MEMORY.md` 和日期笔记分层；Letta 则把多个相关事实聚合在 `human`、`persona`、`organization` 等 memory block 中。共同点是“按作用域或主题聚合”，而不是把每一条人类可读规则做成一个文件。

参考：

- [Claude Code Memory](https://code.claude.com/docs/en/memory)
- [OpenCode Rules](https://dev.opencode.ai/docs/rules/)
- [Cursor Rules](https://docs.cursor.com/context/rules)
- [OpenClaw Memory](https://docs.openclaw.ai/concepts/memory)
- [Letta Memory Blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/)

## 对现有记忆四层的影响

对照 `docs/memory-system.md`，这次不是推翻所有记忆能力：

| 现有层 | 新行为 |
|---|---|
| tool output inline/preview/microCompact | 完全不变，不经过 Context 服务 |
| Session Memory checkpoint | 保留 Markdown 写入和 compact 读回，只把配置移动到 `sessionContinuity` |
| personalization 环境事实 | 保留确定性提取器，取消 `facts.json + rules.md` 双写，proposal 交给 Context 服务 |
| `/remember` 持久记忆 | 保留语义提取、签名去重、逐轮检索和使用计数，落盘统一为 schema 2 Context Markdown |
| Run 后自动语义提取 | 从“默认直接写最多三条”改为统一策略：只有安全的高置信环境事实自动生效，其余进入候选 |
| `/dream` | 保留整合能力，取消模型直接编辑 memory 目录，改为结构化操作经服务验证后落盘 |

旧 schema 1 memory 文件不自动迁移或读取；这是存储契约硬切。能力层面仍保留跨会话记忆、相关性检索、去重、候选、整合和管理入口。

## 上下文分类

### `user_preference`

跟随当前用户、跨项目生效的偏好，例如：

- 回答使用简洁中文。
- UI 设计优先使用真实业务文案。
- Node 项目优先使用 pnpm。

作用域固定为 `user`。

### `project_rule`

只在当前项目生效的行为要求，例如：

- 当前项目部署前必须先运行数据库迁移。
- 本仓库测试统一使用 Vitest。
- 当前项目 UI 必须遵循已有设计系统。

它是从对话产生的个人项目规则，不修改仓库中的 `AGENTS.md/CLAUDE.md`。项目指令文件仍由开发者显式维护并通过版本控制共享。

### `project_knowledge`

当前项目的稳定知识、决定和经验，例如：

- 权限校验由 API gateway 统一处理。
- 订单状态机的最终状态包括 cancelled 和 completed。
- 某次排障已确认根因是连接池耗尽。

作用域固定为 `project`，按当前输入检索后注入。

### `environment_fact`

本机或当前项目使用的环境事实，例如：

- Git 安装在本机特定目录。
- 当前项目测试服务器是 `10.0.0.7`。
- 当前项目使用 conda 环境 `openharness`。

作用域可以是 `machine` 或 `project`。密码、令牌、私钥和连接串中的秘密字段不属于环境事实，必须拒绝持久化。

## 不属于长期上下文的内容

| 内容 | 负责人 | 原因 |
|---|---|---|
| Agent 身份、人格 | AgentIdentityService / `SOUL.md` | 需要专门配置权限，不能由普通“记住”改变 |
| 团队仓库指令 | `AGENTS.md`、`CLAUDE.md` | 由开发者显式编辑并随仓库共享 |
| 当前会话连续性 | Session Memory checkpoint | 只服务 compact，不跨会话检索 |
| 完整聊天记录 | SessionStore | 是运行历史，不是长期事实 |
| API key、令牌、密码 | Credential Service | 永不进入 Prompt 或上下文存储 |
| 技能内容 | Skill Registry / Skill 工具 | 按需加载，不是记忆 |

## 逻辑作用域

```ts
export type ContextScope = "user" | "project" | "machine";

export interface ContextScopeRef {
  scope: ContextScope;
  scopeKey: string;
}
```

- `user`：当前本地 OpenHarness 用户，`scopeKey = "local-user"`。
- `machine`：当前 daemon 安装生成并持久化的稳定 `machineId`，不同机器不会共享本地路径和工具事实。
- `project`：使用 SessionStore 中稳定的 `projectId`，不能使用原始 cwd 作为身份。

项目会话必须绑定 `projectId`。真正的 projectless 会话没有项目作用域；若用户在其中要求保存项目规则，服务返回 `needs_clarification`，让用户选择全局偏好或先进入项目。

## 数据模型

持久数据进入 daemon 配置根下的专用 Context 目录。目录不位于项目工作区，不进入 Prompt，也不由 Agent 自己计算：

```text
<configDir>/context/
├── user/
│   ├── preferences.md
│   ├── ui-design.md
│   ├── development-workflow.md
│   └── pending.md
├── machines/<machine-id>/
│   ├── environment.md
│   └── pending.md
└── projects/<project-id>/
    ├── rules.md
    ├── knowledge.md
    ├── environment.md
    └── pending.md
```

首次初始化时，服务用 create-if-absent 方式在 Context 根写入 `.machine-id`，内容是随机稳定 ID；并发初始化只能有一个成功创建者，其他调用者复读同一值。该文件只是作用域身份元数据，不含用户 Context，也不进入 Prompt。

物理存储按主题聚合，不按 entry 拆文件。一个主题文件可以包含多个可独立管理的 Context entry block；entry 的稳定身份位于 block metadata 中。存储粒度是主题文件，管理、冲突、检索和 Prompt 注入粒度仍是 entry。

主题路由第一版使用有限集合，避免模型任意创建新文件：全局偏好进入 `preferences | ui-design | development-workflow`；机器事实进入 `environment`；项目内容进入 `rules | knowledge | environment`。无法可靠确定主题时进入对应作用域的 `pending.md`，不让模型提供文件名。

不创建 `indexes/`。预览由服务按需渲染，不生成旧式 `MEMORY.md`。这里的 `projects/<id>/rules.md` 是新 Context 服务托管的主题容器，不是旧 `local_rules/rules.md`，也不会被 Prompt 层直接按文件读取。

### Context entry

```ts
export type ContextKind =
  | "user_preference"
  | "project_rule"
  | "project_knowledge"
  | "environment_fact";

export type ContextTopic =
  | "preferences"
  | "ui-design"
  | "development-workflow"
  | "rules"
  | "knowledge"
  | "environment"
  | "pending";

export type ContextEntryStatus = "active" | "candidate" | "superseded" | "disabled";
export type ContextSensitivity = "none" | "sensitive" | "secret";
export type ContextOrigin =
  | "explicit_user"
  | "automatic_extraction"
  | "context_api";

export interface ContextEntryRecord {
  id: string;
  title: string;
  scope: ContextScope;
  scopeKey: string;
  kind: ContextKind;
  semanticKey: string;
  topic: ContextTopic;
  content: string;
  normalizedContent: string;
  status: ContextEntryStatus;
  sensitivity: ContextSensitivity;
  confidence: number;
  origin: ContextOrigin;
  sourceSessionId?: string;
  sourceInputId?: string;
  sourceRunId?: string;
  supersedesId?: string;
  useCount: number;
  lastUsedAt?: number;
  candidateReason?: string;
  createdAt: number;
  updatedAt: number;
}
```

对应的主题 Markdown 格式：

```markdown
---
schema_version: 2
scope: user
scope_key: local-user
topic: ui-design
title: UI 设计偏好
updated_at: 2026-08-31T15:00:00+08:00
---

# UI 设计偏好

<!-- context-entry
id: ctx_01K45D7ZGM8R2S6A
kind: user_preference
semantic_key: ui.design.color_palette
status: active
importance: 0.9
confidence: 0.98
sensitivity: none
origin: explicit_user
source_session_id: session_123
created_at: 2026-08-31T15:00:00+08:00
updated_at: 2026-08-31T15:00:00+08:00
use_count: 0
-->

## 配色

不要默认到处使用紫色或靛蓝色。应优先使用项目真实设计系统的色板。

<!-- /context-entry -->

<!-- context-entry
id: ctx_01K45D7ZGM8R2S6B
kind: user_preference
semantic_key: ui.design.gradients
status: active
importance: 0.8
confidence: 0.98
sensitivity: none
origin: explicit_user
created_at: 2026-08-31T15:00:00+08:00
updated_at: 2026-08-31T15:00:00+08:00
use_count: 0
-->

## 渐变

避免大量使用渐变；只有项目设计系统明确规定时才使用其定义的渐变。

<!-- /context-entry -->
```

文档 frontmatter 只描述容器的 scope 和 topic；每个 `context-entry` block 自带 ID、kind、semantic key、状态、来源和时间。显式开始与结束标记使正文可以包含标题、列表、表格和代码块，而不会依赖标题层级猜边界。服务只修改标记内的 block，并稳定保留文档标题和未托管的人类说明。

`semanticKey` 是同一作用域内可冲突的语义槽位，例如：

```text
ui.response_style
node.package_manager
deploy.precondition
environment.test_server
architecture.auth_boundary
```

同一 `(scope, scopeKey, kind, semanticKey)` 同时最多有一条 `active` entry。这样“包管理器是 npm”和“包管理器是 pnpm”能被识别为冲突，而不是两条互相打架的文本。

候选按作用域聚合在 `pending.md`，每个候选仍是一个 `status: candidate` block，并记录 `target_topic` 和 `candidate_reason`。候选不进入 Prompt。接受时先幂等插入目标主题文件，再从 `pending.md` 删除；若进程在两步之间退出，启动扫描发现相同 ID 已 active 时清理重复 pending block。拒绝时只从 `pending.md` 删除对应 block。默认 30 天清理过期候选。

### 待澄清 decision

显式请求需要用户澄清时，只在 daemon 的当前会话运行状态中保存短期 decision，不为它创建长期 Markdown：

```ts
export interface ContextDecisionRecord {
  id: string;
  reason: "ambiguous_scope" | "conflict" | "sensitive";
  proposal: ContextProposal;
  options: ContextDecisionOption[];
  status: "pending" | "resolved" | "expired";
  sessionId: string;
  runId: string;
  createdAt: number;
  expiresAt: number;
}
```

决策绑定当前会话，24 小时过期，避免其他会话误确认。daemon 重启后未完成 decision 可以失效，用户重新表达即可；它不是长期知识。

### 一次请求包含多个记忆

Resolver 的输出必须是数组，而不是单条自由文本：

```ts
export interface ContextProposal {
  title: string;
  content: string;
  kind: ContextKind;
  scope: ContextScope;
  scopeKey?: string;
  semanticKey: string;
  confidence: number;
  sensitivity: ContextSensitivity;
  evidence: string;
  replace: boolean;
}
```

拆分标准是“能否独立修改或失效”，不是标点：不同作用域、不同 semantic key、将来可能单独更新的偏好拆成多个 proposal；共同构成一个架构决定的结论、原因和约束保留在同一个 proposal。

每个 proposal 独立得到 committed、noop、needs_clarification、rejected 或 failed。一个 secret 不阻止同批其他安全偏好保存；一个冲突只询问冲突项。服务绝不能在部分成功时声称“全部记住了”。

例如“记住回答详细一点、代码注释用中文、当前项目提交前必须测试”应拆为：

```text
user / user_preference / response.verbosity
user / user_preference / code.comment_language
project / project_rule / git.pre_commit_test
```

并生成三个逻辑 entry；两个用户偏好可按主题写入同一用户文档，项目规则写入项目 `rules.md`。相反，“暂不迁移 ESM，因为旧插件依赖 CommonJS”是一个不可分割的架构决定，应保留为一个 `project_knowledge` entry。

### Markdown 写入纪律

- 写入前完成文档 schema、block schema、scope、topic、semantic key、秘密和冲突校验。
- 同一次请求先按目标主题分组；同一主题的多个 entry 合并成一次文档重写。
- 主题文件先完整渲染到同目录临时文件，重新解析并比对所有 entry ID 后再原子 rename。
- 单作用域写入由进程内 keyed mutex 串行化；锁 key 为 `scope + scopeKey`，从而覆盖 pending 到 active 的跨文档移动。
- 批量请求采用逐条结果；同一主题文档内部要么整个新版本生效，要么保留旧版本，不产生半个 block。
- update/replace 保留稳定 entry ID，只替换对应 block；forget 删除对应 block，空的自动生成主题文件可以删除。
- 使用计数在内存中合并并由维护阶段批量刷新，避免每次 recall 都重写主题文件。
- 服务启动或首次访问时扫描固定主题文件并校验 Markdown；非法文档隔离整个文件并记录不含正文的诊断，单个非法 block 不参与 Prompt。

## 服务边界

```ts
export interface ContextPersistenceService {
  remember(input: RememberContextInput): Promise<ContextBatchMutationResult>;
  resolve(input: ResolveContextDecisionInput): Promise<ContextItemMutationResult>;
  recall(input: RecallContextInput): Promise<ContextRecallResult>;
  list(input: ListContextInput): Promise<ContextEntryRecord[]>;
  update(input: UpdateContextInput): Promise<ContextItemMutationResult>;
  forget(input: ForgetContextInput): Promise<ContextItemMutationResult>;
  listCandidates(input: ListCandidatesInput): Promise<ContextEntryRecord[]>;
  resolveCandidate(input: ResolveCandidateInput): Promise<ContextItemMutationResult>;
  consolidate(input: ConsolidateContextInput): Promise<ContextConsolidationResult>;
}
```

服务内部拆成四个职责明确的单元：

- `ContextIntentResolver`：判断类型、作用域、语义 key、置信度和敏感度。
- `ContextConflictDetector`：做幂等、替换和冲突判断。
- `MarkdownContextStore`：只负责固定主题文档的扫描、block 解析、按主题合并、锁、原子重写和 pending 移动。
- `ContextPromptRenderer`：按预算选择并渲染本轮模型上下文。

## 写入结果

```ts
export type ContextItemMutationResult =
  | { status: "committed"; entry: ContextEntryRecord; action: "created" | "updated" }
  | { status: "noop"; entry: ContextEntryRecord }
  | {
      status: "needs_clarification";
      decisionId: string;
      reason: "ambiguous_scope" | "conflict" | "sensitive";
      question: string;
      options: Array<{ id: string; label: string }>;
    }
  | { status: "rejected"; reason: "secret" | "unsupported"; message: string }
  | { status: "failed"; message: string };

export interface ContextBatchMutationResult {
  status: "completed" | "mixed" | "failed";
  results: ContextItemMutationResult[];
}
```

`committed` 和 `noop` 都不需要二次确认。`needs_clarification` 由 Agent 原样转成一个简短问题。`rejected` 不允许通过换一个文件工具绕过。批量结果必须逐条汇总；明确、安全的条目可以成功，而同批冲突、含糊、秘密或 I/O 失败的条目分别报告。

## 判断策略

### 明确作用域信号

- “我喜欢、以后都、所有项目、对我来说”优先为 `user`。
- “这个项目、当前仓库、本项目”优先为 `project`。
- “这台机器、本机、Windows 上”优先为 `machine`。
- 当前项目中出现测试服务器、项目环境名等事实，默认 `project`。

提示只是证据，不是字符串命中即写入。Resolver 输出 0 到 1 的置信度；显式请求只有在 `confidence >= 0.85` 时直接提交。

### 类型信号

- 个人表达方式和工具习惯：`user_preference`。
- 必须、禁止、统一、每次先做：`project_rule`。
- 架构决定、业务约束、排障结论：`project_knowledge`。
- IP、主机、路径、环境名、endpoint：`environment_fact`。

### 敏感信息

- `secret`：密码、访问令牌、API key、私钥、完整认证连接串；永远拒绝。
- `sensitive`：内部 IP、SSH 主机、个人身份信息、未公开基础设施信息；显式请求也需要确认。
- `none`：正常偏好、项目约定和非敏感知识。

敏感确认只确认“是否保存”，不展示或重复完整秘密。秘密检测发生在写 Markdown 前，日志也只记录分类和哈希，不记录原文。

## 冲突规则

1. 规范化内容和语义 key 都相同：返回 `noop`。
2. 同一 key 已有 active 记录且内容不同：返回 `needs_clarification(conflict)`。
3. 用户明确说“改成、更新为、不要再，替换之前的”时，Resolver 标记 `replace=true`，服务在持有同作用域锁时原子替换主题文档中的目标 block，并保留稳定 entry ID。
4. 通过 `update(entryId)` 修改时不再询问作用域，但仍执行秘密检测。
5. 项目规则覆盖用户偏好只影响读取优先级，不会删除全局偏好。

## Agent 工具

Agent 只在 daemon 提供 `AgentContextMemoryHost` 时获得以下工具：

- `Remember`：保存显式用户要求。
- `ResolveContextDecision`：处理用户对澄清问题的回答。
- `RecallContext`：查询或列出相关上下文。
- `UpdateContext`：修改已知 ID。
- `ForgetContext`：删除已知 ID或唯一匹配项。

工具输入允许 `scope_hint` 和 `kind_hint`，但服务端必须重新验证。工具输入和返回值没有 path、directory、storage backend 字段。

系统提示增加一条稳定规则：用户明确要求记住、修改或忘记时使用这些工具；不得通过 Read/Write/Edit/Bash 寻找或修改上下文存储文件。

## 显式记住流程

```text
用户明确要求记住
  → Agent 调 Remember
  → daemon 注入 session/project/provenance
  → Resolver 拆成 1..N 个 ContextProposal
  → 每条分别做分类、作用域、敏感和冲突检查
  → MarkdownContextStore 按作用域和主题分组后原子重写文档
  → Agent 汇总 committed/noop/clarification/rejected/failed
```

拆分以“能否独立修改或失效”为准。一次请求混合多个偏好、项目规则和环境事实时允许产生多个 Markdown；结论与原因共同构成一个决定时保持一条。澄清后 Agent 调 `ResolveContextDecision`，服务只接受创建该 decision 的同一会话，并验证未过期。

## 自动提取流程

成功的 root Run 完成后：

1. `SessionPostRunMaintenance` 把 durable transcript 交给 `ContextExtractionService`。
2. 确定性提取器寻找环境事实；模型提取器寻找其他可复用知识。
3. 每个提议都经过同一个 Resolver、秘密检测和冲突检测。
4. 只有 `environment_fact`、`confidence >= 0.95`、非敏感、作用域明确且无冲突时自动提交。
5. 其他有效提议作为 `status: candidate` block 聚合写入作用域 `pending.md`；秘密直接丢弃并记录脱敏审计。
6. 自动提取不在 Run 结束时主动追问，避免打断用户；候选通过管理页或 `/context candidates` 查看。

## `/dream` 整合

保留 `/dream` 的产品能力，但取消“启动子 Agent 并把 memory 目录交给它直接编辑”的实现。新流程是：

1. `ContextPersistenceService` 读取目标作用域的 active entries 并生成脱离路径的结构化快照。
2. 模型只返回 `merge | update | disable` 的结构化操作建议，不返回文件路径。
3. 服务校验 entry ID、scope、秘密、冲突和操作数量；preview 模式只返回计划。
4. 执行模式先备份涉及的主题 Markdown，再通过 `MarkdownContextStore` 更新、移动或合并目标 blocks。
5. 任一步失败都停止剩余操作并报告逐项结果；模型不能调用 Write/Edit 绕过服务。

这样继续支持合并重复、纠正矛盾、相对日期转绝对日期和淘汰过时内容，同时保持 `ContextPersistenceService` 是唯一写入入口。

## 查询与 Prompt 注入

可变上下文不能继续只在 Agent 创建时烘焙进静态 system prompt，否则写入后必须关闭 runtime 才能生效。

每个用户输入进入模型前，`ContextQueryService` 根据当前 `userInput + projectId` 读取：

1. 当前项目 active `project_rule`，按重要性和更新时间排序。
2. active `user_preference`，但被同 key 项目规则覆盖的偏好不注入。
3. 当前项目和本机相关的 `environment_fact`。
4. 与本轮输入相关的 `project_knowledge`。

输出结构：

```ts
export interface ContextPromptBundle {
  sections: Array<{
    title: "User Preferences" | "Project Rules" | "Environment Facts" | "Project Knowledge";
    content: string;
    entryIds: string[];
  }>;
  totalChars: number;
}
```

Prompt 层只接收渲染结果，不读取存储路径。默认总预算 12,000 字符；项目规则和用户偏好优先于检索知识。使用过的 entry 在模型请求成功组装后增加 `useCount/lastUsedAt`。

`AGENTS.md/CLAUDE.md` 仍作为 Project Instructions 注入，并且优先级高于对话产生的项目规则。发生矛盾时，Agent 应遵循显式仓库指令并向用户说明冲突。

## API 与命令

删除旧 `/memory` 和 `/profile` 记忆相关契约，新增：

```text
GET    /context/entries
GET    /context/entries/:id
POST   /context/entries
PATCH  /context/entries/:id
DELETE /context/entries/:id
GET    /context/candidates
POST   /context/candidates/:id/accept
POST   /context/candidates/:id/reject
GET    /context/status
GET    /context/preview
```

所有请求通过逻辑 scope/kind 过滤，不返回托管 Markdown 路径。

Slash 命令统一为：

```text
/context list [--scope user|project|machine] [--kind ...]
/context show <id>
/context add <content>
/context update <id> <content>
/context remove <id>
/context candidates
/context accept <candidate-id>
/context reject <candidate-id>
/context status
/context preview
/remember <content>
```

`/remember` 是显式语义入口，直接调用同一个 `ContextPersistenceService`；无参数时提示用法，不再扫描整段会话并写 Markdown。

## 桌面端

桌面端增加 Context 管理面板，用于：

- 按作用域和类型查看 active 条目。
- 查看来源会话、创建时间、更新时间和敏感级别。
- 编辑或删除条目。
- 接受或拒绝自动候选。
- 查看当前项目下一轮会注入的上下文预览。

普通消息仍只显示 Agent 的自然语言确认，不显示记忆胶囊或撤销按钮。

## 托管资源保护

新增宿主拥有的 `ManagedResourcePolicy`。Write/Edit 在执行前调用它；daemon 注册整个 Context Markdown 根目录、凭据文件和 `SOUL.md` 为托管资源。被命中时返回 policy error，要求使用对应语义工具。

Context 根目录不进入 Prompt、工具结果或普通 status 输出。Shell 是通用代码执行能力，无法在未启用 OS sandbox 时可靠解析并阻止任意脚本访问；因此设计保证：

- 模型不获得 Context 根目录路径。
- Write/Edit 具有硬拒绝。
- 启用 SRT/Docker 时把 daemon 配置根加入 deny-write。
- 非 sandbox 的 Bash 仍受权限系统控制；不宣称能够抵御主动恶意脚本。

## `SOUL.md` 边界

`SOUL.md` 暂时保留，但 Prompt 包只通过 `AgentIdentityService` 读取。删除 `USER.md` 初始化、pending update 和相关检查。`/profile` 改为 `/agent-identity`，只报告和管理身份配置。

Agent 的 `Remember`、`UpdateContext`、自动提取和 Context API 都没有 `agent_identity` 类型，因此无法误写 SOUL。

## Session Memory 边界

Session Memory checkpoint 保留当前文件实现和刚补齐的 compact 读回接线。设置从旧的 `memory.sessionMemoryEnabled` 移到 `sessionContinuity.enabled`。它不出现在 Context CRUD、搜索、候选和桌面管理列表中。

## 配置

删除旧 `memory` 配置，新增：

```ts
context: {
  enabled: true,
  explicitCommitThreshold: 0.85,
  automaticEnvironmentCommitThreshold: 0.95,
  automaticExtractionEnabled: true,
  candidateRetentionDays: 30,
  promptMaxChars: 12_000,
  promptMaxEntries: 40,
},
sessionContinuity: {
  enabled: true,
}
```

阈值由配置加载层校验在 `[0, 1]`，但产品 UI 第一版只暴露开关，不暴露高级阈值。

## 旧结构切换

切换提交完成后：

- 删除 `@openharness/memory` 包和 `MemoryManager`。
- 删除 `@openharness/personalization` 包和 `updateRulesFromSession`。
- 删除 prompts 中 USER、pending update、local rules 读取逻辑。
- 删除 agent-runtime 的 `memory-runtime.ts` 和 `OpenHarnessAgent.remember()`。
- 删除 services 的旧 `memory-extract.ts` 和允许模型直接编辑 memory 目录的 autodream 流程；新的整合只提交结构化操作给 Context 服务。
- 删除 server 的 `MemoryService`、旧 memory routes 和 profile 中 USER 部分。
- 删除 client 的 `MemoryEntryRecord/MemoryListResponse` 和旧 HTTP 方法。
- 删除 `/memory` 命令；`/remember` 改走新服务。
- 删除所有 `directory/path` 形式的记忆诊断输出。

旧文件留在磁盘但完全不被读取。文档提供一次性人工归档命令，不在应用启动时自动移动或删除。

这是代码和契约的一次性硬切，不是数据文件的自动销毁：升级不会导入旧内容，也不会删除旧内容。若确实需要保留其中某一条规则，用户应在升级前或升级后通过新的 `/remember`、`/context add` 或 Context 面板明确录入；录入后唯一事实源是服务托管的 Context Markdown。

## 失败处理

- 主题 Markdown 临时写入、复读校验或原子 rename 失败：该文档涉及的条目返回 failed，不声称“记住了”，并清理临时文件。
- Resolver 输出非法：显式请求返回 needs clarification；自动提取丢弃该候选并记录告警。
- 项目作用域缺 projectId：显式请求询问，自动候选不提交。
- 冲突：不覆盖，除非用户明确表达替换或随后确认 decision。
- Prompt 查询失败：记录告警并继续本轮，不让上下文服务阻断基本对话。
- 自动维护失败：不改变已完成 Run 状态。
- 删除不存在 ID：返回 not found，不做模糊成功。

## 可观测性

结构化事件至少包括：

```text
context.remember.committed
context.remember.noop
context.remember.needs_clarification
context.remember.rejected
context.entry.updated
context.entry.deleted
context.candidate.created
context.candidate.resolved
context.prompt.rendered
context.extraction.failed
```

日志只记录 entryId、scope、kind、confidence、sensitivity 和来源 ID；不记录敏感原文。

## 测试策略

- 领域测试：分类阈值、作用域、秘密检测、幂等、冲突、替换、候选策略。
- Markdown store 测试：固定主题路由、文档与 block schema 2、同主题批量写、原子重写、复读校验、同作用域锁、唯一 active key、pending 移动、候选清理、人工说明保留和非法 block 隔离。
- 服务测试：显式写入、澄清 decision、自动提取、查询排序和预算。
- Agent 工具测试：真实 host 调用、无 host 时不注册、工具结果不泄露路径。
- Prompt 测试：每轮读取最新上下文、项目规则覆盖用户偏好、旧文件完全不读取。
- HTTP/client/command 测试：新 CRUD 和候选管理，旧 `/memory` 返回 404。
- 文件工具测试：Context Markdown 根和 SOUL 被托管策略拒绝，普通工作区文件不受影响。
- daemon 集成测试：一次 Run 中 Remember 写入，下一轮无需重建 Agent 即可召回。
- 删除检查：`rg` 确认无 `USER.md`、`local_rules`、`MemoryManager`、`isMemoryWriteToolCall` 运行时代码引用。

## 验收标准

1. 用户说“记住以后回答简洁一些”，高置信度时直接保存为 user preference。
2. 用户说“记住这个项目用 pnpm”，直接保存为 project rule。
3. 用户说“记住我喜欢 pnpm”且上下文无法判断全局还是项目时，只问一次作用域。
4. 已有 npm 规则时保存 pnpm 会询问冲突，不静默覆盖。
5. API key、密码和私钥不能被保存，也不会出现在日志。
6. 自动发现非敏感项目 endpoint 可以高置信度写入；低置信度内容只进入候选。
7. 新写入内容在下一轮生效，不关闭或重建 Agent。
8. Agent 无法用 Write/Edit 修改托管 Context Markdown、SOUL 或凭据。
9. `/context` 和桌面面板能查看、修改、删除和管理候选。
10. 普通消息没有撤销胶囊。
11. `USER.md`、`rules.md`、旧 Project Memory 即使存在也不影响 Prompt。
12. Session Memory compact 连续性保持通过。
13. 一次保存整组 UI 规则时只产生一个 `user/ui-design.md`，其中包含多个可独立更新和检索的 entry blocks。

## 实施顺序

1. 建立领域类型、Markdown schema 和 `MarkdownContextStore`。
2. 建立 Resolver、冲突、敏感策略和统一服务。
3. 接入 Agent 工具和 daemon host。
4. 改造每轮查询和 Prompt 注入。
5. 接入自动提取和候选。
6. 提供 API、client、Slash 命令和桌面管理面板。
7. 加入托管资源保护。
8. 硬切删除旧实现、旧配置和旧 API。
9. 完成端到端验证、文档和遗留引用扫描。
