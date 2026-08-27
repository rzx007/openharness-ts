# Durable Job Admission 与 Producer 协议设计

> 状态：已按里程碑落地，当前行为以 [Jobs Protocol](../jobs-protocol.md) 为准。
>
> 本文保留这次改造的设计理由和取舍：持久记账与真实执行仍是两个职责，但二者之间改成“先登记，再启动，按同一个 `jobId` 幂等执行”。接口细节和当前行为以 Jobs Protocol 为准。

## 一、问题与结论

后台 shell 同时涉及两件不同的事：

1. 在操作系统中启动、观察和停止一个真实进程。
2. 让 `JobRead`、`JobList`、`JobWait` 和 `JobCancel` 能稳定找到这项工作。

这两个职责应该分开，但不能各自维护一套互不相干的内存状态。旧问题的本质不是“职责分开”，而是创建方生成 `task_1` 并放入自己的内存表后，查询方没有收到可靠、持久、可恢复的交接结果。

目标架构采用下面的原则：

> Job Registry 先分配并持久化 `jobId`，Producer 再使用这个 `jobId` 启动真实工作；同一个 `jobId` 无论收到多少次启动请求，最多只能对应一次真实执行。

大白话是：先挂号，再开工。挂号失败就不允许开工；开工失败则保留一条可查询的失败记录，不能让任务凭空消失。

## 二、当前基线

当前代码已经完成第一阶段收口：

- `BackgroundShellCreate` 不再直接查找 `DetachedProcessSupervisor`。
- QueryEngine 通过宿主注入的 `AgentBackgroundShellHost` 发起创建。
- daemon 将模型工具和 HTTP 创建请求路由到 `BackgroundShellService.create()`。
- `BackgroundShellService` 启动进程后立即创建 `SessionExecutionRecord`。
- projection 写入失败时，服务会停止刚启动的进程并让创建失败。
- 创建成功返回的 `jobId` 可以立即用于 `JobRead`、`JobList` 和 `JobCancel`。

改造前流程是：

```text
创建请求
  -> 启动进程
  -> 写 SessionExecutionRecord
  -> 绑定状态同步
  -> 返回 jobId
```

这已经消除了工具和 daemon 各持一份运行时注册表的问题，但仍有一个不可完全关闭的窗口：进程已经启动，持久记录尚未写入。当前通过“写入失败后停止进程”进行补偿；如果停止也失败，仍可能留下孤儿进程。

当前流程已经调整为：

```text
创建请求
  -> 写 pending 记录并分配 jobId
  -> Producer 按 jobId 启动
  -> 更新 running/failed
  -> 返回 jobId
```

## 三、目标

实施完成后必须满足以下结果：

1. 创建开始后，Job 在真实进程启动前就已经存在于持久账本中。
2. `JobRead` 不会因为任务尚在启动而返回 `Job not found`。
3. Registry 与 Producer 使用同一个预先分配的 `jobId`。
4. Producer 对重复的同一启动请求具备幂等保证，不会启动两个进程。
5. daemon 在任意创建步骤崩溃后，都能通过持久记录与 Producer 现状进行对账。
6. 查询和控制仍统一使用 `JobRead/List/Wait/Send/Cancel`，不新增通用的模型侧 `JobCreate`。
7. shell、Terminal、child Agent 和 Workflow 可以使用不同 Producer，但通过同一种路由和状态约束进入 Jobs。
8. root Agent、child Agent 和 worktree 的 owner session、cwd 与运行时作用域必须明确，不能借用父会话的绑定能力越界执行。

## 四、本轮明确不做

以下内容不属于第一阶段实施范围：

- 不引入 Kafka、Redis、RabbitMQ 或其他外部消息队列。
- 不把整个应用改成只靠事件重建状态的完整 Event Sourcing。
- 不立即把 `DetachedProcessSupervisor` 拆成独立系统服务。
- 不承诺 daemon 异常退出后继续控制所有旧操作系统进程；无法确认时必须诚实标记为 interrupted/unknown，而不是伪装为 running。
- 不自动重放无法确认是否已经产生副作用的任意命令。
- 不用一个通用 `JobCreate` 混合 shell、Terminal、Agent 和 Workflow 各自不同的创建参数。
- 不在本次设计中改变用户权限模型；Producer 启动前仍必须完成既有工具授权与 cwd/sandbox 校验。

## 五、架构边界

### 5.1 组件关系

```text
BackgroundShellCreate / HTTP / 内部调用方
                  |
                  | create shell request
                  v
       BackgroundShellService
       （创建流程的协调者）
          |                 |
          | reserve         | start(jobId)
          v                 v
 SessionExecutionStore   ShellJobProducer
 （持久账本）             （真实执行者）
          ^                 |
          | update status   | runtime events / snapshot
          +-----------------+
                  |
                  v
           DaemonJobService
      JobRead/List/Wait/Cancel 路由
```

### 5.2 Registry 的责任

Registry 在当前代码中由 `SessionExecutionRecord` 和相应 Store 方法承担。它负责：

- 分配或接受稳定的 `jobId`。
- 记录 owner session、cwd、Job kind 和 Producer 类型。
- 保存 durable 状态、错误、输出检查点和时间戳。
- 拒绝相同 `jobId` 对应不同创建参数。
- 为 `DaemonJobService` 提供查询与控制路由信息。
- daemon 重启后提供待对账任务集合。

Registry 不保存：

- `ChildProcess` 对象。
- Promise、AbortSignal、回调函数。
- PTY 或 stdin 的内存句柄。
- 只能在旧进程中使用的临时对象。

### 5.3 Producer 的责任

Producer 是“真正把工作跑起来”的组件。shell Producer 第一阶段由 `DetachedProcessSupervisor` 适配得到。它负责：

- 使用调用方给定的 `jobId` 启动真实进程。
- 保证同一 `jobId` 的重复启动不会产生第二个进程。
- 返回 runtime receipt，包括 runtime ID、当前状态和启动时间。
- 提供 read、wait、send（若支持）和 cancel。
- 发布或暴露状态变化，让 projector 更新持久账本。
- 正确停止整个进程树，并清理监听器和输出资源。

Producer 不负责决定：

- Job 属于哪个用户或 session。
- 某个 cwd 是否允许执行。
- 模型工具是否获得权限。
- 公共 Job 状态应如何展示。
- 历史记录保留多久。

### 5.4 Coordinator 的责任

`BackgroundShellService` 是协调者，不是第二个进程管理器。它负责把 Registry 和 Producer 串成一个有明确失败语义的流程：

```text
校验请求
  -> reserve durable Job
  -> dispatch to Producer
  -> persist launch result
  -> attach observation
  -> return receipt
```

它不应维护独立的任务 Map，也不应让工具层直接访问 Producer。

## 六、创建协议

### 6.1 请求身份

创建请求至少包含：

```ts
interface CreateShellJobRequest {
  requestId: string;
  sessionId: string;
  cwd: string;
  command: string;
  description: string;
  settings?: Settings;
}
```

字段含义：

- `requestId`：一次逻辑创建请求的稳定身份，用于处理调用方重试。它不是模型每次重试时随意生成的新 ID。
- `sessionId`：任务的 owner session。
- `cwd`：必须与该 session 或获准的 worktree 作用域一致。
- `command`：交给 shell Producer 的命令。
- `description`：用户可读标签。
- `settings`：当前运行设置，包括 sandbox 所需配置；不得从另一个 session 借用。

第一阶段可由 daemon 根据稳定的工具调用身份生成 `requestId`。HTTP 客户端应允许显式提供幂等键；未提供时只能保证单次连接内的创建语义，不能保证响应丢失后的安全重试。

### 6.2 Reserve

Registry 首先原子地创建一条 pending 记录：

```ts
interface ReservedShellJob {
  id: string;
  requestId: string;
  sessionId: string;
  type: "shell";
  status: "pending";
  description: string;
  cwd: string;
  metadata: {
    producer: "detached_process";
    executionBackend: "detached_process";
    commandFingerprint: string;
  };
}
```

Reserve 必须保证：

1. 同一 owner session 下，相同 `requestId` 和相同请求内容返回原来的 Job。
2. 相同 `requestId` 携带不同 command/cwd/description/执行设置时失败，不能静默复用。
3. `jobId` 在启动前确定，并直接作为 Producer runtime ID 使用。
4. Reserve 失败时不得调用 Producer。

`commandFingerprint` 是用于检测重试载荷变化的稳定摘要，不用于替代权限检查，也不应泄露敏感命令内容到普通日志。

### 6.3 Dispatch

协调者把已持久化的 Job 交给 Producer：

```ts
interface ShellJobProducer {
  start(input: {
    jobId: string;
    command: string;
    description: string;
    cwd: string;
    sessionId: string;
    settings?: Settings;
  }): Promise<{
    runtimeId: string;
    status: "running" | "completed" | "failed";
    startedAt: number;
    finishedAt?: number;
    error?: string;
  }>;
}
```

硬规则：

- 第一阶段要求 `runtimeId === jobId`，避免维护不必要的 ID 映射。
- 如果未来某个远程 Producer 无法使用相同 ID，必须把 `runtimeId` 持久化后再允许控制操作。
- Producer 收到已存在的相同 Job 请求时返回现有执行 snapshot。
- Producer 收到相同 `jobId` 但不同启动参数时必须失败并报告 identity conflict。

### 6.4 Confirm

Producer 返回后，协调者更新持久状态：

```text
Producer running   -> durable running
Producer completed -> durable completed
Producer failed    -> durable failed
Producer throw     -> durable failed，保存结构化错误
```

短命令可能在 `start()` 返回前已经结束，因此不能强制经过可观察的 running 阶段。允许：

```text
pending -> completed
pending -> failed
```

但不允许终态重新回到 running。

## 七、状态机

### 7.1 Durable 状态

现有 `SessionTaskStatus` 已包含：

```text
pending | running | completed | failed | stopped | interrupted
```

第一阶段不必为 `starting` 新增数据库枚举；可使用：

```text
status = pending
metadata.admissionPhase = reserved | dispatching
```

这样可以减少 migration 和跨端协议变化。若实际运行观测证明 UI 必须区分“等待调度”和“正在启动”，再把 `starting` 提升为正式状态。

允许的主要转换：

```text
pending -> running
pending -> completed
pending -> failed
pending -> interrupted

running -> completed
running -> failed
running -> stopped
running -> interrupted
```

禁止：

```text
completed/failed/stopped/interrupted -> pending/running
```

需要重新执行时创建新的 Job，而不是复活旧 Job。

### 7.2 公共 Job 状态

当前公共 `JobStatus` 没有 pending。第一阶段建议保持协议兼容：

- durable pending 对外投影为 `running`。
- `snapshot.detail` 使用“waiting to start”或“starting”。
- `snapshot.metadata.phase` 返回 `reserved` 或 `dispatching`。
- pending Job 允许 read、wait 和 cancel，不允许 send。

如果 UI、自动化或外部 API 确实需要过滤 pending，应单独设计公共协议升级，而不是偷偷增加未被旧客户端识别的状态字符串。

## 八、取消协议

取消必须覆盖尚未启动和已经启动两种情况。

### 8.1 pending 时取消

```text
JobCancel
  -> Registry 原子地 pending -> stopped
  -> 不调用 Producer.start
```

如果 dispatch 已经并发开始，协调者必须在 Producer 返回后再次读取 durable 状态；若已经 stopped，则立即调用 Producer.cancel，不得把状态改回 running。

### 8.2 running 时取消

```text
JobCancel
  -> 标记 stopping（公共状态或 metadata phase）
  -> Producer.cancel(jobId)
  -> durable stopped
```

取消失败时不能假装 killed。应保留当前非终态并记录错误，或在无法继续确认时转成 interrupted。具体策略需由实现阶段的并发测试确定。

## 九、崩溃窗口与恢复

### 9.1 失败矩阵

| 崩溃/失败位置 | 持久状态 | 真实执行 | 恢复动作 |
| --- | --- | --- | --- |
| Reserve 前 | 无 Job | 未启动 | 调用方可安全重试 |
| Reserve 写入失败 | 无 Job | 未启动 | 返回失败，不调用 Producer |
| Reserve 后、Dispatch 前 | pending | 未启动 | 重启后标记 interrupted/failed，或按明确策略重试 |
| Dispatch 已送达、回复前 | pending | 可能已启动 | 按 jobId 向 Producer 查询，不盲目启动第二次 |
| Producer 返回、Confirm 前 | pending | running/terminal | 对账后补写真实状态 |
| running 期间 daemon 崩溃 | running | 可能存活 | 重启后查询 Producer；无法确认则 interrupted |
| cancel 已发出、确认前崩溃 | running/stopping | 未知 | 对账，不重复假设成功 |

### 9.2 Reconciler

daemon ready 阶段增加后台 Job 对账：

```text
列出 durable pending/running tasks
  -> 按 producer 分组
  -> producer.inspect(jobId)
  -> 对比 durable 与 runtime
  -> 只允许向真实终态或可证明的 running 收敛
```

建议规则：

- durable pending + runtime running：补写 running。
- durable pending + runtime completed/failed：补写对应终态。
- durable pending + runtime missing：标记 interrupted 或 failed，不自动执行任意旧命令。
- durable running + runtime completed/failed/stopped：补写终态。
- durable running + runtime missing：标记 interrupted，并说明 daemon restart/runtime lost。
- durable terminal + runtime running：这是严重冲突；不得把 durable 状态回退，应尝试停止 runtime 并记录诊断事件。

第一阶段不自动重放 shell 命令。即使 `requestId` 能去重，也无法保证旧 Producer 是否仍持有已启动进程；只有当 Producer 提供可证明的幂等 inspect/start 协议后，才能讨论恢复 dispatch。

## 十、Session、child Agent 与 worktree

后台任务能力不能只绑定 root Agent 后无限传给所有 child。每次创建必须根据实际 ToolContext 验证：

- `sessionId` 对应的 durable session 存在且未 archived/closing。
- `cwd` 等于该 session 的项目目录，或等于已登记并仍有效的 worktree lease。
- child Agent 创建的 Job 归 child session 所有，或明确采用 parent-visible ownership；不能两种语义混用。
- `JobRead/JobCancel` 使用与创建一致的 owner 规则。

实现前必须先决定 child Job 的 ownership：

### 方案 A：child-owned

```text
child session 创建 Job
-> ownerSession = child session
-> child 使用自己的 Job host 管理
-> parent 通过层级查询或显式代理观察
```

优点是边界清楚；缺点是需要为 child 注入按其 session 解析的 host，不能直接复用 root 的 bound host。

### 方案 B：root-owned

```text
child 发起创建
-> ownerSession = root session
-> metadata 记录 childSessionId/childId
-> parent 与 child 共享 Job 控制面
```

优点是 parent 易于统一观察；缺点是 child 权限和 cwd 必须额外校验，且 child session 的独立审计性较弱。

本文建议采用方案 A，保持“谁执行、谁拥有”的直观语义；Jobs Panel 可以在 UI 层聚合 descendant sessions，而不是修改底层 owner。该决策必须在实现前写入 `jobs-protocol.md`，并补 child/worktree 集成测试。

## 十一、本地无 daemon 模式

本地 SDK 不能依赖 daemon Store，但仍应复用同一 Producer 协议：

- `LocalAgentJobHost` 同时提供轻量 Registry 与 shell Producer 路由。
- Registry 可保留在进程内，明确声明不具备跨进程恢复能力。
- 仍然先创建本地 pending 记录，再调用 Producer。
- 仍然使用预先分配的 `jobId` 和幂等 start。
- API 行为与 daemon 一致：返回 `jobId` 后立即可 read/list/cancel。

“本地不持久化”不等于“可以让创建和查询各用一份 Map”。本地模式也只能有一个 Job host 作为当前 runtime 的权威目录。

## 十二、数据模型建议

尽量复用 `SessionExecutionRecord`，第一阶段新增 metadata 字段而非新表：

```ts
interface ExecutionAdmissionMetadata {
  producer: "detached_process" | "child_agent" | "terminal" | "workflow";
  runtimeExecutionId: string;
  requestId: string;
  commandFingerprint?: string;
  admissionPhase?: "reserved" | "dispatching" | "confirmed";
  origin: "tool" | "http" | "schedule" | "workflow" | "local";
  childSessionId?: string;
}
```

需要评估是否把 `requestId` 提升为正式列并建立唯一索引。建议最终采用正式列或独立 admission 表，因为只放在 JSON metadata 中难以实现数据库级原子去重。

推荐唯一约束：

```text
(session_id, request_id) UNIQUE
```

如果多个入口可能共享 request ID 命名空间，则增加 namespace：

```text
(session_id, request_namespace, request_id) UNIQUE
```

不得只依靠“先查再插”，否则并发请求仍可能创建两个 Job。

## 十三、接口草案

建议把“创建”和“后续控制”继续分开：

```ts
interface AgentBackgroundShellHost {
  create(input: CreateShellJobRequest): Promise<{
    jobId: string;
    label: string;
  }>;
}

interface AgentJobHost {
  list(input: JobListRequest): Promise<JobSnapshot[]>;
  read(input: JobReadRequest): Promise<JobReadResult>;
  wait(input: JobWaitRequest): Promise<JobWaitResult>;
  send(input: JobSendRequest): Promise<void>;
  cancel(input: JobCancelRequest): Promise<JobSnapshot>;
}
```

内部增加明确的 Registry/Producer 接口，不把 Store 或 supervisor 暴露给工具：

```ts
interface JobAdmissionStore {
  reserveShell(input: ReserveShellJobInput): SessionExecutionRecord;
  markDispatching(jobId: string): SessionExecutionRecord;
  confirmRuntime(jobId: string, receipt: RuntimeReceipt): SessionExecutionRecord;
  failAdmission(jobId: string, error: StructuredJobError): SessionExecutionRecord;
}

interface ShellJobProducer {
  start(input: StartShellJobInput): Promise<RuntimeReceipt>;
  inspect(jobId: string): RuntimeSnapshot | undefined;
  readOutput(jobId: string): string;
  cancel(jobId: string): Promise<RuntimeSnapshot>;
}
```

`BackgroundShellService` 只依赖这些接口，便于测试每一个崩溃窗口，不直接依赖具体 SQLite 或进程类。

## 十四、日志与诊断

每次创建至少记录下面的结构化事件：

```text
job.admission.reserved
job.admission.dispatching
job.runtime.started
job.admission.confirmed
job.admission.failed
job.reconcile.corrected
job.reconcile.runtime_missing
job.identity_conflict
```

事件字段至少包括：

- `jobId`
- `requestId`
- `sessionId`
- `producer`
- `previousStatus`
- `nextStatus`
- `failureKind`
- `traceId`（若来自 Agent run）

普通日志不得默认输出完整 command、环境变量、token 或 settings 密钥。诊断页应能区分：

- 从未登记。
- 已登记但未 dispatch。
- dispatch 结果未知。
- runtime 丢失。
- durable/runtime 状态冲突。

## 十五、实施里程碑

### Milestone A：协议与失败测试

- [x] A1：为创建链路建立崩溃窗口测试表。
- [x] A2：定义 `requestId`、请求内容匹配和 identity conflict。
- [x] A3：定义 Producer start/inspect/cancel 的幂等契约。
- [x] A4：确定 child-owned ownership，并写入权威 Jobs 文档。

### Milestone B：Durable Reserve

- [x] B1：为 Store 增加原子 reserve API。
- [x] B2：增加 `(session, namespace, requestId)` 唯一约束或等效 schema。
- [x] B3：让 `BackgroundShellService` 先 reserve，再调用 Producer。
- [x] B4：让 pending Job 可立即通过 JobRead/List/Wait/Cancel 观察。

### Milestone C：幂等 Producer

- [x] C1：durable producer 调用 `DetachedProcessSupervisor.startShellExecution` 时提供预留的 `jobId`；standalone 入口仍可由本地 host 先分配。
- [x] C2：相同 ID + 相同请求返回已有执行。
- [x] C3：相同 ID + 不同请求返回 identity conflict。
- [x] C4：处理短命令在 confirm 前已经结束的情况。

### Milestone D：恢复与对账

- [x] D1：daemon ready 时扫描 pending/running shell Jobs。
- [x] D2：实现 runtime inspect 和状态收敛。
- [x] D3：runtime missing 转 interrupted，不盲目重放。
- [x] D4：durable terminal + runtime running 时停止孤儿并记录诊断。

### Milestone E：调用方与本地模式

- [x] E1：模型工具和 HTTP shell 创建入口明确提供 request namespace/id；Schedule/Workflow 不直接创建 shell。
- [x] E2：继承的 host 按真正发起调用的 child session 解析 owner。
- [x] E3：创建时校验 session 未归档且 cwd 等于该 session/worktree 的登记 cwd。
- [x] E4：LocalAgentJobHost 先分配 jobId 和请求槽，再按该 ID 幂等启动。

### Milestone F：文档与清理

- [x] F1：更新 `jobs-protocol.md` 为最终权威流程。
- [x] F2：删除正常创建路径中的懒投影依赖；仅保留启动恢复和旧数据 reconciliation。
- [x] F3：删除生产代码中绕过 service 直接创建 shell 的入口。
- [x] F4：沿用现有 completed Job retention、bounded output 和 supervisor 终态监听器清理策略，并用恢复对账覆盖异常退出。

## 十六、必须覆盖的测试

### 正常行为

- reserve 后、Producer 尚未返回时，JobRead 能看到任务。
- 创建成功后 JobList 立即包含同一 jobId。
- JobCancel 能停止真实进程树。
- 短命令可以从 pending 直接进入 completed/failed。

### 幂等与并发

- 相同 requestId 并发创建只得到一个 jobId 和一个真实进程。
- 响应丢失后重试不启动第二个进程。
- 相同 requestId 携带不同 command/cwd 时失败。
- cancel 与 start 并发时，终态不会回退为 running。

### 崩溃恢复

- reserve 后崩溃、未启动：重启后正确收束。
- 进程已启动但 confirm 前崩溃：通过 inspect 补写 running/terminal。
- durable running 但 runtime missing：转 interrupted。
- durable terminal 但 runtime running：停止 runtime，durable 状态不回退。

### 权限和所有权

- session A 不能使用 session B 的 host 创建或控制 Job。
- 普通 session 不能在未登记的任意 cwd 启动。
- child Agent 的 Job owner、JobRead 和 JobCancel 使用同一 ownership 规则。
- worktree 已释放后不能继续创建新 Job。

### 构建产物

- `BackgroundShellCreate` 的生产 bundle 不包含对 `getDetachedProcessSupervisor` 的直接调用。
- Electron 构建前依赖包 dist 已由依赖图重建，不能打包陈旧的 agent-runtime 产物。
- 打包后的真实调用链完成 create -> read -> list -> cancel。

## 十七、验收标准

以下条件全部满足才算实施完成：

1. 所有生产 shell 创建入口都先 reserve durable Job。
2. Producer 不生成自己的临时 Job ID。
3. 相同逻辑请求最多启动一次真实进程。
4. 创建中的 Job 对 JobRead/List 可见。
5. 每个崩溃窗口都有明确、经过测试的恢复结果。
6. daemon 重启不会把无法确认的旧 Job 永久留在 running。
7. child/worktree 的 owner 与 cwd 规则已确定并有集成测试。
8. 正常创建不再依赖 `JobRead/List` 顺便把内存进程懒投影到 Store。
9. 文档、源码、agent-runtime dist 和 Electron bundle 表达同一条调用链。

## 十八、风险与取舍

### 多一次持久写入

创建会增加一次 reserve 写入，但相对于启动 shell 的成本可以忽略。换来的是“返回前必定有账”和可恢复的创建状态。

### pending 记录可能增多

daemon 在 reserve 后崩溃会留下 pending。必须依靠 ready reconciliation 和 retention 清理，不能让 pending 永久积累。

### Producer 协议复杂度提高

`start(jobId)` 需要参数一致性校验和重复请求处理。这是可靠创建必须付出的复杂度，不能用共享 Map 省略。

### 公共状态兼容

当前公共 JobStatus 没有 pending。第一阶段用 running + phase 投影保持兼容，但语义不够精确；是否升级公共协议应根据 UI 和外部客户端需求单独决策。

### 不保证任意命令自动恢复

shell 命令可能具有不可逆副作用。即使创建协议幂等，也不代表命令本身幂等。恢复阶段优先对账和诚实收束，不自动重新执行未知结果的命令。

## 十九、最终建议

本项目不应退回“工具直接启动、daemon 事后发现”的方式，也不需要让 daemon 亲自实现所有执行细节。建议目标保持为：

```text
Registry 负责先挂号和记账
Coordinator 负责可靠交接
Producer 负责真实执行
Job Service 负责统一查询和控制
Reconciler 负责崩溃后对账
```

第一项实现工作应是 Store 的原子 reserve API 和失败窗口测试，而不是先改 UI、增加消息队列或拆独立进程。只有 durable admission 建立后，Producer 幂等、重启对账和 child/worktree ownership 才有稳定的落点。
