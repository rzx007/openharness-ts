# 任务 7 审查修复第 1 轮报告

## 范围

基线提交：`818f399`。

本轮只处理两项 Important：

1. 将 selected-project Git refresh 的 timer/debounce 从 `store.ts` 提取到 `project-git-scheduler.ts`。
2. 将 renderer daemon/SSE 事件订阅改为共享、引用计数和可清理的生命周期。

未处理 Minor，没有修改 ledger、附件或任务 8 README。

## 修复内容

- `createSelectedProjectGitRefreshScheduler()` 拥有 `schedule`、`reset`、`dispose` 和 timer；连续 schedule 只执行一次，任一 force 请求会以 `{ force: true }` 触发 refresh。
- `store.ts` 只创建 scheduler 依赖、组装 store 和管理事件订阅；不再保存 timer 或实现 debounce 正文。
- `attachDesktopDaemonStatusEvents()` 取消全局布尔值，返回底层 unsubscribe；`initialize()` 不再私自注册无法清理的 daemon listener。
- `attachDesktopSessionEvents()` 使用引用计数共享一个 SSE listener 和一个 daemon listener。每个 cleanup 幂等；最后一个 cleanup 同时取消两个底层订阅、清除 scheduler 的待执行 refresh，之后可重新 attach。

## TDD 证据

- `project-git-scheduler.test.ts` 首次运行因目标模块不存在失败；实现后覆盖 debounce、force 透传、reset 和 dispose，转绿。
- `store.integration.test.ts` 的事件生命周期测试首次运行在重复 attach 注册两次 SSE listener 处失败；实现共享生命周期后转绿，覆盖重复 attach、部分 cleanup、最后 cleanup 和重新 attach。

## 验证

- 聚焦测试：`project-git-scheduler.test.ts` 与 `store.integration.test.ts`，7/7 通过。
- 桌面完整 Vitest：39 文件、230 测试通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false --pretty false`，exit 0。
- 指定 ESLint：exit 0；保留 5 条此前已有、未纳入本轮的 Prettier 换行 warning（pending/session-view 纯状态文件）。
