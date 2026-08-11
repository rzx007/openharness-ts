# Agent Run Events / Effects 实施计划

> 状态：已完成。当前架构见 [Agent Run Events / Effects Architecture](../../agent-run-events-effects-architecture.md)。
>
> 迁移原则：**不做兼容**。不提交双 public API、deprecated alias、daemon adapter 或旧 projection fallback；每个提交都必须通过相关 typecheck/tests。

## 目标

把当前：

```text
daemon creates AgentRunHost + AgentChildProjection
  -> framework calls daemon methods during execution
```

替换为：

```text
framework owns AgentRunHandle / AgentChildHandle
  -> emits ordered AgentEvent
  -> awaits AgentEffects only when a result is required
daemon consumes events and projects durable state
```

## 改造前基线

- root：`SessionRunExecutor -> DaemonRunProjection.createHost -> OpenHarnessAgent.submitMessage`。
- permission：`QueryEngine -> AgentRunHost.requestPermission -> StorePermissionBroker`。
- steer：`mergeWake -> wakeCount -> drainSteeredInputs -> pullFollowUps`。
- child：`AgentChildManager <-> AgentChildProjection <-> DaemonChildAgentProjection`。
- live child：`LiveChildAgentRegistry` 保存 daemon 收到的 `AgentChildControls`。
- durable transcript：`SessionTranscriptProjection` 已经是可保留的窄 reducer。

## Task 1：一次性切换 framework execution API

- [x] 在 core/agent-runtime 定义 serializable `AgentEvent` union、event envelope、`AgentEventSource`、`AgentEffects`、`AgentRunHandle`、`AgentChildHandle`。
- [x] `OpenHarnessAgent.submitMessage()` 改为返回 active `AgentRunHandle`；`runMessage()` 作为 await-result convenience API。
- [x] event source 支持一个 agent-level ordered/awaited required subscriber；terminal event 被消费后才 settle `run.result`。
- [x] agent-level effects 在 child agent 中继承；无 permission effect 时默认 denied。
- [x] 将 provider `StreamEvent` 在 framework 内归一化为 output/tool/usage/run events；error 改为 serializable DTO。
- [x] 将 QueryEngine/tool/workflow 的 `QueryRuntimeHost` 改为 framework internal execution context。
- [x] 删除 `AgentRunHost`、`QueryRuntimeHost` application contract、`AgentSessionHostCallbacks` 和 `composeAgentRunHost()`。
- [x] 更新 framework tests：direct run、event ordering、listener failure、permission effect、interrupt、steer、terminal barrier。

退出标准：

- 单进程代码可以 `const run = agent.submitMessage("hi"); await run.result`。
- framework package 不需要 daemon 提供任何 host 才能执行工具和 child。
- public declarations 中不存在旧 host contract。

## Task 2：一次性切换 daemon root run 与 permission

- [x] 新增单入口 `DaemonAgentEventProjector.apply(event)`，复用 `SessionTranscriptProjection`、store、event publisher 和 observability。
- [x] `AgentPool` 创建 agent 时注入 daemon `AgentEffects`，并在 hydrate/submit 前建立 required event subscription。
- [x] `SessionRunExecutor` 只 acquire agent、submit admitted IDs、注册 active run handle、await result 和处理基础设施兜底。
- [x] permission effect 直接调用 `StorePermissionBroker.ask(context + request + signal)`；保留现有 durable request、lineage、HTTP reply 和 expiration 语义。
- [x] `SessionRunCoordinator` 保存 active run handle 引用；steer 直接调用 `run.steer()`，interrupt 调用 `run.interrupt()`。
- [x] handle 注册前已 durable admit 的 steer 在 lane 中按顺序暂存，`registerActiveHandle()` 后主动 flush；用 `input.accepted` event 绑定 input/run。
- [x] 删除 `DaemonRuntimeHostPort`、`DaemonRunProjection`、对应 factory/context/test。
- [x] 删除 `wakeCount`、`drainSteeredInputs()`、`pullFollowUps()` 的 root run 回拉链路。
- [x] 更新 server tests：admit/run、delta transcript、tool part、failed run、permission、steer、interrupt、pool eviction/restart。

退出标准：

- TUI 发送 `hi` 的 durable transcript/SSE 行为不变。
- root run 的 framework -> daemon 调用只剩 event subscription 和 permission effect。
- server 源码不再 import `AgentRunHost`。

## Task 3：一次性切换 child lifecycle

- [x] `AgentChildManager` 直接生成 canonical `childId/sessionId/inputId/runId`，暴露 `agent.children` directory。
- [x] child tool 返回/接收 `childId`；删除 daemon `taskId` 作为 framework alias 的行为。
- [x] child create/run/suspend/resume/close 使用统一 `AgentEvent`，descendant event 汇入 root agent event source。
- [x] 把 worktree acquire/release 移入 agent-runtime 的 `ChildEnvironmentProvider`；daemon 只投影 worktree metadata。
- [x] `DaemonAgentEventProjector` 根据 child events 创建/更新 durable child session/input/run/task/transcript。
- [x] durable task 保存 `childId`；task input/stop 和 child HTTP route 通过 `agent.children` directory 路由。
- [x] 删除 `AgentChildProjection`、所有 projection handle/state、`DaemonChildAgentProjection`、`ChildAgentProjectionFactory`。
- [x] 删除 controls 注册式 `LiveChildAgentRegistry`；如仍需索引，只保存 root agent/session 与 childId，不复制 controls。
- [x] 更新 child tests：follow-up、active steer、parent abort、idle suspend/resume、required event failure、worktree cleanup，并由 server integration 覆盖 durable child follow-up。

退出标准：

- framework child 在无 daemon 环境下完整运行。
- daemon 不向 framework 返回 session/task/run/host/opaque state。
- framework event 中不存在 function、Promise、AbortSignal 或 controls。

## Task 4：数据一致性与清理

- [x] projector 按 framework event ID 做当前进程幂等投影；实体 ID 重放执行 create-or-validate，相同 ID 不同 payload 失败关闭。
- [x] 验证 root daemon-assigned ID 与 child framework-assigned ID 共用同一 durable namespace。
- [x] output delta 通过 ordered/awaited event bus 串行投影，复用 transcript delta 边界测试。
- [x] 验证 required listener 失败时 live run 失败，executor 对未终态 durable run 执行 failed/interrupted fallback。
- [x] 验证 listener failure 不会通过同一个失败 listener 递归发送 terminal event。
- [x] 删除旧测试 fixture、导出、文件和文档中的 `AgentRunHost` / `DaemonRunProjection` / `AgentChildProjection` 当前链路描述。
- [x] 将本文标记完成，并把目标架构文档状态改为“当前实现”。
- [x] 更新 `daemon-application-architecture.md`、`agent-runtime-framework-architecture.md`、`agent-framework-capability-boundary.md`、`permission-flow.md`、`agent-child-session-flow.md`。

退出标准：

- `rg "AgentRunHost|DaemonRuntimeHostPort|AgentChildProjection|DaemonChildAgentProjection|pullFollowUps|wakeCount" packages` 只允许历史迁移说明中出现，生产代码为零。
- 全量 package typecheck 通过。
- framework、server、client、frontend 的 run/permission/child integration tests 通过。
- daemon 启动、TUI prompt、permission approve/deny、child follow-up 完成人工 smoke test。

## Task 5：复盘 hardening

- [x] framework 用 typed `AgentRunNotAcceptingInputError` 表达 terminal boundary，不再匹配错误字符串。
- [x] steer 先同步预占 pending slot；最终 turn 原子 drain/close，late reject 由 daemon 创建 durable replacement run。
- [x] `AgentRunHandle.started` 建立 required `run.started` delivery barrier；child receipt 不早于 durable run start。
- [x] root tree 共享 `AgentChildRegistry`，支持从 root 路由任意深度 descendant，同时保留 manager-local lifecycle ownership。
- [x] `AgentPool` 把 agent promise 与 subscription 收入同一代际 entry，旧 close 不影响 replacement。
- [x] `child.created` partial failure 补偿 task/live route/new child session。
- [x] projector 用成功 event sequence 水位替代无界 event/input sets。
- [x] listener/infrastructure failure 收束遗留 running transcript parts。
- [x] permission effect 原样保留 `approved | denied | expired`。
- [x] 增加 terminal steer、descendant directory、pool race、projection rollback、transcript fallback、permission expiration 回归测试。
- [x] 更新 TUI、framework、daemon、child、permission 权威文档。

退出标准：相关 package typecheck 和 focused tests 通过；生产代码不存在旧 host/projection compatibility path。

## Task 6：二次复盘一致性修复

- [x] steer receipt 延迟到可用 turn boundary 的 `input.accepted` 成功交付与实际消费；provider/tool/terminal/max-turn 先结束时统一 typed reject。
- [x] 批量 steer projection 失败不报告部分成功。
- [x] coordinator delivery 返回输入最终归属 run；late steer replacement run ID 透传到 HTTP，replacement 失败不会悬挂 promise。
- [x] child run 严格校验 framework `started` receipt，不再用 manager 预分配 ID 覆盖真实 receipt。
- [x] live child HTTP 删除 durable input/run 补造 fallback；receipt 与 durable projection 不一致时明确失败。
- [x] `input.accepted` 携带 child input metadata，删除 fallback 后仍由唯一 projector 完整落盘。
- [x] child event projection 失败补偿 durable run/transcript/task terminal 状态；`child.closed` 不再吞 durable completion failure。
- [x] task bridge durable-first 注册；live TaskManager 注册失败回写 failed，live completion 失败不阻断 durable terminal。
- [x] 更新 framework/daemon/event 权威文档并补充 steer、child identity、projection、task bridge 回归测试。

退出标准：core、agent-runtime、server typecheck 通过；上述 focused tests 通过；所有 steer delivery promise 都有 resolve/reject 终点。

## 提交策略

建议按三个可审查提交落地，而不是按文件碎片提交：

1. `refactor(agent): expose runs through events effects and handles`
   - Task 1 + Task 2，root vertical slice 原子切换。
2. `refactor(agent): move child lifecycle to framework events`
   - Task 3，child vertical slice 原子切换。
3. `docs(test): close agent event architecture migration`
   - Task 4 的 hardening、文档和退场检查。

实现过程中工作区可以暂时处于未编译状态，但任何 commit 都不能同时暴露新旧两套 public API。

## 不接受的实现

- 新增 `AgentEvent`，同时长期保留 `AgentRunHost.emitEvent()`。
- 用 `LegacyAgentRunHostAdapter`、`CompatChildProjection` 等兼容层包住旧链路。
- 把 `resolve/reject` function 放进 permission event 或 durable store。
- 把 `AgentRunHandle`、`AgentChildHandle` 序列化到 event/SSE。
- daemon 继续生成 taskId，再把它返回 framework 当 invocation handle。
- child event 已存在，仍要求 framework 调 `projection.startRun/finishRun`。
- 为了删除 projection，把 transcript/task/store 逻辑搬进 framework。

## 完成定义

用户面对的心智模型应收敛为：

```text
agent.submitMessage() -> AgentRunHandle
agent.events          -> 执行事实
agent.effects         -> 外部决定
agent.children        -> live child handles

daemon                -> durable projection + HTTP/SSE + concurrency policy
```

打开目标架构文档，应能直接定位一条动作属于 event、effect 还是 handle，并沿同一条链找到 framework 产生点和 daemon durable 消费点。
