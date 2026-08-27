# Desktop Session Store 模块化与会话运行态实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将约 1,700 行的桌面会话 store 拆成职责清晰的模块，并用按会话、按操作的运行态替代全局 `sending/error`，同时保持现有 IPC、SSE 和 UI 行为。

**架构：** 保留一个 Zustand store 作为原子状态容器；应用/目录/primary 视图继续只有一份，会话本地覆盖和异步操作进入 `newConversationRuntime` 或 `sessionRuntimes[sessionId]`。动作模块只负责 IPC 编排，operation、cursor、pending prompt 和错误归属由纯状态模块统一处理，组件通过命名 selector 读取页面语义。

**技术栈：** TypeScript、React、Zustand、Electron IPC、SSE session snapshot、Vitest、React DOM server rendering、ESLint、Prettier、Turbo。

**设计规格：** `docs/superpowers/specs/2026-08-27-desktop-session-store-modular-runtime-design.md`

---

## 最终文件结构与职责

### 新建文件

- `apps/desktop/src/renderer/src/stores/desktop-session/README.md`：真实运行流程、模块职责和不可破坏约束。
- `apps/desktop/src/renderer/src/stores/desktop-session/types.ts`：完整 state、actions、runtime、operation 和局部实体类型。
- `apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts`：无副作用地创建初始状态。
- `apps/desktop/src/renderer/src/stores/desktop-session/store.ts`：组合 action creator，创建唯一 Zustand store。
- `apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts`：面向组件的 sending、opening、error 和局部覆盖 selector。
- `apps/desktop/src/renderer/src/stores/desktop-session/operation-state.ts`：operation 创建、绑定、确认、失败和清理纯函数。
- `apps/desktop/src/renderer/src/stores/desktop-session/error-state.ts`：错误文本和作用域错误读取纯函数。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.ts`：cursor、active session 校验和 SSE 对账纯函数。
- `apps/desktop/src/renderer/src/stores/desktop-session/pending-prompt-state.ts`：submission placement、重试、确认和 queued action 对账纯函数。
- `apps/desktop/src/renderer/src/stores/desktop-session/bootstrap-actions.ts`：initialize、refresh bootstrap 和 daemon 事件。
- `apps/desktop/src/renderer/src/stores/desktop-session/project-actions.ts`：项目选择、Git、branch 和项目设置。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`：创建、打开、fork、rename、pin、archive 和 delete。
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`：发送、命令、编辑、停止和授权回复。
- `apps/desktop/src/renderer/src/stores/desktop-session/queued-prompt-actions.ts`：提升和取消排队消息。
- `apps/desktop/src/renderer/src/stores/desktop-session/persistence.ts`：active session localStorage 读写。
- `apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts`：稳定排序、upsert、路径和标题等跨模块纯函数。
- `apps/desktop/src/renderer/src/stores/desktop-session/operation-state.test.ts`：operation 生命周期和隔离。
- `apps/desktop/src/renderer/src/stores/desktop-session/selectors.test.ts`：会话、新会话和项目作用域 selector。
- `apps/desktop/src/renderer/src/stores/desktop-session/pending-prompt-state.test.ts`：placement 和 SSE 对账。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.test.ts`：cursor 与 active view 规则。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`：创建/打开会话竞态。
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`：发送、编辑、停止和授权竞态。
- `apps/desktop/src/renderer/src/stores/desktop-session/store.integration.test.ts`：跨模块 IPC/SSE/切换集成测试。

### 修改文件

- `apps/desktop/src/renderer/src/stores/desktop-session-store.ts`：最终缩成兼容导出入口。
- `apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts`：测试迁移完成后删除。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`：改用命名 selector 和 active runtime 局部数据。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.tsx`：改为接收 selector 产出的展示模型，不自行读取 store。
- `apps/desktop/src/renderer/src/routes/__root.tsx`：读取应用级 daemon 状态 selector。
- `apps/desktop/src/renderer/src/routes/_main.index.tsx`：继续通过兼容入口初始化并读取 active session。
- `apps/desktop/src/renderer/src/routes/_main.conversation.$sessionId.tsx`：保持 primary open 路由所有权检查。
- `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`：切换到目录 selector。
- `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`：切换到目录 selector 和 action。
- `apps/desktop/src/renderer/src/components/desktop/layout/settings-layout/settings-layout.tsx`：切换到导航 selector。
- 其他只读消费者继续从兼容入口读取稳定字段，不做无关重写。

## 最终核心类型

所有任务使用下面这些名称，后续任务不得另起同义字段：

```ts
export type DesktopOperationPhase = "pending" | "acknowledged" | "failed"

export type DesktopOperationKind =
  | "create-session"
  | "open-session"
  | "send-prompt"
  | "invoke-command"
  | "edit-prompt"
  | "promote-prompt"
  | "cancel-prompt"
  | "interrupt-run"
  | "reply-permission"
  | "project-action"

export interface DesktopOperation {
  id: string
  kind: DesktopOperationKind
  phase: DesktopOperationPhase
  sessionId: string | null
  projectId?: string
  startedAt: number
  finishedAt?: number
  error?: string
}

export interface DesktopSessionRuntime {
  operations: Record<string, DesktopOperation>
  pendingPromptSubmissions: Record<string, PendingPromptSubmission>
  pendingPromptEdit: PendingPromptEdit | null
  queuedPromptActions: Record<string, QueuedPromptAction>
}

export interface DesktopRuntimeState {
  appOperations: Record<string, DesktopOperation>
  projectOperations: Record<string, Record<string, DesktopOperation>>
  newConversationRuntime: DesktopSessionRuntime
  sessionRuntimes: Record<string, DesktopSessionRuntime>
}
```

`DesktopSessionState` 组合现有应用/目录/导航字段、`DesktopRuntimeState` 和 `DesktopSessionActions`。最终不得含有顶层 `sending`、`sendingOperationId`、`openingSession`、`error`、`pendingPromptSubmissions`、`pendingPromptEdit` 或 `queuedPromptActions`。

---

### 任务 1：建立 runtime 与 operation 纯状态核心

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/operation-state.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/operation-state.test.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`

- [ ] **步骤 1：编写 operation 所有权失败测试**

```ts
it("only settles the operation with the matching id", () => {
  const runtime = createEmptySessionRuntime()
  const first = beginOperation(runtime, {
    id: "op-old",
    kind: "send-prompt",
    sessionId: "session-1",
    startedAt: 1,
  })
  const second = beginOperation(first, {
    id: "op-new",
    kind: "send-prompt",
    sessionId: "session-1",
    startedAt: 2,
  })

  const settled = acknowledgeOperation(second, "op-old", 3)

  expect(settled.operations["op-old"]?.phase).toBe("acknowledged")
  expect(settled.operations["op-new"]?.phase).toBe("pending")
})

it("moves a new-conversation operation to the created session", () => {
  const runtime = beginOperation(createEmptySessionRuntime(), {
    id: "op-create",
    kind: "create-session",
    sessionId: null,
    startedAt: 1,
  })

  const moved = bindOperationToSession(runtime, createEmptySessionRuntime(), "op-create", "s1")

  expect(moved.source.operations).toEqual({})
  expect(moved.target.operations["op-create"]).toMatchObject({ sessionId: "s1" })
})
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session/operation-state.test.ts
```

工作目录：`apps/desktop`

预期：FAIL，模块或导出尚不存在。

- [ ] **步骤 3：实现最小 operation API**

在 `operation-state.ts` 实现并导出：

```ts
export function createEmptySessionRuntime(): DesktopSessionRuntime
export function beginOperation(
  runtime: DesktopSessionRuntime,
  input: Omit<DesktopOperation, "phase">
): DesktopSessionRuntime
export function acknowledgeOperation(
  runtime: DesktopSessionRuntime,
  operationId: string,
  finishedAt: number
): DesktopSessionRuntime
export function failOperation(
  runtime: DesktopSessionRuntime,
  operationId: string,
  error: string,
  finishedAt: number
): DesktopSessionRuntime
export function removeOperation(
  runtime: DesktopSessionRuntime,
  operationId: string
): DesktopSessionRuntime
export function bindOperationToSession(
  source: DesktopSessionRuntime,
  target: DesktopSessionRuntime,
  operationId: string,
  sessionId: string
): { source: DesktopSessionRuntime; target: DesktopSessionRuntime }
```

所有函数返回新对象；找不到 operation ID 时原样返回，绝不清理“最新一个”或同 kind 的其他操作。

- [ ] **步骤 4：从旧 store 导出临时共享类型**

把 `PendingPromptSubmission`、`QueuedPromptAction`、`PendingPromptEdit`、`SubmitPromptOptions` 和 `DesktopSessionState` 搬到 `types.ts`。旧 `desktop-session-store.ts` 从新文件导入这些类型，行为暂时不变。

- [ ] **步骤 5：建立无副作用初始状态工厂**

```ts
export function createInitialRuntimeState(): DesktopRuntimeState {
  return {
    appOperations: {},
    projectOperations: {},
    newConversationRuntime: createEmptySessionRuntime(),
    sessionRuntimes: {},
  }
}
```

先把新 runtime state 合入 store 初始值，但此任务不删除旧顶层状态；这是受测试保护的短期迁移桥，后续任务 6 必须删除。

- [ ] **步骤 6：运行聚焦测试、旧 store 测试和类型检查**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session/operation-state.test.ts src/renderer/src/stores/desktop-session-store.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
```

预期：全部 PASS，TypeScript exit 0。

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/types.ts apps/desktop/src/renderer/src/stores/desktop-session/operation-state.ts apps/desktop/src/renderer/src/stores/desktop-session/operation-state.test.ts apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts apps/desktop/src/renderer/src/stores/desktop-session-store.ts
git commit -m "refactor(desktop): 建立会话操作运行态"
```

---

### 任务 2：提取 pending prompt 与 session view 对账规则

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/pending-prompt-state.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/pending-prompt-state.test.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`

- [ ] **步骤 1：编写 placement 与 cursor 失败测试**

```ts
it("classifies a second unconfirmed prompt as queued", () => {
  const runtime = createEmptySessionRuntime()
  runtime.pendingPromptSubmissions["input-1"] = {
    id: "input-1",
    sessionId: "s1",
    content: "first",
    createdAt: 1,
    phase: "accepted",
    placement: "transcript",
  }

  expect(classifyPromptPlacement(null, runtime, "s1")).toBe("queue")
})

it("does not replace a newer active view with an older cursor", () => {
  const current = emptySessionView("s1", 5)
  const incoming = emptySessionView("s1", 4)

  expect(acceptActiveSessionView("s1", current, incoming)).toBe(current)
})

it("ignores a view for a background session", () => {
  expect(acceptActiveSessionView("s2", emptySessionView("s2", 2), emptySessionView("s1", 3)))
    .toEqual(emptySessionView("s2", 2))
})
```

- [ ] **步骤 2：运行两个新测试文件并确认红灯**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session/pending-prompt-state.test.ts src/renderer/src/stores/desktop-session/session-view-state.test.ts
```

预期：FAIL，目标模块尚未实现。

- [ ] **步骤 3：移动 pending prompt 纯函数**

把旧 store 中以下逻辑移动到 `pending-prompt-state.ts`，改成显式导出：

```ts
export function classifyPromptPlacement(
  view: DesktopSessionView | null,
  runtime: DesktopSessionRuntime,
  sessionId: string
): "transcript" | "queue"
export function updatePendingPromptSubmission(...): Record<string, PendingPromptSubmission>
export function removePendingPromptSubmission(...): Record<string, PendingPromptSubmission>
export function reconcilePendingPromptSubmissions(...): Record<string, PendingPromptSubmission>
export function reconcileQueuedPromptActions(...): Record<string, QueuedPromptAction>
export function queuedPromptActionConfirmed(...): boolean
export function queuedPromptActionKey(sessionId: string, runId: string): string
```

`classifyPromptPlacement` 同时检查权威 `pending/running` run 和同会话本地 `submitting/accepted` submission；失败 submission 不算 in-flight。

- [ ] **步骤 4：移动 session view 纯函数**

```ts
export function acceptActiveSessionView(
  activeSessionId: string | null,
  current: DesktopSessionView | null,
  incoming: DesktopSessionView
): DesktopSessionView | null

export function reconcileRuntimeWithView(
  runtime: DesktopSessionRuntime,
  view: DesktopSessionView
): DesktopSessionRuntime
```

第一函数只接收 active session 且 cursor 不更旧的 view；第二函数只清理同 session、稳定 ID 已被 view 确认的 submission/action/operation。

- [ ] **步骤 5：旧 store 改用新纯函数并删除原地副本**

保留行为完全一致；不要同时迁移动作或组件。

- [ ] **步骤 6：运行新旧测试和类型检查**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session/pending-prompt-state.test.ts src/renderer/src/stores/desktop-session/session-view-state.test.ts src/renderer/src/stores/desktop-session-store.test.ts src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
```

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/pending-prompt-state.ts apps/desktop/src/renderer/src/stores/desktop-session/pending-prompt-state.test.ts apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.ts apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.test.ts apps/desktop/src/renderer/src/stores/desktop-session-store.ts
git commit -m "refactor(desktop): 提取会话视图对账规则"
```

---

### 任务 3：提取 persistence、helpers、bootstrap 与 project actions

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/persistence.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/error-state.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/bootstrap-actions.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/project-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`
- 测试：`apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts`

- [ ] **步骤 1：加强 bootstrap/project 错误隔离测试**

```ts
it("keeps a project operation failure out of the active session runtime", async () => {
  window.desktop.projects.inspect = vi.fn(async () => {
    throw new Error("project unavailable")
  })
  useDesktopSessionStore.setState({
    activeSessionId: "s1",
    sessionRuntimes: { "s1": createEmptySessionRuntime() },
  })

  await expect(useDesktopSessionStore.getState().selectProject(project)).rejects.toThrow()

  expect(useDesktopSessionStore.getState().sessionRuntimes["s1"]?.operations).toEqual({})
  expect(
    Object.values(useDesktopSessionStore.getState().projectOperations[project.id] ?? {})
  ).toContainEqual(expect.objectContaining({ phase: "failed", error: "project unavailable" }))
})
```

- [ ] **步骤 2：运行测试确认当前实现失败**

预期：FAIL，因为项目错误仍写入旧全局 `error`，selector 尚不存在。

- [ ] **步骤 3：提取无状态 helpers 与 persistence**

`helpers.ts` 导出：

```ts
upsertProject
upsertSession
sortSessions
isSessionPinned
resolveInitialProject
resolveSessionWorkspace
sessionPermissionMode
sessionProvider
projectFromSession
samePath
formatSessionTitle
isPlaceholderTitle
```

`persistence.ts` 导出：

```ts
readPersistedActiveSessionId
writePersistedActiveSessionId
clearPersistedActiveSessionId
```

localStorage 不可用或抛错时读取返回 `null`，写入/删除静默失败。

- [ ] **步骤 4：建立 action creator 统一上下文**

在 `types.ts` 定义：

```ts
export interface DesktopStoreContext {
  set: StoreApi<DesktopSessionState>["setState"]
  get: StoreApi<DesktopSessionState>["getState"]
}
```

`bootstrap-actions.ts` 和 `project-actions.ts` 分别导出：

```ts
export function createBootstrapActions(context: DesktopStoreContext): BootstrapActions
export function createProjectActions(context: DesktopStoreContext): ProjectActions
```

- [ ] **步骤 5：移动对应动作并改用作用域 operation**

从旧 store 移动：

- bootstrap：`initialize`、`refreshBootstrap`、daemon status event；
- project：`chooseProject`、`selectProject`、`selectOutsideProject`、Git refresh、checkout/create branch、rename/pin/shell/remove/rebind。

项目操作使用 `projectOperations[projectId]`；尚无 project ID 的 picker/bootstrap 错误使用 `appOperations`。不再写旧顶层 `error`。

- [ ] **步骤 6：运行 provider/project/Git 测试与类型检查**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session-store.test.ts src/renderer/src/components/desktop/settings-page/provider-feedback.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
```

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/persistence.ts apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts apps/desktop/src/renderer/src/stores/desktop-session/error-state.ts apps/desktop/src/renderer/src/stores/desktop-session/bootstrap-actions.ts apps/desktop/src/renderer/src/stores/desktop-session/project-actions.ts apps/desktop/src/renderer/src/stores/desktop-session/types.ts apps/desktop/src/renderer/src/stores/desktop-session-store.ts apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts
git commit -m "refactor(desktop): 拆分启动与项目状态动作"
```

---

### 任务 4：迁移 session actions 并保护 primary open 所有权

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`

- [ ] **步骤 1：迁移并加强两个关键竞态测试**

```ts
it("does not let a late create steal the primary subscription", async () => {
  const starting = store.getState().startSession("start A")
  await store.getState().openSession("session-b")
  resolveCreate(sessionA)
  await starting

  expect(store.getState().activeSessionId).toBe("session-b")
  expect(window.desktop.sessions.open).toHaveBeenCalledTimes(1)
  expect(window.desktop.sessions.open).toHaveBeenCalledWith("session-b")
})

it("does not let an older open snapshot replace a newer SSE view", async () => {
  const opening = store.getState().openSession("session-1")
  store.getState().applySessionUpdate(emptySessionView("session-1", 5))
  resolveOpen(emptySessionView("session-1", 2))
  await opening

  expect(store.getState().sessionView?.cursor).toBe(5)
})
```

- [ ] **步骤 2：运行新测试文件确认迁移前红灯**

预期：FAIL，因为 `session-actions.ts` 及测试辅助 store 尚未存在。

- [ ] **步骤 3：实现 `createSessionActions`**

移动以下动作：

```ts
startNewConversation
selectModel
selectPermissionMode
updateSessionModel
updateSessionPermissionMode
openSession
startConversationFrom
forkSession
renameSession
togglePinSession
archiveSession
deleteSession
startSession
```

创建会话使用 `newConversationRuntime` 的 `create-session` operation；session 返回后用 `bindOperationToSession` 原子移动 operation，并把首条 submission 写入目标 session runtime。

- [ ] **步骤 4：用 operation 替代 `openingSession`**

打开 B 时，在 B runtime 写入 `open-session` operation。snapshot 只能在以下条件同时满足时应用：

```ts
state.activeSessionId === sessionId &&
state.sessionRuntimes[sessionId]?.operations[operationId]?.phase === "pending"
```

应用 snapshot 时仍调用 `acceptActiveSessionView`，防止旧 cursor 覆盖新 SSE。

- [ ] **步骤 5：确保迟到创建不调用 primary open**

只有 `newConversationRuntime` 当前 create operation 仍拥有页面时才写 active session、持久化并调用 `sessions.open(session.id)`。否则仅按明确 session ID 发送首条 prompt。

- [ ] **步骤 6：运行 session action、旧 store 和路由测试**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session/session-actions.test.ts src/renderer/src/stores/desktop-session-store.test.ts src/renderer/src/router.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
```

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts apps/desktop/src/renderer/src/stores/desktop-session/types.ts apps/desktop/src/renderer/src/stores/desktop-session-store.ts apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts
git commit -m "refactor(desktop): 拆分会话生命周期动作"
```

---

### 任务 5：迁移 prompt 与 queued prompt actions 到会话 runtime

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/queued-prompt-actions.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`

- [ ] **步骤 1：写会话隔离和 SSE/IPC 顺序失败测试**

```ts
it("does not let an old session send settle the new session send", async () => {
  const oldRequest = store.getState().sendMessage("old")
  store.setState({ activeSessionId: "session-new" })
  const newRequest = store.getState().sendMessage("new")
  resolveOld()
  await oldRequest

  expect(selectSessionSending(store.getState(), "session-old")).toBe(false)
  expect(selectSessionSending(store.getState(), "session-new")).toBe(true)

  resolveNew()
  await newRequest
})

it("treats SSE-confirmed input as success when IPC rejects later", async () => {
  const request = store.getState().sendMessage("confirmed")
  const id = sendPrompt.mock.calls[0]![0].id
  store.getState().applySessionUpdate(viewContainingInput("session-1", id, 1))
  rejectSend(new Error("response lost"))

  await expect(request).resolves.toBeUndefined()
  expect(selectSessionComposerError(store.getState(), "session-1")).toBeNull()
})
```

- [ ] **步骤 2：运行新测试并确认红灯**

预期：FAIL，因为 selector 和新 action 模块尚不存在。

- [ ] **步骤 3：实现 `createPromptActions`**

移动：

```ts
sendMessage
editLatestMessage
interrupt
replyPermission
```

命令仍走 `sendMessage(content, { commandLine })` 分支，但 operation kind 使用 `invoke-command`，且不创建 prompt submission。

每次操作读取点击时的 `sessionId`，此后只更新 `sessionRuntimes[sessionId]`。IPC catch 先用稳定 ID 判断 SSE 是否已确认；确认后按成功结束，不写失败。

- [ ] **步骤 4：实现 `createQueuedPromptActions`**

移动 `promoteQueuedPrompt` 和 `cancelQueuedPrompt`。每条 action 保存在所属 session runtime；operation/action key 使用 `${sessionId}:${runId}`，只锁对应 run。

- [ ] **步骤 5：把 `applySessionUpdate` 改成 runtime 对账入口**

接受 view 后：

```ts
const runtime = getSessionRuntime(state, view.session.id)
const reconciled = reconcileRuntimeWithView(runtime, view)
```

只写回 `sessionRuntimes[view.session.id]`，不清理其他 runtime。Git refresh 调度仍保留。

- [ ] **步骤 6：运行 prompt、queue、组件和 store 测试**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session/prompt-actions.test.ts src/renderer/src/stores/desktop-session-store.test.ts src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
```

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts apps/desktop/src/renderer/src/stores/desktop-session/queued-prompt-actions.ts apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts apps/desktop/src/renderer/src/stores/desktop-session/types.ts apps/desktop/src/renderer/src/stores/desktop-session-store.ts apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts
git commit -m "refactor(desktop): 按会话隔离消息操作状态"
```

---

### 任务 6：建立 selector，迁移组件并删除全局状态

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/selectors.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.tsx`
- 修改：`apps/desktop/src/renderer/src/routes/__root.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/settings-layout/settings-layout.tsx`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts`

- [ ] **步骤 1：编写 selector 行为测试**

在 `selectors.test.ts` 写：

```ts
it("selects sending only from the requested session", () => {
  const state = stateWithPendingOperation("session-a", "send-prompt")

  expect(selectSessionSending(state, "session-a")).toBe(true)
  expect(selectSessionSending(state, "session-b")).toBe(false)
})

it("selects new-conversation sending independently", () => {
  const state = stateWithNewConversationOperation("create-session")

  expect(selectNewConversationSending(state)).toBe(true)
  expect(selectActiveSessionSending({ ...state, activeSessionId: "session-a" })).toBe(false)
})
```

- [ ] **步骤 2：实现命名 selector**

至少导出：

```ts
selectActiveSessionRuntime
selectNewConversationSending
selectSessionSending
selectActiveSessionSending
selectActiveSessionOpening
selectActiveSessionPromptSubmissions
selectActiveSessionQueuedPromptActions
selectSessionComposerError
selectNewConversationError
selectProjectOperationError
```

selector 不修改 state，不调用 IPC，不返回每次都新建的大对象；需要数组时仅在组件用 `useMemo` 或提供稳定的实体 map。

- [ ] **步骤 3：迁移 conversation page**

替换：

```ts
const sending = useDesktopSessionStore(selectActiveSessionSending)
const openingSession = useDesktopSessionStore(selectActiveSessionOpening)
const pendingPromptSubmissions = useDesktopSessionStore(selectActiveSessionPromptSubmissions)
const queuedPromptActions = useDesktopSessionStore(selectActiveSessionQueuedPromptActions)
```

新会话页面使用 `selectNewConversationSending`；已有会话页面使用 `selectActiveSessionSending`。不要再让一个全局 boolean 同时控制两处。

- [ ] **步骤 4：迁移其他直接消费者**

路由和布局继续通过命名 selector 读取 daemon、目录和导航状态。只读 selected project/session view 的工具组件可以保留窄匿名 selector，不需要为每个字段创建包装函数。

- [ ] **步骤 5：删除旧顶层状态和双写代码**

先把 `desktop-session-store.test.ts` 中直接写入或断言旧顶层字段的 fixture 改为 `newConversationRuntime/sessionRuntimes`，并用本任务的 selector 断言页面语义。保持原有测试名称和竞态断言；任务 7 只负责把已经迁移完成的测试按职责移动到多个文件。

从类型、初始值和所有 action 删除：

```text
sending
sendingOperationId
openingSession
error
pendingPromptSubmissions
pendingPromptEdit
queuedPromptActions
clearError
```

运行 `rg` 确认生产代码不存在旧字段：

```powershell
rg -n "state\.(sending|sendingOperationId|openingSession|error|pendingPromptSubmissions|pendingPromptEdit|queuedPromptActions)|clearError" apps/desktop/src/renderer/src
```

预期：无匹配；测试 fixture 的旧字段也应在任务 7 迁移后归零。

- [ ] **步骤 6：运行组件测试、桌面完整测试和类型检查**

```powershell
..\..\node_modules\.bin\vitest.CMD run
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
```

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts apps/desktop/src/renderer/src/stores/desktop-session/selectors.test.ts apps/desktop/src/renderer/src/stores/desktop-session/types.ts apps/desktop/src/renderer/src/stores/desktop-session-store.ts apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.tsx apps/desktop/src/renderer/src/routes/__root.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx apps/desktop/src/renderer/src/components/desktop/layout/settings-layout/settings-layout.tsx
git commit -m "refactor(desktop): 以会话 selector 驱动界面状态"
```

---

### 任务 7：组合新 store，拆分测试并缩小兼容入口

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/store.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/store.integration.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session-store.ts`
- 删除：`apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts`
- 修改：任务 1 至任务 6 创建的测试文件

- [ ] **步骤 1：建立最终 store composition**

```ts
export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => {
  const context = { set, get }
  return {
    ...createInitialState(),
    ...createBootstrapActions(context),
    ...createProjectActions(context),
    ...createSessionActions(context),
    ...createPromptActions(context),
    ...createQueuedPromptActions(context),
    applySessionUpdate: createApplySessionUpdate(context),
  }
})
```

`store.ts` 不直接实现动作正文。

- [ ] **步骤 2：将旧测试按职责迁移**

测试映射：

- provider refresh、project order、Git cache → `project-actions.test.ts`；
- outside-project、create/open/fork 生命周期 → `session-actions.test.ts`；
- send/edit/interrupt/permission → `prompt-actions.test.ts`；
- promote/cancel → `pending-prompt-state.test.ts` 或 `prompt-actions.test.ts`；
- 跨模块竞态 → `store.integration.test.ts`。

迁移时保留所有 31 条 store 测试的行为断言，并加入规格列出的快速连续发送、SSE 先到、后台会话和错误隔离场景。

- [ ] **步骤 3：运行新测试集合确认全部通过**

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session
```

预期：PASS，迁移后的测试总数不少于旧 store 的 31 条加新增纯状态测试。

- [ ] **步骤 4：删除旧测试和实现正文**

`desktop-session-store.ts` 最终内容只允许：

```ts
export { useDesktopSessionStore, attachDesktopSessionEvents } from "./desktop-session/store"
export { isSessionPinned } from "./desktop-session/helpers"
export * from "./desktop-session/selectors"
export type { DesktopSessionState, QueuedPromptAction } from "./desktop-session/types"
```

- [ ] **步骤 5：检查依赖方向和文件体积**

```powershell
rg -n "desktop-session-store" apps/desktop/src/renderer/src/stores/desktop-session
Get-ChildItem apps/desktop/src/renderer/src/stores/desktop-session/*.ts | ForEach-Object { "{0} {1}" -f $_.Name, (Get-Content $_.FullName).Count }
```

预期：新目录内部不反向导入兼容入口；没有一个 action 文件重新聚合所有职责。

- [ ] **步骤 6：运行桌面完整测试、类型检查和 lint**

```powershell
..\..\node_modules\.bin\vitest.CMD run
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
.\node_modules\.bin\eslint.CMD src/renderer/src/stores/desktop-session src/renderer/src/stores/desktop-session-store.ts src/renderer/src/components/desktop/conversation-page/conversation-page.tsx
```

- [ ] **步骤 7：提交**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session apps/desktop/src/renderer/src/stores/desktop-session-store.ts apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts
git commit -m "refactor(desktop): 完成会话 store 模块化组合"
```

---

### 任务 8：补齐职责 README 并做最终回归

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/README.md`
- 修改：仅当最终实现与设计文件名有合理偏差时，更新 `docs/superpowers/specs/2026-08-27-desktop-session-store-modular-runtime-design.md`

- [ ] **步骤 1：按真实代码编写职责 README**

README 必须包含以下可核对内容：

```markdown
## 目录边界
## 四层状态放在哪里
## 文件职责表
## 新会话创建流程
## 普通发送与排队发送流程
## Primary SSE 所有权与会话切换
## IPC/SSE 对账顺序
## Operation 与错误生命周期
## 新增状态或动作的放置检查清单
## 不可破坏约束
```

每个流程用“入口 → 调用 → 状态写入位置 → SSE 返回 → 清理位置”的大白话描述，不只罗列架构名词。

- [ ] **步骤 2：运行规格覆盖扫描**

逐项检查设计规格的 12 条不可破坏约束，并在对应测试文件中找到断言。使用：

```powershell
rg -n "late|older|cursor|response lost|queued|placement|session-new|error|primary|open" apps/desktop/src/renderer/src/stores/desktop-session/*.test.ts
```

任何缺失都先补失败测试，再补实现；不能只在 README 声称支持。

- [ ] **步骤 3：运行最终验证**

```powershell
..\..\node_modules\.bin\vitest.CMD run
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false --pretty false
.\node_modules\.bin\eslint.CMD src/renderer/src/stores/desktop-session src/renderer/src/stores/desktop-session-store.ts src/renderer/src/components/desktop/conversation-page/conversation-page.tsx src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.tsx
```

工作目录：`apps/desktop`

然后在仓库根目录运行：

```powershell
.\node_modules\.bin\turbo.CMD check-types
git diff --check
git status --short
```

预期：所有测试通过、TypeScript 和 ESLint exit 0、Turbo 57/57 或更多任务成功、diff check 无错误；status 只保留任务修改和用户原有的无关修改。

- [ ] **步骤 4：请求代码审查**

审查重点：

- primary subscription 是否仍只有一个所有者；
- operation 是否可能无界积累；
- selector 是否会跨会话读取错误或 sending；
- SSE 已确认成功是否可能被 IPC catch 反转；
- 普通消息、快速连续消息和真实队列是否仍符合 UI 预期；
- README 是否与代码一致。

修复所有 Critical/Important 后重新运行步骤 3。

- [ ] **步骤 5：提交职责文档与最终修正**

```powershell
git add -- apps/desktop/src/renderer/src/stores/desktop-session/README.md apps/desktop/src/renderer/src/stores/desktop-session docs/superpowers/specs/2026-08-27-desktop-session-store-modular-runtime-design.md
git commit -m "docs(desktop): 说明会话 store 模块职责"
```

注意：显式排除用户已有的 `message-block.tsx` 和 `files-tool.tsx` 修改，除非用户另行授权把它们纳入本任务。
