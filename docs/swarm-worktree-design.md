# 设计：teammate worktree 隔离（D.3）

> 状态：已批准，待实现。建立在 D.1（subprocess 派发）+ D.2（完成等待）之上。

## 目标

并行 teammate 在各自独立的 git worktree（独立分支 + 工作目录）里干活，写代码互不冲突。
读类 agent（Explore/Plan）不写、默认不隔离。

## 关键取舍（已批准）

1. **何时建 worktree**：**opt-in** —— `agent` 工具加 `isolate?: boolean`（默认 false）。
2. **路径/分支**：worktree 放 `~/.openharness/worktrees/<repo-id>/<flatSlug>`；
   slug=`<team>-<name>-<shortId>`（校验防 `..`/绝对路径穿越）；分支 `worktree-<flatSlug>`。
3. **拿结果/清理**：teammate 在 worktree 里改（建议它 commit），完成后**保留** worktree+分支，
   结果告知 leader「改动在分支 `worktree-<flatSlug>` / 路径 `<path>`」，leader 自行 merge/review；
   `terminate` 时 `git worktree remove`（**非 force**：有未提交改动则 git 拒绝 → 保留，等于
   「未改动才自动清」）；force 清理由 manager 暴露供显式调用。**不自动 merge**。
4. **非 git 仓库**：isolate 变 no-op + 警告，不中断（teammate 仍在共享 cwd 跑）。

## 组件

### a) `WorktreeManager` — packages/swarm（新文件）
- 经注入的 git 运行器调用，便于测试：
  `new WorktreeManager({ runGit: (args, cwd) => Promise<{code, stdout, stderr}>, baseDir })`。
- `validateWorktreeSlug(slug)`：非空、长度上限、拒绝绝对路径与 `.`/`..` 段、字符集限制（移植 Python）。
- `create(slug, opts?): Promise<{ slug, path, branch, created: boolean }>`：
  `git worktree add -b <branch> <path>`；已存在且为有效 worktree 则复用（created=false）。
  branch=`worktree-<flatSlug>`（`/`→`+`），path=`baseDir/<flatSlug>`。
- `remove(slug, opts?: { force? }): Promise<void>`：`git worktree remove [--force] <path>`。
- `list(): Promise<WorktreeInfo[]>`。
- （可选）`hasChanges(slug)`：`git status --porcelain` 判脏。
- （可选）symlink `node_modules` 等大目录省空间——**最小版可不做**，留 TODO。

### b) `SubprocessBackend` — packages/swarm
- `TeammateSpawnConfig.isolate?: boolean`。
- 经注入的可选 `worktreeManager`（缺省则 isolate 退化为 no-op + 警告）。
- spawn：isolate 且仓库是 git → `create(slug)`，teammate 的 `cwd` 设为 worktree path；
  记录 `agentId → { taskId, slug }`。SpawnResult 增加可选 `worktree?: { path, branch }`。
- `terminate(agentId)`：stopTask + 若隔离则 `worktreeManager.remove(slug)`（非 force）。

### c) `agent` 工具 — packages/tools
- inputSchema 加 `isolate?: boolean`（描述：并行写任务时隔离到独立 git worktree）。
- 透传到 spawn config.isolate；SpawnResult.worktree 存在时把分支/路径写进返回文本，告知 leader。

### d) 接线 — apps/cli/src/runtime.ts
- 构造真实 `WorktreeManager`（git 运行器用 child_process，baseDir 用配置目录下按 repo 区分），
  注入进 `SubprocessBackend`。

## 测试

- `WorktreeManager`（临时 git repo + 真实 git，跨平台）：create→得 path+branch 且 `git worktree list` 含它 /
  复用已存在(created=false) / remove 清掉 / 脏 worktree 非 force remove 被拒 / slug 校验拒 `..`·绝对路径·空。
- `SubprocessBackend`（mock worktreeManager + mock taskRunner）：isolate=true → 用 worktree path 当 cwd、
  SpawnResult.worktree 正确、terminate 调 remove；isolate=true 但无 worktreeManager → no-op 用原 cwd；
  isolate=false → 不碰 worktree。

## 范围外（保持最小）

- 自动 merge teammate 改动（leader/用户手动）。
- node_modules 等大目录 symlink（留 TODO）。
- AllowedPath 权限范围、team.json 持久化、stale 批量清理（更大，后续）。
