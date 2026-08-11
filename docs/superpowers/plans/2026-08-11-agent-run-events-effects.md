# Agent Run Events / Effects 实施计划

> 状态：待实施。目标架构见 [Agent Run Events / Effects Architecture](../../agent-run-events-effects-architecture.md)。
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

## 当前基线

- root：`SessionRunExecutor -> DaemonRunProjection.createHost -> OpenHarnessAgent.submitMessage`。
- permission：`QueryEngine -> AgentRunHost.requestPermission -> StorePermissionBroker`。
- steer：`mergeWake -> wakeCount -> drainSteeredInputs -> pullFollowUps`。
- child：`AgentChildManager <-> AgentChildProjection <-> DaemonChildAgentProjection`。
- live child：`LiveChildAgentRegistry` 保存 daemon 收到的 `AgentChildControls`。
- durable transcript：`SessionTranscriptProjection` 已经是可保留的窄 reducer。

## Task 1：一次性切换 framework execution API

- [ ] 在 core/agent-runtime 定义 serializable `AgentEvent` union、event envelope、`AgentEventSource`、`AgentEffects`、`AgentRunHandle`、`AgentChildHandle`。
- [ ] `OpenHarnessAgent.submitMessage()` 改为返回 active `AgentRunHandle`；`runMessage()` 作为 await-result convenience API。
- [ ] event source 支持一个 agent-level ordered/awaited required subscriber；terminal event 被消费后才 settle `run.result`。
- [ ] agent-level effects 在 child agent 中继承；无 permission effect 时默认 denied。
- [ ] 将 provider `StreamEvent` 在 framework 内归一化为 output/tool/usage/run events；error 改为 serializable DTO。
- [ ] 将 QueryEngine/tool/workflow 的 `QueryRuntimeHost` 改为 framework internal execution context。
- [ ] 删除 `AgentRunHost`、`QueryRuntimeHost` application contract、`AgentSessionHostCallbacks` 和 `composeAgentRunHost()`。
- [ ] 更新 framework tests：direct run、event ordering、listener failure、permission effect、interrupt、steer、terminal barrier。

退出标准：

- 单进程代码可以 `const run = agent.submitMessage("hi"); await run.result`。
- framework package 不需要 daemon 提供任何 host 才能执行工具和 child。
- public declarations 中不存在旧 host contract。

## Task 2：一次性切换 daemon root run 与 permission

- [ ] 新增单入口 `DaemonAgentEventProjector.apply(event)`，复用 `SessionTranscriptProjection`、store、event publisher 和 observability。
- [ ] `AgentPool` 创建 agent 时注入 daemon `AgentEffects`，并在 hydrate/submit 前建立 required event subscription。
- [ ] `SessionRunExecutor` 只 acquire agent、submit admitted IDs、注册 active run handle、await result 和处理基础设施兜底。
- [ ] permission effect 直接调用 `StorePermissionBroker.ask(context + request + signal)`；保留现有 durable request、lineage、HTTP reply 和 expiration 语义。
- [ ] `SessionRunCoordinator` 保存 active run handle 引用；steer 直接调用 `run.steer()`，interrupt 调用 `run.interrupt()`。
- [ ] handle 注册前已 durable admit 的 steer 在 lane 中按顺序暂存，`registerActiveHandle()` 后主动 flush；用 `input.accepted` event 绑定 input/run。
- [ ] 删除 `DaemonRuntimeHostPort`、`DaemonRunProjection`、对应 factory/context/test。
- [ ] 删除 `wakeCount`、`drainSteeredInputs()`、`pullFollowUps()` 的 root run 回拉链路。
- [ ] 更新 server tests：admit/run、delta transcript、tool part、failed run、permission、steer、interrupt、pool eviction/restart。

退出标准：

- TUI 发送 `hi` 的 durable transcript/SSE 行为不变。
- root run 的 framework -> daemon 调用只剩 event subscription 和 permission effect。
- server 源码不再 import `AgentRunHost`。

## Task 3：一次性切换 child lifecycle

- [ ] `AgentChildManager` 直接生成 canonical `childId/sessionId/inputId/runId`，暴露 `agent.children` directory。
- [ ] child tool 返回/接收 `childId`；删除 daemon `taskId` 作为 framework alias 的行为。
- [ ] child create/run/suspend/resume/close 使用统一 `AgentEvent`，descendant event 汇入 root agent event source。
- [ ] 把 worktree acquire/release 移入 agent-runtime 的 `ChildEnvironmentProvider`；daemon 只投影 worktree metadata。
- [ ] `DaemonAgentEventProjector` 根据 child events 创建/更新 durable child session/input/run/task/transcript。
- [ ] durable task 保存 `childId`；task input/stop 和 child HTTP route 通过 `agent.children.getBySessionId()` 路由。
- [ ] 删除 `AgentChildProjection`、所有 projection handle/state、`DaemonChildAgentProjection`、`ChildAgentProjectionFactory`。
- [ ] 删除 controls 注册式 `LiveChildAgentRegistry`；如仍需索引，只保存 root agent/session 与 childId，不复制 controls。
- [ ] 更新 child tests：recursive child、follow-up、active steer、stop、parent abort、idle suspend/resume、worktree cleanup、restart 后 durable recovery。

退出标准：

- framework child 在无 daemon 环境下完整运行。
- daemon 不向 framework 返回 session/task/run/host/opaque state。
- framework event 中不存在 function、Promise、AbortSignal 或 controls。

## Task 4：数据一致性与清理

- [ ] store 支持按 framework event ID 幂等投影；相同 ID 不同 payload 失败关闭。
- [ ] 验证 root daemon-assigned ID 与 child framework-assigned ID 共用同一 durable namespace。
- [ ] 给 output delta 做顺序、批量和大小边界测试。
- [ ] 验证 required listener 失败时 live run 被 interrupt，durable run 最终为 failed/interrupted。
- [ ] 验证 listener failure 不会通过同一个失败 listener 递归发送 terminal event。
- [ ] 删除旧测试 fixture、导出、文件和文档中的 `AgentRunHost` / `DaemonRunProjection` / `AgentChildProjection` 当前链路描述。
- [ ] 将本文标记完成，并把目标架构文档状态改为“当前实现”。
- [ ] 更新 `daemon-application-architecture.md`、`agent-runtime-framework-architecture.md`、`agent-framework-capability-boundary.md`、`permission-flow.md`、`agent-child-session-flow.md`。

退出标准：

- `rg "AgentRunHost|DaemonRuntimeHostPort|AgentChildProjection|DaemonChildAgentProjection|pullFollowUps|wakeCount" packages` 只允许历史迁移说明中出现，生产代码为零。
- 全量 package typecheck 通过。
- framework、server、client、frontend 的 run/permission/child integration tests 通过。
- daemon 启动、TUI prompt、permission approve/deny、child follow-up 完成人工 smoke test。

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
