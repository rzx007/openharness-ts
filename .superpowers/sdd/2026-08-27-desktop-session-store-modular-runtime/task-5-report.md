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

## 审查修复第 1 轮：兼容镜像回填

### RED

1. IPC `sendPrompt` 仍在 pending、而 SSE view 尚未包含该 input 时，`applySessionUpdate` 会把顶层 `sending` 和 submission 镜像错误清空。
2. 从旧会话切换并重新打开具有 pending、failed runtime 的会话时，顶层 submission、edit、queued action 与 sending 镜像仍沿用旧会话。
3. 已确认 input 的 SSE 到达后，镜像必须才被清理；不能由 IPC 或不含 input 的 SSE 提前清理。

### GREEN

- 在 `operation-state.ts` 提供纯函数 `projectRuntimeToLegacyMirror`：从指定 runtime 投影 `sending`、`sendingOperationId`、submission、edit 与 queued action。pending 的 send、invoke-command、edit operation 保持 composer 锁定；new conversation 的 create-session 在显式 opt-in 时也保持锁定。
- `applySessionUpdate`、`openPrimarySession` 的开始、snapshot、失败路径，以及 prompt/queued action 的 runtime replace 入口均改为复用该投影，避免兼容字段各自更新而漂移。
- 新增覆盖未确认 SSE、重新打开目标会话的 pending/failed runtime，以及确认 SSE 才清镜像的测试。

### 本轮验证

- 定向 RED 后 GREEN：`prompt-actions.test.ts` 与 `session-actions.test.ts`，22/22 通过。
- Desktop 全量 Vitest：33 个测试文件、197 个测试通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false` 通过。
- 本轮修改文件 ESLint 与 `git diff --check` 通过。
- Node TypeScript 仍因工作区现有 `drizzle-orm/better-sqlite3` 类型入口缺失而失败，未改动该无关依赖问题。

## 审查修复第 2 轮：首条发送锁与新会话导航代际

### RED

1. 新建会话的首条普通 prompt 在 create/open 完成后只保留 `submitting` submission，因没有 pending send operation，兼容 `sending` 镜像在 IPC 仍 pending 时提前变为 `false`。
2. create 尚未返回时进入新空白页或“从会话开始”，页面继续投影旧 `newConversationRuntime`；旧 create 回包只凭 operation ID 判断所有权，会重新抢占 primary 页面。

### GREEN

- `projectRuntimeToLegacyMirror` 将仍为 `submitting` 的普通 submission 也视作 composer busy，并使用其 input ID 作为稳定 `sendingOperationId`；IPC 结算或 SSE 以该 input ID 确认后按既有生命周期解除锁定。
- `startSession` 捕获创建时的 primary navigation generation。create 回包必须同时拥有相同代际、自己的 operation 和自己的镜像 ID，才能设为 active 并打开 primary snapshot。
- `startNewConversation` 与 `startConversationFrom` 现在建立新的空 `newConversationRuntime` 并从它投影兼容镜像。失去页面所有权的旧 create 仍可在后台把首条 prompt 写入自己的目标 session runtime，但不写当前页面镜像，也不打开 primary session。
- 首条 prompt、命令、成功、失败和 finally 路径按目标 session runtime 更新镜像，防止后台旧请求污染新页面。

### 本轮验证

- TDD 定向 RED：`session-actions.test.ts` 的三个新回归均按预期失败；最小修复后 GREEN，19/19 通过。
- Desktop 全量 Vitest：33 个测试文件、200 个测试通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false` 通过。
- 本轮修改文件 ESLint、Prettier 与 `git diff --check` 通过。
