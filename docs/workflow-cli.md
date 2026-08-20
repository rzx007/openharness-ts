# Workflow CLI

`ohs workflow` 是硬调度器的普通命令行入口，用来查看、校验和收口已经持久化的 workflow run。它不是 `ohs --tui`：当前先提供 JSON-first 的 CLI 面，后续 TUI/Web 可以直接复用这些 payload 做列表、详情、筛选和取消按钮。

持久化数据默认在当前项目的 `.openharness/workflows/` 下。跨目录查看时用 `--cwd <dir>` 指向目标项目。

## 常用命令

```bash
# 列出最近的 workflow run
ohs workflow list --limit 10

# 按状态、预算 preset 或冲突状态筛选
ohs workflow list --status running,failed --budget-preset safe-write
ohs workflow list --needs-reconciliation

# 查看某个 run；省略 runId 时读取 latest
ohs workflow status <runId>
ohs workflow status --no-events

# 启动 worker 前 dry-run 校验 spec
ohs workflow validate --spec ./workflow.json
ohs workflow validate --spec-json '{"mode":"sequential","tasks":[{"id":"check"}]}'

# 查看内置模板，或带参数展开模板
ohs workflow template
ohs workflow template research-implement-verify
ohs workflow template safe-write --params ./workflow-template-params.json

# 从已有 run 的 reconciliationPlan 生成后续修复 workflow spec
ohs workflow reconcile <runId>
ohs workflow reconcile <runId> --action-ids reconcile-file-src-index-ts --budget-preset safe-write

# 取消 running workflow，并停止背后的 TaskManager task
ohs workflow cancel <runId> --reason "superseded by manual fix"
```

## 命令语义

| 命令 | 用途 | 说明 |
|------|------|------|
| `list` | 浏览历史 run | 输出 `{ runs, total, filters }`；支持状态、runId 前缀、创建/更新时间、是否需要 reconcile、预算 preset 和 limit 过滤 |
| `status` | 查看 run 快照 | 输出 `{ snapshot, events }`；`--no-events` 可跳过 `.events.ndjson` 时间线 |
| `validate` | 校验 workflow spec | 只展开 DAG / mode / budget preset / 写范围冲突，不启动 worker |
| `template` | 展示内置模板 | 当前包含 `research-implement-verify`、`parallel-review`、`safe-write` |
| `reconcile` | 生成后续 spec | 只输出 follow-up workflow spec，不自动运行 |
| `cancel` | 取消持久化 run | 停止 running task，把 running 标记为 killed，把未启动 task 标记为 skipped，并写 terminal snapshot |

所有命令都输出 JSON，便于脚本、TUI 和 Web dashboard 复用。

## Daemon 重启语义

`ohs serve` 重启时不会假装续跑旧进程里的 provider 调用、TaskManager task 或 child session。它会保留 session、child session、消息与 timeline，并将遗留 session run 标为 `interrupted`。

若 workflow 的 `workflow.workflow_started` 事件已写入 daemon session event stream，daemon 会把对应的 running snapshot 收口为 terminal：运行中的 task 为 `killed`，未启动 task 为 `skipped`，并写入 `workflow.workflow_cancelled` 事件。没有这条 session 所有权事件的同项目 workflow 不受影响。之后应由用户显式启动新的工作；不要把重启后的状态理解为后台仍在继续执行。

## Workflow Spec 示例

```json
{
  "mode": "pipeline",
  "budgetPolicyPreset": "safe-write",
  "tasks": [
    {
      "id": "research",
      "readOnly": true,
      "prompt": "Inspect the target area and summarize risks."
    },
    {
      "id": "implement",
      "writeScope": ["packages/coordinator"],
      "isolate": true,
      "prompt": "Apply the scoped implementation."
    },
    {
      "id": "verify",
      "readOnly": true,
      "prompt": "Run focused checks and summarize remaining risk."
    }
  ]
}
```

先校验：

```bash
ohs workflow validate --spec ./workflow.json
```

真正启动 workflow 仍由 Coordinator/Leader 调 `Workflow` 工具完成；CLI 当前负责“看、验、收口、取消”，不直接替代模型入口提交执行。

`Workflow action: "run"` 默认会快速返回包含 `jobId` 的 Job receipt，并把真实 worker DAG 留在后台继续跑；模型后续使用 `JobRead/JobWait/JobCancel`，不要依赖单次工具调用一直阻塞到全部 task 完成。需要同步等待完整结果时显式传 `waitForCompletion: true`。TUI 的 `/workflow` 是统一 Jobs Panel 的别名；CLI 仍可用 `ohs workflow status <runId>` 读取 Workflow 领域详情。

## Template 参数示例

```json
{
  "taskPrompts": {
    "research": "Only inspect packages/coordinator.",
    "implement": "Patch the smallest coordinator surface.",
    "verify": "Run coordinator tests only."
  },
  "writeScope": ["packages/coordinator"],
  "maxConcurrency": 2,
  "budgetPreset": "fast-parallel",
  "failurePolicy": "skip-dependents"
}
```

```bash
ohs workflow template research-implement-verify --params ./workflow-template-params.json
```

## 和 TUI 的关系

当前 `ohs workflow ...` 是 Workflow 领域操作面：

- `list/status` 提供 run 列表与详情，适合脚本、CLI 诊断和未来 Web 消费；
- `validate/template` 给 planner 或用户在提交前检查 spec；
- `reconcile` 把冲突/重叠写入转换成下一轮可执行 spec；
- `cancel` 是 Workflow 领域取消入口；TUI 的普通取消统一走 JobCancel。

TUI 的 `/workflow` 和 `/workflows` 现在都打开统一 Jobs Panel：

- 顶层列表使用 Jobs API，不再维护第二份 Workflow runs 列表；
- `r` 同时刷新 Jobs 列表和当前选中 Job 的详情；
- `enter` 读取 Job detail，Workflow 的 Steps 从 `JobReadResult.details` 展示；
- `c` 仅在 Job capability 允许时取消；`k` / `f` 分别筛选 kind / status；
- timeline、history、reconcile 和 follow-up 仍是 Workflow 领域操作，通过 CLI 或 Workflow 工具执行。

通俗地说：Jobs Panel 负责“看这个后台工作现在怎样、读取详情、按能力取消”；`ohs workflow reconcile` 等命令负责 Workflow 特有的计划修复，不把这些领域动作复制进通用 Jobs 协议。
