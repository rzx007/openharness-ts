# Agent Worktree Isolation

> 状态：当前主线文档。worktree 隔离现在由 `DaemonChildAgentHost` 在 runtime-host child invocation 路径中处理。

## 目标

并行写代码的 child agent 可以 opt-in 到独立 git worktree，避免多个 agent 在同一个 cwd 上互相覆盖。

默认规则：

- `isolate` 缺省为 `false`。
- 读类 agent 通常不需要隔离。
- 非 git repo 中 `isolate: true` 是 no-op，继续使用原 cwd。
- daemon 不自动 merge child worktree 的改动。

## 当前流程

```text
Agent tool / Workflow worker
  -> runtimeHost.spawnChildAgent({ isolate: true, ... })
  -> DaemonChildAgentHost
  -> resolve git repo root
  -> compute <configDir>/worktrees/<repoId>/<slug>
  -> git worktree add -B worktree-<slug> <path> HEAD
  -> create child session with cwd = worktree path
  -> register parent-visible task with cwd = worktree path
  -> return invocation.worktree { path, branch }
```

## 组件

| 组件 | 文件 | 责任 |
|---|---|---|
| Agent input schema | `packages/tools/src/agent/index.ts` | 暴露 `isolate?: boolean` |
| Workflow task spawn | `packages/tools/src/agent/workflow-runner.ts` | 透传 `isolate` |
| Worktree creation | `packages/server/src/http/daemon-child-agent-host.ts` | 创建/复用/删除 worktree |
| Child session cwd | `packages/server/src/http/daemon-child-agent-host.ts` | child session 和 task projection 都使用 worktree path |

## Path / branch

当前实现：

```text
baseDir = <configDir>/worktrees/<sha1(repoRoot)[0..12]>
slug = <team>-<agent>-<shortHash>-<random>
path = baseDir/<slug>
branch = worktree-<slug>
```

slug 会校验：

- 非空
- 长度不超过 64
- 不允许绝对路径
- 不允许 `.` / `..`
- 每个 segment 只允许字母、数字、点、下划线、加号、横线

## Cleanup

spawn 失败：

```text
complete parent task as failed when task exists
interrupt/close/archive child when child exists
force remove newly-created worktree
```

child interrupt/stop：

```text
interrupt child session
close child runtime
archive child session
complete parent task as stopped
if worktree has no changes:
  git worktree remove <path>
else:
  keep worktree for user review
```

normal completion：

- 不自动删除 worktree。
- Agent 返回文本包含 branch/path，提醒用户 review/merge/cleanup。

## 范围外

- 自动 merge child worktree。
- 自动创建 commit。
- 大目录 symlink 优化。
- stale worktree 批量清理。
- 更细的 allowed-path sandbox。
