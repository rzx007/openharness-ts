# OpenHarness 文档目录

> 状态：文档总入口。最后核对：2026-08-23。

这里不是按文件名堆链接，而是按“先看全局，再逐层下钻”的顺序组织。第一次了解项目从第 0 层开始；修改具体模块时，直接进入对应层级。

本目录常用词的白话含义：

- durable：状态已经写进数据库或明确的持久文件，进程退出后还能查到。
- terminal：这项运行已经结束，例如 completed、failed、interrupted 或 killed，不能再假装回到 running。
- projection：把 Agent 运行中发生的事写成数据库记录和客户端可读状态。
- repository：保存和读取某类记录的明确接口，例如 daemon 的 SQLite Workflow repository。
- contract：代码重构后也不能静默改变的硬规则。
- snapshot：某一时刻的完整状态；SSE 是服务端持续推送后续变化的连接。

## 阅读顺序

```text
第 0 层：系统鸟瞰
  整个产品由哪些层组成，CLI/TUI/Web/Desktop/IDE/Bot/Workflow 怎样共用一套能力
    ↓
第 1 层：跨模块硬规则
  哪些状态归谁、记录长什么样、运行怎样收尾、失败后怎样恢复
    ↓
第 2 层：子系统架构
  Runtime、Durable Application、Client、Workflow、Jobs、Memory、Sandbox 各自怎样工作
    ↓
第 3 层：端到端流程
  一条 prompt、一个 child、一次 permission、一个 Bot 消息实际经过哪些步骤
    ↓
第 4 层：开发和运维入口
  SDK、CLI、daemon、远程连接、排障、备份恢复怎样使用
    ↓
第 5 层：决策与历史
  ADR 解释长期决定；plans/reviews 只解释当时怎样落地
```

## 第 0 层：系统鸟瞰

1. [OpenHarness 架构总览](./architecture-overview.md)：先看 CLI/TUI/Web/Desktop/IDE/Bot/Workflow 怎样共用一套 Application 和 Runtime。
2. [产品入口接入边界](./product-surface-integration.md)：再看每种产品自己负责什么、哪些状态必须共用。
3. [Framework 与 Durable Application 的能力边界](./agent-framework-capability-boundary.md)：继续下钻 Runtime、daemon 和产品界面的所有权。
4. [Daemon Application Architecture](./daemon-application-architecture.md)：追踪一个请求怎样进入 durable state 和 Agent Runtime。
5. [Client Sync Flow](./client-sync-flow.md)：理解 snapshot、SSE、cursor 和多端收敛。

## 第 1 层：跨模块硬规则

这一层记录“不管内部类名怎么改，都必须一直成立”的约束。

| 核心保证 | 当前权威落点 | 覆盖情况 |
|---|---|---|
| 每条运行记录有稳定 ID、固定字段、版本和关系 | [Durable Execution Data Model](./durable-execution-data-model.md) | 已有权威数据模型 |
| 每个 Run、Attempt、Tool、Child 和 Workflow 最终都进入明确终态 | [Agent Lifecycle Contract](./agent-lifecycle-contract.md)、[Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md) | 已有权威契约 |
| 子 Agent 不得无限递归、无限并发或靠关闭后重建绕过上限 | [Agent Child Session Flow：Child 预算](./agent-child-session-flow.md#child-预算防止无限叫人) | 已完整记录 |
| 相同请求可以安全重试，不同内容不能复用同一个 ID | [Durable Execution Data Model：ID 和安全重试](./durable-execution-data-model.md#id-和安全重试) | 已记录 |
| 已结束状态不能被迟到事件重新改回 running | [Agent Lifecycle Contract：D3](./agent-lifecycle-contract.md#daemon)、[Jobs Protocol：状态机](./jobs-protocol.md#状态机) | 已记录 |
| 投影失败不能假装成功，重启后要继续收束 | [Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md)、[Agent Lifecycle Contract：P8](./agent-lifecycle-contract.md#durable-projection) | 已记录 |
| 一个数据目录只有一个活动 Application Owner | [Operations and Recovery：Application Owner](./operations-and-recovery.md#application-owner) | 已有权威操作手册 |
| 客户端与服务端必须使用完全相同的协议版本 | [Protocol Contract](./protocol-contract.md) | 已有权威协议契约 |
| 清理、备份和恢复不能留下半完成状态 | [Operations and Recovery](./operations-and-recovery.md) | 已有权威操作手册 |

你举的三项目前对应关系是：

```text
固定格式的运行记录  → durable-execution-data-model.md
所有运行正确收尾    → agent-lifecycle-contract.md 是权威契约
限制子 Agent        → agent-child-session-flow.md 的 Child 预算章节
```

## 第 2 层：子系统架构

### Agent Runtime Kernel

- [Agent Runtime 框架架构](./agent-runtime-framework-architecture.md)：Kernel 对象、创建流程、Run、事件、Handle 和状态机。
- [OpenHarness Agent SDK](./agent-sdk.md)：程序中怎样直接创建和使用 Agent。
- [Agent Child Session Flow](./agent-child-session-flow.md)：child 创建、等待、follow-up、预算、关闭和 durable 投影。
- [CompactService](./compact-service-design.md)：上下文压缩、checkpoint、Tool 配对和失败策略。
- [Prompt Layering](./prompt-layering-design.md)：系统提示词怎样分层组装。
- [Output Styles](./output-styles-design.md)：输出风格怎样进入 prompt 和产品界面。
- [Personalization](./personalization-design.md)：用户个性化设置的边界。

### Durable Agent Application

- [Daemon Application Architecture](./daemon-application-architecture.md)：Session、Input、Run、Permission、Workflow、Owner、恢复和关闭的总入口。
- [Durable Execution Data Model](./durable-execution-data-model.md)：所有运行记录的固定格式、关系、终态和版本。
- [Protocol Contract](./protocol-contract.md)：协议版本、请求错误、snapshot、SSE 和升级规则。
- [Client Sync Flow](./client-sync-flow.md)：HTTP client、snapshot、SSE、cursor 和 reducer。
- [Observability](./observability.md)：trace、结构化日志、runtime snapshot 和排障。
- [Scheduled Tasks Flow](./scheduled-tasks-flow.md)：定时任务怎样保存、触发、运行和记录结果。
- [Channels Flow](./channels-flow.md)：Bot/Channel 消息怎样进入同一套 durable Session/Run。
- [Daemon System Service](./daemon-system-service.md)：daemon 怎样作为系统常驻服务运行。

### Workflow、Coordinator 与 Jobs

- [Coordinator 硬调度器调用链](./coordinator-hard-scheduler-flow.md)：DAG、并发、重试、预算、repository 和 child runner。
- [Coordinator Agents](./coordinator-agents-design.md)：Coordinator 角色与 Agent 定义。
- [Jobs Protocol](./jobs-protocol.md)：Terminal、shell、Agent、dream、Workflow 的统一观察与控制协议。
- [Workflow CLI](./workflow-cli.md)：项目文件 CLI 与 daemon SQLite Workflow 的边界。
- [Workflow Scheduler Tests](./workflow-scheduler-test.md)：调度器的测试场景。

### Context、Memory 与 Prompt

- [Context And Memory Map](./context-memory-map.md)：进入模型上下文的信息总图。
- [Memory System](./memory-system.md)：Memory 的读取、写入和检索。
- [Memory Quartet](./services-memory-quartet-design.md)：四类 memory service 的职责。
- [Prompt Runtime Audit](./prompt-runtime-audit.md)：prompt 运行时审计记录。

### 工具、扩展与执行环境

- [Permission Flow](./permission-flow.md)：权限请求、durable decision 和取消。
- [Sandbox Runtime Flow](./sandbox-runtime-flow.md)：命令和文件工具实际在哪里执行。
- [Sandbox Runtime Design](./sandbox-runtime-design.md)：Sandbox 的详细设计。
- [MCP HTTP Transport](./mcp-http-transport-design.md)：MCP HTTP/SSE 与鉴权。
- [Plugin Contributions](./plugins-contributions-design.md)：插件怎样贡献 commands、skills 和其他能力。
- [Skills Flow](./skills-flow.md) 与 [Skills Enhancement](./skills-enhance-design.md)：Skill 的发现、加载和增强。
- [Slash Commands](./slash-commands.md)、[Slash Command Flow](./slash-commands-flow.md)、[Slash Batch](./slash-batch-design.md)：命令入口和批处理。

### 产品界面

- [Product Surface Integration](./product-surface-integration.md)：各种上层产品共同使用 Application 的规则。
- [TUI Flow](./tui-flow.md)：TUI 怎样连接 daemon 和渲染运行状态。
- [Desktop Agent Message Rendering](./desktop-agent-message-rendering.md)：Desktop 消息和文件变更展示。
- [Desktop Terminal PTY](./desktop-terminal-pty-design.md)：Desktop 终端、PTY、IPC 和 Sandbox。

## 第 3 层：端到端流程

按实际问题找文档：

| 想追踪的流程 | 文档 |
|---|---|
| 用户发送 prompt，直到 Run 和 transcript 收尾 | [Daemon Application Architecture：TUI 发送 hi](./daemon-application-architecture.md#tui-发送-hi) |
| child Agent 创建、运行、继续输入和关闭 | [Agent Child Session Flow](./agent-child-session-flow.md) |
| Tool 请求权限，UI 回复，Run 继续 | [Permission Flow](./permission-flow.md) |
| Bot 收消息、幂等执行、发送或重试回复 | [Channels Flow](./channels-flow.md) |
| Workflow 拆任务、调度、持久化和恢复 | [Coordinator 硬调度器调用链](./coordinator-hard-scheduler-flow.md) |
| Job 创建后怎样 read/wait/send/cancel | [Jobs Protocol](./jobs-protocol.md) |
| 客户端首次同步、断线重连和去重 | [Client Sync Flow](./client-sync-flow.md) |
| Sandbox 中怎样启动和停止进程 | [Sandbox Runtime Flow](./sandbox-runtime-flow.md) |
| 定时任务到点后怎样启动 Agent | [Scheduled Tasks Flow](./scheduled-tasks-flow.md) |
| TUI 怎样 attach daemon | [TUI Flow](./tui-flow.md) |

## 第 4 层：开发和运维入口

- 直接嵌入 Agent：[OpenHarness Agent SDK](./agent-sdk.md)
- 使用 Workflow 文件 CLI：[Workflow CLI](./workflow-cli.md)
- 使用 slash command：[Slash Commands](./slash-commands.md)
- 远程连接 daemon：[Remote Attach](./remote-attach.md)
- 安装和管理常驻 daemon：[Daemon System Service](./daemon-system-service.md)
- 配置认证、Provider 和 Model：[Auth、Provider、Model](./auth-provider-model.md)
- 查看 trace、metrics 和运行诊断：[Observability](./observability.md)
- 处理启动恢复、Owner、Retention 和备份：[Operations and Recovery](./operations-and-recovery.md)
- 检查认证、权限和 Sandbox 边界：[Security and Trust Boundaries](./security-and-trust-boundaries.md)

## 第 5 层：决策、计划和历史

- `docs/adr/`：已经作出的长期决定。当前有 [Projection Settlement 失败分类与恢复边界](./adr/0001-projection-settlement-failure-policy.md)。
- `docs/plans/`：阶段实施计划和完成记录，不是当前 API 手册。
- `docs/superpowers/plans/`、`docs/superpowers/specs/`：更细的历史实施过程。
- 文件名包含 `review`、`notes` 或明确标为“历史设计”的文档：用于解释过去，不用于决定当前 API。

当前文档、ADR、计划和历史发生冲突时，优先级是：

```text
当前代码、migration、自动化测试
  > 标为“权威契约 / 当前实现”的文档
  > ADR
  > plans、specs、reviews 和历史设计
```

## 文档建设状态

详细设计与当时缺口见 [文档体系设计与缺口](./plans/2026-08-23-documentation-architecture-and-gaps.md)。P0/P1 主文档已经完成：

| 优先级 | 建议文档 | 解决的问题 |
|---|---|---|
| P0 | [Architecture Overview](./architecture-overview.md) | 已完成 |
| P0 | [Durable Execution Data Model](./durable-execution-data-model.md) | 已完成 |
| P0 | [Operations and Recovery](./operations-and-recovery.md) | 已完成 |
| P1 | [Protocol Contract](./protocol-contract.md) | 已完成 |
| P1 | [Product Surface Integration](./product-surface-integration.md) | 已完成 |
| P1 | [Security and Trust Boundaries](./security-and-trust-boundaries.md) | 已完成 |
| P2 | `contract-test-index.md` | 待做：把每条硬规则映射到测试文件，并尽量由脚本检查 |

## 仍需整理的现有文档

- [Runtime Hardening 与可运维性计划](./plans/2026-08-22-runtime-hardening-and-operability.md) 已标为历史完成记录，正文仍保留当时的实施语境。
- [Session 存储增强](./session-storage-design.md) 已标为历史资料，不再作为 daemon SQLite 存储说明。
- [Observability](./observability.md) 还没有覆盖 Run/Tool Attempt 指标、Application Owner 丢失、Workflow、Retention 和 Backup 诊断。
- [Client Sync Flow](./client-sync-flow.md) 仍带有 phase 1/phase 2 的实施口吻，应重新核对当前 Jobs 刷新和事件能力。
- [待修复 Bug 存档](./bugs-unfixed.md) 来自较早审计，需要重新确认每一项是否仍存在，不能继续当当前缺陷列表。
- 多份 `*-design.md` 没有状态标记，需要逐步补上“当前实现 / 待实现 / 历史设计”。

## 当前格式策略

项目已经删除旧 API 别名、re-export façade、字段别名和旧数据读取路径。当前版本只接受当前接口和当前数据格式：

- SQLite、event、settings、Session snapshot、Memory 和 Swarm 文件都有明确版本标记；
- 缺失标记、版本不同、字段缺失或字段名过时都会直接失败；
- 不做自动 migration、读取时升级或旧数据猜测；
- 格式切换和恢复步骤见 [Operations and Recovery](./operations-and-recovery.md#破坏性格式切换)。

## 写文档时的约定

- 当前文档先讲入口、关键步骤、状态放在哪里、结果从哪里返回，再讲类型名。
- 第一次出现英文术语时，要同时解释它实际做什么。
- 一条跨模块硬规则只指定一份权威文档，其他地方链接过去，不复制整段契约。
- 每份当前文档开头必须标明“当前实现”或“权威契约”；计划和历史资料也必须明确状态。
- 计划完成后把状态改成“已完成”，并把计划开始前的问题写成“当时基线”。
- 修改公开入口、持久化格式、协议版本、状态机或所有权边界时，必须同步更新本目录和对应权威文档。
- 不增加兼容代码来维持过时文档。
