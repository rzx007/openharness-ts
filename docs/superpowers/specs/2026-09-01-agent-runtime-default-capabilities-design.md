# Agent Runtime 默认能力与 Host 扩展设计

> 状态：已完成设计讨论，等待书面规格审查。本文只定义架构与迁移边界，不包含实现。

## 背景

OpenHarness 现有 Terminal、后台 Shell、Jobs、附件、长期记忆、Workflow、Schedules 等功能本身已经比较完整，但组装方式不够自洽：多项基础能力依赖 Host 注入，只要 Host 没有提供，Agent 就会失去对应能力。

当前最明显的问题是，`composeOpenHarnessAgent()` 只在完全没有 `hostCapabilities` 对象时创建本地 Jobs 和 Background Shell。Host 即使只想接管权限或 Terminal，也可能意外关闭无关的本地默认能力。与此同时，工具注册根据一组 capability boolean 判断，真正的实现又在后续通过 `QueryEngine.set*()` 接入，两条链可能发生漂移。

长期记忆也暴露了同一个所有权问题：读取记忆、选择相关内容、注入模型上下文和提供 `Remember` 是 Agent 自身行为；Markdown 写到哪里、是否提供管理 UI、是否跨设备同步才是可替换的存储和业务能力。不能为了让 daemon 管理记忆，就让 daemon 成为 Agent 拥有记忆的前提。

本设计的核心目标是：

> `DefaultNodeAgent` 是完整、开箱即用的 Node Agent；Host 可以逐项替换、包装或明确关闭能力，但不负责从零拼装 Agent。

## 设计目标

1. `createDefaultNodeAgent({ cwd })` 在没有 daemon 或其他 Host 能力注入时，默认拥有本地工作所需的基础能力。
2. `AgentKernel` 保持跨平台，不直接绑定 Node PTY、子进程或本机文件系统。
3. Host 覆盖一项能力时，不影响其他未提及能力。
4. 工具、执行实现、系统提示词、compact 上下文和能力报告使用同一份最终能力结果。
5. Agent 行为与底层实现分离：Feature 决定 Agent 怎样使用能力，Capability 实现负责操作外部资源。
6. 长期记忆继续使用 OpenHarness 的 `Remember` 语义和现有 Markdown 格式，模型不接触受管记忆路径。
7. 子 Agent 继承覆盖意图和工具上限，不直接共享父 Agent 的本地默认实例。
8. Host-owned 资源不由 Agent 释放，runtime-owned 资源可靠、幂等地清理。
9. 不保留旧 `hostCapabilities` 双轨兼容。

## 非目标

本次不做：

- 不恢复此前实验分支上的 `ContextPersistenceService`。
- 不把长期记忆写入 SQLite。
- 不修改现有持久记忆 Markdown schema 和目录结构。
- 不增加记忆管理 UI、跨设备同步或组织级记忆。
- 不重新实现 managed `Remember`；它是本设计直接复用的现有基础。
- 不把 Terminal、Jobs、Attachments 和 Memory 统一成一个巨型 Backend。
- 不建立公开的通用 Feature 插件框架。
- 不增加不耐久的进程内 Schedule 默认实现。
- 不增加 OCR 默认实现。
- 不改变模型、MCP、Plugin 的产品语义。

## 外部方案参考

Deep Agents 的做法提供了三个有用参照：

- 构造函数先安装完整的默认 middleware，再允许调用方按名称替换或追加行为。
- Memory middleware 负责读取并注入记忆，Backend 决定内容来自线程状态、本地文件还是远程 Store。
- Node 与 browser 使用不同入口；Node-only 的本地文件和 Shell 实现不进入 browser 入口。

OpenHarness 吸收“默认完整组装、行为与存储分离、逐项覆盖”的原则，但不照搬统一文件 Backend，也不让模型用通用 `edit_file` 修改长期记忆。

参考：

- <https://docs.langchain.com/oss/javascript/deepagents/memory>
- <https://docs.langchain.com/oss/javascript/deepagents/backends>
- <https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/agent.ts>
- <https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/memory.ts>
- <https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/utils.ts>

## 总体架构

```text
Host：daemon / desktop / CLI / SDK 调用方
  只提供能力覆盖、权限交互、业务管理和 UI
                    │
                    │ capabilityOverrides / effects
                    ▼
DefaultNodeAgent
  创建默认 Node 能力工厂
  逐项应用覆盖或禁用
  得到 ResolvedAgentCapabilities
  安装 Agent Features
                    │
                    ▼
Agent Features
  Memory / Terminal / Jobs / Background Shell
  Attachments / Workflow / Skills / Child Agent / Context
  决定 Agent 如何理解和使用能力
                    │
                    ▼
AgentKernel
  模型循环、工具执行、权限判断、事件、中断和状态
  不创建 Node 进程、PTY 或本机持久化
```

### 所有权规则

- Kernel 拥有运行机制。
- Feature 拥有 Agent 行为。
- Capability 实现拥有外部资源操作。
- `DefaultNodeAgent` 拥有默认组装。
- Host 只拥有覆盖、权限交互和业务增强。

### 包级职责

```text
packages/core
  跨平台能力协议、事件、Kernel 所需基础类型

packages/agent-runtime
  AgentKernel
  Capability Resolver
  内部 Feature 安装函数
  DefaultNodeAgent 组装入口
  Node 默认能力适配层

packages/terminal
  可移植 Terminal 协议

packages/terminal-node
  LocalTerminalProvider 等 Node Terminal 实现

packages/jobs
  可移植 Job 协议

packages/tools
  Feature 使用的模型工具和 LocalAgentJobHost

packages/config / packages/core 现有配置模块
  配置目录与受管路径解析

packages/server / apps/daemon
  daemon 能力实现、覆盖接线、持久任务、权限 UI 和业务管理
```

默认 Markdown 记忆实现先留在 agent-runtime 现有边界内，不为了形式统一提前拆新包。

## Kernel 与 DefaultNodeAgent 的边界

### AgentKernel

Kernel 负责：

- 模型与工具调用循环。
- Run 状态、事件、中断和取消。
- 权限判断结果的执行。
- 接收已经解析完成的能力和工具。
- Feature 所需的稳定运行入口。

Kernel 不负责：

- 寻找 Host 或本机默认能力。
- 创建 PTY、Node 子进程或本地存储。
- 推断某个 Host 没传的能力是否应当存在。

直接使用低层 Kernel 时，调用方可以显式组装受限或测试运行时。完整默认体验定义在 `DefaultNodeAgent`。

### DefaultNodeAgent

`DefaultNodeAgent` 是普通 Node 调用方的主要入口，负责：

1. 读取 cwd、session、Settings 和本机配置。
2. 发现 Skills、Plugins、MCP 和 Agent 定义。
3. 创建默认 Node capability factories。
4. 逐项应用 capability overrides。
5. 安装默认 Agent Features。
6. 管理 runtime-owned 资源。
7. 返回已经能工作的 Agent。

## 公开 API

旧的 `hostCapabilities` 替换为 `capabilityOverrides`。新名称明确表示调用方只提交差异，而不是 Agent 的完整能力清单。

```ts
type CapabilityOverride<T> = T | false;

interface AgentCapabilityOverrides {
  terminal?: CapabilityOverride<AgentTerminalHost>;
  jobs?: CapabilityOverride<AgentJobHost>;
  backgroundShell?: CapabilityOverride<AgentBackgroundShellHost>;
  attachments?: CapabilityOverride<AgentAttachmentResourceHost>;
  memory?: CapabilityOverride<AgentMemoryStore>;
  childEnvironment?: CapabilityOverride<AgentChildEnvironmentProvider>;
  workflowRepository?: CapabilityOverride<WorkflowRunRepository>;
  imageToText?: CapabilityOverride<AgentImageToTextHost>;
  schedules?: CapabilityOverride<AgentScheduleEffects>;
}

interface AgentEffectOverrides {
  requestPermission?: AgentEffects["requestPermission"];
}
```

用法：

```ts
const agent = await createDefaultNodeAgent({
  cwd,
  capabilityOverrides: {
    terminal: daemonTerminal,
    jobs: daemonJobs,
    attachments: false,
    memory: daemonMemoryStore,
  },
  effects: {
    requestPermission: daemonPermissionPrompt,
  },
});
```

### 三态覆盖规则

| 输入 | 结果 |
|---|---|
| 未提供或 `undefined` | 使用 `DefaultNodeAgent` 的默认实现 |
| 具体实现对象 | 使用调用方实现 |
| `false` | 明确关闭，不创建默认实现 |

增加一个 override 不能改变其他未提及能力。

## 默认能力工厂

默认实现按需创建，不先创建所有对象再覆盖：

```ts
interface DefaultNodeCapabilityFactories {
  terminal(): Promise<AgentTerminalHost>;
  jobs(): Promise<AgentJobHost>;
  backgroundShell(): Promise<AgentBackgroundShellHost>;
  attachments(): Promise<AgentAttachmentResourceHost>;
  memory(): Promise<AgentMemoryStore>;
  childEnvironment(): Promise<AgentChildEnvironmentProvider>;
  workflowRepository(): Promise<WorkflowRunRepository>;
}
```

如果 override 是对象或 `false`，对应默认 factory 不执行。

Jobs 和 Background Shell 可以共享一个带缓存的 `LocalAgentJobHost`。共享实现不改变它们在 Agent 层的不同语义。同一 runtime-owned 实例只登记和执行一次 cleanup。

默认能力存在创建顺序依赖：`LocalAgentJobHost` 需要 `AgentChildManager`，而 Child Manager 先需要 `childEnvironment`。组装采用两个明确阶段，不引入通用依赖注入容器：

```text
阶段一：解析 childEnvironment，创建 AgentChildManager
阶段二：解析 Jobs、Background Shell 和其他能力，安装 Features
```

## 最终能力结果

```ts
type ResolvedCapability<T> =
  | {
      status: "available";
      implementation: T;
      source: "default" | "override";
      owner: "runtime" | "host";
    }
  | {
      status: "disabled";
      reason: "explicitly-disabled";
    }
  | {
      status: "unavailable";
      reason: string;
    };

interface ResolvedAgentCapabilities {
  terminal: ResolvedCapability<AgentTerminalHost>;
  jobs: ResolvedCapability<AgentJobHost>;
  backgroundShell: ResolvedCapability<AgentBackgroundShellHost>;
  attachments: ResolvedCapability<AgentAttachmentResourceHost>;
  memory: ResolvedCapability<AgentMemoryStore>;
  childEnvironment: ResolvedCapability<AgentChildEnvironmentProvider>;
  workflowRepository: ResolvedCapability<WorkflowRunRepository>;
  imageToText: ResolvedCapability<AgentImageToTextHost>;
  schedules: ResolvedCapability<AgentScheduleEffects>;
}
```

`disabled` 表示调用方有意关闭；`unavailable` 表示这个发行环境没有提供可选实现。承诺存在或明确覆盖的能力初始化失败时，Agent 创建直接失败，不保留长期 `failed` 状态。

工具注册、`QueryEngine` 接线、系统提示词、Feature 安装、compact 内容、子 Agent 组装和诊断全部读取这份结果。删除为了工具注册单独生成的 capability boolean 投影。

## 默认能力清单

| 能力 | DefaultNodeAgent 默认行为 | 分类 |
|---|---|---|
| Files | 现有工作区文件工具 | 基础 |
| Terminal | 基于 `@openharness/terminal-node` 的本地实现 | 基础 |
| Jobs | 本地 Job Host | 基础 |
| Background Shell | 与本地 Job Host 共享底层实现 | 基础 |
| Attachments | 本地附件资源实现 | 基础 |
| Memory | 现有 managed Remember + Markdown 记忆 | 基础 |
| Child Environment | 默认 Node 子 Agent 环境 | 基础 |
| Workflow | Agent Workflow + 本地文件 Repository | 基础 |
| Skills | 现有本地发现和按需加载 | 基础行为 |
| Image to Text | 没有 Provider 时 unavailable | 可选增强 |
| Schedules | 没有持久调度器时 unavailable | 可选增强 |

## Agent Feature 接线

第一版不发布通用 Feature 插件协议，只在 agent-runtime 内使用明确安装函数：

```ts
installMemoryFeature(context);
installTerminalFeature(context);
installJobsFeature(context);
installBackgroundShellFeature(context);
installAttachmentsFeature(context);
installWorkflowFeature(context);
installScheduleFeature(context);
installImageToTextFeature(context);
installChildAgentFeature(context);
```

内部安装上下文提供：

- 最终能力结果。
- Runtime / QueryEngine。
- Tool 注册。
- Prompt section 注册。
- Compact contributor 注册。
- Cleanup 注册。

每个 Feature 集中处理自己的工具、实际实现、提示词和上下文贡献。例如 Terminal 只有在能力为 available 时，同时注册工具、接入实现并增加提示词。不存在工具和实现分别判断的路径。

## 权限模型

`requestPermission` 不再是创建 Agent 的必填 Host capability，而是可选交互 Effect。

```text
PermissionChecker → allow
  直接执行，不依赖 Host

PermissionChecker → deny
  直接拒绝

PermissionChecker → ask，存在 requestPermission
  交给 Host/CLI UI 确认

PermissionChecker → ask，不存在 requestPermission
  安全拒绝，并说明当前没有交互审批器

permissionMode = full_auto
  按现有显式授权语义执行
```

权限拒绝是单次操作结果，不会把能力标记成 unavailable。

## 长期记忆

长期记忆采用 OpenHarness 自己的专用语义：

```text
MemoryFeature
  读取和检索相关记忆
  注入当前模型上下文
  注册 managed Remember
  执行现有 Run 后自动提取
  处理记忆 Feature 生命周期

AgentMemoryStore / 现有 AgentMemoryRuntime
  使用现有 Markdown 数据和路径解析
```

本次保持以下现有行为：

- user scope 通过受管入口更新配置目录的 `USER.md`。
- project scope 通过现有 `MemoryManager` 写当前项目 Markdown 记忆。
- 通用 Write/Edit 不能修改受管记忆路径。
- Run 已主动 Remember 时，自动提取不重复写入。
- 相关记忆按用户输入检索并临时注入，不写进消息历史。
- 模型不知道受管记忆的真实路径，也不负责选择 Write/Edit。

Memory Feature 属于 agent-runtime。daemon 可以覆盖底层 Store 或增加 UI，但不接管记忆读取、注入和 Remember 语义。

### 长期记忆与 Session Memory

二者必须保持分离：

- 长期记忆跨会话，保存稳定偏好、事实和项目知识。
- Session Memory 是当前会话的 compact checkpoint，保存当前目标、下一步和近期工作状态。

Markdown Memory Store 不负责 compact checkpoint；daemon 的 session checkpoint 也不接管长期偏好。

## Compact 上下文贡献者

当前 compact 最终仍可接收一个附件对象，但对象不再要求由某一个 Host provider 同时理解所有字段。agent-runtime 内聚合多个 Feature contributor：

```text
AttachmentsFeature ───────┐
SessionContextFeature ────┼─→ CompactContext
未来其他 Feature ─────────┘
```

示意：

```ts
addCompactContributor("attachments", async () => ({
  attachmentCatalog: await buildAttachmentCatalog(),
}));

addCompactContributor("session-memory", async () => ({
  sessionMemory: await readSessionCheckpoint(),
}));
```

daemon 替换附件实现时，只影响 Attachments Feature；Session Memory contributor 继续由 agent-runtime 安装，避免再次出现附件 provider 漏传 checkpoint 的接线问题。

## Workflow

Workflow 是 Agent 基础能力，不是纯 Host 能力。它分成：

```text
WorkflowFeature
  DAG 验证、模板、执行计划、子 Agent worker、重试
  history、timeline、resume、reconcile

WorkflowRunRepository
  保存和读取 Workflow Run 快照与事件
```

`DefaultNodeAgent` 默认使用现有 `FileWorkflowRunRepository({ cwd })`，安装现有 Workflow 工具。工具参数和运行语义不因本设计改变。

daemon 只需覆盖 Repository：

```ts
capabilityOverrides: {
  workflowRepository: daemonWorkflowRepository,
}
```

`workflowRepository: false` 明确关闭 Workflow Feature。第一阶段不把 API 扩展成可替换整个 Workflow Engine。

## Schedules

Schedules 工具和任务语义保持不变，但接线从 `AgentEffects.schedules` 移到 capability：

```text
capabilityOverrides.schedules
  → ResolvedAgentCapabilities.schedules
  → ScheduleFeature
  → 注册并接入现有 schedule 工具
```

Schedule 是有持久状态的长期服务，不是一次性 UI Effect。

普通 `DefaultNodeAgent` 不提供基于 `setTimeout()` 的伪持久调度器。进程退出后不能继续唤醒任务的实现不符合 Schedule 契约。因此 standalone 默认 unavailable，daemon 或未来常驻本地 scheduler 可以提供 override。

## Attachments、Terminal、Jobs 与 Background Shell

### Attachments

Attachments Feature 负责工具、模型上下文、compact 目录和实现接线；`AgentAttachmentResourceHost` 只负责解析资源、读取内容、返回 MIME 元数据和执行路径边界。

没有附件目录是正常状态；附件根配置非法属于初始化错误；读取某个不存在附件是单次工具错误。

### Terminal 与 Jobs

仓库已有 `@openharness/terminal-node` 的 `LocalTerminalProvider`。默认 Node 能力适配它，不重新实现 PTY。

由于 Terminal 的观察和控制使用 Agent Job 工具，本地默认适配还必须把 Terminal 会话投影到 Job list/read/wait/send/cancel。它复用现有协议和 provider，不创建新的 Terminal 子系统。

Jobs 与 Background Shell 可以共享 LocalAgentJobHost，但仍由不同 Feature 提供不同工具语义。

## 子 Agent 继承

子 Agent 继承的是原始覆盖意图和工具限制，不是父 Agent 的 resolved default 实例：

| 父级来源 | 子 Agent 行为 |
|---|---|
| 父级使用默认实现 | 按子 Agent cwd/session 创建自己的默认实现 |
| 父级使用 Host override | 继续借用相同 Host override |
| 父级显式 `false` | 同样 disabled |
| 父级环境 unavailable | 子 Agent 重新解析，不继承失败结果 |

这样可以避免子 Agent 复用父 Terminal session、父 JobHost 或释放父资源。

最终工具集合仍满足：

```text
实际能力可用
  ∩ Host Tool Ceiling
  ∩ Agent Role Allowed Tools
  - Disallowed Tools
```

能力 available 不表示所有角色都能看见对应工具。

## 错误与降级

### 必须创建成功

- Settings、模型客户端、Kernel、Tool Registry、Session 等结构依赖。
- 未显式关闭的 DefaultNodeAgent 基础能力。
- 调用方明确提供的 override 及对应 Feature。

这些初始化失败时，组装终止并清理已创建资源。

### 可以 unavailable

- 没有默认 Provider 的 Image to Text。
- 没有持久调度器的 Schedules。

### 单次工具错误

命令非零退出、附件不存在、Job 启动失败、记忆被安全规则拒绝或权限拒绝，不改变 capability status。工具返回结构化错误，能力仍为 available。

### 组装错误

统一错误至少包含：

- stage：settings、capability-resolution、feature-installation、extension-setup、mcp-connection 或 session-creation。
- capability / feature 名称。
- 原始 cause。
- cleanup errors。

错误消息同时告诉调用方可以修复环境、提供 override，或者用 `false` 明确禁用。

## 生命周期

- runtime 创建的能力标记 `owner: runtime`，由 Agent 清理。
- override 标记 `owner: host`，Agent 不调用其 dispose。
- 共享实例只清理一次。
- 清理按成功创建的逆序执行。
- 一项清理失败不阻止其他清理。
- 原始创建错误保持主错误，清理错误附加汇总。
- `agent.close()` 幂等。

Feature 安装是事务性的：任一必需 Feature 安装失败，不返回半组装 Agent。

## 能力诊断

Agent 提供只读能力快照，例如：

```ts
agent.getCapabilities();
```

```ts
{
  terminal: { status: "available", source: "default" },
  jobs: { status: "available", source: "override" },
  attachments: { status: "disabled" },
  schedules: {
    status: "unavailable",
    reason: "No persistent scheduler configured",
  },
}
```

同时发送 `agent.capabilities.resolved` 事件，供 daemon、CLI 和测试诊断。

诊断不得暴露实现对象、记忆路径、附件根目录、环境变量、API key 或其他敏感配置。

## Plugin 与 MCP

Plugin 和 MCP 是额外工具来源，不进入基础 `ResolvedAgentCapabilities`。

建议组装顺序：

```text
安装内置 Features
  → 安装发现到的 Plugins
  → 连接和注册 MCP Tools
  → 应用最终工具白名单、黑名单和角色上限
```

Plugin 若要替换内置能力，必须走明确 capability override 或未来的 Feature 替换接口，不能通过同名工具暗中覆盖。

本次不改变现有 Plugin/MCP 的失败策略，只把错误标记在正确组装阶段。

## API 迁移

旧 API：

```ts
createDefaultNodeAgent({
  hostCapabilities: {
    permissions: { requestPermission },
    terminal,
    jobs,
    schedules,
  },
});
```

新 API：

```ts
createDefaultNodeAgent({
  capabilityOverrides: {
    terminal,
    jobs,
    schedules,
  },
  effects: {
    requestPermission,
  },
});
```

在 monorepo 内一次性迁移 agent-runtime、SDK、daemon/server、CLI、测试、示例和文档。删除：

- `AgentHostCapabilities`。
- `hostCapabilities` 配置项。
- “Host 对象存在就关闭默认能力”的判断。
- 工具注册使用的 capability boolean 投影。
- `AgentEffects.schedules`。

不保留旧 API 适配层，changelog 明确记录不兼容变更。

## 测试契约

### Capability Resolver

- undefined 使用默认 factory。
- 对象使用 override 且不调用默认 factory。
- false 标记 disabled 且不调用默认 factory。
- 可选能力无实现时 unavailable。
- 基础默认创建失败和 override 安装失败都产生组装错误。
- 只覆盖 Terminal 时，Jobs、Background Shell、Memory、Attachments 和 Workflow 仍为 default available。

### 惰性创建与共享资源

- 覆盖或关闭的能力不创建默认对象。
- Jobs 与 Background Shell 同时默认时只创建一个 LocalAgentJobHost。
- 两者都被覆盖时不创建 LocalAgentJobHost。

### Feature 一致性

每项 capability 为 available、disabled、unavailable 时，工具、QueryEngine 实现和提示词状态一致，不存在半接线。

### 无 Host 集成

不传 Host、Terminal、Jobs、Attachments、Memory 和权限回调时，DefaultNodeAgent 的 Files、Terminal、Jobs、Background Shell、Attachments、Memory、Child Environment 和 Workflow 可用。

使用 fake model client，不依赖真实模型网络。

### Terminal/Job 联合契约

- 打开本地 Terminal。
- Job list 能看见 Terminal。
- Job read/send/wait/cancel 可工作。
- Agent 关闭时进程正确回收。

### 权限

- allow 无 Host 也执行。
- deny 直接拒绝。
- ask 有回调时遵循批准或拒绝。
- ask 无回调时安全拒绝并说明原因。
- full_auto 沿用现有显式授权。
- 权限拒绝不改变能力状态。

### Memory

- 自动检索和注入相关记忆。
- managed Remember 按 user/project scope 写现有 Markdown 存储。
- 模型输入和工具参数不包含受管真实路径。
- Run 内已 Remember 时不重复自动提取。
- `memory: false` 时不读写、不注册工具。
- Host Memory Store 只替换存储，不改变 Feature 行为。
- 通用 Write/Edit 继续拒绝受管记忆路径。

### Compact

- attachment catalog 和 session memory contributor 同时进入 compact。
- daemon 只替换附件时，session memory 仍被注入。

### 子 Agent

- 默认能力按子 cwd/session 重新创建。
- Host override 被借用但不由子 Agent 释放。
- false 继续传播。
- tool ceiling 和 role restrictions 仍生效。

### Workflow 与 Schedules

- 无 Host 时 Workflow 使用 FileWorkflowRunRepository，可 run/history/timeline/resume/reconcile。
- daemon Repository override 保持现有 Workflow 行为。
- `workflowRepository: false` 隐藏 Workflow Feature。
- standalone Schedules 为 unavailable 且不暴露工具。
- daemon Schedule override 安装现有 Schedule 工具。

### 生命周期与 daemon

- runtime-owned 逆序且一次性释放。
- host-owned 不释放。
- 安装失败完成回滚。
- daemon 现有 Terminal、Jobs、Attachments、Session 和事件流回归通过。
- daemon 只覆盖一项能力时，其他能力仍回退默认实现。

## 完成标准

1. 无 Host 时 DefaultNodeAgent 的基础能力集成测试通过。
2. 覆盖一项能力不会移除其他默认能力。
3. `false` 是唯一显式关闭方式。
4. 权限回调不再是创建 Agent 的必填项。
5. 工具、实现、提示词和上下文使用同一份 resolved capabilities。
6. Memory 由 agent-runtime 主导，模型不接触受管记忆路径。
7. Workflow 默认可用，Schedules 在没有持久调度器时明确 unavailable。
8. compact 独立聚合 attachment catalog 与 session memory。
9. 子 Agent 创建自己的默认资源，只继承覆盖意图。
10. Host-owned 资源不会被 Agent 释放。
11. daemon 现有功能保持通过。
12. 旧 `hostCapabilities` 与 `AgentEffects.schedules` 完全移除，不保留双轨。
