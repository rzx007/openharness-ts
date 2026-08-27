# 任务 4 实现报告：session actions 与 primary open 所有权

## 范围

- 新增 `session-actions.ts`，承接新建、打开、fork、重命名、置顶、归档、删除以及新会话入口的动作。
- 保留现有公开 store API、`openingSession` 展示语义，以及尚未迁移的 prompt / queued-action 顶层兼容状态。
- 没有修改 ledger deferred Minor，也没有暂存或修改两份 `conversation-attachments` 未跟踪文档。

## TDD 记录

### RED

先新增 `session-actions.test.ts`。创建成功后，测试期望目标 session runtime 已拥有首条 submission 和已经从 `newConversationRuntime` 绑定过来的 `create-session` operation；迁移前失败，原因为目标 runtime 的 submission 为空。

同时保留并迁移两条竞态回归：迟到的 create 不得抢占 primary subscription，迟到的较旧 open snapshot 不得覆盖较新 SSE cursor。

### GREEN

- `startSession` 先在 `newConversationRuntime` 建立 `create-session` operation；create 返回后，在同一个 state 更新中用 `bindOperationToSession` 移到目标 runtime，并写入首条 submission。
- 只有创建 operation 仍拥有新会话页面时，才设置 active session、持久化并通过 `openSession` 发起 primary open；后台创建仍以明确 session ID 发送首条 prompt。
- `openSession` 在目标 runtime 创建 `open-session` operation。IPC snapshot 仅在 active session 相同且该 operation 仍为 `pending` 时才可应用，并继续使用 `acceptActiveSessionView` 防止 cursor 回退。
- SSE 对账会清理同一 session 已被 snapshot 确认的 create/open operations，避免完成 operation 无界保留。

## 验证

- 聚焦 Vitest：`session-actions.test.ts`、`session-view-state.test.ts`、`desktop-session-store.test.ts`、`router.test.ts`，48/48 通过。
- Desktop 全量 Vitest：`pnpm test` 通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false --pretty false` 通过。
- Lint：相关文件 ESLint 与 Desktop `pnpm lint` 均通过。
- `git diff --check` 通过。

## 提交

实现提交：`45f5e85`（`refactor(desktop): 拆分会话生命周期动作`）。

## 疑虑 / 后续边界

本任务只迁移 session 生命周期动作。`sending`、顶层 prompt submission、queued action 与其余 prompt 行为仍保持现状，留给后续 prompt-actions / queued-prompt-actions 任务统一迁移；没有提前删除这些兼容状态。
