# 任务 6 实现报告：以会话 selector 驱动界面状态

## 范围

- 新增纯 `desktop-session` selector，并以 active session、new conversation、session 和 project scope 读取运行态。
- conversation page、composer 队列、路由和布局改为使用命名 selector；已有会话与新会话的发送状态彼此独立。
- 删除顶层 `sending`、`sendingOperationId`、`openingSession`、`error`、pending/queued prompt 字段、`clearError` 及全部兼容镜像写入。
- 将旧 `desktop-session-store.test.ts` fixture 和断言迁移为 `newConversationRuntime`、`sessionRuntimes` 与 selector 语义；没有执行任务 7 的测试拆分或 store 入口重组。

## TDD 记录

### RED

1. 先新增 `selectors.test.ts` 并运行。`selectors.ts` 尚不存在，Vitest 以模块缺失失败。
2. 删除旧顶层字段后运行旧 store 测试。11 个失败均来自旧 fixture 或旧顶层状态断言，随后迁移为 runtime 和 selector 断言。
3. 审查发现同 kind、不同 target 的失败 operation 会累积。新增回归要求重试同 kind 时清理旧的失败项；修复前 `edit-old` 仍留在 runtime，测试按预期失败。

### GREEN

- selector 只从指定 session/new conversation/project runtime 读取状态，使用稳定的空 runtime，不在读路径分配对象。
- 页面仅在已有会话读取 active-session sending；新空白会话读取 new-conversation sending，因此后台会话不会污染当前 UI，普通发送也不会凭全局状态闪现队列。
- 失败错误选择保持最具体 scope；启动同一 kind 的新 operation 会清理该 runtime 中旧的失败 operation，保留其他 kind 和失败的可重试实体，限制错误累计。

## 审查

- 定向只读审查初始发现 1 个 Important：不同 target 的同 kind 失败 operation 未被清理。
- 已以对应 RED/GREEN 回归修复；没有 Critical 或其他遗留发现。

## 验证

- selector 初始 RED 后 GREEN：5/5 通过。
- 旧 fixture 迁移后任务聚焦测试：75/75 通过。
- 审查修复的 `operation-state.test.ts` RED 后 GREEN：5/5 通过。
- Desktop 全量 Vitest：34 个测试文件、207 个测试全部通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false --pretty false` 通过。
- 变更文件 ESLint 通过；`git diff --check` 通过。
- 生产代码旧顶层状态/`clearError`/兼容镜像静态扫描无匹配。

## 提交

实现提交：`refactor(desktop): 以会话 selector 驱动界面状态`（提交号见 Git history）。
