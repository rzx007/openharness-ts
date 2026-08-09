# Coordinator 硬调度器调用链

硬调度器用**代码**决定哪个子 agent 先跑、哪个后跑、哪些能并行、失败后怎么办，而不是只靠 Coordinator prompt 让模型自己记住。

它不替代 swarm。分工是：

```text
Coordinator  → 理解目标、提交 Workflow spec、汇总结果
硬调度器     → 按排班表决定何时开工、重试、跳过、串行写冲突
Agent runner → 通过 swarm / TaskManager 真正跑 worker
```

设计演进与路线图见 [`coordinator-hard-scheduler-design.md`](./coordinator-hard-scheduler-design.md)。Coordinator 模式 / agent 加载见 [`coordinator-agents-design.md`](./coordinator-agents-design.md)。

## 核心模型：一次提交 + 调度循环 + 持久快照

分三层：

1. **入口**：模型调 `Workflow` 工具（`run` / `resume` / `status`），或代码直接 `runWorkflow` / `runPersistentWorkflow`。
2. **调度**：`runWorkflow` 维护 ready 队列、并发上限、失败策略、写冲突串行、预算与超时。
3. **执行**：每个 task 经 `WorkflowRunner`（默认 `createAgentWorkflowRunner`）spawn worker → `TaskManager.awaitTask` → 结构化结果回填。

```text
┌─ 模型 / 代码入口 ─────────────────────────────────────┐
│ Workflow 工具 action=run|resume|status                 │
│   run    → parseWorkflowSpec → runPersistentWorkflow   │
│   resume → load snapshot → resumePersistentWorkflow    │
│   status → load snapshot + events → JSON / timeline    │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ runWorkflow 调度循环 ─────────────────────────────────┐
│ createWorkflowPlan（DAG / mode / 并发 / budget）        │
│ ready queue → scheduleMore                             │
│   预算超限 → skip 未启动                                │
│   writeScope 冲突 → blocked，等运行中写任务结束         │
│   可跑 → runner(task) → onFinished → 传播失败 / 入队    │
│ onSnapshot / onEvent → .openharness/workflows/…        │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ Agent WorkflowRunner（每个 task）─────────────────────┐
│ resume 有 taskManagerTaskId → 优先 await 旧任务         │
│ 否则 swarm.spawnWorker → awaitTask → git diff 摘要     │
│ 返回 summary / result / metadata / budget / status     │
└────────────────────────────────────────────────────────┘
```

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| 公共调度入口 | `packages/coordinator/src/workflow-scheduler.ts` | 兼容导出入口；外部仍从这里或 `@openharness/coordinator` 导入 |
| 调度循环 | `packages/coordinator/src/workflow/runner.ts` | `runWorkflow`、ready queue、并发、失败策略、budget、blocked task |
| task attempt | `packages/coordinator/src/workflow/task-runner.ts` | 单 task 执行、retry、timeout、progress budget |
| plan / 校验 | `packages/coordinator/src/workflow/validation.ts` | `WorkflowSpec` 展开、DAG、mode、writeScope 校验 |
| budget | `packages/coordinator/src/workflow/budget.ts` | preset、hard/soft limit、usage 汇总 |
| snapshot | `packages/coordinator/src/workflow/snapshot.ts` | run id、snapshot、summary、snapshot/result 转换 |
| notification | `packages/coordinator/src/workflow/notification.ts` | `<workflow-notification>` formatter/parser |
| reconciliation | `packages/coordinator/src/workflow/reconciliation.ts` | changed-file / write-scope overlap 检测、summary、follow-up spec |
| 公共持久化入口 | `packages/coordinator/src/workflow-store.ts` | 持久化兼容导出入口 |
| 持久化实现 | `packages/coordinator/src/workflow/store.ts` | `.openharness/workflows/<runId>.json` + `.events.ndjson`；resume/cancel/list |
| Coordinator 模式 | `packages/coordinator/src/coordinator-mode.ts` | `getCoordinatorTools()` 含 `Workflow`；prompt / user context |
| System prompt | `packages/coordinator/src/index.ts` | `COORDINATOR_SYSTEM_PROMPT` 说明何时用 Workflow vs Agent |
| Workflow 工具 | `packages/tools/src/agent/workflow.ts` | 解析 input、run/resume/status、返回 `<workflow-notification>` |
| Agent runner | `packages/tools/src/agent/workflow-runner.ts` | spawn swarm worker + `awaitTask` + changed files / diff |
| 工具注册 | `packages/tools/src/registry.ts` | 默认注册表挂上 `workflowTool` |
| CLI 白名单 | `apps/cli/src/commands/main.ts` | coordinator 模式 `setAllowedTools(getCoordinatorTools())` |
| Workflow CLI | `apps/cli/src/commands/workflow.ts` | `ohs workflow list/status/validate/template/reconcile/cancel`；JSON-first 管理面 |

## A. 入口阶段

### A1. Coordinator 模式工具面

开启 `OPENHARNESS_COORDINATOR_MODE` 后，CLI 启动时：

```text
apps/cli/src/commands/main.ts
  if (isCoordinatorMode())
    queryEngine.setAllowedTools(getCoordinatorTools())
    # = ["Agent", "SendMessage", "TaskStop", "Workflow"]
```

Leader 不能直接 Read/Bash；简单委托仍用 `Agent` + `TaskWait`，有明确 DAG / 重试 / 失败策略时用 `Workflow`。

### A1.5. Workflow CLI 管理面

`ohs workflow` 是面向人和 UI 的普通 CLI，不是 Coordinator 模式本身。它读取同一份 `.openharness/workflows/` 持久化数据：

```text
ohs workflow list       # 历史 run 列表，可按状态/时间/reconcile/budget 过滤
ohs workflow status     # latest 或指定 runId 的 snapshot + events
ohs workflow validate   # dry-run 校验 spec，不启动 worker
ohs workflow template   # 展示/参数化内置 workflow spec 模板
ohs workflow reconcile  # 从 reconciliationPlan 生成 follow-up spec
ohs workflow cancel     # stop backing task，并写 terminal snapshot
```

完整命令和示例见 [`workflow-cli.md`](./workflow-cli.md)。后续 TUI/Web 可以直接消费这些 JSON payload，而不是重新实现一套 workflow store 读取逻辑。

### A2. Workflow 工具

```text
模型调 Workflow
  └─ createWorkflowTool().execute()          # packages/tools/src/agent/workflow.ts
       ├─ action=status → WorkflowRunStore.load / latest
       │    view=json     → <workflow-run-snapshot> + timelineControls
       │    view=timeline → 人类可读时间线（可按 taskIds/eventTypes/statuses 过滤）
       │
       ├─ action=resume → load snapshot → resumePersistentWorkflow(runner)
       │
       └─ action=run（默认）
            parseWorkflowSpec(input)
            createAgentWorkflowRunner({ cwd, team, timeoutMs, permissionMode })
            persist!==false → runPersistentWorkflow(spec, runner, { cwd, runId })
            否则 → runWorkflow(spec, runner[, { runId }])
            → formatWorkflowNotification(result)
```

`persist` 默认 `true`，快照写到项目 `.openharness/workflows/`。

常用 input 字段：

| 字段 | 含义 |
|------|------|
| `mode` | `parallel` / `sequential` / `pipeline` |
| `tasks[]` | `id` 必填；`dependsOn` / `retry` / `timeoutSeconds` / `writeScope` / `isolate` / `readOnly` … |
| `maxConcurrency` | 仅 parallel；sequential/pipeline 强制 1 |
| `failurePolicy` | `skip-dependents`（默认）/ `fail-fast` / `continue` |
| `budgetPreset` | `cheap-review` / `safe-write` / `fast-parallel`；可被 `budgetPolicy` 覆盖 |
| `defaultTaskTimeoutSeconds` | 默认 attempt 墙钟超时；task 级可覆盖 |
| `runId` / `latest` | 持久化 id；resume/status 可省略 runId 用 latest |

## B. 调度阶段（`runWorkflow`）

### B1. Plan

```text
createWorkflowPlan(spec)
  normalizeTasksForMode
    sequential/pipeline → 自动把 tasks[i] 依赖 tasks[i-1]
  validate timeouts / budgetPreset / budgetPolicy / tasks
  buildDependencyMap + dependentsMap
  topologicalOrder（环依赖抛错；缺失依赖抛错）
  resolveMaxConcurrency
    sequential|pipeline → 1
    parallel 未设 → Infinity
```

### B2. 调度循环

```text
emit workflow_started + snapshot
propagateInitialFailures（resume 时已有失败结果）
scheduleMore:
  while running < maxConcurrency && ready 非空:
    hard budget 超限 → skip 全部未启动 → break
    soft budget → serialize（有 running 则暂缓）和/或 conserve
    findNextRunnableReadyIndex
      writeScope 与 running 非隔离写任务重叠 → 跳过该 ready（记 blocked）
    取出 task → running
    runWorkflowTask(runner, …).then(onFinished)

onFinished:
  写入 result；emit task_finished + snapshot
  失败:
    fail-fast → skip 全部未启动
    skip-dependents → 递归 skip 下游
    continue → 依赖仅要求「已有结果」，不要求 completed
  成功/继续 → 依赖满足的下游进 ready
  scheduleMore
```

要点：

- **retry** 在 task 内部循环（`retry.maxAttempts`，含首次）；超时记 `failed + timedOut`，再走失败策略。
- **pipeline** 把上一步 `WorkflowTaskRunResult` 注入 `pipelineInput`；依赖结果也会写入 worker prompt。
- **snapshot / event 回调失败不影响调度**（best-effort）。

### B3. 写冲突与 reconcile

**运行时串行**（共享 cwd）：

- `readOnly: true` 或 `isolate: true` → 不参与共享写冲突。
- 否则用 `writeScope` 路径前缀重叠检测；重叠则后到的 ready task 进入 `blockedTasks`，等冲突 running 结束。

**跑完后 reconcile**（不自动 merge）：

| 类型 | 含义 |
|------|------|
| `write-scope-overlap` | 两个 completed 任务声明的 writeScope 重叠（needs-reconciliation） |
| `changed-file-overlap` | worker metadata / git diff 里真实改了同一文件（actual-conflict） |

结果带 `needsReconciliation`、`reconciliationIssues`、`reconciliationSummary`（按文件/任务聚合 insertions/deletions）。

## C. 执行阶段（Agent runner）

```text
createAgentWorkflowRunner()(context)
  buildWorkerPrompt
    task.prompt|description
    + conserve hint（budgetMode=conserve）
    + dependency results
    + pipeline input（mode=pipeline）
  │
  ├─ resumeFrom.metadata.taskManagerTaskId 存在
  │    → awaitTask(旧 id)
  │    成功 → 映射结果 + git diff
  │    失败 → 记 resumeError，改走 spawn
  │
  └─ runtimeHost.childAgentHost.spawnChildAgent(WorkflowWorkerSpawnConfig)
       isolate / permissionMode / tools / maxTurns（conserve 可覆盖）
       → awaitTask(spawn.taskId, { timeoutMs })
       → getDiffSummary（worktree/cwd git）
       → WorkflowWorkerResult
            status / summary / result
            metadata: agentId, taskManagerTaskId, backendType, worktree, diff, changedFiles
```

调度器本身不依赖 swarm；adapter 放在 `@openharness/tools`，`@openharness/coordinator` 保持纯调度。

## D. 持久化与恢复

目录（项目级）：

```text
.openharness/workflows/
  <runId>.json           # WorkflowRunSnapshot
  <runId>.events.ndjson  # 一行一个 WorkflowRunEvent
```

快照关键字段：`status`、`spec`、`plan`、`results`、`pendingTaskIds`、`runningTasks`（含 attempt / taskManagerTaskId 等 metadata）、`blockedTasks`、`budget`。

恢复：

```text
resumePersistentWorkflow(snapshot, runner)
  status !== "running" → 直接从 snapshot 合成 WorkflowRunResult（不重跑）
  status === "running" → runWorkflow(spec, {
       runId, createdAt,
       initialResults: 已完成/失败/跳过的 terminal 结果,
       initialRunningTasks: 仍在跑的任务,
       onSnapshot / onEvent → 继续写盘
     })
```

已 terminal 的 task **不会重跑**；仍在跑的优先 `awaitTask` 旧 TaskManager id。

## E. 三种 mode / 失败策略 / 预算

### Mode

| mode | 行为 |
|------|------|
| `parallel` | 尊重 `dependsOn`；可并发；受 `maxConcurrency` 限制 |
| `sequential` | 自动链式依赖；并发=1；**不**自动传上一步产物 |
| `pipeline` | 同 sequential 链式；额外把上一步结果作 `pipelineInput` |

### Failure policy

| 策略 | 行为 |
|------|------|
| `skip-dependents` | 默认；失败只跳过依赖它的下游 |
| `fail-fast` | 任一失败，未启动全部 skip |
| `continue` | 尽量跑完可运行任务；依赖只需「有结果」 |

### Budget

- **Hard**（`maxTokensUsed` / `maxTimeUsedMs`）：达到后不再启动新 worker，未启动标 skipped。
- **Soft**（`softMax*` + `onSoftLimit`）：`continue` / `serialize` / `conserve` / `serialize-and-conserve`。
- **Preset**：`cheap-review`、`safe-write`、`fast-parallel`；显式 `budgetPolicy` 覆盖 preset。
- 用量来自 task result / progress metadata 的 `budget` 或等价字段；最终汇总进 snapshot / notification。

## F. 结果信封

跑完返回：

```xml
<workflow-notification>
<payload>{…JSON…}</payload>
</workflow-notification>
```

JSON 含：`runId`、`status`、`summary`、`mode`、任务计数、`tasks[]`（含 attempts / timedOut / skippedReason）、`needsReconciliation`、`reconciliationIssues`、`reconciliationSummary`、`budget`。

status 另用：

```xml
<workflow-run-snapshot>
<payload>{ snapshot, events, filters, timelineControls, timelineSummary, timeline, timelineText }</payload>
</workflow-run-snapshot>
```

与单 worker 的 `<task-notification>` 分开；Coordinator 应以 structured payload 为准，不要靠闲聊文本猜状态。

## G. 事件类型

| type | 何时 |
|------|------|
| `workflow_started` / `workflow_finished` | 整次 run 起止 |
| `task_started` / `task_progress` / `task_finished` | 单 task 生命周期 |
| `task_blocked` | ready 但因 writeScope 冲突暂缓 |
| `workflow_budget_conserving` | 触达 soft budget |
| `workflow_budget_exceeded` | 触达 hard budget，开始 skip |

## H. 何时用 Workflow vs Agent

| 场景 | 选择 |
|------|------|
| 一次性调研 / 交互式来回修正 | `Agent` + `SendMessage` / `TaskWait` |
| 明确 DAG、顺序、pipeline、重试、失败策略、并发上限 | `Workflow` |
| 并行写同一目录且未 isolate | 声明 `writeScope`，让调度器串行 |
| 可隔离的并行写 | `isolate: true`（worktree） |
| 中断后续跑 | `action: "resume"`（默认有持久化） |
| 只看进度 / 时间线 | `action: "status"`，可选 `view: "timeline"` |

## I. 测试入口

| 范围 | 文件 |
|------|------|
| 纯调度（fake runner） | `packages/coordinator/src/workflow/scheduler.test.ts` |
| store / resume | `packages/coordinator/src/workflow/store.test.ts` |
| Workflow 工具解析与 status | `packages/tools/src/agent/workflow.test.ts` |
| runner 单元 | `packages/tools/src/agent/workflow-runner.test.ts` |
| 工具 → scheduler → TaskManager smoke | `packages/tools/src/agent/workflow-smoke.test.ts` |

## J. 当前能力边界（相对设计文档）

已落地到设计文档所述 **V9.3** 量级：内存调度、真实 Agent runner、`Workflow` 工具、持久化恢复、writeScope 串行、timeout、事件流、budget soft/hard + preset、reconcile（声明层 + 真实 changed files）、status timeline UI 控件字段。

尚未做（见 design 文档下一步）：

- 跨 run 的列表/索引产品化 UI（store 已有 `list()`）
- reconcile follow-up action 契约
- workflow spec 模板库
- 自动 merge 多 worktree
