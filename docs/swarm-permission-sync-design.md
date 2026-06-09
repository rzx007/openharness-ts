# 设计：只读工具自动放行（permission_sync 最小版，D.4）

> 状态：已批准，待实现。建立在 D.1–D.3 之上。

## 目标

teammate 子进程对**只读工具**自动放行，不必父进程开 `full_auto`。只读 teammate
（Explore/Plan）默认就能干活；写操作仍按继承 mode（写转 leader 审批是完整版，留后续）。

## 只读工具集（对齐 Python `_READ_ONLY_TOOLS` + TS 新增）

```
READ_ONLY_TOOLS = { Read, Glob, Grep, WebFetch, WebSearch,
                    TaskGet, TaskList, TaskOutput, TaskWait, CronList, Lsp }
```
（Python: read_file/glob/grep/web_fetch/web_search/task_get/task_list/task_output/cron_list；
TS 额外加 TaskWait、Lsp。不含 Write/Edit/Bash 等写/执行类。）

## 关键取舍（已批准）

1. **作用域**：只对 **teammate 进程**生效，不动普通用户主会话权限。
2. **开启**：teammate 一律开（只读放行本就安全）—— `buildTeammateCommand` 给所有 teammate 加 `--swarm-worker`。
3. **判定顺序**：`full_auto > deniedTools > autoApprove(只读) > allowedTools/命令/路径/规则 > mode`。
   **denied 永远否决 autoApprove**（安全优先）。
4. **写操作**：最小版仍按 mode（default→ask/deny）。写转 leader 审批 = 完整版，范围外。

## 组件

### a) `packages/permissions`
- 导出常量 `READ_ONLY_TOOLS: ReadonlySet<string>`（上面那组）。
- `PermissionCheckOptions` / `PermissionSettings` 加可选 `autoApproveTools?: string[]`。
- `PermissionChecker` 存 `autoApproveTools: Set<string>`；`checkTool` 在 **deniedTools 拒绝判定之后、allowedTools 白名单之前**插入：
  `if (autoApproveTools.has(toolName)) return { action: "allow", reason: "Auto-approved read-only tool (swarm worker)" }`。

### b) CLI flag + 接线
- `apps/cli/src/index.ts`：加 `--swarm-worker` flag（隐藏/内部用，描述「以 swarm worker 身份运行：只读工具自动放行」）。
- `apps/cli/src/runtime.ts` bootstrap：当该 flag 为真，给 `PermissionChecker` 传 `autoApproveTools: [...READ_ONLY_TOOLS]`。

### c) teammate 命令
- `apps/cli/src/teammate.ts` `buildTeammateCommand`：argv 末尾加 `--swarm-worker`（所有 teammate 都带）。

## 测试

- `PermissionChecker`：
  - autoApprove 内的工具在 `default` mode 下也返回 allow；
  - 非只读工具仍按 mode（default → ask）；
  - **deniedTools 优先**：既在 denied 又在 autoApprove 的工具 → deny；
  - allowedTools 白名单存在时，autoApprove 工具仍能放行（顺序正确）。
- `READ_ONLY_TOOLS`：含 Read/Grep/Glob/WebFetch 等，**不含** Write/Edit/Bash。
- `buildTeammateCommand`：argv 含 `--swarm-worker`。
- runtime/bootstrap：`--swarm-worker` → checker.autoApproveTools 被设为只读集（可测的小函数或行为断言）。

## 范围外

- 写操作转 leader 审批（mailbox + leader/worker 角色，完整 permission_sync）。
- Bash 的"只读子集"判定（Bash 不在只读集，teammate 跑 bash 仍需 full_auto）。
- sandbox 网络权限、leader/worker 角色检测、文件式 pending/resolved 流。
