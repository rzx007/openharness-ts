# 任务 5 实现报告：prompt 与 queued prompt actions 会话运行态迁移

## 范围

- 新增 `prompt-actions.ts`，承接普通发送、slash command、编辑、停止和授权回复。
- 新增 `queued-prompt-actions.ts`，承接排队消息的提升和取消。
- `applySessionUpdate` 以 `sessionRuntimes[sessionId]` 为唯一对账目标；顶层 prompt 字段只保留为任务 6 前的兼容 UI 镜像。
- 没有迁移组件 selector、没有处理 deferred Minor，也没有修改或暂存两份 `conversation-attachments` 未跟踪文档。

## TDD 记录

### RED

1. 新增 `prompt-actions.test.ts` 后先运行。由于 `prompt-actions.ts` 尚不存在，Vitest 以模块缺失失败。
2. 新增 queued action 的稳定键回归：SSE 把 `run-1` 变为终态后，预期同时清理 action 和 `${sessionId}:${runId}` operation。修复前 operation 遗留，测试失败。
3. 新增 interrupt 的 SSE/IPC 乱序回归：SSE 已将点击时的 run 标为 `interrupted` 后，IPC 才报 `response lost`。修复前兼容错误通道被错误写入 `response lost`。

### GREEN

- 每个 prompt action 在点击时捕获 session ID，后续更新只写入该 session runtime；旧会话的异步完成不再清理新会话的状态。
- 普通 prompt 使用 input ID 同时作为 submission 与 `send-prompt` operation 的稳定 ID；失败 submission 可重试并复用 ID 和既有 placement。首次普通发送保持 `transcript` placement，连续尚未确认的发送会得到 `queue` placement。
- slash command 创建 `invoke-command` operation，但不创建 prompt submission；没有可用于 SSE 对账的实体时，IPC 成功会自行清理该 operation。
- queued promote/cancel 的 action 与 operation 都使用 `${sessionId}:${runId}`，只锁定目标 run。SSE 对账按 run ID 清理 action 与 operation；迟到 IPC 失败先读取 runtime 是否已被 SSE 确认，不反转成功。
- `session-view-state.ts` 现在按 operation kind 对账 input、run 或 permission 的稳定 ID；pending edit 在其 input ID 出现在权威 view 时同步清理。
- interrupt 与 permission reply 的 IPC catch 同样先检查目标 operation 是否已被 SSE 对账移除，防止迟到失败污染兼容错误通道。

## 验证

- RED/GREEN 定向 Vitest：`prompt-actions.test.ts` 最终 5/5 通过。
- 任务聚焦 Vitest：`prompt-actions.test.ts`、`desktop-session-store.test.ts`、`pending-prompt-queue.test.ts`，48/48 通过。
- Desktop 全量 Vitest：33 个测试文件、194 个测试全部通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false --pretty false` 通过。
- 变更文件 ESLint 通过；对整个既有 `desktop-session` 目录执行 ESLint 时只有未修改文件的历史 Prettier CRLF 警告，退出码为 0。
- `git diff --check` 通过。

## 提交

实现提交：待本任务提交后补充。
