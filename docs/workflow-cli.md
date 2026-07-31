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

`Workflow action: "run"` 默认会快速返回一个 running snapshot，并把真实 worker DAG 留在后台继续跑；不要依赖单次工具调用一直阻塞到全部 task 完成。需要同步等待完整结果时显式传 `waitForCompletion: true`，但 TUI 场景推荐用 `/workflow` 或 `ohs workflow status <runId>` 观察进度。

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

当前 `ohs workflow ...` 是底层操作面：

- `list/status` 给 TUI/Web 提供 run 列表、详情、时间线和筛选控件数据；
- `validate/template` 给 planner 或用户在提交前检查 spec；
- `reconcile` 把冲突/重叠写入转换成下一轮可执行 spec；
- `cancel` 是后续 UI 取消按钮可以调用的同一条控制路径。

TUI 的 `/workflow` 面板已经接上这条底层路径：

- `r` 刷新 run 列表；
- `enter` 选中 run；
- `t/e/s` 轮换 task / event type / status filter，`x` 清空筛选；
- `c` 取消 running run；
- `1`-`9` 选择 reconciliation action，`f` 把选中的 action 提交为 follow-up workflow。

通俗地说：`ohs workflow reconcile` 负责“把失败后的修复计划生出来”，TUI 的 `f follow-up` 负责“把这个修复计划直接作为新的硬调度 workflow 跑起来”。多 action 时要先按数字选中一个；只有一个 action 时可以直接按 `f`。
